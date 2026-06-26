# OMP ACP Adapter — Implementation Specification

> **Purpose:** Single source of truth for the five new files that wire `omp acp`
> into T3 Code as a first-class provider, modeled exactly on the Grok adapter.
> READ-ONLY reference — no code has been changed.

---

## 0. Structural overview

The Grok adapter is five files; OMP needs the same five:

| New file | Grok counterpart |
|---|---|
| `Drivers/OmpDriver.ts` | `Drivers/GrokDriver.ts` |
| `acp/OmpAcpSupport.ts` | `acp/GrokAcpSupport.ts` |
| `Layers/OmpAdapter.ts` | `Layers/GrokAdapter.ts` |
| `Layers/OmpProvider.ts` | `Layers/GrokProvider.ts` |
| `Services/OmpAdapter.ts` | `Services/GrokAdapter.ts` |

Sixth prerequisite: `OmpSettings` must be added to `@t3tools/contracts` (no
Grok-shaped schema exists yet for omp — see Gap list §3).

---

## 1. Per-file method/event inventory

### 1.1 `Services/OmpAdapter.ts`

Shape anchor only — no logic.

```ts
export interface OmpAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {}
```

Identical to `Services/GrokAdapter.ts` (line 16). One-liner; no decisions.

---

### 1.2 `acp/OmpAcpSupport.ts`

Parallel to `acp/GrokAcpSupport.ts`. Must export:

| Export | Signature | Notes |
|---|---|---|
| `buildOmpAcpSpawnInput` | `(ompSettings, cwd, environment?) => AcpSpawnInput` | Command = `ompSettings?.binaryPath \|\| "omp"`, args = **GAP** (see §3.1) |
| `makeOmpAcpRuntime` | `(input: OmpAcpRuntimeInput) => Effect<AcpSessionRuntime["Service"], AcpError, Scope>` | Calls `AcpSessionRuntime.layer({...input, spawn, authMethodId})` — no `XAiPromptCompletionRuntime` wrapper (that is Grok-specific, lines 74–76 of `GrokAcpSupport.ts`) |
| `resolveOmpAcpBaseModelId` | `(model: string \| null \| undefined) => string` | Normalises slug via `normalizeModelSlug(base, OMP_DRIVER_KIND)` — default fallback is **GAP** (§3.3) |
| `currentOmpModelIdFromSessionSetup` | `(sessionSetupResult: LoadSessionResponse \| NewSessionResponse \| ResumeSessionResponse) => string \| undefined` | `sessionSetupResult.models?.currentModelId?.trim() \|\| undefined` — identical pattern to `GrokAcpSupport.ts:84–91` |
| `applyOmpAcpModelSelection` | `<E>(input: {...}) => Effect<string \| undefined, E>` | Identical shape to `applyGrokAcpModelSelection` — calls `runtime.setSessionModel` |

`OmpAcpRuntimeInput` interface: omits `authMethodId | clientCapabilities | spawn`
from `AcpSessionRuntimeOptions`, adds `childProcessSpawner`, `ompSettings`, and
optional `environment` — identical structure to `GrokAcpRuntimeInput`
(`GrokAcpSupport.ts:22–29`).

Key difference from Grok: no environment-variable auth split. Auth methodId is
a single constant (`"agent"` or omp's actual value — see §3.2). The Grok
two-branch logic at `GrokAcpSupport.ts:47–51` collapses to a constant.

---

### 1.3 `Layers/OmpAdapter.ts`

The largest file (~1 000 lines). Parallel to `Layers/GrokAdapter.ts`.

**Session context struct (`OmpSessionContext`)** — same fields as
`GrokSessionContext` (lines 101–121):

```ts
interface OmpSessionContext {
  readonly threadId: ThreadId;
  readonly acpSessionId: string;
  session: ProviderSession;
  readonly scope: Scope.Closeable;
  readonly acp: AcpSessionRuntime["Service"];
  notificationFiber: Fiber<void, never> | undefined;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  turns: Array<{ id: TurnId; items: Array<unknown> }>;
  lastPlanFingerprint: string | undefined;
  activeTurnId: TurnId | undefined;
  interruptedTurnIds: Set<TurnId>;
  promptsInFlight: number;
  currentModelId: string | undefined;
  stopped: boolean;
}
```

**`makeOmpAdapter(ompSettings, options?)` must implement all methods of
`OmpAdapterShape`:**

| Method | Grok location | OMP differences |
|---|---|---|
| `startSession` | lines 530–909 | Replace `makeGrokAcpRuntime` → `makeOmpAcpRuntime`; replace `applyGrokAcpModelSelection` → `applyOmpAcpModelSelection`; replace `resolveGrokAcpBaseModelId` → `resolveOmpAcpBaseModelId`; **drop** the two `handleExtRequest` calls for `"x.ai/ask_user_question"` / `"_x.ai/ask_user_question"` (lines 611–664 — those are xAI-specific); keep `handleRequestPermission` block (lines 665–729) verbatim; keep full event-stream loop (lines 783–879) verbatim |
| `sendTurn` | lines 911–1272 | Same body; swap model helpers |
| `interruptTurn` | lines 1274–1355 | Identical |
| `respondToRequest` | lines 1357–1373 | Identical |
| `respondToUserInput` | lines 1375–1391 | **May be removed or stubbed** if omp does not emit an ask-user-question extension request (see §3.5) |
| `readThread` | lines 1393–1397 | Identical |
| `rollbackThread` | lines 1399–1414 | Stub with "OMP ACP sessions do not support provider-side rollback yet." |
| `stopSession` | lines 1416–1423 | Identical |
| `listSessions` | lines 1425–1426 | Identical |
| `hasSession` | lines 1428–1432 | Identical |
| `stopAll` | lines 1434–1435 | Identical |
| `streamEvents` (field) | line 1444 | Identical |

**Returned object capabilities:**

```ts
capabilities: { sessionModelSwitch: "in-session" }  // verify against omp; see §3.4
```

**Resume cursor** — Grok stores `{ schemaVersion: 1, sessionId }` in
`resumeCursor` (`GrokAdapter.ts:757–760`). OMP must do the same; the
`parseOmpResume` helper is a direct copy of `parseGrokResume` (lines 175–180)
with the provider name updated.

**`PROVIDER` constant:** `ProviderDriverKind.make("omp")`.

**`OMP_RESUME_VERSION`:** `1 as const` (matching Grok's pattern).

---

### 1.4 `Layers/OmpProvider.ts`

Parallel to `Layers/GrokProvider.ts`. Must export:

| Export | Purpose | Notes |
|---|---|---|
| `buildInitialOmpProviderSnapshot(settings)` | Synchronous placeholder snapshot | Same disabled/enabled branches as Grok lines 57–93 |
| `checkOmpProviderStatus(settings, env?)` | Status probe: binary present? auth ok? model discovery | Runs `omp --version` (or equivalent — **GAP §3.6**), then `discoverOmpModelsViaAcp` |
| `enrichOmpSnapshot(input)` | Optional version-advisory enrichment | Can start as a no-op; Grok lines 316–337 |

**`OMP_PRESENTATION` constant** — adapt from Grok's `GROK_PRESENTATION`
(lines 34–39):

```ts
const OMP_PRESENTATION = {
  displayName: "Omp",
  badgeLabel: "Early Access",     // TODO: adjust after product decision
  showInteractionModeToggle: false,
  requiresNewThreadForModelChange: true,  // TODO: confirm with omp session semantics
} as const;
```

**Built-in models** — `OMP_BUILT_IN_MODELS` is a single fallback entry
(like `GROK_BUILT_IN_MODELS` at line 48–55). Slug and display name are
**GAP §3.3**.

**`discoverOmpModelsViaAcp`** — same pattern as Grok lines 132–147: spawns
`makeOmpAcpRuntime`, calls `acp.start()`, reads `started.sessionSetupResult.models`.

**`runOmpVersionCommand`** — runs `omp --version` (or `omp version` or
`omp -v` — **GAP §3.6**).

---

### 1.5 `Drivers/OmpDriver.ts`

Parallel to `Drivers/GrokDriver.ts`. Must export:

| Export | Shape |
|---|---|
| `OmpDriver` | `ProviderDriver<OmpSettings, OmpDriverEnv>` |
| `OmpDriverEnv` | Union of Effect services: `ChildProcessSpawner \| Crypto \| FileSystem \| HttpClient \| Path \| ProviderEventLoggers \| ServerConfig \| ServerSettingsService` |

**`OmpDriver.create({instanceId, displayName, accentColor, environment, enabled, config})`**
orchestration (parallel to `GrokDriver.ts:85–161`):

1. `mergeProviderInstanceEnvironment(environment)`
2. `defaultProviderContinuationIdentity({ driverKind: OMP_DRIVER_KIND, instanceId })`
3. `makeOmpAdapter(effectiveConfig, { environment, nativeEventLogger, instanceId })`
4. `makeOmpTextGeneration(...)` — **GAP: needs its own TextGeneration file** (see §3.7)
5. `checkOmpProviderStatus(...)` for the probe
6. `makeManagedServerProvider(...)` with `buildInitialOmpProviderSnapshot` and
   `enrichOmpSnapshot`
7. Return `ProviderInstance` with all fields

**Static metadata:**

```ts
metadata: {
  displayName: "Omp",
  supportsMultipleInstances: true,  // TODO: confirm; Grok allows this
}
```

**`SNAPSHOT_REFRESH_INTERVAL`:** `Duration.minutes(5)` (Grok default).

---

## 2. Reused as-is from the generic runtime

These ACP behaviors are fully handled by `AcpSessionRuntime`
(`acp/AcpSessionRuntime.ts`) and `AcpRuntimeModel.ts` / `AcpCoreRuntimeEvents.ts`.
The OMP adapter inherits them by calling `makeOmpAcpRuntime` exactly as Grok calls
`makeGrokAcpRuntime`. **Do not reimplement any of these.**

### 2.1 Wire protocol (process spawn + JSON-RPC framing)

`AcpSessionRuntime.make` (lines 268–798) handles:

- Spawning the child process via `ChildProcessSpawner` (lines 321–343)
- Building the `EffectAcpClient.layerChildProcess` connection (lines 345–357)
- All JSON-RPC framing (request/response correlation, error mapping)

### 2.2 ACP handshake sequence

`startOnce` (lines 519–644) executes the full handshake:

- `initialize` with negotiated `clientCapabilities` (lines 520–530)
- `authenticate` with `authMethodId` (lines 532–540)
- `session/load` (resume path, lines 547–620) with replay-idle gate logic
- `session/new` (fresh path, lines 622–633)
- `parseSessionModeState` and `configOptionsRef` population (lines 635–636)

### 2.3 `session/update` stream parsing

`handleSessionUpdate` (lines 832–899) and `parseSessionUpdateEvent`
(`AcpRuntimeModel.ts:508–582`) parse all standard update variants:

- `current_mode_update` → `ModeChanged`
- `plan` → `PlanUpdated`
- `tool_call` / `tool_call_update` → `ToolCallUpdated`
- `agent_message_chunk` → `ContentDelta`

Assistant-item segment tracking (open/close) is also fully automatic (lines
927–988).

### 2.4 Tool-call state merging and presentation

`mergeToolCallState`, `makeToolCallState`, `deriveToolActivityPresentation`
(`AcpRuntimeModel.ts:308–425`) — the OMP adapter's event-loop switch-case
already receives a fully merged `AcpToolCallState`; no extra parsing is needed.

### 2.5 Permission-request parsing

`parsePermissionRequest` (`AcpRuntimeModel.ts:427–454`) converts the raw
`session/request_permission` params into a typed `AcpPermissionRequest`. The
OMP adapter calls this the same way Grok does (`GrokAdapter.ts:680`).

### 2.6 ProviderRuntimeEvent factories

All six event-builder functions in `AcpCoreRuntimeEvents.ts` are generic:

- `makeAcpRequestOpenedEvent` (line 79)
- `makeAcpRequestResolvedEvent` (line 112)
- `makeAcpPlanUpdatedEvent` (line 135)
- `makeAcpToolCallEvent` (line 160)
- `makeAcpAssistantItemEvent` (line 194)
- `makeAcpContentDeltaEvent` (line 216)

OMP calls them with `provider: PROVIDER` where `PROVIDER = ProviderDriverKind.make("omp")`.

### 2.7 Prompt serialization and cancel

`promptSerializationSemaphore`, `cancel` logic with `activePromptFiberRef`,
and `drainEvents` barrier pattern (`AcpSessionRuntime.ts:707–760`) are all
inside the generic runtime.

### 2.8 Config option and model management

`setConfigOption`, `setMode`, `setModel`, `setSessionModel`
(`AcpSessionRuntime.ts:481–793`) are all generic. The adapter only needs to
call `applyOmpAcpModelSelection` (which calls `setSessionModel`) at the right
moments — identical to how Grok calls `applyGrokAcpModelSelection`.

### 2.9 ACP error mapping

`mapAcpToAdapterError` (`acp/AcpAdapterSupport.ts`) is generic; OMP passes
`PROVIDER` and the method name, same as Grok.

### 2.10 Native event logging

`makeAcpNativeLoggerFactory` and `AcpNativeLogging.ts` are generic;
OMP passes the same `acpNativeLoggers` options object.

---

## 3. GAP / needs recon list

These are the exact fields whose values cannot be determined without running
`omp acp`. Each entry names the file and line where the unknown is consumed.

### 3.1 Spawn command and args

**Unknown:** What arguments does `omp` accept for its ACP server mode?
Grok uses `["agent", "stdio"]` (`GrokAcpSupport.ts:38–40`).
Cursor uses `["acp"]` (`CursorAcpSupport.ts:35–43`).

**Consumed at:** `OmpAcpSupport.ts` → `buildOmpAcpSpawnInput` → `args` field →
passed to `AcpSessionRuntime.make` at `AcpSessionRuntime.ts:327–343` as
`options.spawn.args`.

**Recon action:** Run `omp --help` or `omp acp --help`; confirm the subcommand
that starts an ACP stdio server.

---

### 3.2 Auth `methodId`

**Unknown:** What string does omp accept in `authenticate({ methodId: "???" })`?
Grok uses `"xai.api_key"` or `"cached_token"` depending on `XAI_API_KEY`
(`GrokAcpSupport.ts:13–17, 47–51`). Cursor uses `"cursor_login"`
(`CursorAcpSupport.ts:54`).

**Consumed at:** `OmpAcpSupport.ts` → constant passed to `AcpSessionRuntime.layer`
as `authMethodId` → used in `startOnce` at `AcpSessionRuntime.ts:532–540`.

**Recon action:** Run the Phase-0 recon client; inspect the `authenticate`
response. Confirm whether omp offers multiple methods (e.g. `"agent"` when
`XAI_API_KEY`-equivalent is absent vs. an API-key method when present) or a
single method.

---

### 3.3 Default fallback model slug

**Unknown:** What model identifier does omp return for
`sessionSetupResult.models?.currentModelId` on a fresh session? Grok defaults
to `"grok-build"` when the field is absent (`GrokAcpSupport.ts:80–81`).

**Consumed at:**
- `OmpAcpSupport.ts` → `resolveOmpAcpBaseModelId` → the `|| "omp-build"` fallback
- `Layers/OmpProvider.ts` → `OMP_BUILT_IN_MODELS[0].slug`
- `Layers/OmpAdapter.ts` → `resolveOmpAcpBaseModelId(boundModelId)` in
  `startSession` (parallel to `GrokAdapter.ts:755`)

**Recon action:** Start a session; print `started.sessionSetupResult.models`.
Note `currentModelId` and `availableModels[*].modelId`.

---

### 3.4 `session/update` variants omp emits

**Unknown:** Which `sessionUpdate` discriminant values does omp actually produce?
The generic runtime handles `current_mode_update | plan | tool_call |
tool_call_update | agent_message_chunk` (`AcpRuntimeModel.ts:516–578`). OMP
may emit all of these, a subset, or additional vendor-specific variants.

**Consumed at:** `AcpRuntimeModel.ts:parseSessionUpdateEvent` (line 508) —
the `switch (upd.sessionUpdate)` default branch silently drops unknown variants.
If omp uses a different discriminant name for text streaming (e.g. a different
value than `agent_message_chunk`), content deltas will be swallowed silently.

**Recon action:** Run a real edit prompt; capture all raw `session/update`
frames; enumerate the `update.sessionUpdate` values present.

---

### 3.5 Vendor extension requests (ask-user equivalents)

**Unknown:** Does omp send any `handleExtRequest` calls back to the client?
Grok sends `"x.ai/ask_user_question"` and `"_x.ai/ask_user_question"`
(`GrokAdapter.ts:611–664`), which are registered as handlers and surface as
`user-input.requested` events.

**Consumed at:** If omp has an equivalent, it must be registered in
`startSession` the same way (before `acp.start()` is called), and
`respondToUserInput` must remain implemented. If omp has no such extension,
`respondToUserInput` may be stubbed with an appropriate error.

**Recon action:** Complete a turn that might trigger user confirmation (e.g. a
destructive refactor). Check whether omp calls back on any `x-*` or
`_omp/*` method before `session/request_permission`.

---

### 3.6 Version probe command

**Unknown:** How do you check omp's version from the CLI?
Grok uses `grok --version` (`GrokProvider.ts:154–165`).

**Consumed at:** `Layers/OmpProvider.ts` → `runOmpVersionCommand` → `args`
passed to `spawnAndCollect`.

**Recon action:** Run `omp --version` and `omp version` and `omp -v`; see which
exits 0 and produces parseable version output.

---

### 3.7 Text generation API

**Unknown:** Does omp expose a non-ACP REST or RPC endpoint for commit message /
PR content / branch name generation? Grok has `makeGrokTextGeneration`
(`GrokTextGeneration.ts`); it calls xAI's HTTP API directly using `grokSettings`.

**Consumed at:** `Drivers/OmpDriver.ts` → `makeOmpTextGeneration(effectiveConfig, processEnv)`
(parallel to `GrokDriver.ts:113`).

**Recon action:** Check omp's documentation or `omp --help` for a generation or
completion subcommand. If none exists, the `textGeneration` field in
`ProviderInstance` can be set to a no-op / pass-through implementation.

---

### 3.8 `clientCapabilities` to advertise

**Unknown:** Should the OMP adapter advertise `fs`, `terminal`, `elicitation`,
or `auth` capabilities in `initialize`?

Grok passes no `clientCapabilities` override; the runtime defaults to
`{ fs: { readTextFile: false, writeTextFile: false }, terminal: false }`
(`AcpSessionRuntime.ts:394–406`).

Cursor passes `CURSOR_PARAMETERIZED_MODEL_PICKER_CAPABILITIES`
(`CursorAcpSupport.ts:54`).

**Consumed at:** `OmpAcpSupport.ts` → `clientCapabilities` field of
`AcpSessionRuntime.layer(...)` → `AcpSessionRuntime.ts:394–406`
(`initializeClientCapabilities`).

**Recon action:** Run Phase-0 recon client with each capability flag set to `true`;
observe which callbacks omp actually sends (fs/write_text_file is the most
important — it routes diffs into T3 Code's diff viewer instead of straight to disk).

---

### 3.9 `OmpSettings` contract schema

**Unknown:** The `OmpSettings` Effect Schema (equivalent to
`packages/contracts/src/…/GrokSettings`) does not exist yet.

**Consumed at:**
- `Drivers/OmpDriver.ts:1` — `import { OmpSettings } from "@t3tools/contracts"`
- `Drivers/OmpDriver.ts:configSchema` — `OmpSettings`
- `Layers/OmpAdapter.ts:makeOmpAdapter(ompSettings: OmpSettings, ...)`
- `Layers/OmpProvider.ts:checkOmpProviderStatus(settings: OmpSettings, ...)`

**Minimum required fields** (inferred from Grok):
```ts
OmpSettings = Schema.Struct({
  enabled: Schema.Boolean,
  binaryPath: Schema.optional(Schema.String),   // custom `omp` binary path
  customModels: Schema.optional(Schema.Array(Schema.String)),
})
```

Additional fields depend on recon (API key env var name, OAuth referrer, etc.).

---

## 4. `Layers/OmpAdapter.ts` skeleton

Function signatures with `// TODO` markers for all GAP-dependent code.
Implementation bodies are **not** included here — Opus fills those.

```ts
import {
  ApprovalRequestId,
  type OmpSettings,        // TODO: add to @t3tools/contracts first
  EventId,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderUserInputAnswers,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeRequestId,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { mapAcpToAdapterError } from "../acp/AcpAdapterSupport.ts";
import type * as AcpSessionRuntime from "../acp/AcpSessionRuntime.ts";
import {
  makeAcpAssistantItemEvent,
  makeAcpContentDeltaEvent,
  makeAcpPlanUpdatedEvent,
  makeAcpRequestOpenedEvent,
  makeAcpRequestResolvedEvent,
  makeAcpToolCallEvent,
} from "../acp/AcpCoreRuntimeEvents.ts";
import { parsePermissionRequest } from "../acp/AcpRuntimeModel.ts";
import { makeAcpNativeLoggerFactory } from "../acp/AcpNativeLogging.ts";
import {
  applyOmpAcpModelSelection,
  currentOmpModelIdFromSessionSetup,
  makeOmpAcpRuntime,
  resolveOmpAcpBaseModelId,
} from "../acp/OmpAcpSupport.ts";
import { type OmpAdapterShape } from "../Services/OmpAdapter.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";

// ─── Constants ────────────────────────────────────────────────────────────────

const PROVIDER = ProviderDriverKind.make("omp");
const OMP_RESUME_VERSION = 1 as const;

// ─── Options / context types ──────────────────────────────────────────────────

export interface OmpAdapterLiveOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  readonly instanceId?: ProviderInstanceId;
}

/** Internal per-session state — mirrors GrokSessionContext exactly. */
interface OmpSessionContext {
  readonly threadId: ThreadId;
  readonly acpSessionId: string;
  session: ProviderSession;
  readonly scope: Scope.Closeable;
  readonly acp: AcpSessionRuntime.AcpSessionRuntime["Service"];
  notificationFiber: Fiber.Fiber<void, never> | undefined;
  readonly pendingApprovals: Map<ApprovalRequestId, { readonly decision: Deferred.Deferred<ProviderApprovalDecision> }>;
  readonly pendingUserInputs: Map<ApprovalRequestId, { readonly resolution: Deferred.Deferred<PendingUserInputResolution> }>;
  turns: Array<{ id: TurnId; items: Array<unknown> }>;
  lastPlanFingerprint: string | undefined;
  activeTurnId: TurnId | undefined;
  interruptedTurnIds: Set<TurnId>;
  promptsInFlight: number;
  currentModelId: string | undefined;
  stopped: boolean;
}

type PendingUserInputResolution =
  | { readonly _tag: "answered"; readonly answers: ProviderUserInputAnswers }
  | { readonly _tag: "cancelled" };

// ─── Resume cursor ────────────────────────────────────────────────────────────

/** Identical structure to parseGrokResume (GrokAdapter.ts:175–180). */
function parseOmpResume(raw: unknown): { sessionId: string } | undefined {
  // TODO: copy-paste from GrokAdapter.ts:175–180, change schemaVersion guard constant name
}

// ─── Permission option selection ──────────────────────────────────────────────

/**
 * Maps a ProviderApprovalDecision to an ACP optionId.
 * TODO: copy verbatim from GrokAdapter.ts:182–203 — no OMP-specific logic.
 */
function selectPermissionOptionId(
  request: EffectAcpSchema.RequestPermissionRequest,
  decision: Exclude<ProviderApprovalDecision, "cancel">,
): string | undefined { /* TODO */ }

function selectAutoApprovedPermissionOption(
  request: EffectAcpSchema.RequestPermissionRequest,
): string | undefined { /* TODO */ }

// ─── Main factory ─────────────────────────────────────────────────────────────

export function makeOmpAdapter(ompSettings: OmpSettings, options?: OmpAdapterLiveOptions) {
  return Effect.gen(function* () {
    // ── Infrastructure (copy from GrokAdapter.ts:228–261) ──
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("omp");
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const serverConfig = yield* Effect.service(ServerConfig);
    const crypto = yield* Crypto.Crypto;
    // ... nativeEventLogger, makeAcpNativeLoggers, sessions map, etc.
    // TODO: copy GrokAdapter.ts:228–295 verbatim; replace "Grok" strings with "OMP"

    // ── startSession ──────────────────────────────────────────────────────────
    const startSession: OmpAdapterShape["startSession"] = (input) =>
      // TODO: copy GrokAdapter.ts:530–909 with these replacements:
      //   makeGrokAcpRuntime  → makeOmpAcpRuntime
      //   resolveGrokAcpBaseModelId → resolveOmpAcpBaseModelId
      //   applyGrokAcpModelSelection → applyOmpAcpModelSelection
      //   currentGrokModelIdFromSessionSetup → currentOmpModelIdFromSessionSetup
      //   GROK_RESUME_VERSION → OMP_RESUME_VERSION
      //   DROP lines 611–664 (x.ai/ask_user_question handlers — xAI-specific)
      //   TODO: replace "Grok" in all log/error strings with "OMP"
      //   TODO §3.2: confirm authMethodId before implementing makeOmpAcpRuntime call
      //   TODO §3.5: if omp HAS a user-question extension, re-add the handleExtRequest block here
      Effect.void as any; // placeholder

    // ── sendTurn ──────────────────────────────────────────────────────────────
    const sendTurn: OmpAdapterShape["sendTurn"] = (input) =>
      // TODO: copy GrokAdapter.ts:911–1272 verbatim; swap model helpers:
      //   resolveGrokAcpBaseModelId → resolveOmpAcpBaseModelId
      //   applyGrokAcpModelSelection → applyOmpAcpModelSelection
      //   All "Grok" error/log strings → "OMP"
      Effect.void as any; // placeholder

    // ── interruptTurn ─────────────────────────────────────────────────────────
    const interruptTurn: OmpAdapterShape["interruptTurn"] = (threadId, turnId) =>
      // TODO: copy GrokAdapter.ts:1274–1355 verbatim; update "Grok" strings to "OMP"
      Effect.void as any; // placeholder

    // ── respondToRequest ──────────────────────────────────────────────────────
    const respondToRequest: OmpAdapterShape["respondToRequest"] = (
      threadId,
      requestId,
      decision,
    ) =>
      // TODO: copy GrokAdapter.ts:1357–1373 verbatim
      Effect.void as any; // placeholder

    // ── respondToUserInput ────────────────────────────────────────────────────
    const respondToUserInput: OmpAdapterShape["respondToUserInput"] = (
      threadId,
      requestId,
      answers,
    ) =>
      // TODO §3.5: if omp has NO ask-user-question extension, replace with:
      //   Effect.fail(new ProviderAdapterRequestError({ provider: PROVIDER,
      //     method: "respondToUserInput",
      //     detail: "OMP ACP does not support user-input requests." }))
      // If omp DOES have an equivalent extension, copy GrokAdapter.ts:1375–1391
      Effect.void as any; // placeholder

    // ── readThread ────────────────────────────────────────────────────────────
    const readThread: OmpAdapterShape["readThread"] = (threadId) =>
      // TODO: copy GrokAdapter.ts:1393–1397 verbatim
      Effect.void as any; // placeholder

    // ── rollbackThread ────────────────────────────────────────────────────────
    const rollbackThread: OmpAdapterShape["rollbackThread"] = (threadId, numTurns) =>
      // TODO: copy GrokAdapter.ts:1399–1414; update error string to "OMP ACP sessions..."
      Effect.void as any; // placeholder

    // ── stopSession ───────────────────────────────────────────────────────────
    const stopSession: OmpAdapterShape["stopSession"] = (threadId) =>
      // TODO: copy GrokAdapter.ts:1416–1423 verbatim
      Effect.void as any; // placeholder

    // ── listSessions / hasSession / stopAll ───────────────────────────────────
    const listSessions: OmpAdapterShape["listSessions"] = () =>
      // TODO: copy GrokAdapter.ts:1425–1426 verbatim
      Effect.void as any; // placeholder

    const hasSession: OmpAdapterShape["hasSession"] = (threadId) =>
      // TODO: copy GrokAdapter.ts:1428–1432 verbatim
      Effect.void as any; // placeholder

    const stopAll: OmpAdapterShape["stopAll"] = () =>
      // TODO: copy GrokAdapter.ts:1434–1435 verbatim
      Effect.void as any; // placeholder

    // ── Finalizer + event stream ──────────────────────────────────────────────
    // TODO: copy GrokAdapter.ts:1437–1444 verbatim (addFinalizer + streamEvents)

    return {
      provider: PROVIDER,
      capabilities: {
        // TODO §3.4: confirm omp supports in-session model switching before
        //   leaving this as "in-session"; otherwise set "unsupported"
        sessionModelSwitch: "in-session" as const,
      },
      startSession,
      sendTurn,
      interruptTurn,
      readThread,
      rollbackThread,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      stopAll,
      streamEvents: null as any, // TODO: Stream.fromPubSub(runtimeEventPubSub)
    } satisfies OmpAdapterShape;
  });
}
```

---

## 5. Contracts prerequisite checklist

Before any of the five files can compile, the following must be added to
`packages/contracts/src/`:

1. **`OmpSettings` schema** (see §3.9) — minimum: `{ enabled, binaryPath?, customModels? }`
2. **`ProviderDriverKind.make("omp")`** must be accepted — verify the `ProviderDriverKind`
   branded type is an open string brand (it is; `ProviderDriverKind.make("grok")` uses
   the same call at `GrokAdapter.ts:74`)
3. **Export** `OmpSettings` from `@t3tools/contracts` index

---

## 6. Build order

```
1. packages/contracts: add OmpSettings schema + export
2. acp/OmpAcpSupport.ts         (no deps on Layers)
3. Services/OmpAdapter.ts        (one-liner; no deps)
4. Layers/OmpProvider.ts         (depends on OmpAcpSupport)
5. Layers/OmpAdapter.ts          (depends on OmpAcpSupport, Services/OmpAdapter)
6. Drivers/OmpDriver.ts          (depends on all four above + textGeneration/OmpTextGeneration.ts)
7. textGeneration/OmpTextGeneration.ts   (can be a stub; unblocks Driver)
8. Register OmpDriver in the driver registry (find where GrokDriver is registered)
```

Step 8 location: search for `GrokDriver` in `Layers/ProviderAdapterRegistry.ts`
and the equivalent driver-registration file to find the exact insertion point.

---

*Spec authored against codebase state at git HEAD `52b04b94` (2026-06-26).
All line references are to the files as read above.*
