import { Queue, Worker } from 'bullmq';

/**
 * generate-digest.job.ts
 * BullMQ repeatable job for Hassan v1.1 coaching digest.
 * Fires at 08:00 Cairo time.
 */

const coachingQueue = new Queue('coaching-digest', {
  connection: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
  },
});

export const scheduleCoachingDigest = async () => {
  await coachingQueue.add(
    'generate-digest',
    {},
    {
      repeat: {
        pattern: '0 8 * * *',
        tz: 'Africa/Cairo',
      },
    },
  );
};

const _worker = new Worker(
  'coaching-digest',
  async (job) => {
    if (job.name === 'generate-digest') {
      const { prisma } = job.data as { prisma: any }; // Pass prisma via job data or global
      const last24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

      // Get all Hassans to process
      const brokers = await prisma.broker.findMany();

      for (const broker of brokers) {
        // 1. Query hassan_score_events for last 24h
        const events = await prisma.hassan_score_events.findMany({
          where: {
            hassan_id: broker.id,
            created_at: { gte: last24h },
          },
          orderBy: { total: 'desc' },
        });

        if (events.length === 0) continue;

        // 2. Find top 3 (best) and bottom 3 (worst)
        const bestMoments = events.slice(0, 3).map((e: any) => ({
          interaction_id: e.id,
          score: e.total,
          reason: 'High performance across criteria',
        }));

        const worstMoments = events
          .slice(-3)
          .reverse()
          .map((e: any) => ({
            interaction_id: e.id,
            score: e.total,
            reason: 'Improvement needed',
            cause: 'Latency or missing qualification fields',
          }));

        // 3. Generate micro-quiz (Generic real estate scenario for now)
        const microQuiz = {
          question:
            "A lead asks 'Is the price negotiable?' on a primary market unit. What is the correct response?",
          options: [
            'Yes, I can get you a 10% discount immediately.',
            'Prices for primary units are fixed by the developer, but I can check for the best payment plan.',
            'Everything is negotiable in Egypt.',
          ],
          correct_index: 1,
        };

        // 4. Write to coaching_sessions
        await prisma.coaching_sessions.create({
          data: {
            tenant_id: broker.tenant_id || 'default', // Fallback if tenant_id missing on broker
            hassan_id: broker.id,
            best_moments: bestMoments,
            worst_moments: worstMoments,
            micro_quiz: microQuiz,
          },
        });

        console.log(`Generated digest for Broker: ${broker.name}`);
      }
    }
  },
  {
    connection: {
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379', 10),
    },
  },
);
