# Glossary

Shorthand and internal language for the Seller assistants project.

## Product terms
| Term | Meaning | Where |
|------|---------|-------|
| seller | One business with its own bot, website `/s/<slug>/` and leads | `SellerContext` in `src/sellers.ts` |
| slug | Seller id in URLs, lowercase letters, digits and dashes (`SLUG_RE`) | `seller.json` |
| seller row / Manage | One line per seller on `/admin` (badges, leads, products, categories, updated, View site); **Manage** expands the KB upload, crawl, persona and Delete controls. Opens itself after `?added=`, `?kb=`, `?crawl=` or `#seller-<slug>` | `sellerRow()` in `src/admin.ts` |
| bot key / simulator API | Per-seller `sa_live_…` key (header `X-Bot-Key`) for chat simulators like the AI Assistant Auditor; `POST /api/v1/bots/<slug>/chat` returns one JSON reply per message. Simulated leads are **test** leads; traces tagged `eval` | `docs/SIMULATOR_API.md`, `src/botKeys.ts` |
| AI Assistant Auditor | Nitin's scenario simulator (IndiaMART) that runs saved buyer scenarios against vendor bots (NIVA, Maxi, now Seller assistants) | Not in this repo |
| directory | Public home `/`: list of sellers, **Visit site** only (plus **Edit prompts** for admins) | `directoryPage` |
| seller site / mini-site | Generated website: Home, About Us, Products, category, product, Contact, search | `src/site/pages.ts` |
| widget | Embeddable chat bubble, bottom-right; `SellerChat.open/close/reset` | `public/widget.js` |
| New chat | Refresh button in the chat header; starts a new session id | widget |
| KB | Knowledge base. Bot sources: BUSINESS CARD, PRODUCT CARDS, SELLER CATALOGUE | `src/kb.ts`, `src/sellerKb.ts` |
| KB folder | `kb/sellers/<slug>/`: `seller.json`, `business_card.json`, `product_cards.json`, `sitemap.xml`, optional `persona.json`, `guardrails.md`, `catalogue.json`, `seller_kb.json` | repo |
| KB JSON / export / master JSON / BotPress export | Seller export `_version` 5.0 (3.0 still loads) with `seller` (`seller_id` = glid), `company_pages`, `photo_gallery`, `categories`, `products` (`taxonomy.glmcat_ids` = the product's MCAT; `faqs`). Uploaded on `/admin`; becomes the main source | `src/sellerKb.ts` |
| uploaded KB | The KB JSON stored at `DATA_DIR/sellers/<slug>/seller_kb.json` | data disk |
| repo seller | Seller defined by a KB folder in git | `source: "repo"` |
| admin seller | Seller added via **+ Add seller**; `seller.json` + `seller_kb.json` live on the data disk; deletable | `source: "admin"` |
| catalogue | Website and retrieval pages: KB JSON entries first, crawled pages fill gaps (`mergeCatalogue`) | `src/sellers.ts` |
| crawl | Fetches the sitemap (or the JSON's page URLs) into `catalogue.json`; on start and every 24 hours | `src/crawler.ts` |
| partial crawl | A crawl that got under 80% of the existing pages; the old catalogue is kept | `MIN_CRAWL_SHARE` |
| RAG / SELLER CATALOGUE | Top catalogue matches put into each turn's user prompt | `src/claude.ts` `retrieve` |
| prompt budget / large catalogue | `PROMPT_BUDGET` (300k chars). KB text up to it goes in the system prompt in full; above it `promptPlan()` uses "index" (all product names) or "partial" (some per category) and details come from the catalogue search | `src/sellerKb.ts` |
| ISQ | Item Specification Question. Per MCAT within a category: the MCAT file's specs the seller's products carry (seller's options first), else derived from the products' spec values | `KbView.isqPlan` |
| chips | Tap-to-reply buttons; the `show_options` tool (2–8 options) | `src/tools.ts`, widget |
| cards / carousel | `share_media` tool: product, image, video and document cards plus related products; built server-side only | `src/shareMedia.ts` |
| lightbox | In-chat viewer for photos and videos (YouTube nocookie, Vimeo, MP4) | widget |
| persona / brand persona | Per seller: **system** part (in the system prompt as `<brand_persona>`) and **user** part (each turn as `<seller_instructions>`). Default from `persona.json`; edit at `/admin/sellers/<slug>/prompts` | `seller_prompts` table |
| common prompts | Shared system prompt template + chat guardrails for all sellers; edit at `/admin/prompts` | `platform_prompts` table |
| operator note | `<operator_note>`: tells the model a sentence of its last reply was replaced by a guardrail | `src/claude.ts` |
| current page | `<current_page>`: the product or category page the buyer has open | `src/prompts.ts` |
| lead | Verified enquiry: mobile (asked on the first message) → OTP → name → `save_lead` (saved) → product if unclear → ISQs → `save_lead` again (updates the same row, summary card) | `leads` table, `ChatDb.updateLead` |
| completion guard | `save_lead` with `complete: true` shows the summary only when the product is known and all its plan's questions were asked (chips shown) or answered (spec label); else the tool result names the next question | `notComplete` in `src/tools.ts`, `pendingQuestions` in `src/isqTracker.ts` |
| prompt version | A snapshot of the common prompts (system + guardrails) or a seller's persona (system + user). Sources: saved, reset, restored, built-in (shipped default recorded at startup when a deploy changed it). View = diff vs in use; Restore. Newer built-in banner on `/admin/prompts` when an edit hides a new default | `prompt_versions` table, `src/promptVersions.ts`, `src/diff.ts` |
| trace / observation / score | Langfuse: a trace per buyer message (`chat-turn`) with observations (catalogue-search retriever, `claude round N` generations, tool calls, output-guardrails) and scores (lead_captured, lead_updated, guardrail_fired, fallback_reply, buyer_feedback). Sessions = whole chats | `src/tracing.ts` |
| canned / fallback reply | `FALLBACK_REPLY` (API error or empty answer) and `REFUSAL_REPLY` (model declined); scored `fallback_reply` in Langfuse | `src/claude.ts` |
| buyer feedback | 👍/👎 under each widget reply when tracing is on → `buyer_feedback` score (+1/−1, a changed vote replaces it); only for replies in the buyer's own chat | `/api/feedback` in `src/app.ts` |
| enquiry summary / summary card | "Your enquiry" card shown once ISQs are done (`save_lead` with `complete: true`, honoured only when the completion guard passes): product, specs, quantity, city, name, masked mobile; scored `summary_shown` | `src/tools.ts` `enquirySummary`, `public/widget.js` `addSummary` |
| chat cost | `chat_cost_usd` Langfuse **session** score: running USD total of a chat's Claude calls, same score id so it's replaced each message; totals kept in `sessions.usage` | `src/app.ts` |
| extra files | Per-seller optional uploads in Manage: business card .md, MCAT specs JSON, product cards JSON (DATA_DIR/sellers/<slug>/files/) | `src/sellerFiles.ts`, `SellerRegistry.compose` |
| MCAT | IndiaMART micro-category. Each product has one (`glmcat_ids`); a site category pools several; the per-seller MCAT specs file is the ISQ source | `KbView.mcatsOf`, `findMcat` |
| built-in auto-apply | On deploy, a changed `prompts/*.md` or `persona.json` replaces an older admin edit of that part (kept in Versions) | `applyNewerBuiltIn`, `applyNewerBuiltInPersonas` |
| main MCAT | The MCAT most of a category's products belong to; asked when only the category is known | `KbView.mainMcatOf` |
| policy card | The business card .md: sections of handling rules (Dispatch, GST, Packaging, Must escalate…) kept whole with amounts/terms stripped | `parseBusinessCardMd` |
| Knowledge mapping | Admin report per seller: categories → MCATs → questions, MCAT file use, cards, FAQs, policy card, flags | `src/mapping.ts` |
| spec_questions | Per-turn block with only the chat's product's ISQs ("Product: <category> · <MCAT>"), asked/next marked | `src/isqTracker.ts` |
| chat id | Unique id per conversation; Langfuse session = `<seller>:<chatId>`; in transcript/leads `chat_id` | `Session.chatId` |
| common FAQ / FAQ sheet | One Excel/CSV for all sellers on /admin/prompts (`Seller Name`, `gl_faq_question`, `gl_faq_answer`, optional Category); rows scoped by Seller (name, slug or glid) and Category; only the **first** sheet is read (the second tab of Nitin's sheet holds other vendors' keys: never paste or commit it); searched per message into `<faq>` | `src/faq.ts` |
| product FAQs | `products[].faqs` in a v5 export; merged into the seller's FAQ index, hits shown as "(about <product>)"; price answers dropped | `KbView.faqs`, `FaqStore.forSeller` |
| derived ISQs | Questions built from the products' own spec values when the MCAT file has no entry or none of its specs is on the seller's products; badge **derived** in Knowledge mapping | `deriveIsqs` in `src/sellerKb.ts` |
| mapping.json | `GET /admin/sellers/<slug>/mapping.json`: the Knowledge mapping as JSON for audits (same data as the admin block) | `src/admin.ts` |
| test lead / test chat | A lead or transcript made through the simulator API (`leads.test = 1`); hidden on Leads unless "Show test chats" is ticked | `src/db.ts`, `src/admin.ts` |
| sensitive fields | v5 export fields the bot never sees: `price`, `delivery_time`, `payment_terms`, `production_capacity`, `packaging_details`, `port_of_dispatch`, `year_established`, `employees`, `member_since`, `gst_verified`, `trustseal_url`, `ratings` (the website still shows prices) | `src/sellerKb.ts` |
| build id | The deployed commit (Render's `RENDER_GIT_COMMIT`, "local" elsewhere) in the admin footer and `/health` `build.commit`, with the process start time; the way to confirm a deploy is live | `src/admin.ts` `shell`, `/health` |
| Simulator key button | On each seller row; opens the row's **Simulator API** block (anchor `#keys-<slug>`) where keys are generated and revoked; rows with keys show an "N simulator keys" badge | `ROWS_SCRIPT`, `keysBlock` |
| Test Langfuse | /admin button: server version → keys → upload a test trace → is it stored; the failing step names the cause | `runConnectionTest` in `src/tracing.ts` |
| langfuse.intermesh.net | The self-hosted Langfuse production traces go to | `LANGFUSE_BASE_URL` on Render |
| tracing status | `off` / `ok` / `auth_failed` / `unreachable` from the startup key check; on `/health` and `/admin` | `src/tracing.ts` `resolveLangfuse` |
| served model | `final.model` of a Claude response: the model that actually answered (shows server-side fallbacks) | `src/claude.ts` |
| inline chips | ISQ buttons drawn in the chat log under the asking message; after the reply they stay greyed with the pick highlighted | `addChips`/`retireChips` in `public/widget.js` |
| demo OTP | `12345` (`DEMO_OTP`); no SMS is sent yet | `src/tools.ts` |

## Guardrails (G1–G9, `prompts/guardrails.md`)
| Id | Rule | Code enforcement (`src/guardrails.ts`) |
|----|------|-------------------|
| G1 | Price: never state, confirm or estimate a price; the team confirms prices | Every ₹, lakh or crore amount is replaced; prices are never shown to the model |
| G2 | Freight: no freight amounts or terms | replaced |
| G3 | Contact: only the business card's contacts; links only to the seller's domains | phone, email and link check |
| G4 | Brand/stock: no stock or authenticity promises | replaced |
| G5 | Payment/ID: never ask for or accept payment or ID details | redacted from the input |
| G6 | Delivery: no dispatch dates or lead times | replaced |
| G7 | Business disclosure: no earnings, tenure, customer or enquiry counts | profile pages not crawled; KB JSON fields and sentences filtered |
| G8 | GST/tax: no rates or inclusive/exclusive claims | replaced |
| G9 | Products outside the product cards: only the catalogue's facts; collect the requirement | prompt |

## Acronyms
| Term | Meaning |
|------|---------|
| ISQ | Item Specification Question (IndiaMART term) |
| MOQ | Minimum order quantity |
| KB | Knowledge base |
| RAG | Retrieval-augmented generation (the per-turn catalogue matches) |
| SSE | Server-sent events; how `/api/chat` streams replies |
| CNC / NC | Computer / numerical control (machine types in Jayshree's range) |

## People
| Name | Who |
|------|-----|
| Nitin | Project owner (`nitinsinghbalyan`) |
| Nalinbhai Harsora | Jayshree Machinetools CEO (business card fact) |
| Kishan Harsora | Jayshree contact person / owner (export); "Mr. Kishan Bhai" on their About page |

## Project names
| Name | Meaning |
|------|---------|
| Seller assistants | The whole platform (this repo, `nitinsinghbalyan/chat-bot`) |
| Jayshree | Jayshree Machinetools Private Limited, slug `jayshree-machinetools` (first seller, repo seller, v3 export) |
| KISHAN | Jayshree's machine brand |
| Exotica / Exotica Steel | Exotica Steel (India): stainless-steel cookware and kitchenware (triply kadhai, army mugs…). v5 files received Oct 18; 304 product FAQs |
| Herbaveda | Herbaveda Overseas: v5 files received Oct 18 (biggest MCAT file, 337 entries) |
| NI / National Industries | National Industries: v5 files received Oct 18; 13 categories without questions and 8 MCAT ids missing from its file |
| Sewa | Sewa Enterprises: v5 files received Oct 18 (small: 5 MCATs) |
| Unicorn | Unicorn Equipment: v5 files received Oct 18 |
| NIVA, Maxi | Other vendors' bots in the AI Assistant Auditor; not ours. Their keys sit in the FAQ sheet's second tab: never use or copy them |
| jayshree-chatbot | The Render service name (`jayshree-chatbot.onrender.com`) |
