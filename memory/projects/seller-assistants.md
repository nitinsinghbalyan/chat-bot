# Seller assistants (platform)

**Repo:** `nitinsinghbalyan/chat-bot` · **Production:** Render service `jayshree-chatbot` (Singapore, starter plan, 1 GB disk at `/var/data`), auto-deploys `main`.
**Status:** live. Jayshree is the first seller; 5+ more are coming, added by uploading their KB JSON.

## What it does
- Answers buyers' discovery and enquiry questions **on the seller's behalf**, grounded in the seller's KB, within 9 guardrails.
- Captures verified leads: mobile, OTP (demo `12345`), name.
- Asks ISQs one at a time as tap-to-reply chips. Shares photos, videos, PDFs and related products as a carousel.
- Generates a full website per seller from the KB JSON (with crawled pages as a fallback).
- Admin for the team: sellers, KB upload and add seller, crawls, personas, common prompts, leads and transcripts.

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
| SQLite: sessions, transcript, leads, guardrail_events, seller_prompts, platform_prompts, prompt_versions | `src/db.ts` |
| Website templates | `src/site/pages.ts`, `src/site/html.ts`, `public/site.css` |
| Widget | `public/widget.js` |

**Claude call:**
- `client.beta.messages.stream`, model `BOT_MODEL` (default `claude-sonnet-5-5`), effort `BOT_EFFORT=low`
- server-side fallback `server-side-fallback-2026-07-01` with `fallbacks: "default"`
- strict tools with `eager_input_streaming`; `tool_choice` auto (forced tool use is a 400 on 5.5 models)
- the system prompt is cached; with Jayshree's JSON it is about 43k tokens

**Tools:** `send_otp`, `verify_otp`, `save_lead`, `show_options`, `share_media`.

## Decisions (and why)
| Decision | Reason / who decided |
|----------|---------------------|
| Claude via Anthropic SDK, Node/TypeScript | Nitin's choice at the start |
| Handoff = mobile, then OTP `12345`, then name | Nitin |
| Lead first: ask mobile as soon as the machine is named, then OTP, name (lead saved), then ISQ chips; lead updated after the last ISQ. Buyer who declines isn't blocked | Nitin (Oct 2026) |
| Replies brief: 1–2 sentences, ~40 words, no filler, options only as chips | Nitin |
| Chips inline in the chat log (not a bar above the input) | Nitin |
| Prompt version history for common prompts and personas, with diff, restore and built-in banner | Nitin |
| Catalogue from crawling the sitemap; MCAT specs file not used | Nitin |
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

## Open items / ideas
- Real SMS OTP (replace the demo check in `src/tools.ts`; stop sending `demo: true` from `/api/sellers/:slug`).
- Run `npm run eval` (live-model scenarios) where an API key is available. The price scenario now expects no price.
- After deploying #12: if production has a saved edit of the common prompt, click **Use the new built-in** on `/admin/prompts` or the new flow/style won't apply. Check tone and order with the live model.
- Large-catalogue answers (index/partial modes, details via per-message search) are untested with the live model; check on production with questions that name specific models.
- Check on production that seller photos (imimg.com) load; they can't be seen from cloud sessions.
- The seller's own site rate-limits the Render crawler. The JSON covers the website, so this is low priority.
- Possible: write a `persona.json` for each new seller; an About page built from the export's `company_pages`.
