import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { Store, readJSON, sessionIdentity } from './store.mjs';
import { summarize, usageDelta, costEstimate } from './accounting.mjs';
import * as codex from './codex.mjs';
import * as agy from './agy.mjs';
import * as claude from './claude.mjs';

export const defaults = {
  provider: 'codex', executable: 'codex', bubblewrap: 'bwrap', billingMode: 'subscription', quotaReader: 'app-server',
  maxCallsPerSession: null, unknownQuotaCallsPerSession: null, maxTokensPerSession: null,
  maxAstraCallsPerSession: null, allowAstraWithUnknownQuota: false, allowEmergencyLuna: false,
  reservePercent: 20, astraMinimumPercent: 40, depletedPercent: 10,
  timeoutMs: 600000, maxPacketBytes: 49152, pricing: {},
};
export function validateConfig(raw = {}) {
  const c = { ...defaults, ...raw };
  if (!['codex','agy','claude'].includes(c.provider)) throw new Error('Provider not installed; choose codex, agy or claude.');
  if(c.providers){
    if(typeof c.providers!=='object'||Array.isArray(c.providers))throw new Error('providers must be an object');
    for(const [id,p] of Object.entries(c.providers)){
      if(!['codex','agy','claude'].includes(id)||typeof p!=='object'||p===null||Array.isArray(p)||typeof (p.enabled??true)!=='boolean')throw new Error('Invalid provider configuration');
      if(p.enabled!==false)validateConfig({...c,providers:undefined,...p,provider:id});
    }
    if(!c.providers[c.provider]||c.providers[c.provider].enabled===false)throw new Error('Default provider must be enabled');
  }
  if(c.provider==='agy'&&!c.providers){
    if(!Object.hasOwn(raw,'executable')||raw.executable==='codex')c.executable='agy';
    if(c.billingMode!=='subscription')throw new Error('AGY supports subscription authentication only');
    if(!c.models?.default&&!c.setupOnly)throw new Error('Configure an explicit default AGY model');
    for(const m of Object.values(c.models))if(!m||typeof m.id!=='string'||!m.id||typeof m.quotaGroup!=='string'||!['low','medium','high'].includes(m.effort))throw new Error('AGY model requires id, quotaGroup and effort');
  }
  if(c.provider==='claude'&&!c.providers){
    if(!Object.hasOwn(raw,'executable')||raw.executable==='codex')c.executable='claude';
    if(c.billingMode!=='subscription')throw new Error('Claude advisor currently supports subscription authentication only');
    c.models ??= {default:{id:'sonnet',effort:'medium'},maximum:{id:'opus',effort:'high',requiresReason:true},economy:{id:'haiku',effort:'medium'}};
    if(!c.models.default)throw new Error('Configure a default Claude model');
    for(const m of Object.values(c.models))if(!m||typeof m.id!=='string'||!m.id||!['low','medium','high','xhigh','max'].includes(m.effort))throw new Error('Claude model requires id and effort');
  }
  if (!['subscription','api'].includes(c.billingMode) || !['off','app-server'].includes(c.quotaReader)) throw new Error('Invalid billingMode or quotaReader.');
  for (const k of ['maxCallsPerSession','unknownQuotaCallsPerSession','maxTokensPerSession','maxAstraCallsPerSession']) if (c[k] !== null && (!Number.isSafeInteger(c[k]) || c[k] < 1)) throw new Error(`Invalid positive integer or null: ${k}`);
  for (const k of ['timeoutMs','maxPacketBytes']) if (!Number.isSafeInteger(c[k]) || c[k] < 1) throw new Error(`Invalid positive integer: ${k}`);
  for (const k of ['reservePercent','astraMinimumPercent','depletedPercent']) if (!Number.isFinite(c[k]) || c[k] < 0 || c[k] > 100) throw new Error(`Invalid percentage: ${k}`);
  if (c.provider==='codex' && !(c.depletedPercent <= c.reservePercent && c.reservePercent < c.astraMinimumPercent)) throw new Error('Require depletedPercent <= reservePercent < astraMinimumPercent.');
  for (const k of ['allowAstraWithUnknownQuota','allowEmergencyLuna']) if (typeof c[k] !== 'boolean') throw new Error(`Invalid boolean: ${k}`);
  for (const k of ['executable','bubblewrap']) if (typeof c[k] !== 'string' || !c[k]) throw new Error(`Invalid executable: ${k}`);
  return c;
}
export function quotaForModel(snapshot, model, now = Date.now()) {
  if (snapshot?.state !== 'known' || !snapshot.observedAt || now - snapshot.observedAt > 60000) return { state: 'unknown', remaining: null };
  // A named model bucket maps explicitly. Generic codex buckets conservatively apply to all Codex models.
  const buckets = snapshot.buckets.filter(b => b.model === model || (!b.model && b.id === 'codex'));
  const windows = buckets.flatMap(b => b.windows);
  if (!windows.length || windows.some(w => w.resetsAt != null && w.resetsAt <= now)) return { state: 'unknown', remaining: null };
  return { state: 'known', remaining: Math.min(...windows.map(w => w.remainingPercent)), reached: buckets.some(b => b.reached) || snapshot.ordinaryUsageAllowed === false, windows };
}
export function selectModel(request, config, state, quota) {
  const tier = request.tier ?? 'default';
  const models = { default: 'gpt-6.1-sol', maximum: 'gpt-6-astra', emergency: 'gpt-6-luna' };
  const model = models[tier]; if (!model) throw new Error('Unknown advisor tier.');
  if (quota?.ordinaryUsageAllowed === false) throw new Error('The provider reports that ordinary usage is not allowed. Wait for restored access.');
  const effort = request.effort ?? (tier === 'maximum' ? 'high' : 'medium');
  if (!['low','medium','high','xhigh','max'].includes(effort)) throw new Error('Unsupported thinking effort.');
  const s = summarize(state);
  if ((config.maxCallsPerSession !== null && s.calls >= config.maxCallsPerSession) || (config.maxTokensPerSession !== null && s.totalTokens >= config.maxTokensPerSession)) throw new Error('This Pi session has reached its advisor call/token budget. Change the user configuration to increase it.');
  const q = quotaForModel(quota, model);
  if (tier === 'maximum') {
    if (!request.reason?.trim()) throw new Error('Astra requires a concrete escalation reason.');
    if (config.maxAstraCallsPerSession !== null && state.runs.filter(r => r.model === model).length >= config.maxAstraCallsPerSession) throw new Error('Session Astra allowance reached.');
    if (q.state === 'unknown' && !config.allowAstraWithUnknownQuota) throw new Error('Astra quota is unknown; configure an explicit allowance or use Sol.');
    if (q.state === 'known' && q.remaining <= config.astraMinimumPercent) throw new Error('Conserve quota: use Sol for this review.');
  }
  if (tier === 'emergency') {
    const sol = quotaForModel(quota, models.default);
    if (!config.allowEmergencyLuna || !request.reason?.trim() || sol.state !== 'known' || sol.remaining > config.depletedPercent || q.state !== 'known' || q.remaining <= 0 || q.reached) throw new Error('Luna requires enabled emergency use, known severe depletion, an available applicable quota window, and a necessary second-opinion reason.');
    if (state.runs.some(r => r.model === model)) throw new Error('One emergency Luna call is allowed per session.');
  } else {
    if (q.state === 'known' && (q.remaining <= config.reservePercent || q.reached)) throw new Error('Advisor quota is at its reserve or exhausted; wait for reset.');
    if (q.state === 'unknown' && config.unknownQuotaCallsPerSession !== null && s.calls >= config.unknownQuotaCallsPerSession) throw new Error('Unknown-quota advisor allowance reached for this Pi session.');
  }
  return { model, effort, quotaState: q.state };
}

export function providerConfig(config,id=config.provider){
  const entry=config.providers?.[id];
  if(config.providers?(!entry||entry.enabled===false):id!==config.provider)throw new Error('Requested advisor provider is not enabled');
  return validateConfig({...config,providers:undefined,...entry,provider:id,executable:entry?.executable??(config.providers?id:config.executable)});
}
export function selectAgyModel(request,config,state,quota,capability){
  const tier=request.tier??'default';
  const selected=request.model?Object.values(config.models).find(m=>m.id===request.model):config.models[tier];
  if(!selected)throw new Error('Requested AGY model is not enabled');
  if(request.model&&request.tier&&config.models[tier]?.id!==request.model)throw new Error('Model and tier conflict');
  if(request.effort&&request.effort!==selected.effort)throw new Error('Effort conflicts with the configured AGY model ID');
  if(selected.requiresReason&&!request.reason?.trim())throw new Error('This model requires an escalation reason');
  if(!capability.models?.some(m=>m.id===selected.id))throw new Error('Configured model is not advertised by AGY');
  const usage=summarize(state),q=quotaForModel(quota,selected.id);
  if(config.maxCallsPerSession!==null&&usage.calls>=config.maxCallsPerSession)throw new Error('Session advisor call allowance reached');
  if(config.maxTokensPerSession!==null)throw new Error('AGY token caps need verified normalized accounting; use native usage reporting');
  if(q.state==='known'&&(q.remaining<=config.reservePercent||q.reached))throw new Error('Advisor quota is at its reserve or exhausted');
  if(q.state==='unknown'&&config.unknownQuotaCallsPerSession!==null&&usage.calls>=config.unknownQuotaCallsPerSession)throw new Error('Unknown-quota advisor allowance reached');
  return {model:selected.id,effort:selected.effort,quotaState:q.state};
}

export function selectClaudeModel(request,config,state,quota){
  const selected=request.model?Object.values(config.models).find(m=>m.id===request.model):config.models[request.tier??'default'];
  if(!selected)throw new Error('Requested Claude model is not enabled');
  if(request.model&&request.tier&&config.models[request.tier]?.id!==request.model)throw new Error('Model and tier conflict');
  if(selected.requiresReason&&!request.reason?.trim())throw new Error('This model requires an escalation reason');
  const effort=request.effort??selected.effort;
  if(!['low','medium','high','xhigh','max'].includes(effort))throw new Error('Unsupported thinking effort');
  const usage=summarize(state),q=quotaForModel(quota,selected.id);
  if(config.maxCallsPerSession!==null&&usage.calls>=config.maxCallsPerSession)throw new Error('Session advisor call allowance reached');
  if(config.maxTokensPerSession!==null&&usage.totalTokens>=config.maxTokensPerSession)throw new Error('Session advisor token allowance reached');
  if(q.state==='known'&&(q.remaining<=config.reservePercent||q.reached))throw new Error('Advisor quota is at its reserve or exhausted; wait for reset');
  if(q.state==='unknown'&&config.unknownQuotaCallsPerSession!==null&&usage.calls>=config.unknownQuotaCallsPerSession)throw new Error('Unknown-quota advisor allowance reached');
  return {model:selected.id,effort,quotaState:q.state};
}

export class AdvisorService {
  constructor(agentDir, adapter = codex) {
    this.agentDir = agentDir; this.store = new Store(join(agentDir, 'advisor')); this.adapter = adapter; this.adapters = {codex: adapter, agy, claude}; this.active = null;
  }
  adapterFor(id) { return id==='codex'?this.adapter:this.adapters[id]; }
  async config() { return validateConfig(await readJSON(join(this.agentDir, 'advisor.json'), {})); }
  async quota(config, signal, adapter = this.adapterFor(config.provider)) {
    try { return await adapter.readQuota(config, this.store.root, { signal }); }
    catch (e) { return { state: 'unknown', source: config.provider==='claude'?'claude-usage':config.quotaReader, observedAt: Date.now(), buckets: [], error: e.message }; }
  }
  async state(context) { return this.store.load(await sessionIdentity(context.cwd, context.sessionId)); }
  async status(context, { refreshQuota = true, signal } = {}) {
    const config = await this.config(), state = await this.state(context);
    const ids=config.providers?Object.keys(config.providers).filter(id=>config.providers[id].enabled!==false):[config.provider];
    const providers=await Promise.all(ids.map(async id=>{
      const c=providerConfig(config,id),adapter=this.adapterFor(id);
      const quota=refreshQuota?await this.quota(c,signal,adapter):{state:'unknown',source:'not_refreshed',buckets:[]};
      let capability=null,error=null;
      if(id==='agy'&&refreshQuota)try{capability=await adapter.inspect(c,this.store.root,signal);}catch(e){error=e.message;}
      return {provider:id,enabled:true,quota,capability,error,models:id!=='codex'?Object.values(c.models):['gpt-6.1-sol','gpt-6-astra','gpt-6-luna']};
    }));
    const quota=providers.find(p=>p.provider===config.provider).quota;
    return {provider:config.provider,implementedProviders:['codex','agy','claude'],providers,billingMode:config.billingMode,quota,
      windows:providers.flatMap(p=>p.quota.buckets.flatMap(b=>b.windows.map(w=>({provider:p.provider,bucket:b.id,model:b.model,...w,resetsAtISO:w.resetsAt==null?null:new Date(w.resetsAt).toISOString(),secondsUntilReset:w.resetsAt==null?null:Math.max(0,Math.ceil((w.resetsAt-Date.now())/1000))})))),
      usage:summarize(state),limits:{calls:config.maxCallsPerSession,unknownQuotaCalls:config.unknownQuotaCallsPerSession,tokens:config.maxTokensPerSession},
      advisors:Object.entries(state.advisors).filter(([,a])=>!a.invalid&&context.runIds.includes(a.latestRunId)).map(([ref,a])=>({advisorRef:ref,provider:a.provider??'codex',model:a.model,summary:a.summary})),usageFile:this.store.path(state)};
  }
  async inspect(signal){const c=providerConfig(await this.config());return this.adapterFor(c.provider).inspect(c,this.store.root,signal);}

  cancel() { this.active?.abort(); }
  async acknowledge(context, runId) {
    const release = await this.store.lock();
    try {
      const state = await this.state(context), run = state.runs.find(r => r.id === runId);
      if (!run || run.status !== 'unknown_outcome') throw new Error('Supply a run ID with unknown_outcome from the saved usage file.');
      run.status = 'acknowledged_unknown'; run.acknowledgedAt = new Date().toISOString();
      await this.store.save(state);
    } finally { await release(); }
  }
  async recover(context) {
    await this.store.recoverLock();
    const release = await this.store.lock();
    try {
      const state = await this.state(context);
      for (const r of state.runs) if (r.status === 'running') { r.status = 'unknown_outcome'; r.error = 'Pi stopped before completion was recorded. No automatic retry.'; }
      for (const a of Object.values(state.advisors)) if (state.runs.some(r => r.id === a.latestRunId && r.status === 'unknown_outcome')) a.invalid = true;
      await this.store.save(state);
    } finally { await release(); }
  }
  async sessions(context) {
    await this.store.init(); const current = await sessionIdentity(context.cwd, context.sessionId); const results = [];
    for (const name of await readdir(join(this.store.root, 'sessions'))) if (name.endsWith('.json')) {
      const state = await readJSON(join(this.store.root, 'sessions', name));
      if (state.project === current.project) results.push(summarize(state));
    }
    return results;
  }
  async ask(context, request, { signal, onProgress } = {}) {
    const allConfig = await this.config();
    if (!['consult','start','resume'].includes(request.mode)) throw new Error('Choose consult, start or resume.');
    if (typeof request.question !== 'string' || !request.question.trim()) throw new Error('Supply an advisor request.');
    if (request.context != null && typeof request.context !== 'string') throw new Error('Context must be text.');
    // The caller controls the conversation. No serialized message contract or answer-size target.
    const packet = request.context ? `${request.context}\n\n${request.question}` : request.question;
    if (Buffer.byteLength(packet) > allConfig.maxPacketBytes) throw new Error(`Packet is ${Buffer.byteLength(packet)} bytes; limit ${allConfig.maxPacketBytes}. Remove irrelevant or duplicate evidence.`);
    const release = await this.store.lock();
    const controller = new AbortController(); this.active = controller;
    const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
    try {
      const state = await this.state(context);
      if (state.runs.some(r => r.status === 'running' || r.status === 'unknown_outcome')) throw new Error('An earlier advisor outcome is unknown. Inspect /advisor usage; use a new Pi session or explicitly reconcile the saved record before further spending.');
      let previous;
      if (request.mode === 'resume') {
        previous = state.advisors[request.advisorRef];
        if (!previous || previous.invalid || !context.runIds.includes(previous.latestRunId)) throw new Error('Advisor reference is absent, expired, or belongs to another session/branch. Start a fresh advisor with a short handoff.');
      }
      if (controller.signal.aborted) throw new Error('Advisor cancelled before launch.');
      const provider=request.provider??previous?.provider??(previous?'codex':allConfig.provider);
      if(previous&&(previous.provider??'codex')!==provider)throw new Error('Changing provider requires a fresh advisor conversation');
      const config=providerConfig(allConfig,provider),adapter=this.adapterFor(provider);
      if(previous?.accountProfile&&previous.accountProfile!==(config.accountProfile??'default'))throw new Error('Advisor account profile changed; start a fresh conversation');
      const capability=await adapter.inspect(config,this.store.root,controller.signal);
      const quota=await this.quota(config,controller.signal,adapter);
      const selection=previous&&!request.model&&!request.tier?{...request,model:previous.model}:request;
      const choice=provider==='agy'?selectAgyModel(selection,config,state,quota,capability):provider==='claude'?selectClaudeModel(selection,config,state,quota):selectModel(request,config,state,quota);
      if(provider==='codex'&&request.model&&request.model!==choice.model)throw new Error('Codex model selector conflicts with tier');
      if (previous && previous.model !== choice.model) throw new Error('Changing tier requires a fresh advisor conversation with a handoff.');
      if (controller.signal.aborted) throw new Error('Advisor cancelled before launch.');
      const id = randomUUID(), ref = request.mode === 'consult' ? null : request.advisorRef ?? randomUUID();
      const conversationId = previous?.conversationId ?? randomUUID();
      const run = { id, startedAt: new Date().toISOString(), provider, accountProfile:config.accountProfile??'default', mode: request.mode, purpose: (request.purpose ?? 'second_opinion').slice(0,100), ...choice,
        billingMode: config.billingMode, cliVersion: capability.version, status: 'running', advisorRef: ref, usage: null, cost: null, packetBytes: Buffer.byteLength(packet) };
      state.runs.push(run);
      if (previous) previous.invalid = true; // Crash during resume must not allow replay of the same turn.
      await this.store.save(state);
      let result;
      try { result = await adapter.ask(config, this.store.root, { mode: request.mode, conversationId, threadId: previous?.threadId, resolvedModel: previous?.resolvedModel, ...choice, packet }, { signal: controller.signal, onProgress }); }
      catch (e) { result = { error: e.message, outcomeUnknown: true }; }
      run.finishedAt = new Date().toISOString(); run.durationMs = Date.parse(run.finishedAt) - Date.parse(run.startedAt);
      run.status = typeof result.answer === 'string' && !result.error ? 'completed' : result.cancelled ? 'cancelled' : result.outcomeUnknown ? 'unknown_outcome' : 'failed';
      run.error = result.error ?? null; run.warnings = result.warnings ?? [];
      run.partial = result.partial === true;
      run.rawUsage = result.usage ?? null; run.usage = usageDelta(result.usage, provider==='claude'?null:previous?.rawUsage);
      if(provider==='agy'){
        run.rawNativeUsage=result.nativeUsage??null;
        run.nativeArtifact=result.nativeArtifact??null;
        run.nativeUsage=agy.nativeUsageDelta(result.nativeUsage,previous?.rawNativeUsage);
        run.usageBasis=result.usageBasis;
      }
      run.cost = costEstimate(run.usage, choice.model, config, result.rerouted);
      run.rerouted = !!result.rerouted;
      if ((run.status === 'completed' || (provider === 'agy' && run.status === 'failed' && result.resumable)) && ref && result.threadId) state.advisors[ref] = { conversationId, threadId: result.threadId, provider, accountProfile:config.accountProfile??'default', model: choice.model, resolvedModel: result.resolvedModel, rawUsage: result.usage ?? null, rawNativeUsage: result.nativeUsage??null, latestRunId: id, summary: (result.answer ?? '').slice(0,2000), invalid: !!result.rerouted || (provider==='agy'?!run.nativeUsage:!run.usage) };
      await this.store.save(state);
      return { runId: id, advisorRef: ref, answer: result.answer ?? null, error: run.error, outcome: run.status, partial:run.partial, resumable:!!ref && state.advisors[ref]?.latestRunId === id && !state.advisors[ref]?.invalid, provider, nativeUsage:run.nativeUsage??null, model: choice.model, effort: choice.effort, usage: run.usage, cost: run.cost, sessionUsage: summarize(state), warnings: run.warnings };
    } finally { signal?.removeEventListener('abort', abort); this.active = null; await release(); }
  }
}
