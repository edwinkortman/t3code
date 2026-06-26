# Build plan: Omp ACP adapter — parallel, token-cheap

Companion to `omp-t3code-adapter-plan.md`. This is the *execution* plan.

## Token strategy

Two levers:

1. **Build-time (now):** This Opus session orchestrates only. Sonnet subagents do
   all mechanical + structural file work in parallel. Opus writes only the one hard
   file (`Layers/OmpAdapter.ts` event mapping) and does final integration + review.
   Target: ~80% of file work off Opus.
2. **Run-time (after ship):** The adapter consumes Omp's role-based model routing
   (`smol`/`commit` use cheap models). Daily loop stops defaulting to Opus. This is
   the permanent saving and the reason the project exists.

Decision (this session): build via **cheap Claude subagents**, **Sonnet tier** for
everything non-Opus. Dogfooding-via-Omp deferred until omp can self-build.

## Repo reality (from recon of the fork)

- T3 Code already speaks ACP generically. Grok + Cursor are ACP-CLI adapters.
  **Model the omp adapter on Grok, not OpenCode** (OpenCode uses its own SDK).
- ACP client handlers (`fs/*`, `terminal/*`, `request_permission`) are already
  generic in `apps/server/src/provider/acp/AcpSessionRuntime.ts:98-246`. Inherited,
  not bespoke. Plan's "Phase 1d = highest-value work" is mostly already done.
- `ProviderDriverKind` is an open branded slug → adding `"omp"` = 0 contracts edits.
- Adapter contract: `ProviderAdapterShape<TError>` in
  `apps/server/src/provider/Services/ProviderAdapter.ts`.
- T3 ships `packages/effect-acp` — recon must drive omp through THAT, not an
  external `@zed-industries` SDK.

## Files

CREATE (mirror Grok): `Drivers/OmpDriver.ts`, `acp/OmpAcpSupport.ts`,
`Layers/OmpAdapter.ts`, `Layers/OmpProvider.ts`, `Services/OmpAdapter.ts`.
Optional: `textGeneration/OmpTextGeneration.ts`, `acp/OmpAcpExtension.ts`.
EDIT: `provider/builtInDrivers.ts` (import + env union + array, 3 lines).
APPEND: `packages/contracts/src/settings.ts` (`OmpSettings`).

## Waves

### Wave 0 — parallel NOW, all Sonnet (no recon dependency)
- A. Recon client against `packages/effect-acp` → runnable recon.ts.
- B. Deep-read Grok chain (GrokAdapter, GrokAcpSupport, AcpSessionRuntime,
     AcpRuntimeModel) → "Omp adapter spec" note: method/event map + gap list.
- C. `OmpSettings` schema, clone GrokSettings.
- D. `Services/OmpAdapter.ts` shape anchor (~16 lines).
- E. `builtInDrivers.ts` registration stub.
- F. `acp/OmpAcpSupport.ts` spawn skeleton (`command:"omp", args:["acp"]`).

### Recon gate — YOU run it (free tokens, runs a process)
Run recon.ts vs real `omp acp`. Capture 4 unknowns:
- auth methods advertised with/without `auth.terminal` (want terminal-free `agent`).
- `available_commands_update` contents.
- `session/update` variants during an edit turn.
- does omp call back `fs/*` and `terminal/*` when caps advertised?
Diff observed shapes vs what AcpRuntimeModel already handles = the real adapter gap.

### Wave 1 — after recon, parallel
- `Layers/OmpAdapter.ts` session/turn/event mapping — **OPUS** (hardest, needs shapes).
- G. `Layers/OmpProvider.ts` install/version/model probe — Sonnet.
- H. `OmpTextGeneration.ts` commit/PR/branch msgs — Sonnet.
- I. auth wiring (`agent` methodId, reuse `~/.omp`) — Sonnet.

### Wave 2 — Opus only
Wire layers, integration review, end-to-end headline test: LSP-correct rename
across barrel files lands as a reviewable diff. Terminal-free check.

## Dependency notes
- Wave 0 is fully independent; safe to fan out 6 Sonnet agents at once.
- Everything that maps live session data is blocked on recon. Don't pre-write it.
- Opus touches only the event-mapping file + final wiring/review.
