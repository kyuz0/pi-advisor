# Configuration

Settings live in `advisor.json` inside Pi's agent directory:

```json
{
  "provider": "codex",
  "providers": {
    "codex": {"enabled": true, "executable": "codex"}
  },
  "maxCallsPerSession": 4
}
```

Codex uses its CLI login. `codexHome` selects a separate login directory. For Antigravity, configure `agy` with an exact Gemini model and quota group from the CLI. `/advisor status` shows the enabled providers and models.

`advisor_ask` accepts `consult`, `start` and `resume`. A started conversation returns an `advisorRef` for follow-up. References and selected summaries persist across Pi compaction and restarts; resuming uses the same session branch. The advisor receives the context supplied with each request and returns its reply unchanged.

## Separate advisor service

Set `PI_ADVISOR_SOCKET` when starting Pi to connect to an advisor service over a Unix socket. Run the service with:

```sh
PI_ADVISOR_CONFIG=/path/to/advisor.json \
PI_CODING_AGENT_DIR=/path/to/private-state \
PI_ADVISOR_SOCKET=/run/advisor/advisor.sock \
node scripts/server.mjs
```

The service hosts the provider CLIs and credentials. [Local AI Sandboxes](https://github.com/kyuz0/local-ai-sandboxes) provides container setup, sign-in, credential storage and network rules.

Provider tool use is disabled. The service accepts consultation requests and rejects command execution, arbitrary paths and configuration changes. Access to its socket permits consultations using the configured account quota.

Direct installation runs under the current user's account. Separate credential isolation requires the service to run in a separate environment.
