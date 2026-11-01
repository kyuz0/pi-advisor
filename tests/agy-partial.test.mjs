import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import * as agy from '../lib/advisor/agy.mjs';
import {AdvisorService,validateConfig} from '../lib/advisor/service.mjs';
import {registerAdvisor} from '../lib/advisor/pi.mjs';
const model={id:'gemini-3.8-flash-high',effort:'high',quotaGroup:'Gemini Models'};
const config=validateConfig({provider:'agy',models:{default:model},reservePercent:0});
const usage=n=>({input_tokens:100*n,output_tokens:20*n,thinking_tokens:9*n,cache_read_tokens:50*n,total_tokens:120*n});
const reply='  {unfinished JSON-looking advice\n```coq\n'+ 'Opaque text Ω. '.repeat(900);
function launch({status='ERROR',text=reply,counters=usage(1),modelId=model.id,id='native-thread',tool=false}={}){
 return async()=>{
  const events=[{event:'init',conversation_id:id,init:{model:modelId}}];
  if(tool)events.push({event:'step_update',step_update:{step_type:'tool',tool_name:'run_command'}});
  events.push({event:'result',result:{conversation_id:id,status,response:text,error:status==='ERROR'?'The stream was interrupted.':undefined,usage:counters}});
  return {command:process.execPath,args:['-e','process.stdout.write(process.argv[1])',events.map(x=>JSON.stringify(x)).join('\n')+'\n'],env:{PATH:process.env.PATH}};
 };
}
async function setup(options={}){
 const root=await mkdtemp(join(tmpdir(),'agy-partial-'));
 await writeFile(join(root,'advisor.json'),JSON.stringify({provider:'agy',models:{default:model},reservePercent:0}));
 const service=new AdvisorService(root);let calls=0;
 service.adapters.agy={inspect:async()=>({version:'fixture',models:[model]}),readQuota:async()=>({state:'known',observedAt:Date.now(),buckets:[{id:'Gemini Models',model:model.id,windows:[{remainingPercent:90,resetsAt:Date.now()+60000}]}]}),ask:async(c,r,request,o)=>{
  const first=++calls===1;
  if(!first)assert.equal(request.threadId,'native-thread');
  return agy.ask(c,r,request,{...o,launch:launch(first?options:{status:'SUCCESS',text:'Continued advice.',counters:usage(3)})});
 }};
 return {root,service,ctx:{cwd:root,sessionId:'one',runIds:[]},calls:()=>calls,close:()=>rm(root,{recursive:true,force:true})};
}
test('settled native failure forwards opaque partial text with error and usage intact',async()=>{
 const root=await mkdtemp(join(tmpdir(),'agy-partial-'));try{
 const result=await agy.ask(config,root,{mode:'start',conversationId:'test',model:model.id,packet:'Question'},{launch:launch()});
 assert.equal(result.answer,reply);assert.equal(result.error,'The stream was interrupted.');assert.equal(result.partial,true);assert.equal(result.resumable,true);assert.deepEqual(result.nativeUsage,usage(1));
 }finally{await rm(root,{recursive:true,force:true});}
});
test('identity mismatch and tool attempt withhold partial text and continuation',async()=>{
 const root=await mkdtemp(join(tmpdir(),'agy-partial-'));try{
 for(const options of [{modelId:'wrong'},{id:'wrong-thread'},{tool:true}]){
  const result=await agy.ask(config,root,{mode:'resume',conversationId:'test',threadId:'native-thread',model:model.id,packet:'Question'},{launch:launch(options)});
  assert.ok(result.error);assert.equal(result.answer,undefined);assert.equal(result.resumable,false);
 }
 }finally{await rm(root,{recursive:true,force:true});}
});
test('failed native turn remains failed, resumes after service restart, and is charged exactly once',async()=>{
 const s=await setup();try{
 const first=await s.service.ask(s.ctx,{mode:'start',question:'Plan?'});assert.equal(first.outcome,'failed');assert.equal(first.partial,true);assert.equal(first.resumable,true);assert.equal(s.calls(),1);s.ctx.runIds.push(first.runId);
 const restarted=new AdvisorService(s.root);restarted.adapters.agy=s.service.adapters.agy;
 await assert.rejects(restarted.ask({...s.ctx,runIds:[]},{mode:'resume',advisorRef:first.advisorRef,question:'Continue'}),/branch/);
 const second=await restarted.ask(s.ctx,{mode:'resume',advisorRef:first.advisorRef,question:'Continue'});
 assert.equal(second.outcome,'completed');assert.equal(second.advisorRef,first.advisorRef);assert.deepEqual(second.nativeUsage,usage(2));assert.equal(second.sessionUsage.nativeByModel['agy/'+model.id].total_tokens,usage(3).total_tokens);
 const state=await restarted.state(s.ctx);assert.deepEqual(state.runs.map(x=>x.status),['failed','completed']);assert.equal(state.runs[0].partial,true);assert.equal(s.calls(),2);
 }finally{await s.close();}
});
test('partial reply reaches Pi unchanged alongside explicit error and resumable reference',async()=>{
 const s=await setup();try{
 const tools=new Map(),entries=[];const Type={Object:x=>x,Optional:x=>x,String:()=>({}),Boolean:()=>({}),Literal:x=>x,Union:x=>x};
 const pi={registerTool:t=>tools.set(t.name,t),registerCommand:()=>{},on:()=>{},appendEntry:(customType,data)=>entries.push({type:'custom',customType,data})};
 registerAdvisor(pi,{getAgentDir:()=>s.root,Type,service:s.service});
 const ctx={cwd:s.root,sessionManager:{getSessionId:()=>s.ctx.sessionId,getBranch:()=>entries},ui:{setStatus:()=>{}}};
 const result=await tools.get('advisor_ask').execute('one',{mode:'start',question:'Plan?'},undefined,undefined,ctx);
 assert.equal(result.isError,true);assert.equal(result.content[0].text,reply);assert.match(result.content[1].text,/failed.*stream was interrupted/);assert.ok(result.content[2].text.includes(result.details.advisorRef));assert.equal(result.details.outcome,'failed');assert.equal(entries.length,1);
 }finally{await s.close();}
});
test('missing native accounting preserves partial text but cannot create a resumable reference',async()=>{
 const s=await setup({counters:null});try{
 const first=await s.service.ask(s.ctx,{mode:'start',question:'Plan?'});s.ctx.runIds.push(first.runId);
 assert.equal(first.answer,reply);assert.equal(first.nativeUsage,null);assert.equal(first.resumable,false);
 await assert.rejects(s.service.ask(s.ctx,{mode:'resume',advisorRef:first.advisorRef,question:'Continue'}),/absent, expired/);
 assert.equal(s.calls(),1);
 }finally{await s.close();}
});
