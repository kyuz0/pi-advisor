const fields = ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens', 'reasoning_output_tokens'];
export function usageDelta(current, previous = null) {
  if (!current || fields.some(k => !Number.isSafeInteger(current[k] ?? 0) || (current[k] ?? 0) < 0)) return null;
  const delta = Object.fromEntries(fields.map(k => [k, (current[k] ?? 0) - (previous?.[k] ?? 0)]));
  if (Object.values(delta).some(n => n < 0) || delta.cached_input_tokens > delta.input_tokens || delta.reasoning_output_tokens > delta.output_tokens) return null;
  // CLI emits zero defaults when it has not received a usage snapshot.
  if (delta.input_tokens + delta.output_tokens === 0) return null;
  return delta;
}
export function costEstimate(usage, model, config, rerouted = false) {
  if (config.billingMode !== 'api') return { usd: null, reason: 'Subscription usage; per-call monetary charge not supplied by Codex.' };
  const rate = config.pricing?.[model];
  if (!usage || rerouted || !rate || !rate.source || !rate.asOf || !['input', 'cachedInput', 'output'].every(k => Number.isFinite(rate[k]) && rate[k] >= 0) || usage.cache_write_input_tokens > 0) return { usd: null, reason: 'Unknown usage, model, or applicable price; no cost inferred.' };
  return { usd: ((usage.input_tokens - usage.cached_input_tokens) * rate.input + usage.cached_input_tokens * rate.cachedInput + usage.output_tokens * rate.output) / 1e6, kind: 'estimated_api_cost', ratesPerMillion: rate, currency: 'USD' };
}
export function summarize(state) {
  const totals = Object.fromEntries(fields.map(k => [k, 0]));
  let estimatedUsd = 0, pricedCalls = 0, unknownUsageCalls = 0, unnormalizedUsageCalls = 0;
  const byModel = {}, nativeByModel = {};
  for (const run of state.runs) {
    const key = `${run.provider}/${run.model}`;
    const group = byModel[key] ??= { calls: 0, input: 0, output: 0, unknownUsageCalls: 0, reroutedCalls: 0 };
    group.calls++;
    if(run.nativeUsage){
      const n=nativeByModel[key]??={calls:0,input_tokens:0,output_tokens:0,thinking_tokens:0,cache_read_tokens:0,total_tokens:0,usageBasis:run.usageBasis};
      n.calls++;for(const k of ['input_tokens','output_tokens','thinking_tokens','cache_read_tokens','total_tokens'])n[k]+=run.nativeUsage[k]??0;
    }
    if (run.rerouted) group.reroutedCalls++;
    if (run.usage) {
      fields.forEach(k => totals[k] += run.usage[k] ?? 0);
      group.input += run.usage.input_tokens; group.output += run.usage.output_tokens;
    } else if(run.nativeUsage) { unnormalizedUsageCalls++; } else { unknownUsageCalls++; group.unknownUsageCalls++; }
    if (run.cost?.usd != null) { estimatedUsd += run.cost.usd; pricedCalls++; }
  }
  return { sessionId: state.sessionId, calls: state.runs.length, completed: state.runs.filter(r => r.status === 'completed').length, ...totals,
    totalTokens: totals.input_tokens + totals.output_tokens, unknownUsageCalls, unnormalizedUsageCalls, estimatedUsd: pricedCalls ? estimatedUsd : null, pricedCalls, unpricedCalls: state.runs.length - pricedCalls, byModel, nativeByModel };
}
export function usageText(state) {
  const s = summarize(state);
  const rows = state.runs.map(r => `| ${r.mode} | ${r.model} / ${r.effort} | ${r.status} | ${r.usage?.input_tokens ?? '?'} | ${r.usage?.cached_input_tokens ?? '?'} | ${r.usage?.output_tokens ?? '?'} | ${r.cost?.usd == null ? '—' : '$' + r.cost.usd.toFixed(6)} |`);
  return [`Advisor usage — Pi session ${s.sessionId}`, `${s.calls} calls (${s.completed} completed); ${s.totalTokens.toLocaleString()} recorded tokens: ${s.input_tokens.toLocaleString()} input, ${s.output_tokens.toLocaleString()} output.`, `Cached input: ${s.cached_input_tokens.toLocaleString()}; reasoning output: ${s.reasoning_output_tokens.toLocaleString()} (already included, not added again).`, `${s.unknownUsageCalls} calls have unknown usage. API cost estimate: ${s.estimatedUsd == null ? 'unavailable' : '$' + s.estimatedUsd.toFixed(6)}; ${s.pricedCalls}/${s.calls} calls priced. Subscription tokens are not an API bill.`, '', ...(Object.keys(s.nativeByModel).length?[`Provider-native usage (separate accounting basis): ${JSON.stringify(s.nativeByModel)}`,'']:[]), '| Mode | Model / effort | Outcome | Input | Cached | Output | Est. USD |', '| --- | --- | --- | ---: | ---: | ---: | ---: |', ...rows].join('\n');
}
