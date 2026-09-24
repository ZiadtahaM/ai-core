import { GoogleGenAI } from '@google/genai';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY });

/**
 * score-hassan-message.tool.ts
 * Evaluates Hassan's message and logs it to hassan_score_events.
 * Guards: idempotency (webhook_idempotency table) + cost ceiling (broker_cost_ceilings table).
 */
export async function executeHassanScore(input: {
  hassan_id: string;
  tenant_id: string;
  lead_id: string;
  message_text: string;
  message_ts: Date;
  lead_state_before: string;
  lead_state_after: string;
  response_time_seconds: number;
  lead_profile_completeness_pct: number;
  tone_preset: string;
  objections_detected: string[];
  compound_facts_mentioned: string[];
  compound_facts_verified: boolean[];
}) {
  // ─── Guard 1: Idempotency ─────────────────────────────────────────────────
  // Key: tenant + lead + message timestamp — same message replayed N times = 1 score event
  const idemKey = `${input.tenant_id}:${input.lead_id}:${input.message_ts.getTime()}`;

  const existing = await prisma.webhook_idempotency.findUnique({
    where: { idem_key: idemKey },
  });

  if (existing?.status === 'SUCCESS') {
    console.log(`[Idempotency] Duplicate message skipped: ${idemKey}`);
    return { success: true, cached: true, idem_key: idemKey };
  }

  // Mark as PENDING before any side effects
  await prisma.webhook_idempotency.upsert({
    where: { idem_key: idemKey },
    create: { idem_key: idemKey, tenant_id: input.tenant_id, status: 'PENDING' },
    update: { status: 'PENDING' },
  });

  // ─── Guard 2: Cost ceiling ────────────────────────────────────────────────
  // broker_cost_ceilings.limit_egp defaults to 1500 EGP/period (schema default)
  const ceiling = await prisma.broker_cost_ceilings.findUnique({
    where: { broker_id: input.hassan_id },
  });

  if (ceiling && ceiling.current_spend >= ceiling.limit_egp) {
    console.warn(
      `[Cost] Broker ${input.hassan_id} exceeded ceiling: ${ceiling.current_spend}/${ceiling.limit_egp} EGP`,
    );
    await prisma.webhook_idempotency.update({
      where: { idem_key: idemKey },
      data: { status: 'FAILED' },
    });
    return { success: false, error_kind: 'cost_ceiling_exceeded', total: null };
  }

  try {
    await prisma.$executeRaw`SELECT set_config('app.tenant_id', ${input.tenant_id}, true)`;

    const weights = {
      response_time: 0.1,
      qualification_completeness: 0.2,
      tone_match: 0.1,
      objection_handling: 0.15,
      handoff_timing: 0.1,
      cultural_sensitivity: 0.1,
      grounding_accuracy: 0.15,
      lead_progression: 0.1,
    };

    const evaluationPrompt = `
      You are the Sales Coach AI evaluating a real estate broker's message to a client in Egypt.
      
      Broker Message: "${input.message_text}"
      Expected Tone Preset: ${input.tone_preset}
      Objections Detected: ${JSON.stringify(input.objections_detected)}
      
      Return a JSON object with three numbers (0 to 100):
      {
        "tone_match": (How well they mirror colloquial Egyptian Arabic and the ${input.tone_preset} tone),
        "objection_handling": (Constructive objection handling),
        "cultural_sensitivity": (Warm Egyptian cultural markers)
      }
    `;

    // ─── LLM Call (with deterministic fallback) ───────────────────────────
    let tone_match = 80;
    let objection_handling = 85;
    let cultural_sensitivity = 90;

    const hasApiKey = !!(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);

    if (hasApiKey) {
      try {
        const response = await ai.models.generateContent({
          model: 'gemini-2.5-flash',
          contents: evaluationPrompt,
          config: {
            responseMimeType: 'application/json',
            responseSchema: {
              type: 'object',
              properties: {
                tone_match: { type: 'number' },
                objection_handling: { type: 'number' },
                cultural_sensitivity: { type: 'number' },
              },
              required: ['tone_match', 'objection_handling', 'cultural_sensitivity'],
            },
          },
        });

        if (response.text) {
          const aiEvaluation = JSON.parse(response.text);
          tone_match = aiEvaluation.tone_match ?? tone_match;
          objection_handling = aiEvaluation.objection_handling ?? objection_handling;
          cultural_sensitivity = aiEvaluation.cultural_sensitivity ?? cultural_sensitivity;
        }
      } catch (llmError) {
        console.warn('[Scoring] LLM call failed, using deterministic fallback:', llmError);
      }
    } else {
      console.warn('[Scoring] No GEMINI_API_KEY found, using deterministic baseline scores.');
    }

    // ─── Deterministic criteria ───────────────────────────────────────────
    const responseScore =
      input.response_time_seconds < 300
        ? 100
        : Math.max(0, 100 - Math.round((input.response_time_seconds - 300) / 10));

    const groundingScore =
      input.compound_facts_verified.length === 0
        ? 100
        : input.compound_facts_verified.every((v) => v)
          ? 100
          : 0;

    const progressionScore = input.lead_state_after !== input.lead_state_before ? 100 : 50;

    const handoffScore =
      input.lead_state_after === 'QUALIFYING' && input.objections_detected.includes('negotiable')
        ? 30
        : 100;

    const breakdown = {
      response_time: responseScore,
      qualification_completeness: input.lead_profile_completeness_pct,
      tone_match,
      objection_handling,
      handoff_timing: handoffScore,
      cultural_sensitivity,
      grounding_accuracy: groundingScore,
      lead_progression: progressionScore,
    };

    const total = Math.round(
      Object.keys(weights).reduce(
        (sum, key) => sum + (breakdown[key as keyof typeof breakdown] || 0) * (weights as any)[key],
        0,
      ),
    );

    // ─── Persist score event ──────────────────────────────────────────────
    await prisma.hassan_score_events.create({
      data: {
        tenant_id: input.tenant_id,
        hassan_id: input.hassan_id,
        lead_id: input.lead_id,
        criteria_breakdown: breakdown,
        total,
        error_kind: null,
      },
    });

    // ─── Mark idempotency as SUCCESS ──────────────────────────────────────
    await prisma.webhook_idempotency.update({
      where: { idem_key: idemKey },
      data: { status: 'SUCCESS', response_body: { total, hassan_id: input.hassan_id } },
    });

    return { success: true, total, breakdown, hassan_id: input.hassan_id, lead_id: input.lead_id };
  } catch (error) {
    console.error('[Scoring] Tool Error:', error);

    // Mark idempotency as FAILED so the next retry can proceed
    await prisma.webhook_idempotency
      .update({ where: { idem_key: idemKey }, data: { status: 'FAILED' } })
      .catch(() => {});

    try {
      await prisma.$executeRaw`SELECT set_config('app.tenant_id', ${input.tenant_id}, true)`;
      await prisma.hassan_score_events.create({
        data: {
          tenant_id: input.tenant_id,
          hassan_id: input.hassan_id,
          lead_id: input.lead_id,
          criteria_breakdown: {},
          total: 0,
          error_kind: 'ai_timeout',
        },
      });
    } catch (_dbError) {}

    return { success: false, error_kind: 'ai_timeout', total: null };
  }
}

// Retain export for backward compatibility
export const scoreHassanMessageTool = {
  execute: async ({ input }: any) => await executeHassanScore(input),
};
