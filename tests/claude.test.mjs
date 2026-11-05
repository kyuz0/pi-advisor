import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import * as claude from '../lib/advisor/claude.mjs';
import {AdvisorService,validateConfig,providerConfig,selectClaudeModel} from '../lib/advisor/service.mjs';
import {validateRequest} from '../lib/advisor/remote.mjs';
const config=validateConfig({provider:'claude'});
const usage={input_tokens:10,cache_read_input_tokens:20,cache_creation_input_tokens:5,output_tokens:7};
const nativeModel='claude-sonnet-test';
function launcher({mode='ok',text='  Advice Ω\n',session='conversation',rate}={}){
 return async (_c,_h,args)=>{
  if(args[0]==='auth')return {command:process.execPath,args:['-e',`console.log(JSON.stringify({loggedIn:true,authMethod:${JSON.stringify(mode==='api'?'apiKey':'claude.ai')}}))`],env:{}};
  assert.equal(args[args.indexOf('--tools')+1],'');assert.ok(args.includes('--safe-mode'));assert.ok(args.includes('--strict-mcp-config'));
  assert.equal(args[args.indexOf('--permission-mode')+1],'dontAsk');
  const rows=[{type:'system',subtype:'init',session_id:session,model:nativeModel,tools:mode==='exposed'?['Bash']:[],mcp_servers:[]}];
  if(mode==='tool')rows.push({type:'assistant',message:{model:nativeModel,content:[{type:'tool_use',name:'Bash'}]}});
  if(mode==='reroute')rows.push({type:'assistant',message:{model:'different',content:[]}});
  if(rate)rows.push({type:'rate_limit_event',rate_limit_info:rate});
  if(mode!=='missing')rows.push({type:'result',subtype:mode==='failure'?'error_during_execution':'success',session_id:session,result:text,usage,errors:['native failure']});
  return {command:process.execPath,args:['-e','process.stdin.resume();process.stdin.on("end",()=>process.stdout.write(process.argv[1]))',rows.map(x=>JSON.stringify(x)).join('\n')+'\n'],env:{}};
 };
}
test('Claude reply unchanged, normalized per-call usage and resolved model',async t=>{
 const root=await mkdtemp(join(tmpdir(),'claude-test-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const r=await claude.ask(config,root,{mode:'start',conversationId:'conversation',model:'sonnet',effort:'medium',packet:'question'},{launch:launcher()});
 assert.equal(r.error,undefined);assert.equal(r.answer,'  Advice Ω\n');assert.equal(r.resolvedModel,nativeModel);
 assert.deepEqual(r.usage,{input_tokens:35,cached_input_tokens:20,cache_write_input_tokens:5,output_tokens:7});
});
test('Claude rejects tools, rerouting, missing completion, API login and changed resume identity',async t=>{
 const root=await mkdtemp(join(tmpdir(),'claude-test-'));t.after(()=>rm(root,{recursive:true,force:true}));
 for(const mode of ['tool','exposed','reroute','missing','api','failure']){
  const r=await claude.ask(config,root,{mode:'consult',conversationId:'test',model:'sonnet',effort:'medium',packet:'question'},{launch:launcher({mode})});
  assert.ok(r.error,mode);assert.equal(r.answer,undefined);
 }
 const r=await claude.ask(config,root,{mode:'resume',conversationId:'test',threadId:'other',resolvedModel:nativeModel,model:'sonnet',effort:'medium',packet:'question'},{launch:launcher()});
 assert.match(r.error,/resume/);
});
test('Claude refreshes native quota without inference and applies shared/scoped windows',async t=>{
 const root=await mkdtemp(join(tmpdir(),'claude-test-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const report={rate_limits:{limits:[{kind:'session',percent:10,resets_at:'2099-01-01T00:00:00Z',scope:null},
  {kind:'weekly_all',percent:30,resets_at:'2099-01-01T00:00:00Z',scope:null},
  {kind:'weekly_scoped',percent:95,resets_at:'2099-01-01T00:00:00Z',scope:{model:{display_name:'Sonnet'}}}]}};
 const launch=async (_c,_h,args)=>{
  assert.equal(args.at(-1),'/usage');assert.ok(args.includes('--no-session-persistence'));
  const events=[{type:'assistant',local_command_source:'native',local_command_run:{command:'usage'},usage_report:report},
   {type:'result',subtype:'success',local_command:'usage',num_turns:0}];
  return {command:process.execPath,args:['-e','process.stdout.write(process.argv[1])',events.map(e=>JSON.stringify(e)).join('\n')+'\n'],env:{}};
 };
 const quota=await claude.readQuota(config,root,{launch});assert.equal(quota.source,'claude-usage');
 assert.throws(()=>selectClaudeModel({},config,{runs:[]},quota),/reserve/);
 assert.equal(selectClaudeModel({model:'haiku'},config,{runs:[]},quota).quotaState,'known');
 assert.equal(quota.buckets.find(b=>b.model==='opus').windows.length,2);
 assert.equal(claude.parseQuota({},config).state,'unknown');
 assert.equal(claude.parseQuota({rate_limits:{limits:[{kind:'session',percent:101,resets_at:'bad'}]}},config).state,'unknown');
 const r=await claude.ask(config,root,{mode:'consult',conversationId:'test',model:'sonnet',effort:'medium',packet:'question'},{launch:launcher({rate:{status:'allowed_warning',utilization:.9,resetsAt:Math.floor(Date.now()/1000)+3600}})});
 assert.match(r.warnings[0],/allowed_warning/);
});
test('Claude service resumes the resolved model and counts each call once across restart',async t=>{
 const root=await mkdtemp(join(tmpdir(),'claude-service-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(join(root,'advisor.json'),JSON.stringify({provider:'claude'}));
 const ctx={cwd:root,sessionId:'test',runIds:[]};let count=0;
 const adapter={inspect:async()=>({version:'fixture'}),readQuota:async()=>({state:'unknown',buckets:[]}),ask:async(_c,_r,request)=>{
  if(count++)assert.equal(request.resolvedModel,nativeModel);
  return {answer:'advice',threadId:'session',resolvedModel:nativeModel,completed:true,usage:claude.normalizeUsage(usage)};
 }};
 let service=new AdvisorService(root);service.adapters.claude=adapter;
 const first=await service.ask(ctx,{mode:'start',question:'first'});ctx.runIds.push(first.runId);
 service=new AdvisorService(root);service.adapters.claude=adapter;
 const next=await service.ask(ctx,{mode:'resume',advisorRef:first.advisorRef,question:'next'});
 assert.equal(next.usage.input_tokens,35);assert.equal(next.sessionUsage.totalTokens,84);assert.equal(next.resumable,true);
 assert.throws(()=>selectClaudeModel({tier:'maximum'},config,{runs:[]},{state:'unknown'}),/reason/);
 assert.equal(selectClaudeModel({model:'haiku'},config,{runs:[]},{state:'unknown'}).model,'haiku');
 assert.throws(()=>validateConfig({provider:'claude',billingMode:'api'}),/subscription/);
 assert.equal(providerConfig(validateConfig({provider:'codex',providers:{codex:{},claude:{}}}),'claude').executable,'claude');
 assert.equal(validateRequest({method:'ask',context:ctx,params:{provider:'claude',mode:'consult',question:'x'}}).params.provider,'claude');
});
test('Claude invocation exposes only private state, clears API keys and disables updates',async t=>{
 const root=await mkdtemp(join(tmpdir(),'claude-isolation-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const home=join(root,'home');await mkdir(home);await writeFile(join(home,'.credentials.json'),'synthetic');
 const inv=await claude.sandboxInvocation({...config,executable:'/bin/true',bubblewrap:'/bin/true',claudeHome:home},join(root,'state'),['--version']);
 assert.ok(inv.args.includes(join(home,'.credentials.json')));assert.ok(!inv.args.includes(home));
 assert.equal(inv.env.ANTHROPIC_API_KEY,undefined);assert.equal(inv.env.CLAUDE_CONFIG_DIR,'/state');
 assert.ok(inv.args.includes('--cap-drop'));assert.equal(inv.env.DISABLE_AUTOUPDATER,'1');assert.equal(inv.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC,undefined);
});
