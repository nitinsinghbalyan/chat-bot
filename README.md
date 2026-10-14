# Seller Assistants

A website that hosts an AI chat assistant for many sellers. For each seller it shows:

- **a directory** (`/`) listing every seller, with a **Visit site** button (and **Edit prompts** for your team)
- **a website per seller** (`/s/<seller>/`) built from the seller's crawled web pages and business card: Home, About Us, Products, category pages, product pages (photo gallery, starting price, specifications, description, features, related machines), Contact Us and search
- **the seller's chatbot** in the **bottom-right corner** on every page of that site (set `"widgetPosition": "left"` to move it). Every "Get quote" and "Send an enquiry" button opens it.
- **a brand persona per seller**: a system prompt and a user prompt you write in a web form, layered on top of the built-in assistant

Each bot answers buyers' discovery and enquiry questions on its seller's behalf. It uses only that seller's knowledge base and follows the guardrails. When a buyer wants a quote, a price that isn't listed, or a callback, the bot captures a verified lead: **mobile number → OTP → name**. Sellers can also embed their bot on their own website with one script tag.

## How it works

```
kb/sellers/<seller>/ (KB you supply) ──► SellerRegistry ──► per seller: KB, cached system prompt, catalogue
sitemap.xml ──► crawler ──► catalogue.json ──► (a) the seller's mini-website  (b) the bot's retrieval

browser ── widget.js (bottom-right) ── POST /api/chat {seller, message, pageUrl} (SSE) ──►
  input guardrails ─► catalogue retrieval (+ the product page the buyer is on) ─► user prompt
  ─► Claude, streaming, with that seller's cached system prompt
  ─► tool loop: send_otp / verify_otp / save_lead (state enforced on the server)
  ─► output guardrails (each sentence checked before the buyer sees it) ─► widget
```

The website and the bot use **the same crawled catalogue**, so the bot never contradicts the page the buyer is reading.

## Adding a seller

Create a folder `kb/sellers/<slug>/`, where `<slug>` uses lowercase letters, digits and dashes (e.g. `alpha-presses`). Put these files in it:

| File | Required | What it holds |
|---|---|---|
| `seller.json` | yes | Display settings (format below) |
| `business_card.json` | yes | **BUSINESS CARD**: company facts, `deals_in`, `listed_contact` |
| `product_cards.json` | yes | **PRODUCT CARDS**: options, qualification questions, handling rules |
| `sitemap.xml` | yes | The seller's sitemap, which the crawler builds the catalogue from |
| `guardrails.md` | no | Replaces the shared `prompts/guardrails.md` for this seller only |
| `catalogue.json` | no | A committed crawl (`npm run crawl -- <slug>`), used until the server's own crawl finishes |

`seller.json`:

```json
{
  "name": "Alpha Presses",
  "slug": "alpha-presses",
  "siteUrl": "https://www.alphapresses.example/",
  "color": "#aa3300",
  "logoUrl": "https://www.alphapresses.example/logo.png",
  "allowedOrigins": ["https://www.alphapresses.example"],
  "greeting": "Hi! Looking for a press brake? Ask me anything.",
  "chips": ["Press Brake", "Shearing Machine"],
  "widgetPosition": "right",
  "tagline": "Manufacturer of press brakes and shearing machines in Rajkot",
  "about": "First paragraph of About Us.\n\nSecond paragraph."
}
```

- `slug` must match the folder name.
- `allowedOrigins` lists the websites that may embed this seller's bot.
- `logoUrl`, `greeting` and `chips` are optional. Without `chips`, the quick replies come from the product cards.
- `widgetPosition` (`right` by default, or `left`) picks the corner for the chat bubble.
- `tagline` and `about` are optional text for the home and About Us pages. Without them the text is built from the business card. Keep `about` to verified business card facts: Guardrail 7 rules out earnings, enquiry volume, customer count and tenure.

Then:

```bash
npm run kb:check            # validates every seller folder and names the file and field of any problem
npm run crawl -- <slug>     # optional: crawl now and commit kb/sellers/<slug>/catalogue.json
git add kb/sellers/<slug> && git commit -m "Add <seller>" && git push
```

On Render, the push redeploys. The server then crawls every seller's sitemap on start and every 24 hours after that, and the new seller appears in the directory. An invalid folder stops the server from starting, with every problem listed in the log, so run `kb:check` first.

## Knowledge and prompts

| Name in the guardrails | Source | Goes into |
|---|---|---|
| BUSINESS CARD | `business_card.json` | System prompt (cached) |
| PRODUCT CARDS | `product_cards.json` | System prompt (cached) |
| SELLER CATALOGUE (RAG) | crawled from `sitemap.xml` | Each turn's user prompt: the top matches, plus the page the buyer is viewing |

- `prompts/system.md` is the system prompt template shared by all sellers. `{{GUARDRAILS}}` is filled from `prompts/guardrails.md`, or from the seller's own `guardrails.md`.
- `prompts/user.md` is the template for each turn. It carries `<current_page>` when the buyer is on a product or category page, so "what's the price of this?" just works.
- The crawler skips profile, testimonial and director pages (guardrail 7). It also drops spec rows, description sentences and feature bullets about GST, freight, delivery, payment or stock, and sentences containing phone numbers, emails or links, so neither the website nor the bot shows them.
- For each page the crawler keeps the title, starting price, specifications, every product photo (linked from the seller's site, not copied), the description, feature bullets, breadcrumbs, and on category pages the listed products with their thumbnails.

### Website pages

| Page | Built from |
|---|---|
| `/s/<slug>/` Home | Tagline, business card facts, product range (categories), featured machines, About teaser, how to get a quote |
| `/s/<slug>/about` About Us | `about` text (or the business card), company facts table (name, nature, CEO, location, address, phone), everything in `deals_in`, linked to matching categories |
| `/s/<slug>/products` | Every category with its first products, and machines not in any category |
| `/s/<slug>/c/<category>` | Category photo, description, sidebar of all categories, product cards with key specs and "Get quote" |
| `/s/<slug>/p/<product>` | Photo gallery, starting price, key specs, full specifications, description, features, related machines |
| `/s/<slug>/contact` | Address, listed phone, Google Maps link, enquiry button |
| `/s/<slug>/search?q=` | Catalogue search |

## Brand persona prompts

Each seller's assistant can have its own voice. On the directory, click **Edit prompts** (or **Set prompts** on `/admin`). The browser asks for the admin login: any username, with `ADMIN_PASSWORD`.

| Box | Goes into | Use it for |
|---|---|---|
| **System prompt: brand persona** (up to 4,000 characters) | The system prompt, as a `# Brand persona` section before the sources | The assistant's name, tone, greeting style, what to emphasise about the brand |
| **User prompt: added to every buyer message** (up to 2,000 characters) | Each buyer turn, as `<seller_instructions>` | A short standing instruction to keep in mind on every reply |

- Both are **added on top of** the built-in prompt. The 9 guardrails, the knowledge-source rules and the OTP enquiry steps always apply, and the prompt tells the model they win if anything conflicts. The code-level output guardrails also still check every sentence.
- Saving takes effect on the next chat turn; there's no redeploy. The prompts are stored in the SQLite database (`seller_prompts` table), so they survive restarts and redeploys on the Render disk.
- **Clear** removes both. The form also shows a preview of the full system prompt.
- Tags such as `<business_card>` or `<seller_instructions>` are stripped from both the prompts and buyer messages, so neither can break out of its block.

## Guardrails

The 9 shared guardrails are in `prompts/guardrails.md`, word for word. The high-risk ones are also enforced in code (`src/guardrails.ts`), for every seller:

| Guardrail | Code enforcement |
|---|---|
| 1 Price | Any ₹, lakh or crore amount must match a catalogue price retrieved in this chat; otherwise the sentence is replaced. The website labels prices as "Starting price". |
| 2 Freight | Freight or transport terms (included, extra, free…) are replaced. |
| 3 Contact | Phone numbers other than the seller's listed number, and any email or external link, are replaced. Only links to the seller's own site pass. |
| 4 Stock / brand | "In stock", "genuine <Brand>" and similar are replaced. |
| 5 Payment / ID | UPI, card, Aadhaar, PAN, GSTIN, IFSC and bank account numbers typed by the buyer are redacted before the model or logs see them. |
| 6 Delivery | Dispatch dates, lead times and door-delivery promises are replaced. |
| 7 Disclosure | Business-profile pages are never crawled; the prompt handles the rest. |
| 8 GST | GST rates and "inclusive/exclusive of tax" are replaced. |
| 9 Other products | Specs come only from the catalogue; the prompt asks the bot to collect the requirement instead. |

A replaced sentence becomes a short hand-off line. The model is told about the correction on its next turn through an `<operator_note>`, and each intervention is recorded per seller.

## Lead capture

- `send_otp` checks the number is a valid Indian mobile (`+91` optional). No SMS is sent: this is demo mode, the OTP is **`12345`** (`DEMO_OTP`), and the widget shows that hint. The OTP is checked on the server and never appears in the prompt.
- `verify_otp` allows 3 attempts per OTP and 3 OTPs per chat.
- `save_lead` is refused until the number is verified. Each lead is stored under its seller.

To send real OTPs, replace the demo check in `src/tools.ts` with your SMS provider's calls, and stop returning `demo: true` from `/api/sellers/:slug` in `src/app.ts`.

## Storage

Everything is kept in one SQLite file, `DATA_DIR/chatbot.db`. Every table has a `seller` column.

| Table | Holds |
|---|---|
| `sessions` | Chat state (history, OTP progress, catalogue hits), keyed by seller and browser. One browser chatting with two sellers has two chats. Idle chats are pruned after 30 days. |
| `transcript` | What buyers typed (payment and ID details already redacted) and what they were shown |
| `leads` | Verified leads |
| `guardrail_events` | Each sentence the output guardrails replaced |
| `seller_prompts` | Each seller's brand persona (system and user prompt) |

A database from the earlier single-seller version is migrated automatically on start. Its rows are assigned to `jayshree-machinetools`.

## Admin

Set `ADMIN_PASSWORD` (at least 8 characters). The browser asks for a login: any username, with that password. If `ADMIN_PASSWORD` isn't set, the admin pages return 404.

- `/admin`: every seller with lead count, catalogue size, last crawl result, a link to their brand persona prompts and a **Re-crawl now** button
- `/admin/sellers/<slug>/prompts`: edit that seller's system and user prompts
- `/admin/leads`, filtered by seller with `?seller=<slug>`: leads, newest first, each linking to its chat
- `/admin/leads.csv` (also takes `?seller=`): a CSV that opens in Excel
- `/admin/transcript/<session>`: one full chat

## Setup (local)

```bash
npm install
cp .env.example .env        # add ANTHROPIC_API_KEY (and ADMIN_PASSWORD for /admin)
npm run kb:check
npm run crawl               # optional: needs internet access to the sellers' sites
npm run dev                 # http://localhost:3000
```

Without a crawled catalogue, a seller's site shows the business card and product cards, and the bot still answers from them. It never quotes a price or shares product links, which is what the guardrails require.

### Configuration (`.env`)

| Variable | Default | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | (none) | Required |
| `BOT_MODEL` | `claude-sonnet-5-5` | `claude-opus-5-5` is the most capable model; `claude-haiku-5-5` is the cheapest |
| `BOT_EFFORT` | `low` | `low` suits chat; raise it if answers miss nuance |
| `BOT_FALLBACKS` | `true` | Server-side refusal fallback. Claude API only; set `false` on Bedrock, Vertex or Foundry |
| `ADMIN_PASSWORD` | (none) | Turns on `/admin` |
| `DATA_DIR` | `./data` | Holds `chatbot.db` and each seller's runtime `catalogue.json` |
| `SELLERS_DIR` | `kb/sellers` | Where the seller folders are |
| `ALLOWED_ORIGINS` | (none) | Extra websites allowed to embed **any** seller's bot. Each seller's own site goes in `seller.json` |
| `CRAWL_ON_START` / `CRAWL_INTERVAL_HOURS` | `false` / `24` | Re-crawls every seller, one after another |
| `DEMO_OTP` | `12345` | Demo OTP |

## Deploying on Render

`render.yaml` is a Render Blueprint. It sets up:

- a Node 22 web service in Singapore, the closest Render region to India
- a 1 GB persistent disk at `/var/data` for the database and the crawled catalogues
- a health check on `/health`, which reports each seller's catalogue size
- automatic deploys from `main`

Steps:

1. In Render, choose **New → Blueprint** and pick this repo.
2. When prompted, enter `ANTHROPIC_API_KEY` and `ADMIN_PASSWORD`.
3. Apply. When the build finishes, open the service URL: `/` is the seller directory.
4. Optional: under the service's **Settings → Custom Domains**, add a domain and create the CNAME record Render shows.

Things to know:

- **Cost:** a persistent disk needs a paid instance (`starter`), which also never sleeps.
- **Downtime on deploy:** with a disk attached, each deploy causes a few seconds of downtime.
- **Backups:** download `/admin/leads.csv` regularly. Render also takes daily snapshots of the disk.

## Embedding a bot on the seller's own website

Add this just before `</body>` on every page, replacing `<slug>` with the seller's folder name:

```html
<script src="https://YOUR-BOT-HOST/widget.js" defer data-seller="<slug>"></script>
```

- The bubble appears bottom-right (or bottom-left with `widgetPosition: "left"`, or `data-position="left"` on the script tag), in the seller's colour and name from `seller.json`.
- The seller's site must be listed in that seller's `allowedOrigins`.
- `/demo.html?seller=<slug>` shows the embed on a blank page.
- Pages can also open the chat from a button: `SellerChat.open("<slug>", { message: "optional first message" })`.
- The chat header has a **New chat** button (circular arrow) that starts a fresh conversation after a confirmation. The previous chat stays in `/admin` and any captured lead is kept. Pages can do the same with `SellerChat.reset()`.

## Tests

```bash
npm test          # unit and HTTP tests, using two fixture sellers in tests/fixtures/sellers/
npm run eval      # live scenarios against the real model for Jayshree, one or more per guardrail, plus the lead flow
```

`npm test` covers:

- the registry and KB validation
- isolation between sellers (prompts, catalogue search, sessions, leads)
- the migration from the old single-seller database
- the crawler
- every guardrail rule
- the OTP and lead flow
- website rendering
- the admin pages

`npm run eval` calls the Claude API and costs a small amount per run.

## Project layout

```
kb/sellers/<slug>/   KB you supply per seller (+ an optional committed catalogue)
prompts/             system.md, user.md, guardrails.md (shared)
src/                 app.ts (HTTP: chat API, website, admin), server.ts, sellers.ts (registry), claude.ts (chat loop),
                     tools.ts, guardrails.ts, crawler.ts, catalogue.ts, db.ts (SQLite), site/ (page templates)
public/              widget.js (embeddable chat), site.css, demo.html
scripts/             crawl.ts, kb-check.ts, eval.ts
tests/               vitest tests + fixtures (HTML pages, two sample sellers)
render.yaml          Render Blueprint (web service + persistent disk)
```
