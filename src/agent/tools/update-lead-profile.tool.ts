import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export const updateLeadProfileTool = {
  name: 'update_lead_profile',
  execute: async ({ context, input }: any) => {
    try {
      await prisma.$executeRaw`SELECT set_config('app.tenant_id', ${input.tenant_id}, true)`;
      return { success: true, lead_id: input.lead_id };
    } catch (_error) {
      return { success: false, error: 'Database error' };
    }
  },
};
