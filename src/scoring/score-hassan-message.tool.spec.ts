import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { hassanFacingAgent } from '../agent/hassan-facing-agent';
import { scoreHassanMessageTool } from './score-hassan-message.tool';

const prisma = new PrismaClient();

describe('scoreHassanMessageTool Verification', () => {
  const testTenant = 'test-tenant-123';
  const testHassanId = 'test-hassan-999';
  const testLeadId = 'test-lead-999';

  beforeAll(async () => {
    // 1. Ensure test tenant/user constraints are cleared in DB
    await prisma.$executeRaw`SELECT set_config('app.tenant_id', ${testTenant}, true)`;

    // Cleanup any orphaned test records
    await prisma.hassan_score_events.deleteMany({
      where: { hassan_id: testHassanId },
    });
    await prisma.lead.deleteMany({
      where: { id: testLeadId },
    });
    await prisma.broker.deleteMany({
      where: { id: testHassanId },
    });

    // 2. Seed test broker
    await prisma.broker.create({
      data: {
        id: testHassanId,
        name: 'Hassan Test Broker',
        phone: '01099999999',
      },
    });

    // 3. Seed test lead
    await prisma.lead.create({
      data: {
        id: testLeadId,
        name: 'Test Client',
        phone: '01088888888',
        brokerId: testHassanId,
      },
    });
  });

  afterAll(async () => {
    await prisma.$executeRaw`SELECT set_config('app.tenant_id', ${testTenant}, true)`;
    // Cleanup seed data
    await prisma.hassan_score_events.deleteMany({
      where: { hassan_id: testHassanId },
    });
    await prisma.lead.deleteMany({
      where: { id: testLeadId },
    });
    await prisma.broker.delete({
      where: { id: testHassanId },
    });
    await prisma.$disconnect();
  });

  it('should calculate scores and write to hassan_score_events under correct RLS context', async () => {
    // Mock the Gemini generate function to isolate database write and scoring calculations
    const spy = vi.spyOn(hassanFacingAgent, 'generate').mockResolvedValue({
      object: {
        tone_match: 92,
        objection_handling: 85,
        cultural_sensitivity: 90,
      },
    } as any);

    const input = {
      hassan_id: testHassanId,
      tenant_id: testTenant,
      lead_id: testLeadId,
      message_text: 'يا باشا متاح شقق بفيو جاردن في هايد بارك استلام فوري',
      message_ts: new Date(),
      lead_state_before: 'QUALIFYING',
      lead_state_after: 'MATCHING',
      response_time_seconds: 120, // < 300s (ideal response time)
      lead_profile_completeness_pct: 80,
      tone_preset: 'Friendly' as const,
      objections_detected: ['price'],
      compound_facts_mentioned: ['Hyde Park'],
      compound_facts_verified: [true],
    };

    const result = await scoreHassanMessageTool.execute({
      context: {},
      input,
    });

    expect(result.success).toBe(true);
    expect(result.total).toBeGreaterThan(0);
    expect(result.breakdown).toBeDefined();

    // Verify database write
    const dbEvent = await prisma.hassan_score_events.findFirst({
      where: {
        hassan_id: testHassanId,
        tenant_id: testTenant,
      },
    });

    expect(dbEvent).not.toBeNull();
    expect(dbEvent!.total).toEqual(result.total);
    expect(dbEvent!.error_kind).toBeNull();

    // Verify RLS is active: attempting to query with a different tenant config should return empty
    await prisma.$executeRaw`SELECT set_config('app.tenant_id', 'different-tenant-456', true)`;
    const rlsBlockedEvent = await prisma.hassan_score_events.findFirst({
      where: {
        hassan_id: testHassanId,
        tenant_id: testTenant,
      },
    });
    expect(rlsBlockedEvent).toBeNull();

    spy.mockRestore();
  });
});
