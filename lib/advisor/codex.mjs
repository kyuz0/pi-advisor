import { runtimeMounts } from './runtime.mjs';
import { access, mkdir, readFile, realpath, writeFile, rm } from 'node:fs/promises';
import { join, delimiter, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { runProcess } from './process.mjs';

const assets = fileURLToPath(new URL('../../examples/', import.meta.url));
export async function executable(name) {
  if (name.includes('/')) return realpath(resolve(name));
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    try { const p = join(dir, name); await access(p, 1); return await realpath(p); } catch {}
  }
  throw new Error(`Executable not found: ${name}`);
}
// Linux-only v1. Never bind the project, global CLI state, or whole home.
export async function sandboxInvocation(config, home, args, { auth = true } = {}) {
  if (process.platform !== 'linux') throw new Error('Advisor v1 requires Linux and bubblewrap.');
  if (config.sharedHome) home = config.codexHome;
  await mkdir(home, { recursive: true, mode: 0o700 });
  const binary = await executable(config.executable ?? 'codex');
  const bwrap = await executable(config.bubblewrap ?? 'bwrap');
  const inputs = join(home, 'advisor-inputs');
  await mkdir(inputs, { recursive: true, mode: 0o700 });
  await writeFile(join(inputs, 'role.txt'), await readFile(join(assets, 'advisor-system.txt')), { mode: 0o600 });
  const flags = ['--die-with-parent', '--new-session', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--unshare-user', '--cap-drop', 'ALL', '--ro-bind', '/usr', '/usr'];
  for (const dir of ['/bin', '/sbin', '/lib', '/lib64']) {
    try { flags.push('--ro-bind', await realpath(dir), dir); } catch {}
  }
  flags.push(...runtimeMounts(config.containerRuntime), '--tmpfs', '/tmp', '--dir', '/work', '--dir', '/home', '--dir', '/opt', '--ro-bind', binary, '/opt/codex', '--bind', home, '/state', '--ro-bind', inputs, '/inputs');
  // Codex resolves its executable during startup. Keep other process data hidden.
  if (config.containerRuntime) flags.push('--dir', '/proc/self', '--symlink', '/opt/codex', '/proc/self/exe');
  for (const path of ['/etc/resolv.conf', '/etc/hosts', '/etc/nsswitch.conf', '/etc/ssl', '/etc/pki']) {
    try { await access(path); flags.push('--ro-bind', path, path); } catch {}
  }
  if (auth && config.billingMode === 'subscription') {
    const source = join(config.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'auth.json');
    try { await access(source); } catch { throw new Error('File-backed Codex login missing. Run codex login first. Keyring-only auth is not supported by this isolated v1.'); }
    if (!config.sharedHome) flags.push('--ro-bind', source, '/state/auth.json');
  }
  const env = { PATH: '/usr/bin:/bin', CODEX_HOME: '/state', LANG: 'C.UTF-8', TERM: 'dumb' };
  // Explicit API mode only; never silently substitute an API key for subscription auth.
  if (config.billingMode === 'api' && auth) {
    const key = process.env.CODEX_API_KEY;
    if (!key) throw new Error('API mode requires CODEX_API_KEY in the Pi process environment.');
    env.CODEX_API_KEY = key;
  }
  for (const key of ['HTTP_PROXY','HTTPS_PROXY','http_proxy','https_proxy','NO_PROXY','no_proxy','NODE_USE_ENV_PROXY']) if (process.env[key]) env[key] = process.env[key];
  flags.push('--chdir', '/work', '--', '/opt/codex', ...args);
  return { command: bwrap, args: flags, env };
}
export const profile = {
  approval_policy: 'never', web_search: 'disabled', project_doc_max_bytes: 0,
  cli_auth_credentials_store: 'file', 'skills.include_instructions': false,
  'skills.bundled.enabled': false, 'cloud.skills.enabled': false,
  'features.shell_tool': false, 'features.view_image': false, 'features.apps': false,
  'features.plugins': false, 'features.hooks': false, 'features.multi_agent': false,
  'features.memories': false, 'features.image_generation': false, 'features.skill_search': false,
  'features.tool_suggest': false, 'features.sleep_tool': false,
  model_instructions_file: '/inputs/role.txt', check_for_update_on_startup: false,
};
const overrides = values => Object.entries(values).flatMap(([key, value]) => ['-c', `${key}=${JSON.stringify(value)}`]);
export async function inspect(config, root, signal, { launch = sandboxInvocation } = {}) {
  const home = join(root, 'inspection');
  const inv = await launch(config, home, ['--version'], { auth: false });
  const result = await runProcess(inv.command, inv.args, { env: inv.env, signal, timeoutMs: 30000 });
  if (result.code !== 0 || result.reason) throw new Error(`Isolated Codex could not start: ${result.reason ?? result.stderr}`);
  const version = result.stdout.trim();
  if (!version) throw new Error('Codex --version returned no version information.');
  return { version, isolation: 'linux-bubblewrap', provider: 'codex' };
}
export async function ask(config, root, request, { signal, onProgress, launch = sandboxInvocation } = {}) {
  const home = join(root, 'conversations', request.conversationId);
  const args = ['exec', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check', '--strict-config', '--json', '-s', 'read-only', '-m', request.model,
    ...overrides({ ...profile, forced_login_method: config.billingMode === 'api' ? 'api' : 'chatgpt', model_reasoning_effort: request.effort })];
  if (request.mode === 'consult') args.push('--ephemeral');
  if (request.mode === 'resume') args.push('resume', request.threadId);
  args.push('-');
  const inv = await launch(config, home, args);
  let threadId, usage, finalText, completed = false, failed = null, rerouted = false;
  const warnings = [];
  const result = await runProcess(inv.command, inv.args, { env: inv.env, input: request.packet, signal, timeoutMs: config.timeoutMs, maxBytes: 1048576,
    onLine(line, _send, stop) {
      const e = JSON.parse(line);
      if (e.type === 'thread.started') threadId = e.thread_id;
      if (e.type === 'turn.started') onProgress?.('Advisor is reasoning.');
      if (e.type === 'turn.completed') { usage = e.usage; completed = true; }
      if (e.type === 'turn.failed' || e.type === 'error') failed = e.error?.message ?? e.message ?? 'Advisor failed.';
      if (e.item?.type === 'agent_message' && e.type === 'item.completed') finalText = e.item.text;
      if (e.item?.type === 'error') { warnings.push(String(e.item.message).slice(0, 1000)); rerouted ||= /model rerouted/i.test(e.item.message); }
      if (e.item && !['agent_message', 'reasoning', 'error'].includes(e.item.type)) { failed = 'Advice-only contract: advisor attempted a tool.'; stop('tool_attempt'); }
    } });
  let answer, error;
  if (result.reason || result.code !== 0 || failed || !completed || !threadId) error = result.reason ?? failed ?? `CLI exit ${result.code}; no valid completion. ${result.stderr.slice(-1000)}`;
  else if (typeof finalText !== 'string') error = 'CLI completed without a final message.';
  else answer = finalText; // Advisor text is opaque: never parse, trim, validate or rewrite it.
  if (request.mode === 'resume' && threadId && threadId !== request.threadId) { error = 'Resume returned a different thread ID.'; answer = undefined; }
  if (request.mode === 'consult') await rm(home, { recursive: true, force: true });
  return { answer, error, threadId, usage, completed, warnings, rerouted, cancelled: result.reason === 'cancelled', outcomeUnknown: !completed && result.reason !== 'spawn_error' };
}
// Quota only. No thread or turn RPCs are ever sent by this client.
export async function readQuota(config, root, { signal, launch = sandboxInvocation } = {}) {
  if (config.billingMode !== 'subscription' || config.quotaReader !== 'app-server') return { state: 'unknown', source: 'disabled', observedAt: null, buckets: [] };
  const home = join(root, 'quota', randomUUID());
  const inv = await launch(config, home, [...overrides(profile), 'app-server']);
  let account, rates, error, done = false;
  const result = await runProcess(inv.command, inv.args, { env: inv.env, signal, timeoutMs: 45000, maxBytes: 1048576,
    onStart(send) { send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'local_pi_advisor', version: '0.3.0' } } }); },
    onLine(line, send, stop) {
      const e = JSON.parse(line);
      if (e.error) { error = e.error.message; done = true; stop('quota_done'); return; }
      if (e.id === 1) { send({ method: 'initialized', params: {} }); send({ id: 2, method: 'account/read', params: { refreshToken: false } }); }
      if (e.id === 2) { account = e.result?.account; if (account?.type !== 'chatgpt') { error = 'Expected ChatGPT subscription authentication.'; done = true; stop('quota_done'); } else send({ id: 3, method: 'account/rateLimits/read', params: {} }); }
      if (e.id === 3) { rates = e.result; done = true; stop('quota_done'); }
      // Reject unexpected server requests; never grant tools or token refresh through a custom auth handler.
      if (e.method && e.id != null) send({ id: e.id, error: { code: -32601, message: 'Quota reader does not implement this method.' } });
    } });
  await rm(home, { recursive: true, force: true });
  if (!done || error || !rates) return { state: 'unknown', observedAt: Date.now(), source: 'app-server', buckets: [], error: error ?? result.reason ?? 'No quota response.' };
  const snapshots = rates.rateLimitsByLimitId && Object.keys(rates.rateLimitsByLimitId).length ? Object.entries(rates.rateLimitsByLimitId) : [['codex', rates.rateLimits]];
  const buckets = snapshots.filter(([, s]) => s).map(([id, s]) => ({ id, model: s.normalModelSlug ?? null, reached: s.rateLimitReachedType ?? null,
    windows: ['primary', 'secondary'].flatMap(k => {
      const w = s[k]; if (!w || !Number.isFinite(w.usedPercent) || w.usedPercent < 0 || w.usedPercent > 100) return [];
      return [{ name: k, remainingPercent: 100 - w.usedPercent, windowMinutes: w.windowDurationMins ?? null, resetsAt: Number.isFinite(w.resetsAt) ? w.resetsAt * 1000 : null }];
    }) }));
  return { state: buckets.some(b => b.windows.length) ? 'known' : 'unknown', observedAt: Date.now(), source: 'app-server', ordinaryUsageAllowed: rates.ordinaryUsageAllowed ?? null, buckets };
}
