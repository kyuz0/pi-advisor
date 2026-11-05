import { access, mkdir, readFile, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { executable } from './codex.mjs';
import { runtimeMounts } from './runtime.mjs';
import { runProcess } from './process.mjs';

const rolePath = fileURLToPath(new URL('../../examples/advisor-system.txt', import.meta.url));


export async function sandboxInvocation(config, home, args, { auth = true } = {}) {
  if (process.platform !== 'linux') throw new Error('Claude advisor requires Linux and bubblewrap');
  const source = config.claudeHome ?? join(homedir(), '.claude');
  if (config.sharedHome) home = source;
  await mkdir(home, { recursive: true, mode: 0o700 });
  const binary = await executable(config.executable ?? 'claude');
  const bwrap = await executable(config.bubblewrap ?? 'bwrap');
  const flags = ['--die-with-parent', '--new-session', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--unshare-user', '--cap-drop', 'ALL', '--ro-bind', '/usr', '/usr'];
  for (const dir of ['/bin','/sbin','/lib','/lib64']) {
    try { flags.push('--ro-bind', await realpath(dir), dir); } catch {}
  }
  flags.push(...runtimeMounts(config.containerRuntime), '--tmpfs', '/tmp', '--dir', '/work', '--dir', '/home/advisor', '--dir', '/opt', '--ro-bind', binary, '/opt/claude', '--bind', home, '/state');
  if (config.containerRuntime) flags.push('--dir', '/proc/self', '--symlink', '/opt/claude', '/proc/self/exe');
  for (const path of ['/etc/resolv.conf','/etc/hosts','/etc/nsswitch.conf','/etc/ssl','/etc/pki']) {
    try { await access(path); flags.push('--ro-bind', path, path); } catch {}
  }
  if (auth && !config.sharedHome) {
    const credentials = join(source, '.credentials.json');
    try { await access(credentials); } catch { throw new Error('Claude file-backed login missing. Run claude auth login first.'); }
    flags.push('--ro-bind', credentials, '/state/.credentials.json');
  }
  // Never inherit API keys, alternate API endpoints, hooks or desktop integration.
  const env = { PATH:'/usr/bin:/bin', HOME:'/home/advisor', CLAUDE_CONFIG_DIR:'/state', LANG:'C.UTF-8', TERM:'dumb',
    DISABLE_AUTOUPDATER:'1', DISABLE_TELEMETRY:'1', DISABLE_ERROR_REPORTING:'1' };
  for (const key of ['HTTP_PROXY','HTTPS_PROXY','http_proxy','https_proxy','NO_PROXY','no_proxy','NODE_USE_ENV_PROXY']) if (process.env[key]) env[key] = process.env[key];
  flags.push('--chdir', '/work', '--', '/opt/claude', ...args);
  return {command:bwrap, args:flags, env};
}
export async function inspect(config, root, signal, {launch = sandboxInvocation} = {}) {
  const home = join(root, 'claude-inspection', randomUUID());
  try {
    const inv = await launch(config, home, ['--version'], {auth:false});
    const r = await runProcess(inv.command, inv.args, {env:inv.env,signal,timeoutMs:30000});
    if (r.code !== 0 || r.reason || !r.stdout.trim()) throw new Error('Isolated Claude could not start: '+(r.reason ?? r.stderr));
    return {provider:'claude',version:r.stdout.trim(),isolation:'linux-bubblewrap'};
  } finally { if (!config.sharedHome) await rm(home, {recursive:true,force:true}); }
}
const isolatedFlags = ['--safe-mode','--setting-sources','', '--settings','{"disableAllHooks":true,"fallbackModel":[]}',
  '--tools','', '--strict-mcp-config','--mcp-config','{"mcpServers":{}}', '--permission-mode','dontAsk','--permission-prompts','none'];

export function parseQuota(report, config) {
  const limits=report?.rate_limits?.limits;
  if(!Array.isArray(limits))return {state:'unknown',observedAt:Date.now(),source:'claude-usage',buckets:[],error:'Claude returned no structured subscription quota. Sign in with claude auth login; inference-only tokens cannot read plan usage.'};
  const buckets=[];
  for(const model of Object.values(config.models)) {
    const rows=limits.filter(row=>{
      if(row.scope?.surface)return false;
      const family=row.scope?.model?.display_name?.toLowerCase();
      if(family)return ['sonnet','opus','haiku'].some(f=>family===f&&(model.id===f||model.id.startsWith('claude-'+f+'-')));
      return ['session','weekly_all'].includes(row.kind);
    });
    const windows=rows.flatMap(row=>Number.isFinite(row.percent)&&row.percent>=0&&row.percent<=100&&Number.isFinite(Date.parse(row.resets_at))?
      [{name:row.kind,remainingPercent:100-row.percent,resetsAt:Date.parse(row.resets_at)}]:[]);
    if(windows.length)buckets.push({id:'claude-subscription',model:model.id,windows});
  }
  return {state:buckets.length?'known':'unknown',observedAt:Date.now(),source:'claude-usage',buckets,reportedLimits:limits,extraUsage:report.rate_limits.extra_usage??null};
}
export async function readQuota(config, root, {signal,launch=sandboxInvocation}={}) {
  const home=join(root,'claude-quota',randomUUID());
  try {
    const inv=await launch(config,home,['--print','--verbose','--output-format','stream-json',...isolatedFlags,'--no-session-persistence','/usage']);
    let report,terminal;
    const r=await runProcess(inv.command,inv.args,{env:inv.env,input:'',signal,timeoutMs:45000,maxBytes:2097152,onLine(line,_send,stop){
      const e=JSON.parse(line);
      if(e.type==='assistant'&&e.local_command_run?.command==='usage')report=e.usage_report;
      if(e.type==='result')terminal=e;
      if(e.type==='assistant'&&!e.local_command_source)stop('Unexpected model response to quota command');
    }});
    if(r.reason||r.code!==0||terminal?.local_command!=='usage'||terminal?.num_turns!==0||terminal?.subtype!=='success'||terminal?.is_error)
      throw new Error('Claude /usage did not return a successful local command: '+(r.reason??terminal?.result??r.stderr));
    return parseQuota(report,config);
  } finally {if(!config.sharedHome)await rm(home,{recursive:true,force:true});}
}
export function normalizeUsage(usage) {
  if (!usage || !Number.isSafeInteger(usage.input_tokens) || !Number.isSafeInteger(usage.output_tokens) || !['input_tokens','output_tokens','cache_read_input_tokens','cache_creation_input_tokens'].every(k=>Number.isSafeInteger(usage[k]??0)&&(usage[k]??0)>=0)) return null;
  return {input_tokens:usage.input_tokens+(usage.cache_read_input_tokens??0)+(usage.cache_creation_input_tokens??0),
    cached_input_tokens:usage.cache_read_input_tokens??0,cache_write_input_tokens:usage.cache_creation_input_tokens??0,output_tokens:usage.output_tokens};
}
export async function ask(config, root, request, {signal,onProgress,launch=sandboxInvocation} = {}) {
  const home = join(root,'claude-conversations',request.conversationId);
  const args = ['--print','--verbose','--output-format','stream-json',...isolatedFlags,'--disable-slash-commands','--system-prompt',await readFile(rolePath,'utf8'),
    '--model',request.resolvedModel??request.model,'--effort',request.effort];
  if (request.mode==='consult') args.push('--no-session-persistence');
  else if (request.mode==='resume') args.push('--resume',request.threadId);
  else args.push('--session-id',request.conversationId);
  let init, terminal, toolAttempt=false, lastEvent, modelMismatch=false;
  const warnings=[];
  try {
    const inv = await launch(config,home,args);
    // Authentication status is a local check; report no account identifiers.
    const authInv = await launch(config,home,['auth','status','--json']);
    const auth = await runProcess(authInv.command,authInv.args,{env:authInv.env,signal,timeoutMs:30000});
    let status; try { status=JSON.parse(auth.stdout); } catch {}
    if(auth.reason||auth.code!==0||status?.loggedIn!==true||!['claude.ai','claudeAi'].includes(status?.authMethod))
      return {error:'Claude subscription login is required. Use claude auth login in the advisor environment.',completed:false,outcomeUnknown:false};
    const r = await runProcess(inv.command,inv.args,{env:inv.env,input:request.packet,signal,timeoutMs:config.timeoutMs,maxBytes:16777216,
      onLine(line,_send,stop) {
        const e=JSON.parse(line);
        if(e.type==='system'&&e.subtype==='init') {
          init=e; onProgress?.('Claude advisor is reasoning.');
          if(e.tools?.length || e.mcp_servers?.length) {toolAttempt=true;stop('tool_attempt');}
        }
        if(e.type==='assistant') {
          if(e.message?.content?.some(c=>['tool_use','server_tool_use'].includes(c.type))) {toolAttempt=true;stop('tool_attempt');}
          if(init?.model&&e.message?.model&&e.message.model!==init.model)modelMismatch=true;
        }
        if(e.type==='rate_limit_event') {
          const info=e.rate_limit_info;
          if(info&&['allowed','allowed_warning','rejected'].includes(info.status)) {
            lastEvent={status:info.status,resetsAt:info.resetsAt??null,utilization:info.utilization??null,errorCode:info.errorCode??null};
            if(info.status!=='allowed') warnings.push(`Claude quota ${info.status}${info.resetsAt?' until '+new Date(info.resetsAt*1000).toISOString():''}${info.errorCode?': '+info.errorCode:''}`);
          }
        }
        if(e.type==='result') {if(terminal)throw new Error('Duplicate Claude result');terminal=e;}
      }});
    let error=r.reason??(r.code!==0?`Claude exit ${r.code}: ${r.stderr.slice(-1000)}`:null);
    if(toolAttempt||terminal?.permission_denials?.length)error='Advice-only contract: Claude exposed or attempted a tool.';
    if(terminal?.subtype!=='success'||terminal?.is_error)error??=terminal?.errors?.join('; ')||'Claude did not complete successfully';
    if(!init?.session_id||terminal?.session_id!==init.session_id||!init.model)error??='Claude session identity was not verified';
    if(request.mode==='resume'&&(terminal?.session_id!==request.threadId||init?.model!==request.resolvedModel))error??='Claude resume changed session or model';
    if(request.mode==='start'&&terminal?.session_id!==request.conversationId)error??='Claude started a different session';
    if(modelMismatch)error??='Claude changed model during the request';
    if(typeof terminal?.result!=='string')error??='Claude completed without a textual response';
    return {answer:error?undefined:terminal.result,error:error??undefined,threadId:terminal?.session_id,resolvedModel:init?.model,
      usage:normalizeUsage(terminal?.usage),completed:!!terminal,warnings,cancelled:r.reason==='cancelled',outcomeUnknown:!terminal&&r.reason!=='spawn_error'};
  } finally {if(request.mode==='consult'&&!config.sharedHome)await rm(home,{recursive:true,force:true});}
}
