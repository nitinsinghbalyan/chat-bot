# Seller assistants (platform)

**Repo:** `nitinsinghbalyan/chat-bot` · **Production:** Render service `jayshree-chatbot` (Singapore, starter plan, 1 GB disk at `/var/data`), auto-deploys `main`.
**Status:** live. Jayshree is the first seller; 5+ more are coming, added by uploading their KB JSON.

## What it does
- Answers buyers' discovery and enquiry questions **on the seller's behalf**, grounded in the seller's KB, within 9 guardrails.
- Enquiry order: machine named → mobile → OTP (demo `12345`) → name (lead saved) → ISQs one at a time as tap-to-reply chips **inline in the chat** (the server picks the machine's category each turn and gives the bot only its questions in `<spec_questions>`; chips arrive with the question, no extra Claude call) → lead updated with the answers → **enquiry summary card** ("Your enquiry": machine, each spec, quantity, city, name, masked mobile) + "Anything to change?" with All correct / Change a detail chips; a correction updates the lead and shows a new card. A buyer who won't share a number isn't blocked.
- Replies are brief: 1–2 short sentences (~40 words), answer first, no filler, options only as chips.
- Shares photos, videos, PDFs and related products as a carousel.
- Handles large catalogues: over ~300k characters the system prompt keeps categories, ISQs and a product index; details come per message from the catalogue search.
- Generates a full website per seller from the KB JSON (with crawled pages as a fallback).
- Admin for the team: seller rows (Manage) with KB upload and **extra files** (business card .md, MCAT specs, product cards), add seller, crawls, personas, common prompts with **version history** (View diff, Restore) and the **common FAQ** Excel, leads and transcripts (each conversation linked to its Langfuse session).
- **Prompt updates apply themselves:** a deploy that changes `prompts/*.md` or a `persona.json` replaces an older admin edit of that part at startup (kept in Versions). Claude makes prompt changes in the repo; Nitin doesn't need to click anything.
- Langfuse tracing (when keys are set): a trace per buyer message; **one Langfuse session per conversation** (`<seller>:<chatId>`, stamped under `session.id` and legacy `langfuse.session.id`); mobiles masked, OTPs never sent; scores plus 👍/👎 asked **once per chat, under the summary card**; **per-chat cost** as a `chat_cost_usd` session score (running total, replaced each message).
- Tracing health is visible: startup key check (EU then US cloud auto-detect), `/health` `tracing.state`, red banner on `/admin` when keys are rejected, `[tracing] export failed` in logs.

## Architecture (where things live)
| Area | Files |
|------|-------|
| HTTP: chat API (SSE), website routes | `src/app.ts` |
| Admin pages (Basic auth, any username + `ADMIN_PASSWORD`, same-origin POSTs); seller rows = `sellerRow()` + `ROWS_SCRIPT` | `src/admin.ts`, `public/admin.css` |
| Seller registry, catalogue merge, admin sellers | `src/sellers.ts` |
| KB JSON: lenient schema, repairs, guardrail filters, ISQs, prompt text, catalogue entries | `src/sellerKb.ts` |
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

**Tools:** `send_otp`, `verify_otp`, `save_lead` (fields incl. `specs[{label,value}]` and `complete`; `complete: true` → summary card), `show_options`, `share_media`.

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
| ISQ source: **MCAT first** (by the products' MCAT id, else equal name), else cleaned derived ISQs pooled per MCAT family; **server picks the category per turn** (`<spec_questions>`) | Nitin (Oct 16) |
| 👍/👎 only once per chat, under the summary card | Nitin |
| Claude changes prompts itself in the repo; built-ins apply over older admin edits on deploy (no "Use the new built-in" click) | Nitin (Oct 16) |
| Every trace has a unique per-conversation session id `<seller>:<chatId>` (audit); stamped under new and legacy attribute names | Nitin |
| Common FAQ Excel (Question, Answer, optional Category), searched per message as `<faq>`, scoped per seller by category; guardrails win | Nitin |
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
| Admin = seller rows UI (was cards): one compact row per seller, **Manage** expands its controls in place; public directory keeps cards | Nitin |
| Add seller by uploading JSON | Nitin |
| Lenient import: repair or skip bad records, warn; refuse only unusable files | After a production failure on a blank `category_id` |
| Never commit raw seller exports | They contain GST, bank and turnover data |
| Large KBs accepted: over ~300k characters, the system prompt keeps categories + ISQs + product index, details come per message via catalogue search | A 3.3M-character export was refused by the old 400k limit |

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

## Open items / ideas
- **Langfuse (self-hosted `langfuse.intermesh.net`):** after #16/#18, check that traces appear grouped by conversation. If not, **Test Langfuse** on /admin names the failing step (server version, upload refused, or accepted but not stored, which is for the intermesh Langfuse admins).
- **MCAT file:** Jayshree's uploaded MCAT file is mostly construction MCATs (only the ironworkers match by id). A file with their real MCAT ids (e.g. 25058 press brakes, 1669, 123956, 185336 shears, 182186 laser) would make those questions authoritative; until then they're cleaned derived ISQs.
- Check the live bot asks the right questions per machine (press brake vs shear vs laser), and that categories with no ISQs (single-product ones like H Frame Hydraulic Press) behave well.
- Real SMS OTP (replace the demo check in `src/tools.ts`; stop sending `demo: true` from `/api/sellers/:slug`).
- Run `npm run eval` (live-model scenarios) where an API key is available.
- Large-catalogue answers (index/partial modes) are untested with the live model.
- Check on production that seller photos (imimg.com) load; they can't be seen from cloud sessions.
- The seller's own site rate-limits the Render crawler; low priority since the JSON covers the website.
- Ideas (not built): per-chat cost readout on the admin transcript page; a `persona.json` for each new seller; an About page from the export's `company_pages`.
