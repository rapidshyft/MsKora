/**
 * Kora — the GradeX ops bot.
 *
 * This first version does two things: it echoes what you say (a live proof
 * that grammY and Cloudflare Workers are wired up end to end), and it reports
 * GradeX's health on demand.
 *
 * Everything here is stateless. Cloudflare gives each request a fresh
 * isolate, so the bot is constructed per request rather than held in a module
 * global — `bot.init()` in `index.ts` is what makes that safe.
 */
import { Bot, type Context } from "grammy";

import { checkGradex, formatHealthReport, type GradexEnvironment } from "./gradex";

export interface BotConfig extends GradexEnvironment {
  token: string;
}

/** Escape text so Telegram's HTML parse mode cannot be broken by user input. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

const HELP = [
  "🤖 <b>Kora</b> — GradeX ops bot",
  "",
  "/health — check the GradeX API, readiness and dashboard",
  "/start — this message",
  "",
  "Anything else you send, I echo back.",
].join("\n");

export function createBot(config: BotConfig): Bot<Context> {
  const bot = new Bot<Context>(config.token);

  bot.command("start", async (ctx) => {
    await ctx.reply(HELP, { parse_mode: "HTML" });
  });

  bot.command("health", async (ctx) => {
    // The probes take a moment; say something first so the chat does not
    // look dead while we wait.
    const pending = await ctx.reply("Checking GradeX…");
    const results = await checkGradex(config);
    const report = formatHealthReport(results);

    try {
      await ctx.api.editMessageText(ctx.chat.id, pending.message_id, report, {
        parse_mode: "HTML",
      });
    } catch {
      // Editing can fail (message too old, deleted, etc.) — the report still
      // matters more than the tidiness of one message.
      await ctx.reply(report, { parse_mode: "HTML" });
    }
  });

  // Echo. Registered after the commands so that `/health` is handled as a
  // command rather than echoed back as text.
  bot.on("message:text", async (ctx) => {
    await ctx.reply(escapeHtml(ctx.message.text), { parse_mode: "HTML" });
  });

  // Anything that is a message but carries no text — a photo, a sticker, a
  // voice note. Echoing is impossible, so say so rather than going silent.
  bot.on("message", async (ctx) => {
    await ctx.reply("I can only echo text for now.");
  });

  // Deliberately no `bot.catch` here: grammY only uses it for long polling.
  // Under `webhookCallback` a middleware error propagates out to the Worker,
  // so it is caught in `index.ts` where the HTTP response is actually formed.

  return bot;
}
