# Agent guide

## Purpose and code map

Pi asks Codex or Antigravity for advice; Pi retains implementation and tool execution. Read `README.md` and `docs/configuration.md`. `extensions/advisor.js` exposes the commands/tools; `lib/advisor/` contains provider adapters, process control, remote service, accounting and conversation storage; `scripts/` contains CLI/service entry points.

Keep provider credentials isolated from the coding agent. In companion mode, send selected context over the bounded socket API; do not mount the workspace or expose arbitrary commands through that API. Preserve cancellation, timeouts, conversation references and separate usage accounting. Never turn a consultation into uncontrolled provider tool execution.

## Tests and consumers

Use Node >=22.19; run `npm test` from the root. Provider and socket tests under `tests/` use fixtures; they do not require real sign-in. Local AI Sandboxes pins this extension in `containers/dev/extensions.lock.json` and owns companion/network/login integration. Publish runtime changes first, then update that pin and run its disposable `tests/advisor_container.py` check. Do not update consumer pins for documentation-only changes.

# Development rules

Keep this extension independently installable. Keep credentials, transcripts, generated user configuration and machine-specific paths out of the repository. Preserve user settings and report incomplete operations accurately. Run the fixture suite before publishing changes. Tests that require an account or inference need explicit authorization. Keep documentation concise and focused on installation and behavior.

Write public-facing documentation in plain language. Omit private repository status, development history, working notes, obvious remarks and repetitive disclaimers. Explain installation, useful behavior and necessary configuration.
