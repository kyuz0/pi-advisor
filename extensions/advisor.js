import { Type } from '@earendil-works/pi-ai';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { registerAdvisor } from '../lib/advisor/pi.mjs';
export default function (pi) { registerAdvisor(pi, { getAgentDir, Type }); }
