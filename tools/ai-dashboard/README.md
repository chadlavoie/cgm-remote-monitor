# After Hours — optional Nightscout AI companion

An isolated, single-user prototype in this Nightscout fork. It does not modify the main application, database, alarms, treatment records, or root dependencies. Node.js 22+; no npm packages or build step required. Licensed under the repository's AGPL-3.0 license.

## Run the offline demo

From the repository root:

```sh
cd tools/ai-dashboard
npm test
npm start
```

Open http://127.0.0.1:1340, click **Load three-hour window**, then **Ask** or **Create wall art**. The default source is synthetic; the default engine uses explicitly labeled canned text and local SVG art. The offline engine is for interface demonstration, not an AI answer to arbitrary questions. Choose different narration/art styles. No external request is made by this demo.

## Test a real AI provider with synthetic data

1. Copy `.env.example` to `.env` in this directory. Generate a random dashboard token, for example with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`, and set `DASHBOARD_TOKEN`.
2. Set `AI_BASE_URL`, `AI_API_KEY`, and a comma-separated `AI_MODELS` allowlist. An example base URL is `https://openrouter.ai/api/v1`; select model IDs available to your account. The adapter sends non-streaming `POST /chat/completions` with system/user messages and `max_tokens: 500`. Models requiring a different protocol or incompatible parameters need an adapter change.
3. Set conservative request reservations and a daily budget; configure an actual hard cap at your provider where available. Restart `npm start` after configuration changes.
4. Enter the dashboard token in the browser (held only in memory; never in localStorage). Keep **Synthetic demo** selected. Load the window, choose **External AI provider**, choose a model, inspect the context, and check the consent box before **Ask**.
5. Optional art: set `IMAGE_BASE_URL`, `IMAGE_API_KEY`, `IMAGE_MODEL`. The default image adapter sends `POST /images/generations` with `n:1`, `size:1024x1024`, `quality:low`, `output_format:png`. It accepts base64 PNG responses only. GPT image models use this default; compatible legacy services can set `IMAGE_LEGACY_RESPONSE_FORMAT=true` to send `response_format:b64_json` instead of quality/output_format. OpenRouter's chat-based image modality is **not** this image protocol; use a separate images endpoint. Inspect the art prompt, opt in, and generate. **Regenerate** bypasses the cache and makes another paid request.

The endpoint contracts were checked against [OpenRouter chat documentation](https://openrouter.ai/docs/api/api-reference/chat/create-a-chat-completion) and [OpenAI image documentation](https://developers.openai.com/api/reference/resources/images/methods/generate). No paid provider or credentials were exercised during implementation.

## Enable your Nightscout data separately

Set `ALLOW_REAL_DATA=true`, `NIGHTSCOUT_URL` to your deployment URL, and `NIGHTSCOUT_TOKEN` to a **dedicated read-only** access token with entries/treatments read permissions. Do not use the unrestricted admin secret. The token is sent in the server-side `api-secret` header, supported by this fork's authorization code. It never enters the browser or AI prompt.

Restart, select **My Nightscout**, and explicitly load a window. Only then will the server read `/api/v1/entries.json` and `/api/v1/treatments.json`. Both queries have lower and upper time bounds and an explicit count. Either request failing, or hitting the 1,000-record cap, rejects the entire preview instead of silently returning incomplete data.

The exact three-hour snapshot shown in the preview is retained for five minutes and referenced by an opaque ID. AI calls use that snapshot, not a silently refreshed window. Reloading data clears consent. Changing the source clears previous content. There is no background polling. To stop using real data, disable `ALLOW_REAL_DATA` and restart.

## Data and consent boundaries

- The chronological context includes UTC timestamps, glucose in mg/dL, event type, and numeric carbs/insulin/duration fields. Readings outside the window, nonfinite values, and duplicate reading timestamps are filtered. The graph leaves gaps over ten minutes disconnected and flags a latest reading older than fifteen minutes.
- Patient names, device identifiers, treatment IDs, entered-by fields, notes, profiles, and credentials are not forwarded. Event-type strings and your question are still potentially identifying. Inspect before consenting. Free-text notes are deliberately excluded in this prototype; not all event semantics are represented.
- Text sends the previewed context, selected narration style, and question. Art sends only its displayed prompt containing the numeric glucose sequence and art style, without event details, timestamps, question, or text response. This remains health-derived information, so art also requires consent.
- External generation requires `consent: true` on the server, including with synthetic data. Provider endpoints/models are operator-configured, never supplied by browser requests. Provider retention policies still apply after sending; changing consent cannot retract prior transmissions.
- Question and result are displayed with `textContent`, never rendered as HTML. The browser loads no third-party resources. Image URLs are rejected; base64 images avoid third-party tracking fetches. API secrets remain server-side. Upstream errors are not echoed and requests/payloads are not logged.
- System instructions prohibit dosing, treatment recommendations, diagnosis, causal claims, and shame; fiction is explicitly labeled. **Prompt instructions are not a medically validated safety filter.** A model can still produce inappropriate or inaccurate content. This companion is for narrative exploration and decoration only. It cannot replace Nightscout monitoring or medical decision tools and has no write interface for treatments.

## Budgets, caching and deployment limits

`DAILY_BUDGET_USD` limits **reserved dollars**, not verified billed dollars. Each cache miss reserves `TEXT_REQUEST_RESERVE_USD` or `IMAGE_REQUEST_RESERVE_USD` before dispatch, synchronously, with an atomic ledger replacement. Failed/timeout requests retain their reservation because upstream processing may have occurred. No automatic retries. Cache hits do not reserve again. `DAILY_REQUEST_LIMIT` separately bounds provider attempts. UTC midnight resets both counters; backwards clock movement and malformed/unreadable ledgers fail closed.

Set each reservation to an upper bound for the most expensive permitted model and its maximum context/output. Provider request bodies are capped at 32 KiB and text output at 500 tokens. Pricing changes or an underestimated reserve can cause the actual bill to exceed the local dollar limit. Use a provider-enforced cap and a dedicated key as the actual billing boundary. The defaults are illustrative, not a pricing quote.

Cache keys include model, context, question, and style; art keys include its data-derived prompt and source mode. Cache holds at most 16 responses in memory with configurable expiry; snapshots at most 32 for five minutes. Expired objects are purged on subsequent requests and are inaccessible after expiry; process restart clears both. No health content is written to disk by the application. The budget file contains only UTC day, reserved spend, and request count. Protect the process memory and host backups appropriately.

Run **one Node process / replica per budget ledger**, with persistent writable storage for `.data`. Multiple replicas or workers are unsupported: the ledger is not a distributed lock. Deleting/resetting the ledger resets the local limit. Do not run autoscaled/serverless instances with ephemeral independent ledgers.

Bind to loopback by default. For remote access, run behind your authenticated HTTPS reverse proxy on a dedicated origin (the UI uses root-relative paths); retain the dashboard token. Never expose it over plaintext HTTP. Non-loopback binding or configuring any provider/real data requires a token of at least 24 characters. No cookies or permissive CORS are used; API calls require JSON plus a custom request header. Proxy rate limiting is recommended for an internet-facing deployment. This is a single-user app: anyone holding the dashboard token has the same data access and budget.

No live deployment configuration, private extensions, or API credentials have been verified. Installation is optional and independent; stopping this process removes the companion without affecting Nightscout.

## Review and testing

`npm test` runs Node's built-in test runner without network credentials. It covers synthetic isolation, bounded Nightscout queries/auth, chronological filtering, consent/model validation, text/image adapter payloads, cache hits/regeneration, failed and concurrent requests, restart/rollover/corrupt-ledger budgets, and authenticated HTTP routes. Mock providers exercise the integration; these tests do not establish medical safety or compatibility with every provider model.

Files: `core.mjs` (data/provider/budget logic), `server.mjs` (HTTP/auth/snapshots), `public/` (responsive UI), `test/` (automated tests). All changes are confined to this directory for straightforward upstream maintenance.

Implementation validation: 14 automated tests passed, plus a jsdom interface smoke check for loading, plotting, question submission, art/style/regeneration, consent rejection, and source clearing. Full visual browser QA was not completed because the available Chromium download failed. Live Nightscout access and paid provider calls remain unverified.
