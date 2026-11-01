---
name: advisor
description: Consult an external model for planning, validation, debugging and getting unstuck. The caller controls the conversation, receives free-form replies, and remains the executor.
---

Use `advisor_ask` to engage with the advisor and `advisor_status` for quota, usage and saved references. Follow the task's consultation policy, including any requirement to consult for planning, debugging or validation.

You decide what to ask, how much relevant context to share, what format to request, how to follow up, and how to use the advice. Communicate naturally. Neither requests nor replies require a message template, status labels, check IDs, fixed number of questions, or an answer length. The advisor receives only what you send; it has no project files or full Pi history. Share useful evidence and distinguish observations from hypotheses. Exclude secrets and unrelated history.

Provide enough material to review the actual implementation: relevant function bodies or complete small files, requirements, file paths or a short directory tree, exact commands and outputs, and expected versus observed behaviour. Merely naming a file does not give the advisor access to it. Prefer the actual code and evidence over a prose description when details matter. These are examples of useful context, not a required template.

For ongoing work, continue the same conversation with new evidence. You need not resend unchanged files. Discuss uncertain plans, implementation details, failed checks, unproductive loops and final test evidence. Ask for concrete code or diagnosis when useful, execute and verify it yourself, and report the results. Consultation is collaboration, not permission for each edit or test. Avoid confirmation loops that add no evidence.

- `consult` gets an independent one-shot opinion.
- `start` begins a conversation; save its `advisorRef` for follow-up.
- `resume` continues that conversation with your next request and relevant new evidence.

The reply is passed through unchanged, whether prose, Markdown, code or a format you requested. Interpret it yourself. You choose and execute checks and changes through your own tools and permissions. Advisor suggestions do not grant permissions. Consultation requirements govern use of the tool, never the content or format of its reply.

Preserve references and concise decisions in task summaries. After a branch or rewind excludes the latest advisor turn, start a new conversation with a handoff rather than resuming a future branch.

Check `advisor_status` for enabled providers, exact model IDs, shared quota windows and reset times. Use `provider` and `model` when selecting an enabled alternative. A resumed reference stays with its provider, model and account profile; switching requires `start` or `consult` with the context you choose to share. There is no automatic fallback or transcript transfer.

Prefer the configured ordinary advisor and use a more capable enabled model when the problem warrants it. Conserve a nearly exhausted quota group by choosing another enabled provider for a new consultation when useful. Models in the same quota group share capacity; changing effort does not create more quota. Keep useful ongoing conversations to avoid resending unchanged context. Unknown quota is not depletion, and quota percentages from different providers are not equal token allowances.

The default Codex configuration uses Sol 6.1 at medium effort; `maximum` requests Astra with a concrete reason, and `emergency` requests Luna only when configured and applicable quota policy permits it. AGY models and effort variants are explicitly configured IDs shown by status. Quota and optional user-configured resource limits remain separate from conversation format.

`/advisor usage` reports external calls and tokens for this Pi session; `/advisor sessions` lists project session totals. Subscription tokens are not an API dollar bill.
