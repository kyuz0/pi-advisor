import { readFile } from 'node:fs/promises';
import { AdvisorService, validateConfig } from '../lib/advisor/service.mjs';
import { serveAdvisor } from '../lib/advisor/remote.mjs';
const service = new AdvisorService(process.env.PI_CODING_AGENT_DIR ?? '/home/node/.pi/agent');
// Configuration is host-managed and read-only; RPC never accepts config or paths.
const config = validateConfig(JSON.parse(await readFile(process.env.PI_ADVISOR_CONFIG ?? '/etc/advisor/config.json', 'utf8')));
service.config = async () => config;
const server = await serveAdvisor(process.env.PI_ADVISOR_SOCKET ?? '/run/advisor/advisor.sock', service);
for (const signal of ['SIGTERM','SIGINT']) process.on(signal, async () => { await server.stop(); process.exit(0); });
console.log('Advisor ready');
