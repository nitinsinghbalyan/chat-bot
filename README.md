# Seller Assistants

A website that hosts an AI chat assistant for many sellers. For each seller it shows:

- **a directory** (`/`) listing every seller, with a **Visit site** button (and **Edit prompts** for your team)
- **a website per seller** (`/s/<seller>/`) built from the seller's crawled web pages and business card: Home, About Us, Products, category pages, product pages (photo gallery, starting price, specifications, description, features, related machines), Contact Us and search
- **the seller's chatbot** in the **bottom-right corner** on every page of that site (set `"widgetPosition": "left"` to move it). Every "Get quote" and "Send an enquiry" button opens it.
- **a brand persona per seller**: a system prompt and a user prompt you write in a web form, layered on top of the built-in assistant

Each bot answers buyers' discovery and enquiry questions on its seller's behalf. It uses only that seller's knowledge base and follows the guardrails. When a buyer wants a quote, a price that isn't listed, or a callback, the bot captures a verified lead: **mobile number → OTP → name**. Sellers can also embed their bot on their own website with one script tag.

## How it works

Diagrams of the whole system are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

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

**The quick way: upload their JSON.** On `/admin`, click **+ Add seller** and drop in the seller's knowledge base JSON. The form fills in the name, web address (slug), website and embed origins from the file; pick a brand colour and click **Add seller**. The seller's website (`/s/<slug>/`), chat assistant and lead capture go live straight away, with no repo change or deploy. Their files are kept on the data disk (`DATA_DIR/sellers/<slug>/seller.json` and `seller_kb.json`), so they survive redeploys. Sellers added this way can be deleted from their card; their leads and chats are kept.

**The repo way: a KB folder.** Create a folder `kb/sellers/<slug>/`, where `<slug>` uses lowercase letters, digits and dashes (e.g. `alpha-presses`). Put these files in it:

| File | Required | What it holds |
|---|---|---|
| `seller.json` | yes | Display settings (format below) |
| `business_card.json` | yes | **BUSINESS CARD**: company facts, `deals_in`, `listed_contact` |
| `product_cards.json` | yes | **PRODUCT CARDS**: options, qualification questions, handling rules |
| `sitemap.xml` | yes | The seller's sitemap, which the crawler builds the catalogue from |
| `guardrails.md` | no | Replaces the common guardrails for this seller only |
| `persona.json` | no | The seller's default brand persona: `{"system": "...", "user": "..."}` (see below) |
| `seller_kb.json` | no | A committed seller KB JSON; an upload on `/admin` takes precedence |
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
- `logoUrl`, `greeting` and `chips` are optional. The chat window no longer shows them: every seller's chat opens with the same welcome ("Welcome to <seller>. I can tell you about our machines, share photos and brochures, and pass your enquiry to our team."), which asks the buyer nothing and has no chips under it.
- `widgetPosition` (`right` by default, or `left`) picks the corner for the chat bubble.
- `tagline` and `about` are optional text for the home and About Us pages. Without them the text is built from the business card. Keep `about` to verified business card facts: Guardrail 7 rules out earnings, enquiry volume, customer count and tenure.

Then:

```bash
npm run kb:check            # validates every seller folder and names the file and field of any problem
npm run crawl -- <slug>     # optional: crawl now and commit kb/sellers/<slug>/catalogue.json
git add kb/sellers/<slug> && git commit -m "Add <seller>" && git push
```

On Render, the push redeploys. The server then crawls every seller's sitemap on start and every 24 hours after that, and the new seller appears in the directory. An invalid folder stops the server from starting, with every problem listed in the log, so run `kb:check` first.

## Seller knowledge base (JSON upload)

On `/admin`, each seller row has **Upload JSON**. The file is the seller export (`_version` 5.0, or the older 3.0, with `seller`, `company_pages`, `photo_gallery`, `categories` and `products`; version 5.0 adds each product's `faqs` and `taxonomy.glmcat_ids`, its MCAT). **Download a template** on the same page gives a small example. The upload is checked first, and any problem is listed by field (for example `products[2].name: must not be empty`); nothing changes until the file is valid.

Once uploaded, the JSON is the **main source** for both the bot and the seller's website:
- **The bot:** it replaces `business_card.json` and `product_cards.json` for that seller.
- **The website:** every product and category page is built from it (photos, specifications, description, videos, PDFs and the listed starting price). Crawled pages only fill gaps and add pages the JSON doesn't have.

The site keeps working even when the seller's own website blocks the crawler. The file is kept on the Render disk (`DATA_DIR/sellers/<slug>/seller_kb.json`), so it survives redeploys. **Download** returns it and **Remove** goes back to the KB folder files.

What the bot is given from it:

| From the JSON | Becomes |
|---|---|
| `seller` (name, nature of business, address, phone, WhatsApp, website, contact person) and allowed factsheet rows (CEO, registered address, legal status, certifications, after-sales support, competitive advantage, quality measures, infrastructure) | BUSINESS CARD |
| `company_pages` home, about, why us, our advantage, quality, infrastructure, certificates | "About the company" in the BUSINESS CARD |
| `categories` | Category guide with each category's products and **ISQs** |
| `products` (name, category, brand, model code, minimum order, specifications, description, media counts, page link) | PRODUCT CARDS, one per product, with a `Product id` (the slug of its page URL) |
| `products[].media`, `photo_gallery` (by `tagged_products`), corporate video and brochure | Photos, videos and PDFs the bot can share as cards |

**Never given to the bot (guardrails):** prices, currency and price units, delivery time, payment terms, dispatch port, packaging, production capacity, turnover, staff numbers, year of establishment, member-since, GST and statutory details, bankers, ratings, key customers, and the profile, insights, team, jobs, news and testimonial pages. Sentences about tenure, turnover, export share, staff or customer counts, prices, freight, delivery, payment, GST or stock are also dropped from descriptions and page text, as are phone numbers, emails and links inside text.

**Large catalogues:** a JSON whose bot text fits in about 300,000 characters (Jayshree's 143 products is about 170,000) goes into the bot's system prompt in full. A bigger one, with thousands of products or long descriptions, is still accepted (up to 20,000 products and a 40 MB file). The system prompt then keeps the business card, every category with its ISQs and the product names and ids, or, if even that is too long, the first few products per category. Each buyer message then pulls in the full details of the best-matching products (specifications, description and the id for sharing media) through the catalogue search. The upload result says when this applies.

**ISQs (spec questions):** worked out per **MCAT family**. Categories whose products mostly share an MCAT id (`taxonomy.glmcat_ids`) are one machine, so "CNC PRESS BRAKE" and "Cnc Press Brake Machine" ask the same questions. A family's questions come from, in order:
1. the uploaded MCAT file's specs for its MCAT id;
2. an MCAT whose name equals the category's ("Iron Worker Machine" = "Ironworker Machine"; containing a name is not enough);
3. otherwise, the specs of the family's products: each attribute whose values differ becomes a question.

Derived questions are cleaned. Brand, model, country of origin, usage/application and machine type are skipped. Spellings are merged ("Semi-Automatic" = "Semi Automatic"). Bare numbers and long values are dropped, an attribute must appear on a quarter of the products, and each family gets up to 4 questions with up to 6 options.

**The server picks the machine each turn.** It goes by the product or category page the buyer is on, else the best catalogue match for what they typed, else the product saved with the lead. It gives the bot only that category's questions, inside `<spec_questions>`, marking what was already asked and which comes next. An answer ("6 mm", a tapped option) never switches the machine; naming another machine does.

## Extra seller files and the common FAQ

Each seller's **Manage** panel on `/admin` has an **Extra files** block with three optional uploads. They're stored in `DATA_DIR/sellers/<slug>/files/` and **merged** with the KB JSON (or KB folder); each can be downloaded or removed.

| File | Format | How the bot uses it |
|---|---|---|
| Business card / policy card | Markdown (`.md`) | Kept whole as handling rules under "Seller policy card (how to handle these topics)": Dispatch, Freight, GST, Packaging, Availability, Pricing basis, Samples, Warranty, Must escalate and so on. GSTIN, bank, turnover, staff, ratings and tenure lines are left out, the internal "Dropped" section too; money, percentages, delivery durations and payment terms inside a rule are replaced by "[amount]" or removed (the upload notes say how many). "Deals in" feeds the seller's terms; numbers on contact lines are added to the numbers the bot may share. |
| MCAT specifications | JSON: `[{"mcat_id", "mcat_name", "specifications": [{"name", "options": [...]}]}]`, generated for the seller's MCAT ids | **The source of spec questions.** For the buyer's product (else the category's main MCAT), the bot asks the specs of that MCAT that the seller's products in it actually carry, with the seller's own options first; up to 4 questions with 6 options. Product cards keep their own questions and use an MCAT only when they have none. Brand, model, price, finance and usage fields are dropped. The **Knowledge mapping** block shows what each category asks and which MCAT ids the file lacks. |
| Product cards | JSON, the KB folder's `product_cards.json` format | With a KB JSON: added after its products as "Product cards (uploaded)". For a KB-folder seller: replaces the folder's `product_cards.json`. Broken or duplicate cards are skipped with a note. |

The extra text counts against the large-catalogue prompt budget.

**Knowledge mapping** (Manage → Knowledge mapping, and `/admin/sellers/<slug>/mapping.json`): per category its main MCAT, the other MCATs it pools, the question source (MCAT file or derived from the products) and the questions; the MCAT file entries used, unused and missing; each product card mapped to a category and MCAT or flagged; product FAQ counts; the policy card sections kept. Notes at the top name what needs a look (a category with no questions, an MCAT id missing from the file, an unmatched card). `npm run kb:check` prints the same for sellers on the data disk.

**Common FAQ** (`/admin/prompts`, **Common FAQ (Excel)**): one `.xlsx` (first sheet) or `.csv` for every seller, stored as `DATA_DIR/faq.xlsx` or `faq.csv`.
- **Columns:** `Question`, `Answer` and optionally `Seller` and `Category`. `FAQ`/`Q`/`gl_faq_question`, `Response`/`A`/`gl_faq_answer`, `Seller Name`/`glid` and `MCAT`/`Product` are accepted too.
- **Scope:** a row with a seller (name, URL slug or IndiaMART seller id; "Exoticasteel" matches "Exotica Steel (India)") is used only for that seller. A row with a category (several separated by `,` or `;`) is used only for sellers that deal in it, matched like MCATs. A row with neither is used for every seller. `{seller_name}` is replaced with the seller's name. The panel lists sheet sellers that match no seller here.
- **The seller's own FAQs:** a version 5.0 KB JSON carries `faqs` per product; they join the seller's rows (marked "about <product>" in `<faq>`), with or without a common sheet.
- **Per message:** the buyer's message is searched against the seller's rows (stopwords ignored, light stemming), and up to 3 matching rows go into that turn as `<faq>`.
- **Guardrails:** they still win. Rows whose answer states a price are left out, and rows that mention tax, delivery, payment, discount or stock are flagged for review.
- **Panel:** shows the rows used per seller and a preview.

## Chat features

- **ISQ chips:** the bot asks one ISQ per message and calls `show_options`. The widget shows the options as tap-to-reply buttons inside the conversation, right under that message. The buyer can tap one or type their own answer; the row then stays in the chat greyed out, with the chosen option highlighted. No buttons are shown while it is collecting the mobile number, OTP or name.
- **Order of an enquiry:** welcome (no question, no chips) → on the buyer's first message, whatever it is, only a short mobile number ask ("Please share your 10-digit mobile number.") → OTP → name (lead saved) → which machine, if still unclear → ISQs → summary card (lead updated). A buyer who won't share a number isn't blocked. Replies are kept to one or two short sentences.
- **Media and related products:** when the buyer asks for photos, a video, a brochure or PDF, or related products, the bot calls `share_media` with product ids. The server builds the cards from the KB and the crawl only, never from model text, so links can't be made up. The widget shows a swipeable carousel of up to 12 cards:
  - product cards (photo, name, category)
  - photos, which open in a viewer
  - videos with a play-button thumbnail, which play inside the chat (YouTube/Vimeo/MP4)
  - PDF cards
  On this platform's own site, product cards open the generated product page; on the seller's own website, they open the seller's page. Cards stay in the chat history after a reload.
- **No prices in chat:** the bot never states, confirms or estimates a price. It says prices are confirmed by the seller's team and offers to pass the enquiry on. The model is never shown prices, and any amount it writes is replaced before the buyer sees it. The website pages still show the seller's listed starting prices.

## Prompts: common system prompt, common guardrails, seller brand persona

With many sellers, each layer has one place to edit:

| Layer | Applies to | Default file | Edit in admin |
|---|---|---|---|
| **System prompt** (role, sources, ISQ and media rules, enquiry steps, style) | Every seller | `prompts/system.md` | `/admin/prompts` |
| **Chat guardrails** (the 9 rules) | Every seller without its own `guardrails.md` | `prompts/guardrails.md` | `/admin/prompts` |
| **Brand persona**: system part (who the assistant is, tone, greeting, what to emphasise) | One seller | `kb/sellers/<slug>/persona.json` → `system` | `/admin/sellers/<slug>/prompts` |
| **Brand persona**: user part (standing note sent with every buyer message) | One seller | `persona.json` → `user` | same page |
| **Per-turn user prompt** (lead status, catalogue hits, current page, seller note, buyer message) | Every seller | `prompts/user.md` | (file only) |

- `/admin/prompts` saves for all sellers at once and takes effect on the next chat turn. The system prompt must keep `{{GUARDRAILS}}`, `{{BUSINESS_CARD}}`, `{{PRODUCT_CARDS}}` and `{{BRAND_PERSONA}}` (and may use `{{SELLER_NAME}}`). **Reset to defaults** goes back to the files in `prompts/`. Edits are stored in the database (`platform_prompts`).
- A seller's persona from `persona.json` is used until someone saves one in admin. **Reset to default** on the persona page goes back to `persona.json`.
- **Versions:** both pages have a **Versions** panel. Every save, reset and restore is kept with an optional "What changed?" note (the newest 50 per prompt), and so is each shipped default whenever a deploy changes `prompts/*.md` or a `persona.json` ("Built-in default"). **View** shows a version's changes against the one in use, and **Restore** makes it live. **Prompt changes ship with the code and apply themselves.** When a deploy changes `prompts/system.md`, `prompts/guardrails.md` or a seller's `persona.json`, and an older edit saved in admin is in use, the new built-in replaces it at startup. Only the changed part is replaced: a new system prompt keeps edited guardrails, and a new persona user part keeps an edited system part. The replaced edit stays in **Versions** with a note, so **Restore** brings it back, and the server log says what was applied. An edit saved *after* a deploy stays until the next deploy that changes that file. History is in the `prompt_versions` table.
- Starting a persona for a new seller: copy `kb/sellers/jayshree-machinetools/persona.json` and change the company, brand, product range and tone. Keep to verified facts: Guardrail 7 rules out tenure, earnings and customer counts.

## Knowledge and prompts (KB folder)

| Name in the guardrails | Source | Goes into |
|---|---|---|
| BUSINESS CARD | uploaded JSON, else `business_card.json` | System prompt (cached) |
| PRODUCT CARDS | uploaded JSON, else `product_cards.json` | System prompt (cached) |
| SELLER CATALOGUE (RAG) | crawled from `sitemap.xml` | Each turn's user prompt: the top matches, plus the page the buyer is viewing |

- `prompts/system.md` is the default common system prompt. `{{GUARDRAILS}}` is filled from the common guardrails, or from the seller's own `guardrails.md`.
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
- **Reset to default** goes back to the seller's `persona.json` (or nothing, if it has none). The form also shows a preview of the full system prompt.
- Tags such as `<business_card>` or `<seller_instructions>` are stripped from both the prompts and buyer messages, so neither can break out of its block.

## Guardrails

The 9 shared guardrails are in `prompts/guardrails.md`, word for word. The high-risk ones are also enforced in code (`src/guardrails.ts`), for every seller:

| Guardrail | Code enforcement |
|---|---|
| 1 Price | The bot never states a price. Prices are kept out of what the model sees, and any ₹, lakh or crore amount it writes is replaced with "Prices are confirmed by our team…". The website still labels the seller's listed prices as "Starting price". |
| 2 Freight | Freight or transport terms (included, extra, free…) are replaced. |
| 3 Contact | Phone numbers other than the seller's listed number, and any email or external link, are replaced. Only links to the seller's own site pass. |
| 4 Stock / brand | "In stock", "genuine <Brand>" and similar are replaced. |
| 5 Payment / ID | UPI, card, Aadhaar, PAN, GSTIN, IFSC and bank account numbers typed by the buyer are redacted before the model or logs see them. |
| 6 Delivery | Dispatch dates, lead times and door-delivery promises are replaced. |
| 7 Disclosure | Business-profile pages are never crawled; turnover, staff, tenure, GST, bank and rating fields of an uploaded JSON are never read, and such sentences are dropped from its text; the prompt handles the rest. |
| 8 GST | GST rates and "inclusive/exclusive of tax" are replaced. |
| 9 Other products | Specs come only from the catalogue; the prompt asks the bot to collect the requirement instead. |

A replaced sentence becomes a short hand-off line. The model is told about the correction on its next turn through an `<operator_note>`, and each intervention is recorded per seller.

## Lead capture

- `send_otp` checks the number is a valid Indian mobile (`+91` optional). No SMS is sent: this is demo mode, the OTP is **`12345`** (`DEMO_OTP`), and the widget shows that hint. The OTP is checked on the server and never appears in the prompt.
- `verify_otp` allows 3 attempts per OTP and 3 OTPs per chat.
- `save_lead` is refused until the number is verified. The bot calls it as soon as it has the name, so a buyer who leaves mid-way is still a lead, and again after the last ISQ, which updates the same lead with the answers. Each lead is stored under its seller.
- **Enquiry summary:** the last `save_lead` call carries each ISQ answer as a `specs` item and `complete: true`. The chat then shows a **Your enquiry** card built by the server from what was saved: machine, each spec, other details, quantity, city, name and masked mobile. The bot adds one line asking if anything needs changing, with **All correct** / **Change a detail** buttons. A correction calls `save_lead` again, which updates the same lead and shows a new card. The lead's `requirements` column stores the specs as `Label: value; …`, and the admin transcript shows a `[Summary: …]` line.

To send real OTPs, replace the demo check in `src/tools.ts` with your SMS provider's calls, and stop returning `demo: true` from `/api/sellers/:slug` in `src/app.ts`.

## Simulator API (chat simulators such as the AI Assistant Auditor)

A simulator can run scripted buyer chats against any seller's bot, one JSON reply per message: `POST /api/v1/bots/<slug>/chat` with an `X-Bot-Key` header. Generate keys per seller on `/admin`: the **Simulator key** button on a seller's row opens its **Simulator API** block. Each key is shown once and can be revoked. Simulated chats run the real journey. Their leads are saved as **test** leads, which the Leads page hides unless you tick **Show test chats**, and their traces are tagged `eval`. Full reference: [docs/SIMULATOR_API.md](docs/SIMULATOR_API.md).

## Tracing (Langfuse)

Set `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY` to send traces to Langfuse, plus `LANGFUSE_BASE_URL` (or `LANGFUSE_HOST`) for a self-hosted Langfuse. Without the keys nothing is sent. On Render, add them under Environment and redeploy. The release is the deployed git commit (`RENDER_GIT_COMMIT`), and the environment is `LANGFUSE_ENVIRONMENT`, else `NODE_ENV`.

**Startup check:** at startup the server asks Langfuse whether it accepts the keys. Without `LANGFUSE_BASE_URL` it tries the EU cloud (`https://cloud.langfuse.com`), then the US cloud (`https://us.cloud.langfuse.com`), and uses whichever accepts them. Keys are trimmed, since a pasted space makes Langfuse reject them. The result appears in the startup log (`[tracing] …`), on `/health` (`tracing.state`: `off`, `ok`, `auth_failed`, `unreachable`) and on `/admin`. `/admin` shows a red banner when the keys are rejected and a warning when exports fail. Export failures are also logged as `[tracing] export of N spans failed: …`.

**Is it working?** `/health` and the `/admin` tracing line show:
- the Langfuse server version
- every trace upload since the last deploy (count, spans, last upload time, OK or failed with the HTTP error)

**Test Langfuse** on `/admin` runs four steps and names the step that fails:
1. Server and version. Langfuse 2.x has no OpenTelemetry endpoint and can't take these traces.
2. Keys and project.
3. Upload one test trace (`langfuse-connection-test`).
4. Whether Langfuse returns that trace from its API within 20s.

If step 3 passes and step 4 fails, the Langfuse server accepted the data but isn't storing it. On a self-hosted Langfuse that points to its worker, ClickHouse or event storage, or a version too old for this SDK (v6 sends `x-langfuse-ingestion-version: 4`). If all steps pass, open the linked trace and check the project and the environment filter. Production traces use environment `production`.

Production uses a **self-hosted Langfuse** (`langfuse.intermesh.net`), set with `LANGFUSE_BASE_URL`.

**One trace per buyer message** (`chat-turn`), grouped in Langfuse **Sessions** by conversation: `<seller>:<chat id>`. The chat id is a new uuid for every conversation, so a chat after 2 hours idle or **New chat** gets its own session even in the same browser. Every span carries the session and user under both `session.id`/`user.id` and the older `langfuse.session.id`/`langfuse.user.id`, so self-hosted Langfuse versions that predate the new names still group them. The admin transcript shows each conversation's Langfuse session id, with a link, and the leads CSV has a `langfuseSession` column, tagged with the seller and `on-platform` or `embedded`. User id is the buyer's masked mobile once verified. Each trace holds:

| Observation | Type | What it shows |
|---|---|---|
| `catalogue-search` | retriever | The query (or the follow-up fallback to the last query) and the products and categories found |
| `claude round N` | generation | One per Claude call: model that actually answered (fallbacks show), effort, this round's new input (the per-turn prompt or the tool results), output, tokens including cache reads and writes, cost in USD, stop reason. API errors are ERROR, refusals WARNING |
| `send_otp`, `verify_otp`, `save_lead`, `show_options`, `share_media` | tool | Input and result of each tool call; failed calls are ERROR |
| `output-guardrails` | guardrail | Only when the output filter replaced something: the rules and the removed sentences (WARNING) |

Trace metadata has the page URL, lead stage before and after, and the prompts in use: the common prompt version (`v12`), the persona version, the knowledge base mode (KB folder or JSON full / index / partial) and the system prompt length. The system prompt itself isn't copied into traces; its text is in the admin version history.

Trace metadata also has `turnCostUsd`, and the chat's running `chatCostUsd`, `chatTokens` and `chatTurns`.

**Per-chat cost:** each Langfuse session (chat) has a `chat_cost_usd` score, the total USD cost of every Claude call in the chat so far. It is replaced after every buyer message, with a comment such as "6 buyer messages, 575,120 tokens". The running totals are kept with the chat in the `sessions` table, so they survive restarts. Costs come from the price table in `src/tracing.ts`. A call to a model missing from that table counts as zero and is flagged "some calls unpriced". Langfuse's Sessions view also adds up the per-call costs.

**Scores:** `lead_captured`, `lead_updated`, `summary_shown`, `guardrail_fired` (count), `fallback_reply` (the buyer got a canned reply), `chat_cost_usd` (per session, above), and buyer feedback: when tracing is on, the widget asks "Was this helpful? 👍 👎" **once per chat, under the enquiry summary card**. A vote is recorded as `buyer_feedback` on that reply's trace and `chat_feedback` on the chat's session (+1 / −1; changing the vote replaces both). Buyers can only rate their own chat.

**Privacy:** mobile numbers are masked as `xxxxxx3210` everywhere in a trace (also by the exporter as a last check), OTPs are never recorded, and payment or ID details are already removed from buyer messages before the bot sees them. Names are kept.

## Storage

Everything is kept in one SQLite file, `DATA_DIR/chatbot.db`. Every table has a `seller` column.

| Table | Holds |
|---|---|
| `sessions` | Chat state (history, OTP progress, catalogue hits, running token and cost totals), keyed by seller and browser. One browser chatting with two sellers has two chats. Idle chats are pruned after 30 days. |
| `transcript` | What buyers typed (payment and ID details already redacted) and what they were shown |
| `leads` | Verified leads |
| `prompt_versions` | Version history of the common prompts and each brand persona |
| `guardrail_events` | Each sentence the output guardrails replaced |
| `seller_prompts` | Each seller's brand persona (system and user prompt) saved in admin |
| `platform_prompts` | The common system prompt and guardrails, when edited in admin |

A database from the earlier single-seller version is migrated automatically on start. Its rows are assigned to `jayshree-machinetools`.

## Admin

Set `ADMIN_PASSWORD` (at least 8 characters). The browser asks for a login: any username, with that password. If `ADMIN_PASSWORD` isn't set, the admin pages return 404.

- `/admin`: one row per seller, with a filter box once there are more than 3. Each row shows:
  - status badges: knowledge base, crawl (OK, partial or failed) and persona
  - leads, products and categories, when the JSON was uploaded (or the last crawl), and **View site**

  **Manage** opens the row, which holds:
  - stats: leads, products, categories, photos, videos and PDFs
  - a drag-and-drop JSON upload, with download and remove
  - the website catalogue and **Re-crawl now**
  - the brand persona
  - for sellers added in admin, **Delete seller**
- `/admin/sellers/new`: add a seller by uploading their JSON
- `/admin/prompts`: the common system prompt and chat guardrails for all sellers
- `/admin/kb-template.json`: a template for the knowledge base JSON
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
| `CRAWL_ON_START` / `CRAWL_INTERVAL_HOURS` | `false` / `24` | Re-crawls every seller, one after another. A crawl that fetches fewer than 80% of the pages already in the catalogue (the site blocking or rate-limiting part-way) doesn't replace it, and shows as **Crawl partial** on `/admin` |
| `DEMO_OTP` | `12345` | Demo OTP |

## Deploying on Render

`render.yaml` is a Render Blueprint. It sets up:

- a Node 22 web service in Singapore, the closest Render region to India
- a 1 GB persistent disk at `/var/data` for the database and the crawled catalogues
- a health check on `/health`, which reports the running build (`build.commit` from Render's `RENDER_GIT_COMMIT`, `build.startedAt`), the model, tracing status and each seller's catalogue size. The admin footer shows the same build id, so a deploy can be confirmed at a glance
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

Full file tree with each file's job: [docs/REPO_STRUCTURE.md](docs/REPO_STRUCTURE.md). System design and flows (journey, chat turn, ISQs, data, routes): [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

```
kb/sellers/<slug>/   KB you supply per seller (+ optional persona.json, seller_kb.json, catalogue)
prompts/             system.md, user.md, guardrails.md (common defaults; editable at /admin/prompts)
src/                 app.ts (HTTP: chat API, website), admin.ts (admin pages), server.ts, sellers.ts (registry), claude.ts (chat loop),
                     tools.ts (OTP, lead, show_options, share_media), sellerKb.ts (JSON upload), sellerFiles.ts (extra
                     seller files, MCAT matching), faq.ts (common FAQ), shareMedia.ts,
                     media.ts, guardrails.ts, crawler.ts, catalogue.ts, db.ts (SQLite), site/ (page templates)
public/              widget.js (embeddable chat), site.css, admin.css, demo.html
scripts/             crawl.ts, kb-check.ts, eval.ts
tests/               vitest tests + fixtures (HTML pages, two sample sellers, a sample KB JSON, a sample FAQ .xlsx)
render.yaml          Render Blueprint (web service + persistent disk)
```
