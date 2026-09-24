import { Worker } from 'bullmq';
import { processWhatsappWorkflow } from '../../workflows/process-whatsapp-message.workflow';

/**
 * whatsapp-incoming.worker.ts
 * Consumes messages from the 360dialog Fast-Ack queue and executes the Mastra AI Workflow.
 */

export const whatsappWorker = new Worker(
  'whatsapp-incoming',
  async (job) => {
    console.log(`[AI-Core] Processing WhatsApp message from ${job.data.lead_id}`);

    try {
      // Execute the deterministic state-machine workflow
      const result = await processWhatsappWorkflow.execute({
        triggerData: {
          message_text: job.data.message_text,
          lead_id: job.data.lead_id,
          tenant_id: job.data.tenant_id,
          current_state: job.data.current_state,
        },
      });

      console.log(
        `[AI-Core] Workflow completed for ${job.data.lead_id}. Final state: ${result.results.generate_reply.output.final_state}`,
      );

      // In production, we would call the 360dialog API here to send result.results.generate_reply.output.reply_text
      console.log(
        `[AI-Core] SIMULATED OUTBOUND REPLY: "${result.results.generate_reply.output.reply_text}"`,
      );
    } catch (error) {
      console.error(`[AI-Core] Failed to process message for ${job.data.lead_id}:`, error);
      throw error; // Let BullMQ handle retries
    }
  },
  {
    connection: {
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379', 10),
    },
  },
);

console.log('👷 BullMQ Worker listening on queue: whatsapp-incoming');
