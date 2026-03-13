import type { ChannelOutboundAdapter, ChannelOutboundContext } from "openclaw/plugin-sdk";
import { sendMessage43Chat } from "./send.js";

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
  textChunkLimit: 1800,

  sendText: async (ctx: ChannelOutboundContext) => {
    const result = await sendMessage43Chat({
      cfg: ctx.cfg,
      to: ctx.to ?? "",
      text: ctx.text ?? "",
      accountId: ctx.accountId ?? undefined,
    });

    return {
      channel: "43chat" as const,
      messageId: result.messageId,
      chatId: result.chatId,
    };
  },

  sendPayload: async (ctx: ChannelOutboundContext) => {
    const text = ctx.payload?.text ?? ctx.text ?? "";
    const result = await sendMessage43Chat({
      cfg: ctx.cfg,
      to: ctx.to ?? "",
      text,
      accountId: ctx.accountId ?? undefined,
    });

    return {
      channel: "43chat" as const,
      messageId: result.messageId,
      chatId: result.chatId,
    };
  },

  sendMedia: async () => {
    throw new Error("43Chat channel does not support media messages");
  },
};
