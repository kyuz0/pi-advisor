# Pi Advisor

Ask Codex (OpenAI models) or Antigravity (Gemini models) for advice from Pi. The local agent chooses the context to send, receives the reply unchanged and carries out the work. Conversations can be resumed; advisor usage is tracked separately.

```sh
pi install git:git@github.com:kyuz0/pi-advisor.git
```

The repository is private; Git access is required. Run `/reload`, then `/advisor check` and `/advisor status`. Pi gets `advisor_status` and `advisor_ask`; `/advisor usage` shows the session's external usage. Use `start` and `resume` for follow-up with the same advisor conversation.

## Run locally

Requires Linux, Node.js 22.19+, Pi, bubblewrap and the selected provider's CLI. Sign in using the provider's supported login flow. Configuration lives in `advisor.json` inside Pi's agent directory. For example:

```json
{
  "provider": "codex",
  "providers": {
    "codex": {"enabled": true, "executable": "codex"}
  },
  "maxCallsPerSession": 4
}
```

Codex uses its subscription login. An optional `codexHome` selects a separate login directory. Antigravity uses `agy`, a Linux Secret Service session and `xdg-dbus-proxy`; configure an exact Gemini model and quota group reported by that CLI. No provider fallback is automatic. CLI versions are recorded, rather than pinned.

## Use a separate advisor service

Set `PI_ADVISOR_SOCKET` when starting Pi to use a service over a Unix socket. The same extension then acts as a client; provider CLIs and credentials can stay in a separate container.

```sh
PI_ADVISOR_CONFIG=/path/to/advisor.json \
PI_CODING_AGENT_DIR=/path/to/private-state \
PI_ADVISOR_SOCKET=/run/advisor/advisor.sock \
node scripts/server.mjs
```

[Local AI Sandboxes](https://github.com/kyuz0/local-ai-sandboxes) manages this setup, including sign-in, private credential volumes and the network allowlist. Direct installation runs under the current user and does not provide that separate credential boundary.

The service accepts bounded consultation requests. It rejects arbitrary commands, paths and configuration changes. Provider tool use is disabled. The advisor sees the supplied context, not the working directory or full Pi conversation. A process with access to the socket can submit consultations and consume the configured account quota.

Replies remain free-form text. Transport failures and usage information are separate metadata. References and selected summaries persist across Pi compaction and restarts; resuming requires the same session branch. Cancellation, per-session call limits and unknown outcomes are recorded.

Run `npm test` for provider, accounting, cancellation and socket fixtures. These tests do not use real accounts or inference.
