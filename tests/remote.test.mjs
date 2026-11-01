import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,stat,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RemoteAdvisorService,serveAdvisor,validateRequest} from '../lib/advisor/remote.mjs';
import {AdvisorService} from '../lib/advisor/service.mjs';
const context={sessionId:'session-1',runIds:[],cwd:'/not/shared'};
async function setup(t, service) {
  const root=await mkdtemp(join(tmpdir(),'advisor-rpc-'));
  const path=join(root,'advisor.sock');
  const server=await serveAdvisor(path,service);
  t.after(async()=>{await server.stop();await rm(root,{recursive:true,force:true});});
  return {root,path,client:new RemoteAdvisorService(path)};
}
test('opaque answers, progress and metadata survive socket transport; socket is owner-only',async t=>{
  const answer='```json\n{not json}\n```\n\n  Keep whitespace. 🎯';
  const progress=[];
  const {client,path}=await setup(t,{cancel(){},async ask(c,p,{onProgress}){
    assert.equal(c.cwd,'/work');assert.equal(p.context,'selected text');onProgress('Reasoning');
    return {answer,advisorRef:'ref',usage:{input:1},outcome:'completed'};
  }});
  const reply=await client.ask(context,{mode:'start',question:'Check?',context:'selected text'},{onProgress:x=>progress.push(x)});
  assert.equal(reply.answer,answer);assert.equal(reply.advisorRef,'ref');assert.deepEqual(progress,['Reasoning']);
  assert.equal((await stat(path)).mode&0o777,0o600);
});
test('transport uses the real service ledger and preserves branch-bound resume',async t=>{
  const root=await mkdtemp(join(tmpdir(),'advisor-ledger-'));t.after(()=>rm(root,{recursive:true,force:true}));
  let calls=0;
  const adapter={inspect:async()=>({version:'fixture'}),readQuota:async()=>({state:'unknown',buckets:[]}),ask:async()=>({answer:'unchanged',threadId:'fixture-thread',usage:{input_tokens:++calls*10,output_tokens:calls*2},completed:true})};
  const service=new AdvisorService(root,adapter),state=service.state.bind(service);
  service.state=c=>state({...c,cwd:root});
  const {client}=await setup(t,service);
  const c={...context,runIds:[]};
  const first=await client.ask(c,{mode:'start',question:'First'});
  c.runIds.push(first.runId);
  const second=await client.ask(c,{mode:'resume',question:'Next',advisorRef:first.advisorRef});
  assert.equal(second.answer,'unchanged');assert.equal(second.sessionUsage.calls,2);
  await assert.rejects(client.ask({...c,runIds:[]},{mode:'resume',question:'Wrong branch',advisorRef:first.advisorRef}),/branch/);
});
test('cancellation closes the request and aborts the companion operation',async t=>{
  let started,stopped;
  const ready=new Promise(r=>started=r),done=new Promise(r=>stopped=r);
  const {client}=await setup(t,{cancel(){},ask:async(_c,_p,{signal})=>{
    started();await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));stopped();return {error:'cancelled'};
  }});
  const controller=new AbortController();
  const pending=client.ask(context,{mode:'consult',question:'Wait'},{signal:controller.signal});
  await ready;controller.abort();await assert.rejects(pending,/cancelled/);await done;
});
test('busy companion rejects a second request without cancelling the first',async t=>{
  let started,finish;const ready=new Promise(r=>started=r);
  const {client}=await setup(t,{cancel(){},ask:async()=>{started();await new Promise(r=>finish=r);return {answer:'done'};},state:async()=>({})});
  const pending=client.ask(context,{mode:'consult',question:'Wait'});await ready;
  await assert.rejects(client.state(context),/already running/);finish();assert.equal((await pending).answer,'done');
});
test('rejects arbitrary commands, paths, providers, object injection and oversized context',()=>{
  const request={method:'ask',context,params:{mode:'consult',question:'Check'}};
  for (const params of [{command:'sh'},{executable:'/bin/sh'},{provider:'other'},{question:{}},{context:'x'.repeat(49153)}])
    assert.throws(()=>validateRequest({...request,params:{...request.params,...params}}));
  assert.throws(()=>validateRequest({...request,method:'constructor'}));
  assert.throws(()=>validateRequest({...request,context:{...context,sessionId:'../../private'}}));
  assert.equal(validateRequest(request).context.cwd,'/work');
});
test('does not overwrite a regular file at socket path',async t=>{
  const root=await mkdtemp(join(tmpdir(),'advisor-file-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const path=join(root,'existing');await writeFile(path,'preserved');
  await assert.rejects(serveAdvisor(path,{cancel(){}}),/not a socket/);assert.equal(await readFile(path,'utf8'),'preserved');
});
