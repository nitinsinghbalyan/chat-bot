# Seller assistants (platform)

**Repo:** `nitinsinghbalyan/chat-bot` · **Production:** Render service `jayshree-chatbot` (Singapore, starter plan, 1 GB disk at `/var/data`), auto-deploys `main`.
**Status:** live. Jayshree is the first seller (v3 export, repo seller). Five more sellers' **v5** files arrived on Oct 18 (Exotica Steel, Herbaveda Overseas, National Industries, Sewa Enterprises, Unicorn Equipment: v5 JSON, MCAT specs, policy card .md, product cards, plus one FAQ sheet for 11 sellers); Nitin adds them on `/admin` by uploading those files.

## What it does
- Answers buyers' discovery and enquiry questions **on the seller's behalf**, grounded in the seller's KB, within 9 guardrails.
- Enquiry order: fixed welcome (same text for every seller, asks nothing, no chips) → mobile asked on the buyer's **first message**, whatever it is, and that reply is **only** the ask ("Please share your 10-digit mobile number."; no "Yes, we make…") → OTP (demo `12345`) → name (lead saved) → which product, if still unclear → ISQs one at a time as tap-to-reply chips **inline in the chat** (the server picks the product's category **and MCAT** each turn, never from a greeting or a vague message, and gives the bot only that MCAT's questions that the seller's products carry, in `<spec_questions>`; chips arrive with the question, no extra Claude call) → lead updated with the answers → **enquiry summary card** ("Your enquiry": product, each spec, quantity, city, name, masked mobile) + "Anything to change?" with All correct / Change a detail chips; a correction updates the lead and shows a new card. A buyer who won't share a number isn't blocked. **The server, not the model, decides completion:** `complete: true` is honoured only once the product is known and every question of its plan was asked or answered; otherwise the tool result names the next question.
- Replies are brief: 1–2 short sentences (~40 words), answer first, no filler, options only as chips.
- Shares photos, videos, PDFs and related products as a carousel.
- Handles large catalogues: over ~300k characters the system prompt keeps categories, ISQs and a product index; details come per message from the catalogue search.
- Generates a full website per seller from the KB JSON (with crawled pages as a fallback).
- Admin for the team: a sellers list and one page per seller (`/admin/sellers/<slug>`) with KB upload and **extra files** (policy card .md, MCAT specs, product cards), the **Knowledge mapping** card (categories → MCATs → questions, flags; also `/admin/sellers/<slug>/mapping.json`), **bot keys** for the simulator, add seller, crawls, personas, common prompts with **version history** (View diff, Restore) and the **common FAQ** Excel, leads (test chats hidden by default) and transcripts (each conversation linked to its Langfuse session).
- Simulator API for the AI Assistant Auditor: `GET /api/v1/bots/<slug>` and `POST /api/v1/bots/<slug>/chat` with `X-Bot-Key`; one JSON reply per message, same chat turn as the widget (`docs/SIMULATOR_API.md`).
- **Prompt updates apply themselves:** a deploy that changes `prompts/*.md` or a `persona.json` replaces an older admin edit of that part at startup (kept in Versions). Claude makes prompt changes in the repo; Nitin doesn't need to click anything.
- Langfuse tracing (when keys are set): a trace per buyer message; **one Langfuse session per conversation** (`<seller>:<chatId>`, stamped under `session.id` and legacy `langfuse.session.id`); mobiles masked, OTPs never sent; scores plus 👍/👎 asked **once per chat, under the summary card**; **per-chat cost** as a `chat_cost_usd` session score (running total, replaced each message).
- Tracing health is visible: startup key check (EU then US cloud auto-detect), `/health` `tracing.state`, red banner on `/admin` when keys are rejected, `[tracing] export failed` in logs.

## Architecture (where things live)
Full design with diagrams: `docs/ARCHITECTURE.md`. Every file with its job: `docs/REPO_STRUCTURE.md`. Keep both updated when files or flows change.

| Area | Files |
|------|-------|
| HTTP: chat API (SSE), website routes | `src/app.ts` |
| Admin pages (Basic auth, any username + `ADMIN_PASSWORD`, same-origin POSTs); sellers list = `sellerListRow()` + `LIST_SCRIPT`; seller page = `sellerPage()` (summaryCard, kbCard, filesCard, mappingCard, catalogueCard, keysCard, personaCard, dangerCard) + `MENU_SCRIPT` + `DROPZONE_SCRIPT` | `src/admin.ts`, `public/admin.css` |
| Seller registry, catalogue merge, admin sellers | `src/sellers.ts` |
| KB JSON (v5/v3): lenient schema, repairs, guardrail filters, MCATs per category, ISQ plans, product FAQs, prompt text, catalogue entries | `src/sellerKb.ts` |
| Extra files: policy card .md parser (sections kept, amounts stripped), MCAT specs and product cards loaders | `src/sellerFiles.ts` |
| Knowledge mapping report (categories → MCATs → questions, MCAT file use, cards, FAQs, policy card, flags) | `src/mapping.ts` |
| Per-chat machine tracking: category + MCAT per turn, `<spec_questions>` text | `src/isqTracker.ts`, `src/session.ts` |
| Common FAQ sheet (Seller/Category scoping) merged with product FAQs; `<faq>` hits | `src/faq.ts` |
| Simulator API keys (`sa_live_…`, sha256 stored) | `src/botKeys.ts` (routes in `src/app.ts`, UI in `src/admin.ts`) |
| Chat loop: Claude streaming, tools, output filter | `src/claude.ts`, `src/tools.ts`, `src/guardrails.ts` |
| Prompts: common system and guardrails templates, per-turn user template; version history and diff | `prompts/system.md`, `prompts/guardrails.md`, `prompts/user.md`, `src/prompts.ts`, `src/promptVersions.ts`, `src/diff.ts` |
| Media cards | `src/shareMedia.ts`, `src/media.ts` |
| Crawler (images, videos, PDFs, specs, partial-crawl guard) | `src/crawler.ts`, `scripts/crawl.ts` |
| SQLite: sessions, transcript (with trace_id), leads, guardrail_events, seller_prompts, platform_prompts, prompt_versions | `src/db.ts` |
| Langfuse tracing: setup, masking, prices, scores | `src/tracing.ts` (runTurn gets a `trace` sink; `/api/feedback` in `src/app.ts`) |
| Website templates | `src/site/pages.ts`, `src/site/html.ts`, `public/site.css` |
| Widget | `public/widget.js` |

**Claude call:**
- `client.beta.messages.stream`, model `BOT_MODEL` (default `claude-sonnet-5-5`), effort `BOT_EFFORT=low`
- server-side fallback `server-side-fallback-2026-07-01` with `fallbacks: "default"`
- strict tools with `eager_input_streaming`; `tool_choice` auto (forced tool use is a 400 on 5.5 models)
- the system prompt is cached; with Jayshree's JSON it is about 43k tokens
- capacity (estimates from the code's limits, not measured): Sonnet 5.5 has a 1M-token context; a large catalogue is capped at ~75–85k tokens; the worst case (large catalogue + 40-turn chat cap) is ~200k tokens per request
- rough cost per message: under 1¢ for Jayshree once cached, ~2¢ for a large catalogue, ~11¢ for the first message after 5 idle minutes (cache rewrite)
- each Claude round is one `generation` in Langfuse, with the served model, tokens and cost

**Tools:** `send_otp`, `verify_otp`, `save_lead` (fields incl. `specs[{label,value}]` and `complete`; `complete: true` → summary card only when the completion guard passes, else the result names the next question), `show_options`, `share_media`.

## Decisions (and why)
| Decision | Reason / who decided |
|----------|---------------------|
| Claude via Anthropic SDK, Node/TypeScript | Nitin's choice at the start |
| Handoff = mobile, then OTP `12345`, then name | Nitin |
| Lead first: ask mobile as soon as the machine is named, then OTP, name (lead saved), then ISQ chips; lead updated after the last ISQ. Buyer who declines isn't blocked | Nitin (Oct 2026) |
| Replies brief: 1–2 sentences, ~40 words, no filler, options only as chips | Nitin |
| Chips inline in the chat log (not a bar above the input) | Nitin |
| Prompt version history for common prompts and personas, with diff, restore and built-in banner | Nitin |
| Langfuse tracing (v6 `@langfuse/tracing` + `@langfuse/otel`): one trace per buyer message, Sessions per chat; mask mobiles/OTPs, system prompt by version reference only, 👍/👎 buyer feedback + automatic scores. Off without keys | Nitin |
| Detailed summary after requirement gathering = server-built card from the saved enquiry (not bot-written text), buyer can correct it | Nitin (Oct 2026) |
| Per-chat cost in Langfuse only (session score + trace metadata), not in admin | Nitin |
| Catalogue from crawling the sitemap | Nitin |
| Extra per-seller files (business card .md, MCAT specs JSON, product cards JSON) **merge** with the KB JSON (earlier "MCAT not used" reversed, Oct 2026) | Nitin |
| ISQ source: **MCAT first** (by the products' MCAT id, else equal name), else cleaned derived ISQs pooled per MCAT family; **server picks the category per turn** (`<spec_questions>`) | Nitin (Oct 16); the family pooling was replaced by per-MCAT plans on Oct 18 (row below) |
| 👍/👎 only once per chat, under the summary card | Nitin |
| Journey: welcome (no question, no chips, same for all sellers) → mobile on the first message → OTP → name → product if unclear → ISQs → summary | Nitin (Oct 16) |
| Questions per MCAT in **three layers** up to 4: MCAT specs the products carry → derived from the products → the MCAT's remaining standard specs. The MCAT files hold only 2–3 specs per MCAT and the file-only rule left half the categories with ≤1 question ("bot asks only one specification") | Nitin's report, Oct 19 |
| **Refined (Oct 19, later):** product → its categories (many-to-many via `product_ids`) → values across that category's products are the seller's spec options, asked **first**; then the MCAT's specs the seller doesn't carry; order key → config → regular when the MCAT file marks types (today's files don't: coverage, then file order); **cap 8 per conversation** | Nitin |
| Completion is enforced server-side (no summary while spec questions remain); a greeting never selects a product; common wording is "product", not "machine" (Herbaveda's bot read "Hi" as Hing and summarised at once) | Nitin's report, Oct 19 |
| Claude changes prompts itself in the repo; built-ins apply over older admin edits on deploy (no "Use the new built-in" click) | Nitin (Oct 16) |
| Every trace has a unique per-conversation session id `<seller>:<chatId>` (audit); stamped under new and legacy attribute names | Nitin |
| Common FAQ Excel (Question, Answer, optional Category), searched per message as `<faq>`, scoped per seller by category; guardrails win | Nitin |
| Simulator API for the AI Assistant Auditor: new vendor there (not NIVA impersonation), per-seller `X-Bot-Key` keys made in admin (hash stored, shown once), one JSON reply per message at `/api/v1/bots/<slug>/chat`; simulated leads saved as **test** (hidden on Leads by default), traces tagged `eval` | Nitin (Oct 16) |
| **Master JSON v5** replaces v3 (old files still load). Questions per **MCAT within a category**: the buyer's product's MCAT (else the category's main one), only the MCAT file's specs the seller's products carry, chips show all MCAT options with the seller's first; cards stay knowledge (no card-driven questions); policy card .md kept whole as handling rules with amounts/terms stripped; v5 product FAQs + FAQ sheet "Seller Name" column merged per seller; Knowledge mapping report in admin | Nitin (Oct 18) |
| SQLite on a Render disk; Render hosting | Nitin |
| Multi-seller; KB supplied per seller | Nitin |
| Widget bottom-right (was bottom-left) | Nitin |
| Directory is visit-only; no chat on `/` | Nitin |
| Brand persona edited in a web form, layered on top of the built-in rules (guardrails win) | Nitin |
| New chat button | Nitin |
| KB JSON upload is the **main source** for bot and website; crawl only fills gaps | Nitin |
| **Bot never states prices**; website keeps starting prices | Nitin |
| JSON format = the seller export v3.0 (we adapted to it; no custom schema) | Nitin sent a sample export |
| ISQs derived from category specs (the export has no question list) | Claude's design, accepted |
| One common system prompt and guardrails for all sellers, editable in admin | Nitin (5+ sellers) |
| Admin = seller rows UI (was cards): one compact row per seller, **Manage** expands its controls in place; public directory keeps cards (superseded by #31) | Nitin |
| Admin redesign (#31): teal design system from Nitin's mockups; the list is a table with search + status chips, each seller has its own page (`/admin/sellers/<slug>`) with cards and a **Manage ▾** menu; all admin pages restyled, layouts kept | Nitin's mockups; "Page + dropdown" and "restyle all pages" chosen by Nitin |
| Add seller by uploading JSON | Nitin |
| Lenient import: repair or skip bad records, warn; refuse only unusable files | After a production failure on a blank `category_id` |
| Never commit raw seller exports | They contain GST, bank and turnover data |
| Large KBs accepted: over ~300k characters, the system prompt keeps categories + ISQs + product index, details come per message via catalogue search | A 3.3M-character export was refused by the old 400k limit |
| **No vector RAG for now** (Oct 23). The bot already retrieves per turn (lexical MiniSearch over the catalogue and FAQs; small sellers get the whole KB in the cached prompt). Measure first with `npm run retrieval:eval`, fix inside the current design in order (query cleanup, synonyms, tighter product pick, a `search_catalogue` tool), add embeddings as a hybrid only if need-description and Hinglish recall stay poor | Claude's assessment to "is this the best architecture, do we need a RAG?"; Nitin asked for the eval and baseline |

## History (PRs, all merged to main)
| PR | What |
|----|------|
| #1 | Guardrailed seller enquiry bot for Jayshree; SQLite, admin leads, Render blueprint |
| #2 | Multi-seller: directory, crawled mini-sites, a bot per seller, DB migration |
| #3 | Full seller website (home, about, products, category, product, contact); widget bottom-right |
| #4 | Visit-only directory; brand persona prompts |
| #5 | New chat button |
| #6 | KB JSON upload, ISQ chips, media carousel, no prices in chat, common prompts, default personas |
| #7 | Admin redesign (cards), add seller by JSON, website from the JSON, partial-crawl guard |
| #8 | Lenient KB import (blank ids or names, duplicates) with fix notes |
| #9 | Project memory (CLAUDE.md + memory/) |
| #10 | Large catalogues: prompt budget with index/partial modes, `ID:` and details in catalogue hits, 20k products / 40 MB uploads |
| #11 | Admin sellers list as expandable rows (Manage), filter box, row opens after upload/crawl/add |
| #12 | Prompt versions (common + personas), lead-first flow, inline chips, brief replies |
| #13 | Langfuse tracing, scores and buyer feedback |
| #14 | Project memory refresh |
| #15 | Enquiry summary card, per-chat cost score, Langfuse key check / region auto-detect / visible tracing status |
| #16 | Langfuse upload counters, server version, **Test Langfuse** button on /admin |
| #17 | Extra seller files (business card .md, MCAT specs, product cards) and the common FAQ Excel |
| #18 | Feedback once per chat (under the summary), instant chips (no extra Claude call after show_options), ISQs per MCAT family with the server picking the category per turn, unique Langfuse session per conversation |
| #19 | Built-in prompts and personas apply automatically on deploy; Jayshree persona asks the `<spec_questions>`; memory refresh |
| #20 | New journey: fixed welcome without chips, mobile on the first message, machine asked after the name if unclear |
| #21 | First reply asks only for the mobile number (no machine confirmation) |
| #22 | Docs: `docs/ARCHITECTURE.md` (system, journey, chat turn, knowledge/ISQ/FAQ, prompts, guardrails, tracing, data, routes) and `docs/REPO_STRUCTURE.md` |
| #23 | Simulator API (`docs/SIMULATOR_API.md`): bot keys in admin, JSON chat endpoint, test leads, `eval` trace tag; chat turn shared by widget and API |
| #24 | Master JSON v5, questions per product MCAT checked against the seller's products, policy card as handling rules, product FAQs + FAQ Seller column, Knowledge mapping report (`src/mapping.ts`) |
| #25 | Project memory refresh after #23/#24 |
| #26 | **Simulator key** button on each seller row (opens the row's Simulator API block, now second in Manage), "N simulator keys" badge, build id on `/health` (`build.commit`) and in the admin footer |
| #27 | Herbaveda "Hi → Hing" fix: no prefix/fuzzy search on very short words, a product is picked from the buyer's words only when a distinctive word is shared, **completion guard** in `save_lead` (no summary while questions remain; tool result names the next one), "product" wording in the common prompt and tools |
| #28 | Project memory refresh after #26/#27 |
| #29 | Layered spec questions (on products → derived → MCAT standard, up to 4): mean questions per category on the real exports 1.3–3.0 → 3.1–4.0; per-question origin badges in Knowledge mapping |
| #30 | Refined mapping: seller's specs across the category's products first (MCAT options merged by name), then the MCAT's uncarried specs; ISQ type order when the file marks it; cap 8; products in several categories; MCAT file keeps usage/size/warranty/origin specs and up to 8 per MCAT. Means per category 4.2–7.6 |
| #31 | Admin redesign to Nitin's mockups: teal tokens in `admin.css`, sellers table with search and status chips, seller page `/admin/sellers/<slug>` (summary + Manage ▾, Knowledge base, Extra files with Replace, Knowledge mapping, catalogue, Simulator API, persona, delete), build id in the Deployment card, old `?kb=`/`?crawl=`/`?added=` links redirect |
| #32 | Project memory refresh after #31 |
| #33 | Retrieval eval: `scripts/retrieval-eval.ts` (`npm run retrieval:eval -- <dir>`) scores the catalogue search and the server's product pick on the sellers' own test cases; baseline below |

## Retrieval baseline (Oct 23, #33)
How well the per-turn retrieval works on real buyer text, measured with `npm run retrieval:eval` on the four sellers that have test material (`<Seller>/*_Bot_Test_Cases.csv` + `*_Scenarios.json` in Nitin's zip; Herbaveda has none). Each buyer input is run as the first message of a new chat through the same code as a chat turn: `Catalogue.search` then `updateCategory`. "Right" = the top hit is the scenario's focus product (same MCAT name, or its distinctive words in the hit's title, category or MCAT name). Re-run after any change to `src/catalogue.ts`, `src/isqTracker.ts` or the search fields, and compare.

**Prompt modes today** (from `promptPlan()` on the real exports): National Industries 569 products → `index` (~35k prompt tokens), Herbaveda 526 → `index` (~23k), Unicorn 218 → `index` (~11k), Exotica 153 → `full` (~66k), Sewa 16 → `full` (~9k). Index-mode sellers depend on the per-turn search for product details; full-mode sellers have everything in the prompt and the search only drives the server's product pick.

| Seller | Cases naming a product | Any hit | Top-1 right | Top-4 right | Server picked right | Picked wrong | No pick | Off-topic messages that still picked a product |
|---|---|---|---|---|---|---|---|---|
| Exotica Steel | 68 | 97% | 75% | 84% | 68% | 15% | 18% | 4 of 23 |
| National Industries | 67 | 99% | 82% | 90% | 81% | 4% | 15% | 13 of 23 |
| Sewa Enterprises | 66 | 91% | 64% | 73% | 55% | 17% | 29% | 7 of 27 |
| Unicorn Equipment | 68 | 100% | 85% | 91% | 76% | 7% | 16% | 7 of 22 |
| **All four** | **269** | **97%** | **77%** | **84%** | **70%** | **11%** | **19%** | **31 of 95** |

By language (all four): English 126 cases, top-1 79%, picked right 75%, no pick 14%; Hinglish 143 cases, top-1 74%, picked right 66%, no pick 24%, and 6% with no hit at all (Sewa's Hinglish: 17% no hit).

By scenario suite (all four): spec_deep_dive 96% top-1 (56 cases), lead_capture 91% (56), guardrail 80% (54), language_handling 76% (42), **product_discovery 33%** (48 cases: top-4 46%, picked right 23%, picked wrong 23%, no pick 54%). "Off-topic" above excludes the catalogue_boundary suite, where the buyer names a related product the seller may sell and a pick is often right (28 such picks).

What it says:
- **When the buyer names the product, retrieval works**: 91–96% top-1 on the suites that carry the lead flow, and the server picks it. The lead journey is not where the gap is.
- **The gap is product discovery**: a need described without the product's name ("we knead dough and wash vegetables in bulk, need a big wide vessel", "papa ko lakwa hai, male caretaker") gets the right top hit a third of the time. Keyword search cannot do this. A full-mode seller's model still has the catalogue in its prompt; an index-mode seller's model gets no details for that turn. This is the case for a model-driven `search_catalogue` tool (the model rewrites the need into product words) and, if that is not enough, embeddings.
- **Sewa's siblings get confused** (maid vs cook vs babysitter): every title shares "24 Hours … Service … Noida", so the numbers and shared words outrank the one distinctive word ("24 ghante ka cook chahiye" → "24 Hours Maid Service"). Query cleanup (drop numbers and filler, weight the MCAT name) and a Hinglish word list ("bachcha samhalne" → babysitting, "ghar ka kaam" → maid) are the cheap fixes.
- **False picks on off-topic text**: a third of the clearly off-topic messages still set a product ("weather in Delhi" matched the category "Ride On Roller Manufacturer In Delhi Ncr"; "developer mode … bar bending machines" names a product). Consequence: that product's `<spec_questions>` go to the model and the lead carries a category; the completion guard still protects the summary. Tighten `updateCategory` so the shared word must come from the product title, not an SEO-style category name or a city.
- **Label noise**: the focus product comes from the scenario, and a few refer to a later turn or are mislabelled ("Steel spoon chahiye" → Stainless Steel Mugs), so top-1 undercounts by a few points. Read the printed misses before acting on a single number.

Next steps in order, each re-measured with the eval (target: top-1 85%+ overall, discovery 50%+, off-topic picks under 15%): query cleanup in `Catalogue.search`; per-seller synonym and transliteration list; tighter pick rule; `search_catalogue` tool; embeddings hybrid only if discovery is still poor after that.

## Open items / ideas
- **Langfuse (self-hosted `langfuse.intermesh.net`):** after #16/#18, check that traces appear grouped by conversation. If not, **Test Langfuse** on /admin names the failing step (server version, upload refused, or accepted but not stored, which is for the intermesh Langfuse admins).
- **Jayshree's files are still the old set:** v3 export (no product FAQs, no `seller_id`) and an MCAT file of mostly construction MCATs (only the ironworkers match by id). A v5 export plus a generated MCAT file for their real ids (e.g. 25058 press brakes, 1669, 123956, 185336 shears, 182186 laser) would make those questions authoritative; until then the Knowledge mapping block shows them as **derived**.
- Check the live bot asks the right questions per machine (press brake vs shear vs laser), and that categories with no ISQs (single-product ones like H Frame Hydraulic Press) behave well.
- **Real-data figures from #24 (local run, Oct 18):** MCAT file ids used Exotica 67/67, Herbaveda 331/337, NI 200/205, Sewa 5/5, Unicorn 65/66; cards matched 23/25, 71/71, 53/53, 4/5, 14/14; FAQ sheet rows per seller 54/46/183/21/130; Exotica has 304 product FAQs. Buyer text such as "triply kadhai 24 cm chahiye" resolves to GSP Triply Cookware · Stainless Steel Kadhai (Construction, Diameter, Capacity).
- Real SMS OTP (replace the demo check in `src/tools.ts`; stop sending `demo: true` from `/api/sellers/:slug`).
- Run `npm run eval` (live-model scenarios) where an API key is available.
- Large-catalogue answers (index/partial modes) are untested with the live model.
- Check on production that seller photos (imimg.com) load; they can't be seen from cloud sessions.
- The seller's own site rate-limits the Render crawler; low priority since the JSON covers the website.
- Memory notes made right after a merge sit on the branch until the next PR; ship them as their own small PR when Nitin asks for a memory update.
- **After #31 deploys** (build id starts `8bed6cf91f5d`, shown in the Deployment card on `/admin`): the admin has the new look; each seller opens at `/admin/sellers/<slug>`. Nitin may send screenshots of anything off (long seller names, many badges, mobile).
- **Spec questions on production** (#27, #29, #30 are all live): chats should ask up to 8 questions per product, the seller's own specs first, and never summarise early; the Knowledge mapping card lists them per category with origin badges. If a bot still summarises early, the Langfuse trace shows the `save_lead` tool result ("not complete yet: still to ask …") and which turn ignored it. A category at 0–1 questions has one product with few specs and an MCAT entry with ≤1 spec: fix the data, not the rule. Odd derived questions (e.g. "Asafoetida Benefits") are fixed with a drop pattern in `SPEC_NOT_ASKED` / `SPEC_NOT_A_QUESTION`. If Nitin can get MCAT files with an ISQ `type` per spec (key/config/regular), re-uploading them makes the order follow the types without a code change.
- **Re-upload after #24:** on /admin, upload each seller's v5 JSON, MCAT file, policy card .md and product cards, and the FAQ sheet (its first sheet only; the 2nd sheet holds other vendors' keys and is ignored). Then read each seller's **Knowledge mapping** block: flags name categories with no questions, MCAT ids missing from the file, unmatched cards. Seen on the real files: NI has 13 categories with no questions and 8 MCAT ids missing from its file; "SS Triply Kadhai and Bowls" appears as an empty category in Herbaveda's and Unicorn's exports (an export quirk).
- **Simulator:** Nitin generates a key per seller on /admin and the Auditor team adds a "Seller assistants" vendor (Base URL, bot slug, X-Bot-Key) per `docs/SIMULATOR_API.md`. Auditor code is not in this repo.
- **Retrieval:** the baseline above is the yardstick; the report JSON with every miss lives in the session scratchpad (`eval/retrieval-baseline.json`), not in git. Nitin's test cases and scenarios sit in the zip next to each seller's export.
- Ideas (not built): per-chat cost readout on the admin transcript page; a `persona.json` for each new seller; an About page from the export's `company_pages`.
