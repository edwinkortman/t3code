import {
  type ModelCapabilities,
  type OmpSettings,
  ProviderDriverKind,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { causeErrorTag } from "@t3tools/shared/observability";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";
// TODO(omp-wave1): import makeOmpAcpRuntime once acp/OmpAcpSupport.ts is created
// import { makeOmpAcpRuntime, resolveOmpAcpBaseModelId } from "../acp/OmpAcpSupport.ts";

const OMP_PRESENTATION = {
  displayName: "Omp",
  badgeLabel: "Early Access", // TODO(omp-recon): adjust badgeLabel after product decision
  showInteractionModeToggle: false,
  requiresNewThreadForModelChange: true, // TODO(omp-recon): confirm with omp session semantics
} as const;
const PROVIDER = ProviderDriverKind.make("omp");
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const VERSION_PROBE_TIMEOUT_MS = 4_000;
// RECON RESULT: omp does NOT expose a model id over ACP. session/new returns
// only `mode` (default|plan) and `thinking` (off|auto) config options — no
// currentModelId, no model list. The model is chosen by omp's own config /
// `/model` command. So ACP-based model discovery is not possible; this timeout
// const is retained only as a placeholder and stays unused.
const _OMP_ACP_MODEL_DISCOVERY_TIMEOUT_MS = 15_000;

// RECON RESULT: model ids are not surfaced over ACP (see above). This single
// built-in entry is a cosmetic placeholder; omp resolves the real model from
// its own config. Do not attempt ACP discovery.
const OMP_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "omp-default",
    name: "Oh My Pi (configured model)",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
];

export function buildInitialOmpProviderSnapshot(
  ompSettings: OmpSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = ompModelsFromSettings(ompSettings.customModels);

    if (!ompSettings.enabled) {
      return buildServerProvider({
        presentation: OMP_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Omp is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: OMP_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking Omp CLI availability...",
      },
    });
  });
}

function ompModelsFromSettings(
  customModels: ReadonlyArray<string> | undefined,
  builtInModels: ReadonlyArray<ServerProviderModel> = OMP_BUILT_IN_MODELS,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(
    builtInModels,
    PROVIDER,
    customModels ?? [],
    EMPTY_CAPABILITIES,
  );
}

// TODO(omp-wave1): enable once acp/OmpAcpSupport.ts is created
// function buildOmpDiscoveredModelsFromSessionModelState(
//   modelState: EffectAcpSchema.SessionModelState | null | undefined,
// ): ReadonlyArray<ServerProviderModel> {
//   // TODO(omp-recon): real omp model ids — discover via ACP session setup currentModelId once recon confirms
//   if (!modelState || modelState.availableModels.length === 0) {
//     return [];
//   }
//   const seen = new Set<string>();
//   return modelState.availableModels
//     .map((model): ServerProviderModel | undefined => {
//       const slug = resolveOmpAcpBaseModelId(model.modelId);
//       if (!slug || seen.has(slug)) {
//         return undefined;
//       }
//       seen.add(slug);
//       return {
//         slug,
//         name: model.name.trim() || slug,
//         isCustom: false,
//         capabilities: EMPTY_CAPABILITIES,
//       };
//     })
//     .filter((model): model is ServerProviderModel => model !== undefined);
// }

// TODO(omp-wave1): enable once acp/OmpAcpSupport.ts is created
// const discoverOmpModelsViaAcp = (
//   ompSettings: OmpSettings,
//   environment: NodeJS.ProcessEnv = process.env,
// ) =>
//   Effect.gen(function* () {
//     const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
//     const acp = yield* makeOmpAcpRuntime({
//       ompSettings,
//       environment,
//       childProcessSpawner,
//       cwd: process.cwd(),
//       clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
//     });
//     const started = yield* acp.start();
//     // TODO(omp-recon): real omp model ids — discover via ACP session setup currentModelId once recon confirms
//     return buildOmpDiscoveredModelsFromSessionModelState(started.sessionSetupResult.models);
//   }).pipe(Effect.scoped);

/**
 * Version probe: runs `omp --version` and collects stdout/stderr.
 *
 * omp prints its version as `omp/16.1.22`; parseGenericCliVersion extracts
 * the `\d+\.\d+\.\d+` portion so the result is `"16.1.22"`.
 *
 * TODO(omp-recon): §3.6 — confirm `omp --version` exits 0 and that the
 * output format `omp/X.Y.Z` is stable. If `omp version` or `omp -v` is
 * preferred, update the args array here.
 */
const runOmpVersionCommand = (
  ompSettings: OmpSettings,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.gen(function* () {
    const command = ompSettings.binaryPath || "omp";
    const spawnCommand = yield* resolveSpawnCommand(command, ["--version"], {
      env: environment,
    });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  });

export const checkOmpProviderStatus = Effect.fn("checkOmpProviderStatus")(function* (
  ompSettings: OmpSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = ompModelsFromSettings(ompSettings.customModels);

  if (!ompSettings.enabled) {
    return buildServerProvider({
      presentation: OMP_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Omp is disabled in T3 Code settings.",
      },
    });
  }

  const versionResult = yield* runOmpVersionCommand(ompSettings, environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    yield* Effect.logWarning("Omp CLI health check failed.", {
      errorTag: error._tag,
    });
    return buildServerProvider({
      presentation: OMP_PRESENTATION,
      enabled: ompSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "Omp CLI (`omp`) is not installed or not on PATH."
          : "Failed to execute Omp CLI health check.",
      },
    });
  }

  if (Option.isNone(versionResult.success)) {
    return buildServerProvider({
      presentation: OMP_PRESENTATION,
      enabled: ompSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Omp CLI is installed but timed out while running `omp --version`.",
      },
    });
  }

  const versionOutput = versionResult.success.value;
  // omp prints `omp/16.1.22`; parseGenericCliVersion extracts `16.1.22` via /\b(\d+\.\d+\.\d+)\b/
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    yield* Effect.logWarning("Omp CLI version probe exited with a non-zero status.", {
      exitCode: versionOutput.code,
      stdoutLength: versionOutput.stdout.length,
      stderrLength: versionOutput.stderr.length,
    });
    return buildServerProvider({
      presentation: OMP_PRESENTATION,
      enabled: ompSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Omp CLI is installed but failed to run.",
      },
    });
  }

  // TODO(omp-wave1): uncomment ACP model discovery once acp/OmpAcpSupport.ts is created.
  // The block below is intentionally disabled so this file compiles without OmpAcpSupport.
  // Replace the early-return below with the full discovery flow (mirroring GrokProvider.ts:256–313)
  // once makeOmpAcpRuntime is available.
  //
  // const discoveryExit = yield* discoverOmpModelsViaAcp(ompSettings, environment).pipe(
  //   Effect.timeoutOption(OMP_ACP_MODEL_DISCOVERY_TIMEOUT_MS),
  //   Effect.exit,
  // );
  // if (Exit.isFailure(discoveryExit)) {
  //   yield* Effect.logWarning("Omp ACP model discovery failed", {
  //     errorTag: causeErrorTag(discoveryExit.cause),
  //   });
  //   return buildServerProvider({ ... status: "error", message: "Omp CLI is installed but ACP startup failed." });
  // }
  // if (Option.isNone(discoveryExit.value)) {
  //   yield* Effect.logWarning(`Omp ACP model discovery timed out after ${OMP_ACP_MODEL_DISCOVERY_TIMEOUT_MS}ms.`);
  //   return buildServerProvider({ ... status: "error", message: `Omp CLI is installed but ACP startup timed out after ${OMP_ACP_MODEL_DISCOVERY_TIMEOUT_MS}ms.` });
  // }
  // const discoveredModels = discoveryExit.value.value;
  // const models = discoveredModels.length > 0
  //   ? ompModelsFromSettings(ompSettings.customModels, discoveredModels)
  //   : fallbackModels;

  return buildServerProvider({
    presentation: OMP_PRESENTATION,
    enabled: ompSettings.enabled,
    checkedAt,
    models: fallbackModels, // TODO(omp-wave1): replace with `models` from discovery block above
    probe: {
      installed: true,
      version,
      status: "ready",
      auth: { status: "unknown" },
    },
  });
});

export const enrichOmpSnapshot = (input: {
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  readonly httpClient: HttpClient.HttpClient;
}): Effect.Effect<void> => {
  const { snapshot, publishSnapshot } = input;

  return enrichProviderSnapshotWithVersionAdvisory(snapshot, input.maintenanceCapabilities, {
    enableProviderUpdateChecks: input.enableProviderUpdateChecks,
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, input.httpClient),
    Effect.flatMap((enrichedSnapshot) => publishSnapshot(enrichedSnapshot)),
    Effect.catchCause((cause) =>
      Effect.logWarning("Omp version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.asVoid,
  );
};
