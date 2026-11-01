# Pi Advisor

Ask Codex (OpenAI models) or Antigravity (Gemini models) for advice from Pi.

The local agent sends relevant context, gets a second opinion and carries out the work. It can continue an advisor conversation and track its usage separately.

```sh
pi install git:github.com/kyuz0/pi-advisor
```

Install and sign in to the provider's CLI, then run these commands in Pi:

```text
/reload
/advisor check
/advisor status
```

Pi can consult the advisor through `advisor_ask`. Use `/advisor usage` to see calls and token usage, and `/advisor cancel` to stop an active consultation.

[Configuration](docs/configuration.md) covers provider selection, call limits and separate advisor services. [Local AI Sandboxes](https://github.com/kyuz0/local-ai-sandboxes) runs the advisor in a separate container to keep provider credentials outside the coding agent's environment.

Requires Linux, Node.js 22.19+, Pi and bubblewrap. Antigravity also uses Linux Secret Service and `xdg-dbus-proxy`. Run `npm test` for the provider and socket tests.
