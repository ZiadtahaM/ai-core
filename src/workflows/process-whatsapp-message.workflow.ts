import { GoogleGenAI } from '@google/genai';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';

const prisma = new PrismaClient();
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY });

/**
 * process-whatsapp-message.workflow.ts
 *
 * The core vertical AI loop. Three stages run sequentially:
 *   1. LLM-based structured extraction of lead data from message text
 *   2. Deterministic DB write to update lead profile (no LLM — no mismatch risk)
 *   3. LLM-based Egyptian Arabic reply generation
 *
 * Note: Mastra MastraWorkflow/Step removed — the API for agent.generate() with
 * outputSchema and agent.tools.X.execute() is not stable in the installed version.
 * Replaced with a plain async function that composes the same logic with real guarantees.
 */

const extractedDataSchema = z.object({
  budget_max_egp: z.number().optional(),
  zone_preferences: z.array(z.string()).optional(),
  purpose: z.enum(['LIVE', 'INVEST']).optional(),
});

type ExtractedData = z.infer<typeof extractedDataSchema>;

function determineNextState(currentState: string, extracted: ExtractedData): string {
  // Simple state machine — extend as business rules evolve
  if (!extracted.budget_max_egp && !extracted.zone_preferences) return currentState;
  if (extracted.budget_max_egp && extracted.zone_preferences && extracted.purpose)
    return 'MATCHING';
  if (extracted.budget_max_egp || extracted.zone_preferences) return 'QUALIFYING';
  return currentState;
}

export async function processWhatsappMessage(input: {
  message_text: string;
  lead_id: string;
  tenant_id: string;
  current_state: string;
}): Promise<{ reply_text: string; final_state: string; extracted: ExtractedData }> {
  const { message_text, lead_id, tenant_id, current_state } = input;

  const hasApiKey = !!(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);

  // ─── Step 1: Structured extraction ───────────────────────────────────────
  let extracted: ExtractedData = {};

  if (hasApiKey) {
    try {
      const extractionResponse = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: `
          Analyze this message from a real estate lead in Egypt (state: ${current_state}).
          Message: "${message_text}"
          Extract budget, zone preference, and purpose. Return null for missing fields.
        `,
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: 'object',
            properties: {
              budget_max_egp: { type: 'number', nullable: true },
              zone_preferences: { type: 'array', items: { type: 'string' } },
              purpose: { type: 'string', nullable: true },
            },
          },
        },
      });

      if (extractionResponse.text) {
        const parsed = extractedDataSchema.safeParse(JSON.parse(extractionResponse.text));
        if (parsed.success) extracted = parsed.data;
      }
    } catch (err) {
      console.warn('[Workflow] Extraction LLM failed, proceeding with empty extraction:', err);
    }
  }

  // ─── Step 2: Deterministic DB write ──────────────────────────────────────
  // No LLM. No Mastra tool invocation. Direct Prisma write.
  // This eliminates the agent.tools.X.execute() mismatch bug.
  const nextState = determineNextState(current_state, extracted);

  await prisma.$executeRaw`SELECT set_config('app.tenant_id', ${tenant_id}, true)`;

  await prisma.lead.update({
    where: { id: lead_id },
    data: {
      ...(extracted.budget_max_egp ? { budget: extracted.budget_max_egp } : {}),
      status: nextState,
    },
  });

  // ─── Step 3: Generate Egyptian Arabic reply ───────────────────────────────
  let reply_text = 'شكراً، هتواصل معاك قريباً.'; // safe Arabic fallback

  if (hasApiKey) {
    try {
      const replyResponse = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: `
          You are an Egyptian real estate sales assistant writing in warm, colloquial Egyptian Arabic.
          The lead said: "${message_text}"
          The system state is now: ${nextState}
          Ask ONLY for the single most important missing piece of information to reach MATCHING state.
          Be brief, friendly, and culturally appropriate. Max 2 sentences.
        `,
      });

      if (replyResponse.text) {
        reply_text = replyResponse.text.trim();
      }
    } catch (err) {
      console.warn('[Workflow] Reply LLM failed, using fallback reply:', err);
    }
  }

  return { reply_text, final_state: nextState, extracted };
}
