import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { usageDelta, costEstimate, summarize } from '../lib/advisor/accounting.mjs';
import { AdvisorService, defaults, selectModel, quotaForModel, validateConfig } from '../lib/advisor/service.mjs';
import { ask, inspect, readQuota } from '../lib/advisor/codex.mjs';
import { runProcess } from '../lib/advisor/process.mjs';
import { Store } from '../lib/advisor/store.mjs';
const fixture = fileURLToPath(new URL('./fake-cli.mjs',import.meta.url));
const total=(input,output,cached=0)=>({input_tokens:input,output_tokens:output,cached_input_tokens:cached,cache_write_input_tokens:0,reasoning_output_tokens:0});
const answer='Next check.';
const healthy=(remaining=80)=>({state:'known',observedAt:Date.now(),buckets:[{id:'codex',model:null,windows:[{remainingPercent:remaining,resetsAt:Date.now()+3600000}]}]});
async function setup(adapterChanges={}){
 const root=await mkdtemp(join(tmpdir(),'advisor-test-'));let n=0;
 const adapter={inspect:async()=>({version:'fixture'}),readQuota:async()=>healthy(),ask:async()=>({answer,threadId:'owned-thread',usage:total(++n*100,n*20),completed:true}),...adapterChanges};
 const service=new AdvisorService(root,adapter),context={cwd:root,sessionId:'pi-session-A',runIds:[]};
 return {root,adapter,service,context,close:()=>rm(root,{recursive:true,force:true})};
}
test('cumulative deltas avoid double counting; missing/regressed telemetry stays unknown',()=>{
 assert.deepEqual(usageDelta(total(250,60,100),total(100,20,0)),total(150,40,100));
 assert.equal(usageDelta(null),null);assert.equal(usageDelta(total(0,0)),null);assert.equal(usageDelta(total(5,2),total(10,3)),null);
 assert.equal(usageDelta({...total(10,2),reasoning_output_tokens:3}),null);
});
test('cost is null for subscription; explicit dated API rates price input/cache/output once',()=>{
 const rates={input:2,cachedInput:0.2,output:10,source:'synthetic rates',asOf:'2026-10-01'};
 const u={...total(1000000,100000,400000),reasoning_output_tokens:50000};
 assert.equal(costEstimate(u,'model',{billingMode:'subscription'}).usd,null);
 assert.equal(costEstimate(u,'model',{billingMode:'api',pricing:{model:rates}}).usd,2.28);
 assert.equal(costEstimate(u,'model',{billingMode:'api',pricing:{}}).usd,null);
 assert.equal(costEstimate(u,'model',{billingMode:'api',pricing:{model:rates}},true).usd,null);
});
test('session ledger persists across service restart; resume usage is delta and branch refs are checked',async()=>{
 const s=await setup();try{
  const a=await s.service.ask(s.context,{mode:'start',context:'evidence',question:'check?'});s.context.runIds.push(a.runId);
  const restarted=new AdvisorService(s.root,s.adapter);
  const b=await restarted.ask(s.context,{mode:'resume',advisorRef:a.advisorRef,context:'new evidence',question:'now?'});
  assert.equal(b.usage.input_tokens,100);assert.equal(b.sessionUsage.totalTokens,240);assert.equal(b.sessionUsage.calls,2);
  await assert.rejects(restarted.ask({...s.context,runIds:[]},{mode:'resume',advisorRef:a.advisorRef,context:'x',question:'x'}),/branch/);
  await assert.rejects(restarted.ask({...s.context,sessionId:'other'},{mode:'resume',advisorRef:a.advisorRef,context:'x',question:'x'}),/branch/);
  const state=await restarted.state(s.context);assert.equal(state.runs.length,2);assert.equal(state.runs[1].cost.usd,null);
  assert.ok(!JSON.stringify(state).includes('new evidence'));
 }finally{await s.close();}
});
test('failed/unknown/cancelled turns remain counted; unknown outcome requires explicit acknowledgement',async()=>{
 const s=await setup({ask:async()=>({error:'connection lost',outcomeUnknown:true})});try{
  const a=await s.service.ask(s.context,{mode:'consult',context:'x',question:'x'});assert.equal(a.outcome,'unknown_outcome');assert.equal(a.sessionUsage.unknownUsageCalls,1);
  await assert.rejects(s.service.ask(s.context,{mode:'consult',context:'x',question:'x'}),/unknown/);
  await s.service.acknowledge(s.context,a.runId);assert.equal((await s.service.state(s.context)).runs[0].status,'acknowledged_unknown');
 }finally{await s.close();}
});
test('preflight oversized packets and incompatible providers never launch a call',async()=>{
 const s=await setup();try{
  await assert.rejects(s.service.ask(s.context,{mode:'consult',context:'x'.repeat(50000),question:'x'}),/limit/);
  assert.equal((await s.service.state(s.context)).runs.length,0);
  assert.throws(()=>validateConfig({provider:'unsupported'}),/not installed/);
 }finally{await s.close();}
});
test('concurrent operations cannot bypass budgets or resume twice',async()=>{
 let release,started;const ready=new Promise(r=>started=r);
 const s=await setup({ask:()=>new Promise(r=>{release=r;started();})});try{
  const a=s.service.ask(s.context,{mode:'consult',context:'x',question:'x'});await ready;
  await assert.rejects(s.service.ask(s.context,{mode:'consult',context:'x',question:'x'}),/running/);
  release({answer,usage:total(10,2),threadId:'t',completed:true});await a;
 }finally{await s.close();}
});
test('model policy handles healthy, low, unknown, stale/reset and shared exhausted quotas',()=>{
 const state={sessionId:'x',runs:[]};
 assert.equal(selectModel({},defaults,state,healthy()).model,'gpt-6.1-sol');
 assert.throws(()=>selectModel({},defaults,state,{state:'unknown',ordinaryUsageAllowed:false}),/not allowed/);
 assert.equal(selectModel({tier:'maximum',reason:'difficult review'},defaults,state,healthy()).model,'gpt-6-astra');
 assert.throws(()=>selectModel({tier:'maximum',reason:'x'},defaults,state,{state:'unknown'}),/unknown/);
 assert.throws(()=>selectModel({},defaults,state,healthy(15)),/reserve/);
 assert.throws(()=>selectModel({tier:'emergency',reason:'needed'},{...defaults,allowEmergencyLuna:true},state,healthy(0)),/requires/);
 assert.equal(selectModel({tier:'emergency',reason:'needed'},{...defaults,allowEmergencyLuna:true},state,healthy(8)).model,'gpt-6-luna');
 const past=healthy();past.buckets[0].windows[0].resetsAt=Date.now()-1;assert.equal(quotaForModel(past,'gpt-6.1-sol').state,'unknown');
 const stale=healthy();stale.observedAt-=120000;assert.equal(quotaForModel(stale,'gpt-6.1-sol').state,'unknown');
 const multi=healthy();multi.buckets[0].windows.push({remainingPercent:2,resetsAt:Date.now()+86400000});assert.equal(quotaForModel(multi,'gpt-6.1-sol').remaining,2);
});
const childEnv={...process.env}; delete childEnv.NODE_TEST_CONTEXT;
const launch=mode=>async()=>({command:process.execPath,args:[fixture,mode],env:childEnv});
for (const mode of ['valid','bad-answer','no-terminal','no-message','nonzero','tool']) test(`CLI event contract: ${mode}`,async()=>{
 const root=await mkdtemp(join(tmpdir(),'advisor-parser-'));try{
  const r=await ask(defaults,root,{mode:'consult',conversationId:'fixture',model:'gpt-6.1-sol',effort:'medium',packet:'x'},{launch:launch(mode)});
  if(['valid','bad-answer'].includes(mode)){assert.equal(r.answer,mode==='valid'?'Use the numeric comparator. café':'not json');assert.equal(r.warnings.length,1);assert.equal(r.usage.input_tokens,100);}
  else assert.ok(r.error);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('quota reader only performs initialization/account/quota RPCs and removes identity data',async()=>{
 const root=await mkdtemp(join(tmpdir(),'advisor-quota-'));try{
  const q=await readQuota(defaults,root,{launch:launch('quota')});assert.equal(q.state,'known');assert.equal(q.buckets[0].windows[0].remainingPercent,88);assert.ok(!JSON.stringify(q).includes('email'));
 }finally{await rm(root,{recursive:true,force:true});}
});
test('subprocess cancellation and output bounds return partial records',async()=>{
 const controller=new AbortController();const p=runProcess(process.execPath,[fixture,'hang'],{env:childEnv,input:'x',signal:controller.signal,onLine:()=>controller.abort()});
 assert.equal((await p).reason,'cancelled');
 const r=await runProcess(process.execPath,[fixture,'oversize'],{env:childEnv,input:'x',maxBytes:1000});assert.equal(r.reason,'output_limit');
});

test('Pi tools persist compact references and rebuild advisor context without an inference call',async()=>{
 const {registerAdvisor}=await import('../lib/advisor/pi.mjs');
 const s=await setup();try{
  const tools=new Map(),events=new Map(),entries=[],messages=[];
  const Type={Object:x=>x,Optional:x=>x,String:()=>({type:'string'}),Integer:()=>({type:'integer'}),Boolean:()=>({type:'boolean'}),Literal:x=>x,Union:x=>x};
  const pi={registerTool:t=>tools.set(t.name,t),registerCommand:()=>{},on:(k,f)=>events.set(k,f),appendEntry:(customType,data)=>entries.push({type:'custom',customType,data}),sendMessage:m=>messages.push(m),getActiveTools:()=>[...tools.keys()]};
  const ctx={cwd:s.root,sessionManager:{getSessionId:()=>s.context.sessionId,getBranch:()=>entries},ui:{setStatus:()=>{},notify:()=>{}}};
  registerAdvisor(pi,{getAgentDir:()=>s.root,Type,service:s.service});
  const first=await tools.get('advisor_ask').execute('tool-1',{mode:'start',context:'evidence',question:'check'},undefined,undefined,ctx);
  assert.ok(first.details.advisorRef);assert.equal(first.content[0].text,answer);assert.equal(entries.length,1);
  const compacted={systemPromptOptions:{sections:{}}};await events.get('before_agent_start')(compacted,ctx);
  assert.equal(JSON.parse(compacted.systemPromptOptions.sections.advisor_state).advisors[0].advisorRef,first.details.advisorRef);
  const status=await tools.get('advisor_status').execute('tool-2',{refreshQuota:false},undefined,undefined,ctx);assert.equal(status.details.usage.calls,1);
  // A branch before the advisor result has no permission to resume that future thread.
  entries.length=0;
  const resumed=await tools.get('advisor_ask').execute('tool-3',{mode:'resume',advisorRef:first.details.advisorRef,context:'evidence',question:'check'},undefined,undefined,ctx);
  assert.equal(resumed.isError,true);assert.match(resumed.details.error,/branch/);
 }finally{await s.close();}
});

test('pre-aborted consultation spends no call and invalid rates never create a cost',async()=>{
 const s=await setup();try{
  const controller=new AbortController();controller.abort();
  await assert.rejects(s.service.ask(s.context,{mode:'consult',context:'x',question:'x'},{signal:controller.signal}),/cancelled/);
  assert.equal((await s.service.state(s.context)).runs.length,0);
  assert.equal(costEstimate(total(100,20),'x',{billingMode:'api',pricing:{x:{input:1,cachedInput:0,output:2}}}).usd,null);
 }finally{await s.close();}
});

for (const version of ['codex-cli 0.160.0', 'codex-cli 9.0.0-preview']) test(`inspection records ${version} without a release restriction`,async()=>{
 const root=await mkdtemp(join(tmpdir(),'advisor-inspect-'));try{
  const launch=async()=>({command:process.execPath,args:['-e','process.stdout.write(process.argv[1])',version],env:childEnv});
  const result=await inspect(defaults,root,undefined,{launch});
  assert.equal(result.version,version);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('inspection rejects an executable that cannot start',async()=>{
 const root=await mkdtemp(join(tmpdir(),'advisor-inspect-'));try{
  const launch=async()=>({command:process.execPath,args:['-e','process.exit(1)'],env:childEnv});
  await assert.rejects(inspect(defaults,root,undefined,{launch}),/could not start/);
 }finally{await rm(root,{recursive:true,force:true});}
});

// Replies intentionally have no application-level protocol. These exercise the actual
// event decoder, service ledger and Pi tool boundary, rather than a standalone parser.
const unrestrictedReplies = [
 ['prose', '  Try a numeric comparator. café — 日本語\n\nThen check the output.  \n'],
 ['markdown/code', '# Review\n```js\nconst ordered = items.sort((a, b) => a - b);\n```\n- Recheck ties.\n'],
 ['caller-chosen JSON', '{"whatever":[1,2],"status":"my-own-label"}'],
 ['incomplete JSON-looking text', '{not valid JSON\nBut valid advice.'],
 ['long review', Array.from({length:30},(_,i)=>`${i+1}. ${'Detailed advice. '.repeat(60)}`).join('\n')],
 ['empty native message', ''],
];
for (const [name, reply] of unrestrictedReplies) test(`opaque reply reaches Pi unchanged: ${name}`,async()=>{
 const s=await setup();try{
  let launches=0;
  s.adapter.ask=async(config,root,request,options)=>ask(config,root,request,{...options,launch:async(_config,_home,args)=>{
   launches++;assert.equal(args.includes('--output-schema'),false);assert.ok(args.includes('--json'));
   return {command:process.execPath,args:[fixture,'valid',reply],env:childEnv};
  }});
  const {registerAdvisor}=await import('../lib/advisor/pi.mjs');
  const tools=new Map(),entries=[];
  const Type={Object:x=>x,Optional:x=>x,String:()=>({type:'string'}),Boolean:()=>({type:'boolean'}),Literal:x=>x,Union:x=>x};
  const pi={registerTool:t=>tools.set(t.name,t),registerCommand:()=>{},on:()=>{},appendEntry:(customType,data)=>entries.push({type:'custom',customType,data})};
  const ctx={cwd:s.root,sessionManager:{getSessionId:()=>s.context.sessionId,getBranch:()=>entries},ui:{setStatus:()=>{}}};
  registerAdvisor(pi,{getAgentDir:()=>s.root,Type,service:s.service});
  const first=await tools.get('advisor_ask').execute('first',{mode:'start',question:'Help in whatever form is useful.'},undefined,undefined,ctx);
  assert.equal(first.isError,undefined);assert.equal(first.details.outcome,'completed');
  assert.equal(first.content[0].text,reply);assert.ok(first.content[1].text.includes(first.details.advisorRef));assert.equal(first.details.answer,reply);assert.equal(first.details.usage.input_tokens,100);
  const restarted=new AdvisorService(s.root,s.adapter);
  const second=await restarted.ask({...s.context,runIds:entries.map(e=>e.data.runId)},{mode:'resume',advisorRef:first.details.advisorRef,question:'Review the result.'});
  assert.equal(second.answer,reply);assert.equal(second.outcome,'completed');assert.equal(launches,2);
  assert.equal((await restarted.state(s.context)).advisors[first.details.advisorRef].summary,reply.slice(0,2000));
 }finally{await s.close();}
});
test('caller text is transmitted directly without a serialized communication contract',async()=>{
 let packet;
 const s=await setup({ask:async(_config,_root,request)=>{packet=request.packet;return {answer,threadId:'t',usage:total(100,20),completed:true};}});
 try{
  await s.service.ask(s.context,{mode:'consult',context:'Evidence: café\n```text\n1,10,2\n```',question:'Discuss freely. A long answer is fine.'});
  assert.equal(packet,'Evidence: café\n```text\n1,10,2\n```\n\nDiscuss freely. A long answer is fine.');
  await s.service.ask(s.context,{mode:'consult',question:'Just this request.'});assert.equal(packet,'Just this request.');
 }finally{await s.close();}
});
test('users can disable local call/token caps explicitly; provider quota policy remains separate',()=>{
 const config=validateConfig({maxCallsPerSession:null,unknownQuotaCallsPerSession:null,maxTokensPerSession:null,maxAstraCallsPerSession:null});
 const state={runs:Array.from({length:40},(_,i)=>({id:String(i),model:'gpt-6-astra',usage:total(100000,10000)}))};
 assert.equal(selectModel({},config,state,{state:'unknown'}).model,'gpt-6.1-sol');
 assert.equal(selectModel({tier:'maximum',reason:'Review'},config,state,healthy()).model,'gpt-6-astra');
 assert.throws(()=>selectModel({},config,state,healthy(0)),/reserve/);
 assert.throws(()=>validateConfig({maxCallsPerSession:0}),/positive integer or null/);
});

test("default configuration imposes no call or token cap",()=>{
 const state={runs:Array.from({length:40},(_,i)=>({id:String(i),model:"gpt-6-astra",usage:total(100000,10000)}))};
 assert.equal(selectModel({},defaults,state,healthy()).model,"gpt-6.1-sol");
 assert.equal(selectModel({tier:"maximum",reason:"Unresolved implementation question"},defaults,state,healthy()).model,"gpt-6-astra");
 assert.equal(selectModel({},defaults,state,{state:"unknown"}).model,"gpt-6.1-sol");
 assert.throws(()=>selectModel({},defaults,state,healthy(0)),/reserve/);
});
