# Testing

Run `npm test` with Node >=22.19. Tests use fake CLI processes and temporary private state; no account or model calls are needed.

For provider changes, cover unchanged reply text, tool rejection, completion/error/cancellation, session/model identity, resume after restart, quota/reset parsing and usage accounting. Claude `/usage` must return `local_command: "usage"`, zero model turns and native `usage_report`; never parse an LLM answer as remaining quota. Claude result usage is per invocation; Codex and AGY use their adapter-specific cumulative counters.

For Linux isolation changes, use synthetic credentials and check bubblewrap mounts/environment. Local AI Sandboxes owns `tests/advisor_container.py`: it starts a disposable companion, checks the installed CLI binaries and socket/credential separation, then removes its resources. Publish this repository before updating its extension pin.

A read-only signed-in quota check can validate provider response compatibility. A live consultation additionally consumes account quota and requires explicit user authorization. Report fixture and live results separately. Do not write credentials or real consultation transcripts into tests or documentation.
