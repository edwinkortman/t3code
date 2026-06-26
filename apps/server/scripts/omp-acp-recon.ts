#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off
//
// OMP ACP Recon Client
// ====================
// Drives `omp acp` (an ACP agent over stdio) and logs every protocol exchange
// so we can learn omp's real ACP handshake.
//
// Run command:
//   node scripts/omp-acp-recon.ts
//
// Or, if the repo ships tsx / tsgo in devDeps you can run TypeScript directly:
//   pnpm tsx scripts/omp-acp-recon.ts
//   pnpm tsgo scripts/omp-acp-recon.ts
//
// The scripts package uses `node scripts/xxx.ts` (Node >=24 which supports
// --experimental-strip-types natively), so:
//   node --experimental-strip-types scripts/omp-acp-recon.ts
//
// Or simply: node scripts/omp-acp-recon.ts  (Node 24 auto-strips types)

import * as NodeFSPromises from "node:fs/promises";

import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as EffectAcpClient from "effect-acp/client";
import type * as AcpSchema from "effect-acp/schema";
import type * as AcpProtocol from "effect-acp/protocol";
import * as AcpErrors from "effect-acp/errors";

// ---------------------------------------------------------------------------
// Logging helpers
// ---------------------------------------------------------------------------

const REPO_ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

function truncate(value: unknown, maxLen = 800): string {
  const s = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + `\n… [truncated ${s.length - maxLen} chars]`;
}

// All logging routes through Effect.log so it obeys the apps/server typecheck
// (no console / no `new Date()`); Effect.log already prepends a timestamp and
// prints to the terminal via the default logger under NodeRuntime.runMain.
function log(tag: string, payload?: unknown): Effect.Effect<void> {
  return payload === undefined
    ? Effect.log(`[${tag}]`)
    : Effect.log(`[${tag}]\n${truncate(payload)}\n`);
}

// ---------------------------------------------------------------------------
// Main program
// ---------------------------------------------------------------------------

const program = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  yield* log("RECON", "Spawning: omp acp");

  // Spawn `omp acp` — omp is expected to be on $PATH
  const child = yield* spawner.spawn(
    ChildProcess.make("omp", ["acp"], {
      cwd: REPO_ROOT,
      env: process.env as Record<string, string>,
    }),
  ).pipe(
    Effect.tapError((err) => log("SPAWN_ERROR", err)),
  );

  yield* log("RECON", "Process spawned, building ACP client layer…");

  // Build the ACP client layer from the child process handle.
  // logIncoming/logOutgoing capture every raw JSONL line from/to omp.
  const acpLayer = EffectAcpClient.layerChildProcess(child, {
    logIncoming: true,
    logOutgoing: true,
    logger: (event: AcpProtocol.AcpProtocolLogEvent) =>
      log(
        `PROTO:${event.direction.toUpperCase()}:${event.stage.toUpperCase()}`,
        event.payload,
      ),
  });

  const result = yield* Effect.gen(function* () {
    const acp = yield* EffectAcpClient.AcpClient;

    // ------------------------------------------------------------------
    // 1. Register client-side handlers BEFORE initialize so they are
    //    ready to handle any inbound requests that arrive immediately.
    // ------------------------------------------------------------------

    // fs/read_text_file — return real file contents from disk
    yield* acp.handleReadTextFile((req: AcpSchema.ReadTextFileRequest) =>
      Effect.gen(function* () {
        yield* log("HANDLER:fs/read_text_file", { path: req.path });
        const text = yield* Effect.tryPromise({
          try: () => NodeFSPromises.readFile(req.path, "utf-8"),
          catch: (err) =>
            AcpErrors.AcpRequestError.internalError(
              `fs/read_text_file failed: ${String(err)}`,
              undefined,
              { method: "fs/read_text_file" },
            ),
        });
        yield* log("HANDLER:fs/read_text_file:RESULT", {
          path: req.path,
          byteLength: text.length,
        });
        // ReadTextFileResponse expects { content: string }
        return { content: text };
      }),
    );

    // fs/write_text_file — LOG ONLY, do not write
    yield* acp.handleWriteTextFile((req: AcpSchema.WriteTextFileRequest) =>
      // Resolves to void, which the handler signature permits.
      log("HANDLER:fs/write_text_file:LOG_ONLY", {
        path: req.path,
        byteLength: req.content.length,
      }),
    );

    // session/request_permission — auto-approve everything
    yield* acp.handleRequestPermission((req: AcpSchema.RequestPermissionRequest) =>
      log("HANDLER:session/request_permission:AUTO_APPROVE", req).pipe(
        Effect.as({
          outcome: {
            outcome: "selected" as const,
            optionId: "allow",
          },
        }),
      ),
    );

    // terminal/create — stub + log.
    // Clock.currentTimeMillis replaces Date.now() for the stub terminal id.
    yield* acp.handleCreateTerminal((req: AcpSchema.CreateTerminalRequest) =>
      Effect.gen(function* () {
        yield* log("HANDLER:terminal/create:STUB", req);
        const now = yield* Clock.currentTimeMillis;
        return { terminalId: `stub-terminal-${now}` };
      }),
    );

    // terminal/output — stub + log
    // TerminalOutputResponse requires { output: string, truncated: boolean }
    yield* acp.handleTerminalOutput((req: AcpSchema.TerminalOutputRequest) =>
      log("HANDLER:terminal/output:STUB", { terminalId: req.terminalId }).pipe(
        Effect.as({ output: "", truncated: false }),
      ),
    );

    // terminal/wait_for_exit — stub + log
    yield* acp.handleTerminalWaitForExit((req: AcpSchema.WaitForTerminalExitRequest) =>
      log("HANDLER:terminal/wait_for_exit:STUB", {
        terminalId: req.terminalId,
      }).pipe(Effect.as({ exitCode: 0 })),
    );

    // terminal/kill — stub + log (resolves to void)
    yield* acp.handleTerminalKill((req: AcpSchema.KillTerminalRequest) =>
      log("HANDLER:terminal/kill:STUB", { terminalId: req.terminalId }),
    );

    // terminal/release — stub + log (resolves to void)
    yield* acp.handleTerminalRelease((req: AcpSchema.ReleaseTerminalRequest) =>
      log("HANDLER:terminal/release:STUB", { terminalId: req.terminalId }),
    );

    // session/update notifications — log every one
    yield* acp.handleSessionUpdate((notification: AcpSchema.SessionNotification) =>
      log("NOTIFICATION:session/update", notification),
    );

    // Catch-all for unknown extension notifications (e.g. _x.ai/* from Grok)
    yield* acp.handleUnknownExtNotification((method: string, params: unknown) =>
      log(`NOTIFICATION:ext:${method}`, params),
    );

    // Catch-all for unknown extension requests
    yield* acp.handleUnknownExtRequest((method: string, params: unknown) =>
      // Return empty object as a best-effort stub; agent might reject it.
      log(`REQUEST:ext:${method}`, params).pipe(Effect.as({})),
    );

    // ------------------------------------------------------------------
    // 2. initialize — advertise fs.readTextFile, fs.writeTextFile, terminal
    // ------------------------------------------------------------------
    yield* log("STEP", "initialize");
    const initResult = yield* acp.agent.initialize({
      protocolVersion: 1,
      clientCapabilities: {
        fs: {
          readTextFile: true,
          writeTextFile: true,
        },
        terminal: true,
      },
      clientInfo: {
        name: "omp-acp-recon",
        version: "0.0.1",
      },
    });

    yield* log("RESULT:initialize", initResult);

    // ------------------------------------------------------------------
    // 3. Check if authentication is required and authenticate if needed.
    //    omp may advertise authMethods; if so try the first one.
    //    If initialize returns no authMethods we skip authentication.
    // ------------------------------------------------------------------
    const authMethods = (initResult as Record<string, unknown>).authMethods;
    yield* log("INFO:authMethods", authMethods ?? "(none advertised)");

    if (Array.isArray(authMethods) && authMethods.length > 0) {
      const firstMethod = authMethods[0];
      const methodId =
        typeof firstMethod === "object" && firstMethod !== null && "id" in firstMethod
          ? String(firstMethod.id)
          : "default";
      yield* log("STEP", `authenticate with methodId=${methodId}`);
      const authResult = yield* acp.agent.authenticate({ methodId }).pipe(
        Effect.catch((err) => log("WARN:authenticate:FAILED", err).pipe(Effect.as(null))),
      );
      if (authResult !== null) {
        yield* log("RESULT:authenticate", authResult);
      }
    } else {
      yield* log("STEP", "authenticate:SKIP (no authMethods in initResult)");
    }

    // ------------------------------------------------------------------
    // 4. newSession with cwd = repo root
    // ------------------------------------------------------------------
    yield* log("STEP", `session/new cwd=${REPO_ROOT}`);
    const sessionResult = yield* acp.agent.createSession({
      cwd: REPO_ROOT,
      mcpServers: [],
    });
    yield* log("RESULT:session/new", sessionResult);
    const sessionId = sessionResult.sessionId;

    // ------------------------------------------------------------------
    // 5. prompt: "List the files in this repo and stop."
    // ------------------------------------------------------------------
    yield* log("STEP", `session/prompt sessionId=${sessionId}`);
    const promptResult = yield* acp.agent.prompt({
      sessionId,
      prompt: [{ type: "text", text: "List the files in this repo and stop." }],
    });
    yield* log("RESULT:session/prompt", promptResult);

    yield* log("RECON", "All steps complete.");
    return { initResult, sessionResult, promptResult };
  }).pipe(
    // Provide the ACP client layer; it acquires its scoped resources from the
    // ambient Scope supplied by Effect.scoped at the program boundary.
    Effect.provide(acpLayer),
    Effect.catch((err) => log("ERROR", err).pipe(Effect.as(null))),
  );

  yield* log("RECON", "Done.");
  return result;
});

// Mirror apps/server/scripts/acp-mock-agent.ts:
//   Effect.scoped provides the Scope that the spawner + ACP client layer need;
//   NodeServices.layer provides ChildProcessSpawner, FileSystem, Path, Stdio,
//   Terminal, Crypto; NodeRuntime.runMain manages the main fiber + interrupts.
NodeRuntime.runMain(
  program.pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
