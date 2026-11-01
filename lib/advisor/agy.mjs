import { runtimeMounts } from './runtime.mjs';
import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, realpath, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir, userInfo } from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { executable } from './codex.mjs';
import { runProcess } from './process.mjs';

const rolePath=fileURLToPath(new URL('../../examples/advisor-system.txt',import.meta.url));
// AGY exposes background-task listing even for custom advice-only agents.
// Listing the private session's empty task registry grants no file or execution access.
export function isReadOnlyTaskList(event) {
  const step=event?.step_update, info=step?.tool_info, args=info?.parameters;
  return step?.step_type==='tool' && step.tool_name==='manage_task' && info?.name==='manage_task'
    && args?.Action==='list' && Object.keys(args).every(key=>key==='Action');
}
export const nativeUsageFields=['input_tokens','output_tokens','thinking_tokens','cache_read_tokens','total_tokens'];
export function nativeUsageDelta(current,previous=null) {
  if (!current || nativeUsageFields.some(k=>!Number.isSafeInteger(current[k])||current[k]<0)) return null;
  const d=Object.fromEntries(nativeUsageFields.map(k=>[k,current[k]-(previous?.[k]??0)]));
  return Object.values(d).some(v=>v<0)?null:d;
}
export function parseModels(text) {
  const rows=text.trim().split('\n').filter(Boolean).map(line=>{const [id,...label]=line.split('\t'); if(!id||!label.length)throw new Error('Unrecognized AGY model catalog');return {id,label:label.join('\t')};});
  if(!rows.length||new Set(rows.map(r=>r.id)).size!==rows.length)throw new Error('Empty or duplicate AGY model catalog');
  return rows;
}
export function parseQuota(native,config) {
  const groups=native?.command?.name==='usage'&&native.command.data?.groups;
  if(native?.status!=='SUCCESS'||!Array.isArray(groups))throw new Error('AGY supplied no native quota snapshot');
  const buckets=[];
  for(const model of Object.values(config.models)) {
    const group=groups.find(g=>g.name===model.quotaGroup);if(!group)continue;
    const windows=(group.buckets??[]).flatMap(w=>Number.isFinite(w.remaining_fraction)&&w.remaining_fraction>=0&&w.remaining_fraction<=1&&Number.isFinite(Date.parse(w.reset_time))?[{name:w.window,remainingPercent:w.remaining_fraction*100,resetsAt:Date.parse(w.reset_time)}]:[]);
    if(windows.length) buckets.push({id:group.name,model:model.id,windows});
  }
  return {state:buckets.length?'known':'unknown',observedAt:Date.now(),source:'agy-native-usage',buckets};
}

// Exposes only Secret Service through a filtered bus, never the desktop bus or host home.
export async function sandboxInvocation(config,home,args,{auth=true}={}) {
  if(process.platform!=='linux')throw new Error('AGY isolation requires Linux and bubblewrap');
  await mkdir(home,{recursive:true,mode:0o700});
  const work=join(home,'workspace'),state=join(home,'home');
  await mkdir(join(work,'.agents/agents'),{recursive:true,mode:0o700});
  await mkdir(join(state,'.gemini/antigravity-cli'),{recursive:true,mode:0o700});
  await writeFile(join(state,'.gemini/antigravity-cli/settings.json'),JSON.stringify({useG1Credits:false}),{mode:0o600});
  await writeFile(join(work,'.agents/agents/advisor.md'),'---\nname: advisor\ndescription: Advice from caller-supplied context\nmainAgent: true\nsubagent: false\nexcludeDefaultComponents: true\ntools: []\nmcpServers: []\nskills: []\nplugins: []\ncommandExecutionPolicy: off\n---\n'+await readFile(rolePath,'utf8'),{mode:0o600});
  const binary=await executable(config.executable),bwrap=await executable(config.bubblewrap??'bwrap');
  const runtime='/run/user/'+process.getuid(),username=userInfo().username;
  const socketDir=await mkdtemp(join(tmpdir(),'agy-bus-'));
  let proxy, socket=join(socketDir,'bus');
  const close=async()=>{if(proxy&&proxy.exitCode===null){proxy.kill('SIGTERM');await new Promise(resolve=>{const timer=setTimeout(()=>{proxy.kill('SIGKILL');resolve();},1500);proxy.once('close',()=>{clearTimeout(timer);resolve();});});}await rm(socketDir,{recursive:true,force:true});};
  try {
    if(auth){
      const address=process.env.DBUS_SESSION_BUS_ADDRESS;if(!address)throw new Error('No login session bus; AGY has no credential fallback');
      const helper=await executable(config.dbusProxy??'xdg-dbus-proxy');
      await rm(socket,{force:true});
      proxy=spawn(helper,[address,socket,'--filter','--talk=org.freedesktop.secrets'],{stdio:'ignore'});
      let failure;proxy.on('error',e=>{failure=e;});let ready=false;
      for(let i=0;i<100;i++){if(failure)throw failure;if(proxy.exitCode!==null)throw new Error('Secret Service proxy exited');try{await access(socket);ready=true;break;}catch{}await new Promise(r=>setTimeout(r,25));}
      if(!ready)throw new Error('Secret Service proxy did not become ready');
    }
    const flags=['--die-with-parent','--new-session','--unshare-pid','--unshare-ipc','--unshare-uts','--unshare-user','--cap-drop','ALL','--ro-bind','/usr','/usr'];
    for(const dir of ['/bin','/sbin','/lib','/lib64'])try{flags.push('--ro-bind',await realpath(dir),dir);}catch{}
    flags.push(...runtimeMounts(config.containerRuntime),'--tmpfs','/tmp','--ro-bind',work,'/work','--dir','/opt','--dir',runtime,'--ro-bind',binary,'/opt/agy','--bind',state,'/home/agent');
    if(auth)flags.push('--ro-bind',socket,runtime+'/bus');
    for(const path of ['/etc/resolv.conf','/etc/hosts','/etc/nsswitch.conf','/etc/ssl','/etc/pki'])try{await access(path);flags.push('--ro-bind',path,path);}catch{}
    const env={PATH:'/usr/bin:/bin',HOME:'/home/agent',LANG:'C.UTF-8',TERM:'dumb',USER:username,LOGNAME:username,XDG_RUNTIME_DIR:runtime,AGY_CLI_DISABLE_AUTO_UPDATE:'true'};
  for (const key of ['HTTP_PROXY','HTTPS_PROXY','http_proxy','https_proxy','NO_PROXY','no_proxy','NODE_USE_ENV_PROXY']) if (process.env[key]) env[key] = process.env[key];
    if(auth)env.DBUS_SESSION_BUS_ADDRESS='unix:path='+runtime+'/bus';
    flags.push('--chdir','/work','--','/opt/agy',...args);
    return {command:bwrap,args:flags,env,close};
  }catch(e){await close();throw e;}
}
async function invoke(config,root,args,options={}){
  const home=join(root,'agy-inspection',randomUUID());let inv;
  try{inv=await (options.launch??sandboxInvocation)(config,home,args,{auth:options.auth!==false});return await runProcess(inv.command,inv.args,{env:inv.env,input:'',signal:options.signal,timeoutMs:45000,maxBytes:2097152});}
  finally{await inv?.close?.();await rm(home,{recursive:true,force:true});}
}
export async function inspect(config,root,signal,options={}){
  const r=await invoke(config,root,['--version'],{...options,signal,auth:false});
  if(r.code!==0||r.reason||!r.stdout.trim())throw new Error('Isolated AGY could not start: '+(r.reason??r.stderr));
  const catalog=await invoke(config,root,['models'],{...options,signal});
  if(catalog.code!==0||catalog.reason)throw new Error('AGY models unavailable: '+(catalog.reason??catalog.stderr));
  return {provider:'agy',version:r.stdout.trim(),isolation:'linux-bubblewrap-secret-service-only',models:parseModels(catalog.stdout)};
}
export async function readQuota(config,root,{signal,launch}={}){
  const r=await invoke(config,root,['-p','/usage','--output-format','json'],{signal,launch});
  if(r.code!==0||r.reason)throw new Error('AGY quota unavailable: '+(r.reason??r.stderr));
  return parseQuota(JSON.parse(r.stdout),config);
}
export async function ask(config,root,request,{signal,onProgress,launch=sandboxInvocation}={}) {
  const home=join(root,'agy-conversations',request.conversationId);
  const args=['--agent','advisor','--model',request.model,'--disable-slash-commands','--print-timeout','0','--output-format','stream-json'];
  if(request.mode==='resume')args.push('--conversation',request.threadId);
  args.push('--print',request.packet);
  let inv,result,terminal,init,toolAttempt=false;
  try{
    inv=await launch(config,home,args);
    result=await runProcess(inv.command,inv.args,{env:inv.env,input:'',signal,timeoutMs:config.timeoutMs,maxBytes:16777216,
      onLine(line,_send,stop){
        const event=JSON.parse(line);
        if(event.event==='init'){init=event;onProgress?.('Advisor is reasoning.');}
        if(event.event==='step_update'&&event.step_update?.step_type==='tool'&&!isReadOnlyTaskList(event)){toolAttempt=true;stop('tool_attempt');}
        if(event.event==='result'){if(terminal)throw new Error('Duplicate native result');terminal=event.result;}
      }});
    const evidence=join(root,'agy-events');await mkdir(evidence,{recursive:true,mode:0o700});
    const artifact=join(evidence,`turn-${randomUUID()}`);
    await writeFile(artifact+'.events.jsonl',result.stdout,{mode:0o600});
    await writeFile(artifact+'.stderr.txt',result.stderr,{mode:0o600});
    let error;
    if(result.reason||result.code!==0||terminal?.status!=='SUCCESS')error=result.reason??terminal?.error??`AGY exit ${result.code}; no successful terminal result. ${result.stderr.slice(-1000)}`;
    if(toolAttempt)error='Advice-only contract: advisor attempted a tool.';
    if(!terminal?.conversation_id||init?.conversation_id!==terminal.conversation_id||init?.init?.model!==request.model)error??='AGY conversation/model identity was not verified.';
    if(request.mode==='resume'&&terminal?.conversation_id!==request.threadId)error='Resume returned a different conversation ID.';
    if(typeof terminal?.response!=='string')error??='AGY completed without a textual response.';
    // Preserve text from a settled native failure. Only transport identity and
    // terminal metadata determine whether it can be delivered or resumed.
    const identityVerified = !!terminal?.conversation_id && init?.conversation_id === terminal.conversation_id && init?.init?.model === request.model && (request.mode !== 'resume' || terminal.conversation_id === request.threadId);
    const usableTerminal = !result.reason && !toolAttempt && identityVerified && ['SUCCESS','ERROR'].includes(terminal?.status) && typeof terminal?.response === 'string';
    return {answer:usableTerminal?terminal.response:undefined,error,threadId:terminal?.conversation_id,
      partial:!!error&&usableTerminal,resumable:usableTerminal,
      nativeUsage:terminal?.usage??null,usage:null,nativeArtifact:artifact+'.events.jsonl',usageBasis:'agy-native-cumulative; cache/thinking inclusion unverified',
      completed:!!terminal,cancelled:result.reason==='cancelled',outcomeUnknown:!terminal&&result.reason!=='spawn_error',warnings:[]};
  }finally{await inv?.close?.();if(request.mode==='consult')await rm(home,{recursive:true,force:true});}
}
