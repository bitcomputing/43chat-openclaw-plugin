import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk/channel-contract";
import type { ReplyPayload } from "openclaw/plugin-sdk";
import { sendMessage43Chat } from "./send.js";
import { log } from "node:console";
import packageJson from "../package.json" with { type: "json" };

type ChannelOutboundContext = Parameters<NonNullable<ChannelOutboundAdapter["sendText"]>>[0];

function looksLikeStructuredCognitionJson(text: string): boolean {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return false;
    }
    const record = parsed as Record<string, unknown>;
    if (Object.hasOwn(record, "envelope")) {
      return false;
    }
    return Object.hasOwn(record, "reply")
      || Object.hasOwn(record, "writes")
      || Object.hasOwn(record, "decision");
  } catch {
    return false;
  }
}

function classifySuppressedOutboundText(text: string): "no_reply" | "cognition_envelope" | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed === "NO_REPLY") {
    return "no_reply";
  }
  if (
    /^<chat43-cognition>[\s\S]*<\/chat43-cognition>$/i.test(trimmed)
    || /^```chat43-cognition[\s\S]*```$/i.test(trimmed)
    || looksLikeStructuredCognitionJson(trimmed)
  ) {
    return "cognition_envelope";
  }
  return null;
}

function buildSuppressedResult(ctx: ChannelOutboundContext) {
  return {
    channel: packageJson.openclaw.channel.id,
    messageId: "suppressed",
    chatId: ctx.to ?? "",
  };
}

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
    const suppressedReason = classifySuppressedOutboundText(ctx.text ?? "");
    if (suppressedReason) {
      log(`43chat[${ctx.accountId}]: suppress outbound ${suppressedReason}`);
      return buildSuppressedResult(ctx);
    }
    log(`43chat[${ctx.accountId}]: send text ${ctx.text}`);
    const result = await sendMessage43Chat({
      cfg: ctx.cfg,
      to: ctx.to ?? "",
      text: ctx.text ?? "",
      accountId: ctx.accountId ?? undefined,
    });
    log(`43chat[${ctx.accountId}]: send text result ${result.messageId} ${result.chatId}`);
    return {
      channel: packageJson.openclaw.channel.id,
      messageId: result.messageId,
      chatId: result.chatId,
    };
  },

  sendPayload: async (ctx: ChannelOutboundContext & { payload: ReplyPayload }) => {
    const text = ctx.payload.text ?? ctx.text ?? "";
    const suppressedReason = classifySuppressedOutboundText(text);
    if (suppressedReason) {
      log(`43chat[${ctx.accountId}]: suppress outbound payload ${suppressedReason}`);
      return buildSuppressedResult(ctx);
    }
    log(`43chat[${ctx.accountId}]: send payload ${text}`);
    const result = await sendMessage43Chat({
      cfg: ctx.cfg,
      to: ctx.to ?? "",
      text,
      accountId: ctx.accountId ?? undefined,
    });
    log(`43chat[${ctx.accountId}]: send payload result ${result.messageId} ${result.chatId}`);
    return {
      channel: packageJson.openclaw.channel.id,
      messageId: result.messageId,
      chatId: result.chatId,
    };
  },

  sendMedia: async () => {
    throw new Error("43Chat channel does not support media messages");
  },
};
