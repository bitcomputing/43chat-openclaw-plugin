type PluginSdkCompat = {
  waitUntilAbort?: (abortSignal?: AbortSignal) => Promise<void>;
};

function waitUntilAbortFallback(abortSignal?: AbortSignal): Promise<void> {
  if (!abortSignal) {
    return new Promise<void>(() => undefined);
  }
  if (abortSignal.aborted) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    abortSignal.addEventListener("abort", () => resolve(), { once: true });
  });
}

export function waitUntilAbortCompat(
  abortSignal?: AbortSignal,
  sdk: PluginSdkCompat = {},
): Promise<void> {
  if (typeof sdk.waitUntilAbort === "function") {
    return sdk.waitUntilAbort(abortSignal);
  }
  return waitUntilAbortFallback(abortSignal);
}
