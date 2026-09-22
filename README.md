# Kora

GradeX's ops bot on Telegram — [@MsKoraBot](https://t.me/MsKoraBot).

This is the first working version: it echoes what you say, and it reports
GradeX's health on demand. It exists to prove the stack end to end before more
is built on it.

**Stack:** TypeScript · [grammY](https://grammy.dev) · Cloudflare Workers.
**Live at:** `https://ms-kora.rapidshyft.workers.dev`

## Why Cloudflare rather than Telegram Serverless

Telegram's own serverless platform documents *"no npm packages, no filesystem,
and no network except through the SDK's `fetch`"* — which rules out grammY and
the rest of the ecosystem, and it publishes no pricing or rate limits. Workers
is already used for the GradeX dashboard, so it is the same account, the same
`wrangler`, the same CI shape, and TypeScript is first-class.

There is also a reliability reason worth keeping in mind as this grows: **Kora
is deliberately not hosted on the GradeX VPS.** A status bot that lives on the
machine it monitors goes quiet exactly when you need it. Hosted separately, it
can still answer "the API is not responding".

## Commands

| Command | What it does |
|---|---|
| `/start` | Short help. |
| `/health` | Probes the GradeX API (`/health`), its readiness (`/ready`) and the admin dashboard, reporting status, latency and database state for each. |
| anything else | Echoed back verbatim. |

`/health` reports an unreachable host as a failure rather than silence, and
treats a `200` from `/health` whose body says `degraded` — or whose database is
not connected — as unhealthy. The endpoint answers `200` whenever the process
is listening, so its own status field is the real verdict.

## Local development

```bash
npm install
cp .dev.vars.example .dev.vars   # then fill in BOT_TOKEN
npm run dev
```

`.dev.vars` is gitignored. **Never put a token in `wrangler.jsonc`** — that file
is committed.

Drive an update through the local Worker without Telegram:

```bash
curl -X POST http://localhost:8787/webhook \
  -H 'content-type: application/json' \
  -H 'x-telegram-bot-api-secret-token: local-dev-secret' \
  -d '{"update_id":1,"message":{"message_id":1,"date":1,"chat":{"id":123,"type":"private"},"from":{"id":123,"is_bot":false,"first_name":"Dev"},"text":"hello"}}'
```

```bash
npm run typecheck && npm run test:run
```

`typecheck` regenerates `worker-configuration.d.ts` first, so `Env` always
matches `wrangler.jsonc`. That file is generated, not committed. Requires
Node 22 or newer — wrangler 4's minimum.

## Deploying

Already deployed. This is what to do again, or on a fresh account.

### 1. Authenticate

```bash
npx wrangler login
```

### 2. Deploy

`wrangler.jsonc` declares both secrets under `secrets.required`, so a deploy
is **refused** until they exist rather than shipping a Worker that 500s on
every update.

On an account where the Worker does not exist yet, secrets cannot be set in
advance, so supply them with the deploy. Write the file outside the repo and
delete it afterwards:

```bash
umask 077
cat > /tmp/kora.secrets <<EOF
BOT_TOKEN=<from @BotFather>
TELEGRAM_WEBHOOK_SECRET=$(openssl rand -hex 32)
EOF
npx wrangler deploy --secrets-file /tmp/kora.secrets
shred -u /tmp/kora.secrets
```

Once the Worker exists, rotate either one on its own:

```bash
npx wrangler secret put BOT_TOKEN
```

Note that `wrangler secret put` **is a deployment** — it creates a version and
releases it immediately.

`TELEGRAM_WEBHOOK_SECRET` is any random string. Telegram echoes it back on
every delivery and Kora rejects anything that does not match, so the Worker
URL is not an open endpoint anyone can post fabricated updates to.

### 3. Point Telegram at it

```bash
curl -X POST "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
  -H 'content-type: application/json' \
  -d '{
        "url": "https://ms-kora.<your-subdomain>.workers.dev/webhook",
        "secret_token": "<TELEGRAM_WEBHOOK_SECRET>",
        "allowed_updates": ["message"]
      }'
```

Confirm with `getWebhookInfo`:

```bash
curl "https://api.telegram.org/bot<BOT_TOKEN>/getWebhookInfo"
```

`pending_update_count` should be `0` and `last_error_message` absent.

## Rotating the bot token

Revoke in [@BotFather](https://t.me/BotFather) (`/revoke`), then:

```bash
npx wrangler secret put BOT_TOKEN   # paste the new one
# re-run setWebhook with the new token
```

The token is a posting credential — anyone holding it can post **as Kora**, so
treat it like any other production secret.

## Notes for what comes next

- Alerts from GradeX should go **straight from the backend to the Telegram Bot
  API**, not through Kora. Putting a relay in front of the alert path means it
  can be down exactly when the thing it is alerting about is down.
- Any command that reads GradeX data needs GradeX to expose an authenticated
  endpoint to the public internet. That is a new attack surface and should be
  designed deliberately, with an allowlist of chat/user IDs on Kora's side.
- Student data must not be sent to Telegram. GradeX users are schoolchildren;
  alerts should carry opaque IDs at most, never names or email addresses.
