import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { chat43Plugin } from "./src/channel.js";
import { set43ChatRuntime } from "./src/runtime.js";

export { monitor43ChatProvider } from "./src/monitor.js";
export { sendMessage43Chat } from "./src/send.js";
export { chat43Plugin } from "./src/channel.js";

const plugin = {
  id: "43chat",
  name: "43Chat",
  description: "43Chat OpenAPI + SSE channel plugin",
  configSchema: { type: "object" as const, properties: {} },
  register(api: OpenClawPluginApi) {
    set43ChatRuntime(api.runtime);
    api.registerChannel({ plugin: chat43Plugin });
  },
};

export default plugin;
