# Omp ACP recon findings (live capture vs `omp acp` 16.1.22)

Captured by `apps/server/scripts/omp-acp-recon.ts` on 2026-06-26.
Run: `node apps/server/scripts/omp-acp-recon.ts` (must run from apps/server so
`effect-acp` resolves via workspace node_modules).

## CONFIRMED (gaps closed)

- **protocolVersion**: `1`.
- **agentInfo**: `{ name: "oh-my-pi", title: "Oh My Pi", version: "16.1.22" }`.
- **Auth (terminal-free target hit)**: advertising `clientCapabilities.fs` +
  `terminal` and NOT `auth.terminal`, omp returns exactly ONE auth method:
  `{ id: "agent", name: "Use existing local credentials", description:
  "Authenticate via the provider keys/OAuth state already configured under ~/.omp." }`.
  → `authMethodId = "agent"`. `authenticate({methodId:"agent"})` returns `{}` (ok).
- **agentCapabilities**: `loadSession: true`; `mcpCapabilities: { http, sse }`;
  `promptCapabilities: { embeddedContext, image }`;
  `sessionCapabilities: { list, fork, resume, close }`
  → session rewind/fork (Phase 2) is supported by the agent.
- **session/new** returns `configOptions` + `modes`:
  - `mode` (select): `default` | `plan` ("Read-only planning mode that drafts a
    plan to a markdown file before any code changes"). Current: `default`.
  - `thinking` (select): `off` | `auto` (auto-detect low–xhigh per prompt).
  - `modes.availableModes`: default, plan.
  → Mode is driven via the config-option channel, not a distinct set_mode verb.
- **Wire**: standard Zed ACP (session/new, session/prompt, configOptions). No
  omp-specific extension request seen in the handshake. The generic
  `AcpRuntimeModel` / GrokAdapter event mapping should apply directly.

## STILL OPEN — blocked on omp having a model configured (NOT a protocol gap)

`session/prompt` failed immediately with:
```
-32603 Internal error: "No model selected.
Use /login, set an API key environment variable, or create
/home/edwin/.omp/agent/agent.db  Then use /model to select a model."
```
Because the turn never ran, these remain uncaptured:
- `session/update` variant shapes during a real edit turn (agent_message_chunk,
  agent_thought_chunk, tool_call, tool_call_update, plan).
- `available_commands_update` contents (the /plan /model /compact list).
- Whether omp calls back `fs/write_text_file` and `terminal/*` on the client
  during a turn (the mechanism that routes writes into T3 Code's diff viewer).
- Real omp model ids (even `/model` listing needs configured creds).

### Action required (USER, one-time)
Configure a model for omp so a turn can run, e.g. set a provider API key env var,
run `omp` and `/login`, or otherwise create `~/.omp/agent/agent.db` with a
selected model. Then re-run the recon to capture the turn-level shapes above.

## Adapter implications
- `acp/OmpAcpSupport.ts`: `OMP_AUTH_METHOD_ID = "agent"` is CONFIRMED (drop the
  TODO(omp-recon) on it).
- Mode wiring (Phase 1f): expose `mode` config option (default/plan) +
  `thinking` (off/auto).
- Since omp is standard ACP, `Layers/OmpAdapter.ts` can mirror GrokAdapter with
  the xAI ask_user_question handlers removed; turn-shape validation pending the
  model-config action above.
