import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import * as agy from '../lib/advisor/agy.mjs';
import {AdvisorService,validateConfig,providerConfig} from '../lib/advisor/service.mjs';
const model={id:'gemini-3.8-flash-high',effort:'high',quotaGroup:'Gemini Models'};
const config=validateConfig({provider:'agy',models:{default:model},reservePercent:0});
const usage=n=>({input_tokens:100*n,output_tokens:20*n,thinking_tokens:9*n,cache_read_tokens:50*n,total_tokens:120*n});
function launcher(response,{mode='ok',id='native-thread',modelId=model.id,tokenUsage=usage(1)}={}){
 return async (_config,_home,args)=>{
  assert.ok(!args.includes('--json-schema'));
  const rows=[{event:'init',conversation_id:id,init:{model:modelId}},{event:'result',result:{conversation_id:id,status:mode==='failed'?'ERROR':'SUCCESS',error:mode==='failed'?'provider error':undefined,response,usage:tokenUsage}}];
  if(mode==='task_list')rows.splice(1,0,{event:'step_update',step_update:{step_type:'tool',tool_name:'manage_task',tool_info:{name:'manage_task',parameters:{Action:'list'}}}});
  if(mode==='tool')rows.splice(1,0,{event:'step_update',step_update:{step_type:'tool',tool_name:'run_command'}});
  const text=rows.map(e=>JSON.stringify(e)).join('\n')+'\n';
  return {command:process.execPath,args:['-e','process.stdout.write(process.argv[1])',text],env:{PATH:process.env.PATH}};
 };
}
for(const reply of [' plain prose\n','```coq\nA.\n```','{malformed JSON','', 'Ω'.repeat(20000)])test('AGY forwards opaque reply unchanged '+reply.slice(0,10),async()=>{
 const root=await mkdtemp(join(tmpdir(),'agy-test-'));try{
 const r=await agy.ask(config,root,{mode:'consult',conversationId:'test',model:model.id,packet:'Question'},{launch:launcher(reply)});
 assert.equal(r.answer,reply);assert.equal(r.error,undefined);assert.deepEqual(r.nativeUsage,usage(1));assert.equal(r.usage,null);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('native identity mismatch and tools reject advice without interpreting text',async()=>{
 const root=await mkdtemp(join(tmpdir(),'agy-test-'));try{
 for(const options of [{mode:'tool'},{id:'different'},{modelId:'wrong'}]){
 const r=await agy.ask(config,root,{mode:'resume',conversationId:'test',threadId:'native-thread',model:model.id,packet:'Question'},{launch:launcher('arbitrary',options)});assert.ok(r.error);assert.equal(r.answer,undefined);
 }
 }finally{await rm(root,{recursive:true,force:true});}
});
test('AGY cumulative counters charge each turn once without assuming cache inclusion',()=>{
 assert.deepEqual(agy.nativeUsageDelta(usage(3),usage(1)),usage(2));assert.equal(agy.nativeUsageDelta(usage(1),usage(2)),null);assert.equal(agy.nativeUsageDelta({input_tokens:5}),null);
});
test('model inventory and shared quota use native metadata',()=>{
 assert.equal(agy.parseModels(model.id+'\tFlash High\n')[0].id,model.id);
 assert.throws(()=>agy.parseModels('bad'),/catalog/);
 const q=agy.parseQuota({status:'SUCCESS',command:{name:'usage',data:{groups:[{name:'Gemini Models',buckets:[{window:'weekly',remaining_fraction:.8,reset_time:'2099-01-01T00:00:00Z'}]}]}}},config);
 assert.equal(q.buckets[0].windows[0].remainingPercent,80);assert.equal(q.buckets[0].model,model.id);
 assert.throws(()=>agy.parseQuota({response:'100% quota'},config),/native/);
});
test('enabled-provider selection, native resume persistence, switching denied, unavailable provider status isolated',async()=>{
 const root=await mkdtemp(join(tmpdir(),'agy-service-'));try{
 await writeFile(join(root,'advisor.json'),JSON.stringify({provider:'agy',providers:{agy:{models:{default:model}},codex:{enabled:false}}}));
 const service=new AdvisorService(root);let n=0;
 service.adapters.agy={inspect:async()=>({version:'fixture',models:[model]}),readQuota:async()=>({state:'known',observedAt:Date.now(),buckets:[{id:'Gemini Models',model:model.id,windows:[{remainingPercent:90,resetsAt:Date.now()+100000}]}]}),ask:async()=>({answer:' {plain advice',threadId:'native-thread',nativeUsage:usage(++n),usage:null,completed:true})};
 const ctx={cwd:root,sessionId:'one',runIds:[]};
 const first=await service.ask(ctx,{mode:'start',question:'Plan?'});assert.equal(first.outcome,'completed');assert.equal(first.provider,'agy');ctx.runIds.push(first.runId);
 const second=await service.ask(ctx,{mode:'resume',advisorRef:first.advisorRef,question:'Review?'});assert.deepEqual(second.nativeUsage,usage(1));assert.equal(second.sessionUsage.nativeByModel['agy/'+model.id].total_tokens,240);ctx.runIds.push(second.runId);
 await assert.rejects(service.ask(ctx,{mode:'resume',advisorRef:first.advisorRef,provider:'codex',question:'x'}),/Changing provider/);
 await assert.rejects(service.ask(ctx,{mode:'start',provider:'codex',question:'x'}),/not enabled/);
 await assert.rejects(service.ask(ctx,{mode:'start',effort:'low',question:'x'}),/conflicts/);
 assert.equal((await service.status(ctx)).providers[0].provider,'agy');
 }finally{await rm(root,{recursive:true,force:true});}
});
test('legacy Codex configuration remains enabled alone',()=>{
 const c=validateConfig({});assert.equal(providerConfig(c).provider,'codex');assert.throws(()=>providerConfig(c,'agy'),/not enabled/);
});

test('disabled provider needs no account, executable or model setup',()=>{
 const c=validateConfig({provider:'codex',providers:{codex:{enabled:true},agy:{enabled:false}}});
 assert.equal(providerConfig(c).provider,'codex');assert.throws(()=>providerConfig(c,'agy'),/not enabled/);
});

test('private task listing does not discard a valid free-form reply or usage',async()=>{
 const root=await mkdtemp(join(tmpdir(),'agy-test-'));try{
 const r=await agy.ask(config,root,{mode:'start',conversationId:'test',model:model.id,packet:'Question'},{launch:launcher('Unchanged advice',{mode:'task_list'})});
 assert.equal(r.error,undefined);assert.equal(r.answer,'Unchanged advice');assert.deepEqual(r.nativeUsage,usage(1));
 }finally{await rm(root,{recursive:true,force:true});}
});
test('task-list exception does not permit mutation, task identifiers or unrelated tools',()=>{
 const event={step_update:{step_type:'tool',tool_name:'manage_task',tool_info:{name:'manage_task',parameters:{Action:'list'}}}};
 assert.equal(agy.isReadOnlyTaskList(event),true);
 for(const parameters of [{Action:'kill'},{Action:'send_input',Input:'x'},{Action:'list',TaskId:'outside'},{Action:'status'}])assert.equal(agy.isReadOnlyTaskList({step_update:{...event.step_update,tool_info:{name:'manage_task',parameters}}}),false);
 assert.equal(agy.isReadOnlyTaskList({step_update:{...event.step_update,tool_name:'run_command'}}),false);
});
