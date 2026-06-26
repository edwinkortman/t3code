# Plan: Omp harness inside a T3 Code fork (via one ACP adapter)

## Goal

A GUI coding tool you actually like (forked T3 Code) that exposes Omp's full
harness (LSP-correct refactors, real DAP debugging, hashline edits, hindsight
memory, subagents, role-based model routing, plan mode), with no terminal in
your daily loop.

## The one architectural decision

Build a single **ACP client adapter** in your T3 Code fork that spawns
`omp acp` as a subprocess and renders its ACP stream into T3 Code's existing
thread and diff UI.

- Do **not** fork omp. It has no GUI primitives; you would be building a UI on a
  terminal-first codebase.
- Do **not** reimplement the harness inside T3 Code. The harness runs inside the
  omp process and is exposed over ACP. You consume it, you do not rebuild it.

The adapter is the only seam. omp does the agent work. T3 Code does the GUI.

Assumption flagged: this plan assumes T3 Code's provider layer can host a new
adapter without a rewrite. Phase 0 confirms or kills that assumption before you
write real code.

---

## Phase 0: Recon (decides whether this is an afternoon or a weekend)

Two unknowns. Resolve both before committing to the adapter shape.

### 0.1 Learn omp's actual ACP behavior, independent of T3 Code

Write a ~50-line standalone Node/TS client that drives `omp acp` directly and
logs every message. This teaches you omp's real handshake, auth methods, command
list, and `session/update` shapes without T3 Code in the way. Skeleton in
section 6.1. Also capture raw frames for reference:

```bash
# one-off: see omp's stderr while your client drives it
omp acp 2>acp.stderr.log

# or tee the wire both directions through named pipes
mkfifo in out
tee acp.in.log < in | omp acp | tee acp.out.log > out &
# point your client at in/out
```

Deliverable: a short notes file answering
- Which `authenticate` methods does omp advertise when you do / do not set
  `clientCapabilities.auth.terminal`? (Expectation: with it set, omp offers a
  terminal sign-in that launches its TUI; without it, the only method is
  `agent`, reusing provider keys and OAuth already stored under `~/.omp`.)
- What does `available_commands_update` contain? (Expect `/plan`, `/model`,
  `/compact`; expect TUI-only commands and `/login`, `/quit` to be absent.)
- What `session/update` variants does omp emit during a real edit turn?
- Does omp call `fs/read_text_file`, `fs/write_text_file`, and `terminal/*` back
  on your client when you advertise those capabilities? (This is the mechanism
  that makes writes land in T3 Code's diff viewer instead of straight to disk.)

### 0.2 Learn T3 Code's provider interface

Clone your fork and read, in order:
- `packages/` (find the provider/agent abstraction; this is the real target)
- the **OpenCode** integration specifically. OpenCode is ACP-capable, so it is
  your Rosetta stone.
- `apps/` for where threads, diffs, and the worktree/PR flow are wired to a
  provider.
- `AGENTS.md`, `CLAUDE.md`, `docs/`, `REMOTE.md`, `KEYBINDINGS.md`.

The decisive question: **does T3 Code already drive OpenCode over ACP, or
through OpenCode's own SDK?**

- If ACP: your omp adapter is close to a new provider entry pointing at
  `omp acp` plus auth wiring. Reuse their ACP client plumbing.
- If OpenCode-SDK-specific: you write a fresh ACP client adapter against
  T3 Code's provider interface. Still bounded, because ACP is small and omp
  implements all of it.

Deliverable: a one-page note describing T3 Code's provider interface contract
(the methods/events an adapter must implement) and which of the two cases you
are in.

### Phase 0 exit criteria
- Standalone client completes initialize -> authenticate -> session/new ->
  session/prompt -> sees a streamed edit, against real omp.
- You can name the exact T3 Code interface your adapter will implement.

---

## Phase 1: The adapter (the functional harness, no terminal)

This phase delivers everything in the "works through the adapter" column: the
full functional harness surfaced in T3 Code's existing UI. Break into
milestones; each is independently testable.

### 1a. Process lifecycle
- Spawn `omp acp` as a child process from the adapter, inheriting environment.
- Wire stdin/stdout to a `ClientSideConnection`.
- Handle spawn failure (omp not installed / not on PATH) with a clear UI error,
  the same way T3 Code handles a missing Codex/Claude/OpenCode CLI.
- Clean shutdown: cancel in-flight turn, release sessions, kill child on thread
  close.

### 1b. Auth (the part that keeps it terminal-free)
- For a GUI-only daily loop, you want the `agent` auth method: omp reuses
  provider keys and OAuth already stored under `~/.omp`.
- Mirror T3 Code's existing pattern: the user installs and authenticates omp
  once themselves (run `omp` in a terminal, sign in, done). The adapter then
  assumes a pre-authed omp and never bundles or re-implements login.
- Decide deliberately whether to advertise `clientCapabilities.auth.terminal`.
  If you do, omp can launch its TUI for sign-in, which reintroduces a terminal.
  For your goals, prefer not to, and document the one-time `omp` auth step in
  your fork's README.

### 1c. Session + prompt loop
- `session/new` to open a session against the project root (tie to T3 Code's
  selected repo / worktree).
- `session/prompt` to send a user turn.
- Stream `session/update` notifications and render incrementally.
- `session/cancel` wired to T3 Code's stop control.

### 1d. Client-side request handlers (where the harness becomes GUI-native)
Implement the handlers omp calls back on your client. Route each to T3 Code's
existing subsystems. This is the highest-value work in the whole project.

- `fs/read_text_file` -> T3 Code's buffer/file layer, returning **unsaved**
  buffer content where present, so omp sees what you see.
- `fs/write_text_file` -> route through T3 Code's edit/diff pipeline so changes
  land in the diff viewer and the worktree, not silently on disk.
- `session/request_permission` -> T3 Code's approval UI (approve / reject /
  always-allow), matching how it gates other agents' tool calls.
- `terminal/create`, `terminal/output`, `terminal/wait_for_exit`,
  `terminal/kill`, `terminal/release` -> T3 Code's terminal/exec layer, so
  agent-run commands appear in the UI.

Advertise the matching `clientCapabilities` (`fs.readTextFile`,
`fs.writeTextFile`, `terminal`) in `initialize`. Without these, omp falls back to
writing directly and you lose the diff-viewer integration.

### 1e. Content + tool-call rendering
- Map ACP content blocks and tool-call cards to T3 Code's existing renderers:
  `agent_message_chunk`, `agent_thought_chunk`, `tool_call`,
  `tool_call_update`, `plan`.
- Handle `@path` file references as ACP content blocks (T3 Code likely already
  renders these for other agents; reuse).

### 1f. Commands, mode, and model
- Consume `available_commands_update` to populate T3 Code's command surface with
  omp's `/plan`, `/model`, `/compact`, etc.
- Mode: drive `session/set_mode` (or
  `session/set_session_config_option("mode", ...)`); reflect `current_mode_update`
  in the UI (for example a plan-mode indicator).
- Model: `/model` triggers a `config_option_update`; surface omp's role-based
  model selection (default, plan, smol, commit roles) in the UI, or just let it
  ride from omp config for now.

### 1g. Diffs and git flow
- Confirm omp writes (via 1d) surface in T3 Code's diff viewer.
- Confirm the commit / worktree / PR flow works unchanged on top of
  omp-authored changes. This should be free if 1d routes writes correctly,
  because T3 Code's git layer does not care which agent produced the diff.

### Phase 1 definition of done
- A prompt that triggers an LSP-correct rename across barrel files lands as a
  reviewable diff in T3 Code, with the rename propagated correctly.
- Tool calls show as cards; permissions prompt in the GUI; agent-run shell
  commands appear in the UI.
- Hashline reliability, hindsight memory, subagents, and model routing all work,
  because they live in omp and ride the same session stream.
- You never opened a terminal during the loop.

At this point you have the thing you asked for. Phase 2 is polish.

---

## Phase 2: Rich GUI panels (a la carte, only what you actually operate by hand)

These are the harness pieces that are *interactive* in omp's own TUI. Over ACP
they arrive as data and cards; a first-class GUI for them is bespoke work. Build
only the ones you want to drive manually.

| Panel | What feeds it | Build cost | Worth it? |
| --- | --- | --- | --- |
| Debugger (DAP stepper, breakpoint gutter, variables) | DAP tool-call events over the session stream | High | Only if you debug by hand vs letting the agent drive and reading results |
| Plan canvas (editable plan) | `plan` updates + mode events | Medium | Nice for big tasks |
| Subagent tree (live view of parallel subagents) | tool-call cards tagged by subagent | Medium | Useful once you lean on subagents |
| Session rewind browser | omp's `_omp/*` session-discovery methods over JSONL under `~/.omp/agent/sessions/` | Medium | Quality-of-life |
| Model-role picker | `config_option_update` | Low | Optional |

Each is incremental and isolated. You may build none of them and be happy.

### Hard limit to know now
Commands that exist only to drive omp's TUI are filtered out over ACP, and so
are `/login` and `/quit`. Text-handler commands survive. Anything TUI-only is
reachable only through Phase 2 UI you build against omp's `_omp/*` methods, or
not at all.

---

## 6. Reference skeletons

### 6.1 Phase 0 standalone recon client (illustrative)

```ts
// recon.ts  -  run: bun recon.ts   (or tsx/node)
// Purpose: drive `omp acp` directly, log everything, learn the handshake.
import { spawn } from "node:child_process";
import { ClientSideConnection } from "@zed-industries/agent-client-protocol";
// NOTE: verify the package + exact API. The protocol is also published as
// @agentclientprotocol/sdk. Check which is current before you build.

const child = spawn("omp", ["acp"], { stdio: ["pipe", "pipe", "inherit"] });

// The client implements the handlers the AGENT calls back on us.
const client = {
  async readTextFile(params: any) {
    console.log("[fs/read]", params.path);
    // Phase 0: read from disk. In T3 Code: return unsaved buffer if present.
    const fs = await import("node:fs/promises");
    return { content: await fs.readFile(params.path, "utf8") };
  },
  async writeTextFile(params: any) {
    console.log("[fs/write]", params.path, params.content.length, "bytes");
    // Phase 0: log only, do not actually write while exploring.
    return {};
  },
  async requestPermission(params: any) {
    console.log("[permission]", JSON.stringify(params).slice(0, 400));
    // Phase 0: auto-approve so the turn proceeds.
    return { outcome: { outcome: "selected", optionId: "allow" } };
  },
  // terminal/* handlers: stub for recon, real wiring in Phase 1d.
};

const conn = new ClientSideConnection(
  () => client,
  child.stdin,   // we WRITE to the agent's stdin
  child.stdout,  // we READ the agent's stdout
);

// Log the streamed session updates.
conn.onSessionUpdate?.((n: any) =>
  console.log("[update]", JSON.stringify(n).slice(0, 600)),
);

const init = await conn.initialize({
  protocolVersion: 1,
  clientCapabilities: {
    fs: { readTextFile: true, writeTextFile: true },
    terminal: true,
    // auth: { terminal: false }  // keep terminal-free; confirm omp's behavior
  },
});
console.log("INIT:", JSON.stringify(init, null, 2));

// Inspect advertised auth methods, then authenticate with the right one.
// await conn.authenticate({ methodId: "agent" });

const session = await conn.newSession({ cwd: process.cwd() });
console.log("SESSION:", session.sessionId);

await conn.prompt({
  sessionId: session.sessionId,
  prompt: [{ type: "text", text: "List the files in this repo and stop." }],
});
```

The exact method names on the connection object (`onSessionUpdate`, `newSession`
vs `session/new`, field casing) must be checked against the installed package
version. Treat the above as protocol-accurate pseudocode, not copy-paste truth.

### 6.2 Phase 1 adapter seam (illustrative shape)

```ts
// packages/<your-provider-pkg>/omp-adapter.ts
// Implements T3 Code's provider interface  <-- SEAM, confirm in Phase 0.2
//
// class OmpAdapter implements T3ProviderInterface {
//   spawn()        -> 1a: start `omp acp`, build ClientSideConnection
//   authenticate() -> 1b: methodId "agent", reuse ~/.omp
//   sendPrompt()   -> 1c: session/prompt, stream session/update to T3's thread
//   onReadFile()   -> 1d: return T3 unsaved buffer
//   onWriteFile()  -> 1d: route into T3 diff/worktree pipeline
//   onPermission() -> 1d: T3 approval UI
//   onTerminal*()  -> 1d: T3 exec layer
//   commands()     -> 1f: from available_commands_update
//   setMode()/setModel() -> 1f
//   dispose()      -> 1a: cancel, release, kill child
// }
```

Keep this adapter in its **own package** with the thinnest possible seam into
T3 Code's provider interface. That isolation is what makes the fork survivable
(see risks).

---

## 7. Risks and fork hygiene

- **Upstream velocity.** T3 Code is a fast alpha (v0.0.25, 1,511 commits, 106
  releases, not accepting contributions). A fork means rebase cost. Mitigate:
  keep your omp adapter in an isolated package; touch T3 Code's own files as
  little as possible; record any unavoidable core edits as patches under
  `patches/` so they reapply cleanly. Maintain a clean `upstream/main` tracking
  branch and rebase your adapter branch on top.
- **ACP version drift.** Negotiate via `protocolVersion` in `initialize` and
  branch on the negotiated value rather than assuming. Pin a known-good omp
  version in your README; bump deliberately.
- **Auth reintroducing a terminal.** If you advertise `auth.terminal`, omp may
  launch its TUI to sign in. Prefer the `agent` method plus a documented
  one-time `omp` auth, to keep the daily loop terminal-free.
- **TUI-filtered commands.** Some omp commands never cross ACP. Do not design UI
  that assumes they will. Phase 2 `_omp/*` work is the only route for those.
- **Licenses.** T3 Code is MIT, so your fork and redistribution are fine. omp's
  own license is separate and not MIT; since you run an ENK, confirm its terms
  before shipping a build, and prefer the user-installs-omp pattern so you never
  bundle it.

---

## 8. Validation

- **Per milestone:** the recon client (6.1) becomes your protocol test harness;
  keep it to reproduce any ACP-level bug outside the GUI.
- **Harness end-to-end (the headline test):** a rename across barrel files that
  only succeeds if the language server drove it. String-replace agents fail
  this; omp should pass, and the diff should show correct propagation.
- **Debug path:** ask omp to attach a debugger and report a runtime value; in
  Phase 1 it shows as cards, in Phase 2 as a stepper.
- **Diff/worktree:** confirm omp-authored writes are reviewable and commit/PR
  flow is unaffected.
- **Terminal-free check:** complete a full feature task without opening a
  terminal. That is the acceptance test for the entire project.

---

## 9. Sequencing

```
Phase 0   recon client + T3 provider interface note     [blocks everything]
   |
1a spawn/lifecycle
1b auth  ------------------\
1c session/prompt loop      > all unblock 1d
1d fs + terminal + perms   <-- highest value, do carefully
1e content/tool rendering
1f commands/mode/model
1g diffs/git (mostly free if 1d is right)
   |
Phase 1 DONE = usable daily, full functional harness, no terminal
   |
Phase 2   pick panels a la carte (debugger first if you debug by hand)
```

## 10. Open questions to close in Phase 0
1. T3 Code provider interface: exact methods/events an adapter implements.
2. OpenCode integration: ACP or SDK? (sizes Phase 1)
3. ACP TS package: `@zed-industries/agent-client-protocol` vs
   `@agentclientprotocol/sdk`; pin the current one and its `ClientSideConnection`
   API.
4. omp auth methods actually advertised with/without `auth.terminal`.
5. omp license terms for any redistributed build.

## First three actions
1. Fork T3 Code, get it building from source (`mise install`, `vp install`),
   confirm it runs against an existing agent (Codex or OpenCode).
2. Write and run `recon.ts` (6.1) against real `omp acp`; capture the logs.
3. Read the OpenCode provider in `packages/` and write the one-page interface
   note. That note tells you exactly how big Phase 1 is.
