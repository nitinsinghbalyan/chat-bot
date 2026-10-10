# Seller Enquiry Chatbot: Jayshree Machinetools

An embeddable chat assistant that sits in the **bottom-left corner** of the seller's website. It answers buyers' discovery and enquiry questions on the seller's behalf, grounded only in the seller's knowledge base and bound by the seller's guardrails. When a buyer wants a quote, a price we don't list, or a callback, it captures a verified lead: **mobile number → OTP → name**.

## How it works

```
seller site ── <script src=".../widget.js"> ──► bubble (bottom-left) ── POST /api/chat (SSE) ──►
Express ─► input guardrails ─► catalogue retrieval (BM25) ─► user prompt (prompts/user.md)
        ─► Claude, streaming, with the cached system prompt (prompts/system.md + business card + product cards)
        ─► tool loop: send_otp / verify_otp / save_lead (state enforced on the server)
        ─► output guardrails (each sentence checked before the buyer sees it) ─► widget
```

### Knowledge sources (`kb/`)

| Name in the guardrails | File | Used for |
|---|---|---|
| BUSINESS CARD | `kb/business_card.json` | Company facts and the listed contact number |
| PRODUCT CARDS | `kb/product_cards.json` | The 4 machines with detailed cards (options, qualification questions, handling rules) |
| SELLER CATALOGUE (RAG) | `kb/catalogue.json`, built from `kb/sitemap.xml` by `npm run crawl` | Prices, links and specs for everything on the website |

The business card and product cards go into the **system prompt**. They never change between requests, so the prompt is cached. The catalogue is searched for every buyer message, and the top matches go into the **user prompt** for that turn.

The crawler skips the profile, testimonial and director pages (Guardrail 7). It also drops spec rows about GST, freight, delivery, payment or stock before anything reaches the model.

### Guardrails

All 9 seller guardrails are in `prompts/system.md`, word for word. The high-risk ones are also enforced in code (`src/guardrails.ts`), so they hold even if the model slips:

| Guardrail | Code enforcement |
|---|---|
| 1 Price | Any ₹, lakh or crore amount must match a catalogue price retrieved in this chat; otherwise the sentence is replaced. |
| 2 Freight | Freight or transport terms (included, extra, free…) are replaced. |
| 3 Contact | Phone numbers other than the business card number, and any email or external link, are replaced. Only seller-site links pass. |
| 4 Stock / brand | "In stock", "genuine <Brand>" and similar are replaced. |
| 5 Payment / ID | UPI, card, Aadhaar, PAN, GSTIN, IFSC and bank account numbers typed by the buyer are redacted before the model or logs see them. The bot never asks for them. |
| 6 Delivery | Dispatch dates, lead times and door-delivery promises are replaced. |
| 7 Disclosure | Business-profile pages are never crawled; the prompt handles the rest. |
| 8 GST | GST rates and "inclusive/exclusive of tax" are replaced. |
| 9 Other products | Specs come only from the catalogue entry; the prompt asks the bot to collect the requirement instead. |

A replaced sentence becomes a short hand-off line, e.g. "Our team will confirm the freight details with you." The model is told about the correction on its next turn through an `<operator_note>`. Every intervention is recorded in the database, and the transcript marks which replies were corrected.

### Lead capture

- `send_otp` checks the number is a valid Indian mobile (`+91` optional). No SMS is sent: this is demo mode and the OTP is **`12345`** (`DEMO_OTP`). The OTP is checked on the server and never appears in the prompt.
- `verify_otp` allows 3 attempts per OTP and 3 OTPs per chat.
- `save_lead` is refused until the number is verified. Each lead is saved to the database with mobile, name, product, requirement, quantity, city and page URL. The seller sees it at `/admin/leads` (see below).

To send real OTPs, replace the demo check in `src/tools.ts` with your SMS provider's send and verify calls.

### Storage

Everything is kept in one SQLite file, `chatbot.db`, inside `DATA_DIR` (default `./data`):

| Table | Holds |
|---|---|
| `sessions` | Each chat's conversation state (history, OTP progress, catalogue hits), so chats survive restarts. Idle chats are pruned after 30 days. |
| `transcript` | What buyers typed (payment and ID details already redacted) and what they were shown |
| `leads` | Verified leads |
| `guardrail_events` | Each sentence the output guardrails replaced |

A chat resets after 2 hours of inactivity, the same as in the widget.

### Seller admin

Set `ADMIN_PASSWORD` (at least 8 characters). The seller can then open:

- `/admin/leads`: all leads, newest first, each linking to its chat
- `/admin/leads.csv`: the same list as a CSV that opens in Excel
- `/admin/transcript/<session>`: one full chat

The browser asks for a login: any username, with the password. If `ADMIN_PASSWORD` isn't set, these pages return 404.

## Setup

```bash
npm install
cp .env.example .env        # add ANTHROPIC_API_KEY
npm run crawl               # build kb/catalogue.json (needs internet access to jayshreemachinetools.in)
npm run dev                 # http://localhost:3000/demo.html
```

Without a crawled catalogue, the bot still works from the business card and product cards. It just never quotes a price or shares product links, which is what the guardrails require.

### Configuration (`.env`)

| Variable | Default | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | (none) | Required |
| `BOT_MODEL` | `claude-sonnet-5-5` | Use `claude-opus-5-5` for the most capable model, or `claude-haiku-5-5` for the cheapest |
| `BOT_EFFORT` | `low` | `low` suits chat; raise it if answers miss nuance |
| `BOT_FALLBACKS` | `true` | Server-side refusal fallback. It only works on the Claude API, so set `false` on Bedrock, Vertex or Foundry |
| `ALLOWED_ORIGINS` | `http://localhost:3000` | Comma-separated sites allowed to call the API |
| `CRAWL_ON_START` / `CRAWL_INTERVAL_HOURS` | `false` / `24` | Keeps the catalogue fresh while running |
| `DEMO_OTP` | `12345` | Demo OTP |
| `DATA_DIR` | `./data` | Holds `chatbot.db` and the runtime-refreshed `catalogue.json` (which takes precedence over `kb/catalogue.json`) |
| `ADMIN_PASSWORD` | (none) | Turns on `/admin/leads` |

## Deploying on Render

`render.yaml` is a Render Blueprint. It sets up:

- a Node 22 web service in Singapore, the closest Render region to India
- a 1 GB persistent disk at `/var/data` for the database and the refreshed catalogue
- a health check on `/health`
- automatic deploys from `main`

Steps:

1. Merge the PR into `main`.
2. In Render, choose **New → Blueprint**, connect GitHub and pick this repo.
3. When prompted, enter the two secrets:
   - `ANTHROPIC_API_KEY`
   - `ADMIN_PASSWORD` (at least 8 characters)
4. Apply. The first build takes a few minutes. When it finishes, `https://jayshree-chatbot.onrender.com/health` (or whatever URL Render shows) should return `{"ok":true,...}`.
5. Open `https://<your-service>.onrender.com/demo.html` to try the bot.
6. Optional: under the service's **Settings → Custom Domains**, add something like `chat.jayshreemachinetools.in` and create the CNAME record Render shows. Then use that domain in the embed snippet.

Things to know:

- **Cost:** a persistent disk needs a paid instance. The Blueprint uses `starter`, Render's cheapest paid plan, which also doesn't sleep when idle.
- **Brief downtime on deploy:** with a disk attached, Render stops the old instance before starting the new one, so each deploy causes a few seconds of downtime.
- **Catalogue refresh:** `CRAWL_ON_START=true`, so the catalogue is re-crawled from the sitemap on every start and every 24 hours after that. The result is saved to the disk.
- **Backups:** download `/admin/leads.csv` regularly. Render also takes daily snapshots of the disk.

## Embedding on the seller's website

Add this once, just before `</body>`, on every page of jayshreemachinetools.in (in a site-wide footer or custom-code section):

```html
<script src="https://YOUR-BOT-HOST/widget.js" defer
        data-title="Jayshree Machinetools"
        data-color="#0b5cad"></script>
```

Optional attributes:

- `data-api`: the API host, if it differs from where `widget.js` is served
- `data-greeting`: replaces the opening message
- `data-chips="Press Brake|Shearing Machine|…"`: replaces the quick replies
- `data-demo="true"`: shows the demo OTP hint

The site's domains are already in `ALLOWED_ORIGINS` in `render.yaml`. If the site is ever served from a different domain, add it there.

## Changing the bot's behaviour

- **Persona, rules and lead flow:** edit `prompts/system.md`.
- **Per-turn context:** edit `prompts/user.md`.
- **Business card or product cards:** replace the JSON in `kb/` and restart.

The prompts are plain markdown templates (`{{PLACEHOLDER}}`), so they can be changed without touching code.

## Tests

```bash
npm test          # unit tests: crawler, catalogue search, guardrails, OTP/lead flow, prompts, chat loop (fake Claude client)
npm run eval      # live scenarios against the real model, one or more per guardrail, plus the full lead flow
```

`npm run eval` calls the Claude API and costs a small amount per run. It uses a fixed sample catalogue, so the price rules can be tested before a real crawl.

## Project layout

```
kb/            business card, product cards, sitemap, crawled catalogue
prompts/       system.md (dedicated system prompt), user.md (per-turn user prompt)
src/           app (HTTP + admin), server bootstrap, Claude loop, tools, guardrails, crawler, catalogue search, SQLite store
public/        widget.js (embeddable), demo.html
tests/         vitest unit tests + HTML fixtures
scripts/       eval.ts (live-model guardrail scenarios)
render.yaml    Render Blueprint (web service + persistent disk)
```
