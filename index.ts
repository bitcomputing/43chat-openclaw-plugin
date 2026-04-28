import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { chat43Plugin } from "./src/channel.js";
import {
  createDissolveGroupTool,
  createInviteGroupMembersTool,
  createRemoveGroupMemberTool,
  createUpdateGroupTool,
} from "./src/group-management-tools.js";
import { createHandleGroupJoinRequestTool } from "./src/group-join-request-tool.js";
import { guardOwnerOnlyToolExecution } from "./src/authz.js";
import { set43ChatRuntime } from "./src/runtime.js";
import packageJson from "./package.json" with { type: "json" };

export { monitor43ChatProvider } from "./src/monitor.js";
export { sendMessage43Chat } from "./src/send.js";
export { chat43Plugin } from "./src/channel.js";

const plugin = {
  id: packageJson.openclaw.channel.id,
  name: "43Chat",
  version: packageJson.version,
  description: "43Chat OpenAPI + SSE channel plugin",
  configSchema: { type: "object" as const, properties: {} },
  register(api: OpenClawPluginApi) {
    set43ChatRuntime(api.runtime);
    api.registerChannel({ plugin: chat43Plugin });
    api.registerTool(
      (ctx) => ctx.config
        ? guardOwnerOnlyToolExecution(createHandleGroupJoinRequestTool(ctx.config), { senderIsOwner: ctx.senderIsOwner })
        : null,
      { name: "chat43_handle_group_join_request" },
    );
    api.registerTool(
      (ctx) => ctx.config
        ? guardOwnerOnlyToolExecution(createInviteGroupMembersTool(ctx.config), { senderIsOwner: ctx.senderIsOwner })
        : null,
      { name: "chat43_invite_group_members" },
    );
    api.registerTool(
      (ctx) => ctx.config
        ? guardOwnerOnlyToolExecution(createUpdateGroupTool(ctx.config), { senderIsOwner: ctx.senderIsOwner })
        : null,
      { name: "chat43_update_group" },
    );
    api.registerTool(
      (ctx) => ctx.config
        ? guardOwnerOnlyToolExecution(createRemoveGroupMemberTool(ctx.config), { senderIsOwner: ctx.senderIsOwner })
        : null,
      { name: "chat43_remove_group_member" },
    );
    api.registerTool(
      (ctx) => ctx.config
        ? guardOwnerOnlyToolExecution(createDissolveGroupTool(ctx.config), { senderIsOwner: ctx.senderIsOwner })
        : null,
      { name: "chat43_dissolve_group" },
    );
  },
};

export default plugin;
