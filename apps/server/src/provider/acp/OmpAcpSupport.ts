import { type OmpSettings, ProviderDriverKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";
import { normalizeModelSlug } from "@t3tools/shared/model";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

// TODO(omp-recon): confirm actual methodId omp advertises (initialize result).
// "agent" = terminal-free reuse of ~/.omp creds — our target.
const OMP_AUTH_METHOD_ID = "agent";

const OMP_DRIVER_KIND = ProviderDriverKind.make("omp");

// clientCapabilities to advertise: fs read+write and terminal, so that omp's
// writes are routed through T3 Code's diff viewer instead of going straight to
// disk. This is the whole point of integrating omp via ACP.
// TODO(omp-recon): run Phase-0 recon client with each flag toggled; confirm
// which callbacks omp actually sends (especially fs/write_text_file) and
// whether terminal is required for omp's operation.
const OMP_CLIENT_CAPABILITIES = {
  fs: {
    readTextFile: true,
    writeTextFile: true,
  },
  terminal: true,
} satisfies NonNullable<EffectAcpSchema.InitializeRequest["clientCapabilities"]>;

type OmpAcpRuntimeOmpSettings = Pick<OmpSettings, "binaryPath">;

interface OmpAcpRuntimeInput
  extends Omit<
    AcpSessionRuntime.AcpSessionRuntimeOptions,
    "authMethodId" | "clientCapabilities" | "spawn"
  > {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly ompSettings: OmpAcpRuntimeOmpSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
}

export function buildOmpAcpSpawnInput(
  ompSettings: OmpAcpRuntimeOmpSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: ompSettings?.binaryPath || "omp",
    // "acp" is the confirmed real subcommand (verified: `omp acp --help`).
    args: ["acp"],
    cwd,
    env: {
      ...environment,
    },
  };
}

export const makeOmpAcpRuntime = (
  input: OmpAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Scope.Scope
> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildOmpAcpSpawnInput(input.ompSettings, input.cwd, input.environment),
        authMethodId: OMP_AUTH_METHOD_ID,
        clientCapabilities: OMP_CLIENT_CAPABILITIES,
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    // Note: no XAiPromptCompletionRuntime wrapper here — that is xAI/Grok-specific.
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(acpContext),
    );
  });

export function resolveOmpAcpBaseModelId(model: string | null | undefined): string {
  const trimmed = model?.trim();
  // TODO(omp-recon): real omp model id — replace "omp-build" once recon confirms
  // the actual slug omp returns in sessionSetupResult.models?.currentModelId on a
  // fresh session. Recon action: start a session; print started.sessionSetupResult.models.
  const base = trimmed && trimmed.length > 0 ? trimmed : "omp-build";
  return normalizeModelSlug(base, OMP_DRIVER_KIND) ?? "omp-build"; // TODO(omp-recon): real omp model id
}

export function currentOmpModelIdFromSessionSetup(
  sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse,
): string | undefined {
  return sessionSetupResult.models?.currentModelId?.trim() || undefined;
}

export function applyOmpAcpModelSelection<E>(input: {
  readonly runtime: Pick<AcpSessionRuntime.AcpSessionRuntime["Service"], "setSessionModel">;
  readonly currentModelId: string | undefined;
  readonly requestedModelId: string | undefined;
  readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
}): Effect.Effect<string | undefined, E> {
  // RECON RESULT: omp does NOT expose model selection over ACP. session/new
  // returns only `mode` + `thinking` config options and no model list, and
  // calling session/set_model with any slug fails with -32603 (the model is
  // chosen by omp's own config / `/model`). So this is intentionally a no-op:
  // we never call setSessionModel and just let omp ride its configured model.
  // (Driver capabilities advertise sessionModelSwitch: "unsupported".)
  return Effect.succeed(input.currentModelId);
}

// TODO(omp-wave1): OmpAdapter (Layers/OmpAdapter.ts) and OmpProvider
// (Layers/OmpProvider.ts) do not exist yet — cross-references from those files
// into this module will fail to resolve until wave-1 is implemented.
