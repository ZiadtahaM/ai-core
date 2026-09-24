import { updateLeadProfileTool } from './tools/update-lead-profile.tool';

export const hassanFacingAgent = {
  name: 'hassan_facing_agent',
  role: 'Lead-facing sales agent on WhatsApp + Hassan-facing real-time coach',
  tools: {
    updateLeadProfile: updateLeadProfileTool,
  },
  model: {
    provider: 'google',
    name: 'gemini-2.5-flash',
  },
};
