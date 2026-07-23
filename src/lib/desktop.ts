import { Data, Effect, Schema } from "effect";
import {
  type AppConfig,
  AppConfigPatchSchema,
  AppConfigSchema,
  DEFAULT_APP_CONFIG,
  type DesktopApi,
  type OpenCodeInfo,
  OpenCodeInfoSchema,
  type OpenCodeStartupProgress,
  type UpdateInfo,
  UpdateInfoSchema,
} from "@/types/desktop";

const CONFIG_KEY = "bloxbot-config";
const DEFAULT_CONFIG: AppConfig = DEFAULT_APP_CONFIG;

export class DesktopError extends Data.TaggedError("DesktopError")<{
  message: string;
  cause?: unknown;
}> {}

interface DesktopEffects {
  readonly getOpenCodeInfo: Effect.Effect<OpenCodeInfo, DesktopError>;
  readonly getVersion: Effect.Effect<string, DesktopError>;
  readonly openUrl: (url: string) => Effect.Effect<void, DesktopError>;
  readonly loadConfig: Effect.Effect<AppConfig, DesktopError>;
  readonly patchConfig: (patch: Partial<AppConfig>) => Effect.Effect<void, DesktopError>;
  readonly checkForUpdate: Effect.Effect<UpdateInfo | null, DesktopError>;
  readonly installUpdate: Effect.Effect<void, DesktopError>;
  readonly relaunch: Effect.Effect<void, DesktopError>;
}

type StartupProgressListener = (progress: OpenCodeStartupProgress) => void;

const loadBrowserConfig = Effect.gen(function* () {
  const stored = yield* Effect.try({
    try: () => {
      const contents = window.localStorage.getItem(CONFIG_KEY);
      return contents ? (JSON.parse(contents) as unknown) : DEFAULT_CONFIG;
    },
    catch: (cause) => new DesktopError({ message: "Failed to load browser configuration", cause }),
  });
  const candidate =
    stored !== null && typeof stored === "object"
      ? { ...DEFAULT_CONFIG, ...stored }
      : DEFAULT_CONFIG;
  return yield* Schema.decodeUnknown(AppConfigSchema)(candidate).pipe(
    Effect.mapError(
      (cause) => new DesktopError({ message: "Browser configuration is invalid", cause }),
    ),
  );
}).pipe(Effect.catchAll(() => Effect.succeed(DEFAULT_CONFIG)));

const browserEffects: DesktopEffects = {
  getOpenCodeInfo: Effect.fail(
    new DesktopError({
      message: "The desktop service is unavailable. Start BloxBot with pnpm dev.",
    }),
  ),
  getVersion: Effect.succeed("0.5.2"),
  openUrl: (url) =>
    Effect.sync(() => window.open(url, "_blank", "noopener,noreferrer")).pipe(Effect.asVoid),
  loadConfig: loadBrowserConfig,
  patchConfig: (input) =>
    Effect.gen(function* () {
      const patch = yield* Schema.decodeUnknown(AppConfigPatchSchema)(input).pipe(
        Effect.mapError(
          (cause) => new DesktopError({ message: "Browser configuration patch is invalid", cause }),
        ),
      );
      const current = yield* loadBrowserConfig;
      yield* Effect.try({
        try: () =>
          window.localStorage.setItem(CONFIG_KEY, JSON.stringify({ ...current, ...patch })),
        catch: (cause) =>
          new DesktopError({ message: "Failed to save browser configuration", cause }),
      });
    }),
  checkForUpdate: Effect.succeed(null),
  installUpdate: Effect.fail(
    new DesktopError({ message: "Updates are only available in the desktop app." }),
  ),
  relaunch: Effect.sync(() => window.location.reload()),
};

const invoke = <A>(message: string, operation: () => Promise<A>) =>
  Effect.tryPromise({
    try: operation,
    catch: (cause) =>
      new DesktopError({
        message: cause instanceof Error ? `${message}: ${cause.message}` : message,
        cause,
      }),
  });

const decodeBridgeValue =
  <A, I>(message: string, schema: Schema.Schema<A, I>) =>
  <E>(effect: Effect.Effect<unknown, E>) =>
    effect.pipe(
      Effect.flatMap(Schema.decodeUnknown(schema)),
      Effect.mapError((cause) =>
        cause instanceof DesktopError ? cause : new DesktopError({ message, cause }),
      ),
    );

function makeBridgeEffects(api: DesktopApi): DesktopEffects {
  return {
    getOpenCodeInfo: invoke("Failed to get OpenCode connection details", () =>
      api.getOpenCodeInfo(),
    ).pipe(decodeBridgeValue("OpenCode connection details are invalid", OpenCodeInfoSchema)),
    getVersion: invoke("Failed to get the app version", () => api.getVersion()).pipe(
      decodeBridgeValue("Desktop app version is invalid", Schema.String),
    ),
    openUrl: (url) => invoke("Failed to open the URL", () => api.openUrl(url)),
    loadConfig: invoke("Failed to load configuration", () => api.loadConfig()).pipe(
      decodeBridgeValue("Desktop configuration is invalid", AppConfigSchema),
    ),
    patchConfig: (patch) => invoke("Failed to save configuration", () => api.patchConfig(patch)),
    checkForUpdate: invoke("Failed to check for updates", () => api.checkForUpdate()).pipe(
      decodeBridgeValue("Update information is invalid", Schema.NullOr(UpdateInfoSchema)),
    ),
    installUpdate: invoke("Failed to install the update", () => api.installUpdate()),
    relaunch: invoke("Failed to relaunch the app", () => api.relaunch()),
  };
}

export const desktopEffects: DesktopEffects = window.bloxbot
  ? makeBridgeEffects(window.bloxbot)
  : browserEffects;

const runPromise = <A>(effect: Effect.Effect<A, DesktopError>): Promise<A> =>
  Effect.runPromise(effect);

/** Promise-only adapter consumed by React and exposed by the Electron bridge contract. */
export const desktop: DesktopApi = {
  getOpenCodeInfo: () => runPromise(desktopEffects.getOpenCodeInfo),
  onOpenCodeStartupProgress: (listener: StartupProgressListener) =>
    window.bloxbot?.onOpenCodeStartupProgress(listener) ?? (() => {}),
  getVersion: () => runPromise(desktopEffects.getVersion),
  openUrl: (url) => runPromise(desktopEffects.openUrl(url)),
  loadConfig: () => runPromise(desktopEffects.loadConfig),
  patchConfig: (patch) => runPromise(desktopEffects.patchConfig(patch)),
  checkForUpdate: () => runPromise(desktopEffects.checkForUpdate),
  installUpdate: () => runPromise(desktopEffects.installUpdate),
  relaunch: () => runPromise(desktopEffects.relaunch),
};
