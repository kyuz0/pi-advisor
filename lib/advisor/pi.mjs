import { AdvisorService } from './service.mjs';
import { RemoteAdvisorService } from './remote.mjs';
import { usageText, summarize } from './accounting.mjs';

export const callerGuidelines = [
  'Consult the advisor when it can change a consequential decision: before a large uncertain plan, after substantial analysis needs validation, for conflicting evidence, or when repeated attempts add no information. Follow any task policy requiring consultation for planning, debugging or validation.',
  'Choose what to ask, which context to share, and how to use the reply. The advisor sees no project files or full Pi history. Replies are free-form text, passed through unchanged. Follow up naturally with relevant evidence; no required reply fields, format or check IDs.',
  'Give the advisor the material it needs to reason about your actual work: relevant function bodies or complete small files, requirements, file paths or a short directory tree, exact commands and outputs, and expected versus observed behaviour. It cannot read a filename you merely mention. Share enough source to review the implementation instead of only describing it. You choose what is relevant; there is no required packet format.',
  'For ongoing work, resume the same advisor conversation with new evidence and questions; avoid repeating unchanged context. Use advice to make progress, run the proposed checks yourself, and return informative results. You do not need permission for each edit or test. Ask for diagnosis or concrete implementation help when useful, not repeated confirmation of the same plan.',
  'Use consult for one opinion, start for an evidence loop, resume with its advisorRef to continue the discussion. Check advisor_status for enabled providers, exact models, shared quota windows and reset timing. Choose an enabled provider/model explicitly when useful; there is no automatic fallback. A saved advisorRef stays bound to its provider/model/account. Start a fresh conversation with selected context to switch. Codex defaults to Sol 6.1; maximum requests Astra with a concrete reason. Claude defaults to Sonnet at medium effort; Opus requires a reason, and Haiku is available for simpler questions. Before expensive consultations, check advisor_status and conserve nearly exhausted quota by choosing another enabled provider for a fresh conversation. Unknown quota is not depleted quota.',
  'Use advisor_ask instead of invoking advisor CLIs through bash. Stop when resolved or another round would repeat evidence. Preserve the advisorRef and decision in your task summary. External token usage is tracked separately for this Pi session.',
];
export function contextOf(ctx) {
  return { cwd: ctx.cwd, sessionId: ctx.sessionManager.getSessionId(), runIds: ctx.sessionManager.getBranch().filter(e => e.type === 'custom' && e.customType === 'advisor-run').map(e => e.data?.runId).filter(Boolean) };
}
export function registerAdvisor(pi, { getAgentDir, Type, service = process.env.PI_ADVISOR_SOCKET ? new RemoteAdvisorService(process.env.PI_ADVISOR_SOCKET) : new AdvisorService(getAgentDir()) }) {
  const enums = values => Type.Union(values.map(v => Type.Literal(v)));
  const result = value => {
    const content = [{ type: 'text', text: typeof value.answer === 'string' ? value.answer : value.error ?? JSON.stringify(value, null, 2) }];
    // Pi sends content to the caller model; details alone are not a conversation handoff.
    // Keep this launcher-owned reference separate from the verbatim advisor message.
    if (value.error && typeof value.answer === 'string') content.push({ type: 'text', text: `Advisor call failed (transport metadata): ${value.error}. The reply above may be incomplete; it is not a successful consultation.` });
    if ((value.resumable === true || (value.resumable === undefined && value.outcome === 'completed')) && value.advisorRef) content.push({ type: 'text', text: `Advisor conversation reference (tool metadata): ${value.advisorRef}. Use advisor_ask with mode resume and this advisorRef to continue.` });
    if (value.warnings?.length) content.push({type:'text',text:'Advisor warnings (tool metadata): '+value.warnings.join('; ')});
    return { content, details: value, ...(value.error ? { isError: true } : {}) };
  };
  const record = value => { if (value.runId) pi.appendEntry('advisor-run', { runId: value.runId, advisorRef: value.advisorRef, summary: value.answer?.slice(0,2000) ?? value.error, usage: value.usage, cost: value.cost }); };
  const showUsage = (ctx, usage) => ctx.ui.setStatus?.('advisor', `Advisor: ${usage.calls} calls · ${usage.totalTokens.toLocaleString()} tokens${Object.keys(usage.nativeByModel??{}).length ? ' + provider-native usage' : ''}${usage.unknownUsageCalls ? ' + unknown' : ''}`);
  const ask = async (ctx, params, signal, onUpdate) => {
    const value = await service.ask(contextOf(ctx), params, { signal, onProgress: text => onUpdate?.({ content: [{ type: 'text', text }], details: {} }) });
    record(value); showUsage(ctx, value.sessionUsage); return value;
  };
  pi.registerTool({ name: 'advisor_status', label: 'Advisor status', description: 'Read advisor quota/reset windows, local spending limits, per-session external token/cost totals and resumable references. No inference.', promptSnippet: 'Check external advisor quota, reset times and this session’s spending.', parameters: Type.Object({ refreshQuota: Type.Optional(Type.Boolean()) }),
    async execute(_id, params, signal, _update, ctx) { try { return result(await service.status(contextOf(ctx), { refreshQuota: params.refreshQuota !== false, signal })); } catch (e) { return result({ error: e.message }); } } });
  pi.registerTool({ name: 'advisor_ask', label: 'Ask advisor', description: 'Discuss plans, debugging and validation with an external coding model. You choose how to engage and receive its reply unchanged in any format. It cannot inspect your project: include relevant code or small files and exact commands/results, not just filenames or a summary of the code. consult is one-shot; start/resume support follow-up. Pi executes checks.', promptSnippet: 'Ask for plan/analysis review, debugging or a second opinion.', promptGuidelines: callerGuidelines, executionMode: 'sequential', parameters: Type.Object({
    mode: enums(['consult','start','resume']), context: Type.Optional(Type.String({ description: 'Relevant source code or complete small files, requirements, paths/tree, exact commands and outputs, or new evidence. Choose useful material and any format; the advisor cannot access your files itself.' })), question: Type.String(),
    provider: Type.Optional(enums(['codex','agy','claude'])), model: Type.Optional(Type.String({description:'An enabled exact model ID from advisor_status. Native effort variants are separate model IDs.'})),
    advisorRef: Type.Optional(Type.String()), purpose: Type.Optional(Type.String({ description: 'Optional label for your consultation, used only in the usage ledger.' })),
    tier: Type.Optional(enums(['default','maximum','emergency'])), effort: Type.Optional(enums(['low','medium','high','xhigh','max'])), reason: Type.Optional(Type.String()),
  }), async execute(_id, params, signal, onUpdate, ctx) { try { return result(await ask(ctx, params, signal, onUpdate)); } catch (e) { return result({ error: e.message }); } } });
  pi.registerCommand('advisor', { description: 'Advisor: status, usage, sessions, check, ask/start/resume, cancel, recover, acknowledge',
    async handler(args, ctx) {
      const [action = 'usage', ...parts] = args.trim().split(/\s+/).filter(Boolean);
      try {
        let output;
        if (action === 'cancel') { service.cancel(); output = 'Advisor cancellation requested; usage already incurred remains recorded.'; }
        else if (action === 'usage') {
          const state = await service.state(contextOf(ctx));
          output = parts[0] === 'json' ? JSON.stringify({ usage: summarize(state), runs: state.runs }, null, 2) : usageText(state);
        }
        else if (action === 'sessions') output = JSON.stringify(await service.sessions(contextOf(ctx)), null, 2);
        else if (action === 'status') output = JSON.stringify(await service.status(contextOf(ctx)), null, 2);
        else if (action === 'check') output = JSON.stringify(await service.inspect(), null, 2);
        else if (action === 'recover') { await service.recover(contextOf(ctx)); output = 'Recovered stale lock/running records. Inspect /advisor usage before acknowledging an unknown outcome.'; }
        else if (action === 'acknowledge') { await service.acknowledge(contextOf(ctx), parts[0]); output = 'Unknown outcome acknowledged; usage stays unknown and the call stays charged. Its conversation cannot be resumed.'; }
        else if (['ask','start','resume'].includes(action)) {
          const advisorRef = action === 'resume' ? parts.shift() : undefined;
          const text = parts.join(' '); if (!text) throw new Error('Supply a question/evidence after the command.');
          if (!ctx.isIdle()) throw new Error('Wait for the active Pi turn or use the advisor tools from that turn.');
          const value = await ask(ctx, { mode: action === 'ask' ? 'consult' : action, question: text, advisorRef });
          output = result(value).content;
        } else throw new Error('Usage: /advisor usage | sessions | status | check | ask QUESTION | start QUESTION | resume REF EVIDENCE | cancel | recover | acknowledge RUN_ID');
        pi.sendMessage({ customType: 'advisor-report', content: output, display: true }, { triggerTurn: false });
      } catch (e) { ctx.ui.notify(e.message, 'error'); }
    } });
  pi.on('session_shutdown', () => service.cancel());
  pi.on('session_start', async (_event, ctx) => {
    try { showUsage(ctx, summarize(await service.state(contextOf(ctx)))); } catch (e) { ctx.ui.notify(`Advisor usage unavailable: ${e.message}`, 'warning'); }
  });
  pi.on('before_agent_start', async (event, ctx) => {
    if (pi.getActiveTools && !pi.getActiveTools().includes('advisor_ask')) return;
    const context = contextOf(ctx);
    let state;
    try { state = await service.state(context); } catch { return; }
    const refs = Object.entries(state.advisors).filter(([, a]) => !a.invalid && context.runIds.includes(a.latestRunId)).slice(-3).map(([ref, a]) => ({ advisorRef: ref, model: a.model, summary: a.summary.slice(0, 500) }));
    // Rebuilt from durable state after compaction/restart; never sends history externally.
    event.systemPromptOptions.sections.advisor_state = JSON.stringify({ sessionUsage: summarize(state), advisors: refs });
  });
  return service;
}
