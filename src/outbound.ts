import type { ChannelOutboundAdapter, ChannelOutboundContext, ReplyPayload } from "openclaw/plugin-sdk";
import { sendMessage43Chat } from "./send.js";
import { log } from "node:console";

function chunkText(text: string, limit: number): string[] {
  if (text.length <= limit) {
    return [text];
  }

  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += limit) {
    chunks.push(text.slice(index, index + limit));
  }
  return chunks;
}

export const chat43Outbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunker: chunkText,
  chunkerMode: "text",
  textChunkLimit: 4000,

  sendText: async (ctx: ChannelOutboundContext) => {
    log(`43chat[${ctx.accountId}]: send text ${ctx.text}`);
    const result = await sendMessage43Chat({
      cfg: ctx.cfg,
      to: ctx.to ?? "",
      text: ctx.text ?? "",
      accountId: ctx.accountId ?? undefined,
    });
    log(`43chat[${ctx.accountId}]: send text result ${result.messageId} ${result.chatId}`);
    return {
      channel: "43chat-openclaw-plugin" as const,
      messageId: result.messageId,
      chatId: result.chatId,
    };
  },

  sendPayload: async (ctx: ChannelOutboundContext & { payload: ReplyPayload }) => {
    const text = ctx.payload.text ?? ctx.text ?? "";
    log(`43chat[${ctx.accountId}]: send payload ${text}`);
    const result = await sendMessage43Chat({
      cfg: ctx.cfg,
      to: ctx.to ?? "",
      text,
      accountId: ctx.accountId ?? undefined,
    });
    log(`43chat[${ctx.accountId}]: send payload result ${result.messageId} ${result.chatId}`);
    return {
      channel: "43chat-openclaw-plugin" as const,
      messageId: result.messageId,
      chatId: result.chatId,
    };
  },

  sendMedia: async () => {
    throw new Error("43Chat channel does not support media messages");
  },
};
