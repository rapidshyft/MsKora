/**
 * Cloudflare Worker entry point.
 *
 * Telegram delivers updates by POSTing them here. Two things guard that:
 *
 * 1. `TELEGRAM_WEBHOOK_SECRET`. Telegram echoes it back in the
 *    `X-Telegram-Bot-Api-Secret-Token` header on every webhook delivery, and
 *    grammY rejects anything that does not match. Without it, the Worker URL
 *    is effectively a public endpoint anyone can post fabricated updates to —
 *    and a bot that acts on fabricated updates is worse than no bot.
 * 2. Secrets are never in source or `wrangler.toml`. `BOT_TOKEN` and the
 *    webhook secret are Cloudflare Worker secrets, encrypted at rest.
 */
import { webhookCallback } from "grammy";

import { createBot } from "./bot";

export interface Env {
  /** Telegram bot token. Set with: wrangler secret put BOT_TOKEN */
  BOT_TOKEN: string;
  /** Shared secret Telegram echoes back on each webhook call. */
  TELEGRAM_WEBHOOK_SECRET?: string;
  /** Public, non-secret configuration — see wrangler.toml [vars]. */
  GRADEX_API_BASE_URL?: string;
  GRADEX_DASHBOARD_BASE_URL?: string;
}

const DEFAULT_API = "https://api.trygradex.app";
const DEFAULT_DASHBOARD = "https://admin.trygradex.app";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // A plain GET is a human or an uptime check, not Telegram.
    if (request.method === "GET" && url.pathname === "/") {
      return new Response("Kora is running.\n", {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    if (url.pathname !== "/webhook") {
      return new Response("Not found", { status: 404 });
    }

    if (!env.BOT_TOKEN) {
      // Configuration error, not a Telegram problem. 500 so it is visible in
      // Worker logs rather than silently swallowing every update.
      console.error("BOT_TOKEN is not set");
      return new Response("Not configured", { status: 500 });
    }

    const bot = createBot({
      token: env.BOT_TOKEN,
      apiBaseUrl: env.GRADEX_API_BASE_URL ?? DEFAULT_API,
      dashboardBaseUrl: env.GRADEX_DASHBOARD_BASE_URL ?? DEFAULT_DASHBOARD,
    });

    // Each Worker invocation is a fresh isolate, so the bot has never spoken
    // to Telegram before. init() fetches getMe once, which grammY needs
    // before it can dispatch an update.
    await bot.init();

    const handler = webhookCallback(bot, "cloudflare-mod", {
      secretToken: env.TELEGRAM_WEBHOOK_SECRET ?? "",
    });

    try {
      return await handler(request);
    } catch (error) {
      // A handler that throws must still answer Telegram with 2xx. Telegram
      // retries any non-2xx delivery, so letting the error escape turns one
      // bug into a redelivery loop — the same update failing the same way,
      // repeatedly, with whatever side effects it managed before throwing.
      // (grammY's `bot.catch` does not help here: it is long-polling only.)
      //
      // The update is genuinely lost, which is the right trade — it is
      // recorded here, and Worker observability is on.
      console.error("Kora update failed", {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      return new Response("OK", { status: 200 });
    }
  },
};
