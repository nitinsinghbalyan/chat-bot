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

A replaced sentence becomes a short hand-off line, e.g. "Our team will confirm the freight details with you." The model is told about the correction on its next turn through an `<operator_note>`. Every intervention is logged to `data/guardrail_events.jsonl`.

### Lead capture

- `send_otp` checks the number is a valid Indian mobile (`+91` optional). No SMS is sent: this is demo mode and the OTP is **`12345`** (`DEMO_OTP`). The OTP is checked on the server and never appears in the prompt.
- `verify_otp` allows 3 attempts per OTP and 3 OTPs per chat.
- `save_lead` is refused until the number is verified. Leads are appended to `data/leads.jsonl` with mobile, name, product, requirement, quantity, city and page URL.

To send real OTPs, replace the demo check in `src/tools.ts` with your SMS provider's send and verify calls.

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

## Embedding on the seller's website

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

Add the seller's domain to `ALLOWED_ORIGINS`.

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
src/           server, Claude loop, tools, guardrails, crawler, catalogue search
public/        widget.js (embeddable), demo.html
tests/         vitest unit tests + HTML fixtures
scripts/       eval.ts (live-model guardrail scenarios)
```
