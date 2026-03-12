import type { PluginRuntime } from "openclaw/plugin-sdk";

let chat43Runtime: PluginRuntime | undefined;

export function set43ChatRuntime(runtime: PluginRuntime): void {
  chat43Runtime = runtime;
}

export function get43ChatRuntime(): PluginRuntime {
  if (!chat43Runtime) {
    throw new Error("43Chat runtime not initialized");
  }
  return chat43Runtime;
}
