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

## Claude Code

Install the native Claude Code CLI (tested with 2.1.318) and run `claude auth login`. Add `"claude": {"enabled": true}` to `providers`; set `provider` to `"claude"` to make it the default. The default selection is `sonnet` at medium effort; `maximum` selects `opus` at high effort with a reason, and `model: "haiku"` selects Haiku at medium effort. Override these with `providers.claude.models`, using the same `{id, effort, requiresReason}` entries. Use an exact model ID to pin a version. A resumed conversation keeps the concrete model returned at startup.

The adapter disables tools, MCP, hooks, skills, plugins and project customization. It rejects tool attempts and model changes. Subscription authentication is required; API keys and alternate API endpoints are not inherited. In standalone mode only the file-backed login is mounted read-only from `claudeHome` (default `~/.claude`); renew it with `claude auth login` if needed. The sandbox companion uses a private writable `claudeHome` so the CLI can renew its own credentials, without mounting the host login.

## Models and quota

| Provider | Model selection | Quota source |
| --- | --- | --- |
| Codex | Sol 6.1 / medium by default; Astra / high with `maximum` and a reason; optional emergency Luna | Native app-server account limits, including shared windows and reset times |
| Antigravity | Explicit model IDs and matching effort from `agy models`; configure the quota group from `/usage` | Native `agy -p /usage --output-format json` |
| Claude | Sonnet / medium; Opus / high with a reason; Haiku / medium for simpler questions | Native `/usage` in non-interactive mode, using structured session, weekly and recognized model-scoped limits |

`advisor_status` (or `/advisor status`) refreshes quota without model inference. Every consultation also checks quota. The default reserve stops calls at 20% remaining; Astra requires more than 40%. Unknown, missing, expired or unmapped quota stays unknown, never zero. Optional `unknownQuotaCallsPerSession`, call and token limits can constrain that case; they are unset by default. AGY token caps are rejected because its accounting is kept on a separate native basis.

The caller receives guidance to check quota, reuse ongoing conversations and choose another enabled provider when useful. The extension does not predict how much quota a request will consume, automatically switch providers, buy credits or change account billing settings. Claude's `/usage` also reports whether extra usage is enabled; manage that in the provider account. Configure account billing accordingly if you require subscription-only spending.

Claude's structured `usage_report` is experimental. If the CLI returns no recognized limits, status reports unknown with the reason. The CLI must complete `/usage` as a local command with zero model turns; a model-generated estimate is rejected. Provider token totals are recorded separately from subscription allowances and dollar charges.

References: [Claude CLI](https://code.claude.com/docs/en/cli-reference), [model selection](https://code.claude.com/docs/en/model-config), [structured usage report](https://code.claude.com/docs/en/agent-sdk/typescript#sdkusagereport).
