# Memory

Project memory for **Seller assistants**: an AI chat assistant and generated website for each B2B seller. Detail lives in `memory/`.

## Me
**Nitin** (GitHub `nitinsinghbalyan`) owns this repo: adds sellers, uploads their knowledge base JSON and checks production on Render.

## People
| Who | Role |
|-----|------|
| **Nitin** | Project owner; makes product calls (see memory/people/nitin.md) |
| **Nalinbhai Harsora** | CEO of Jayshree Machinetools (business card fact) |
| **Kishan Harsora** | Contact person / owner listed in Jayshree's export |
→ Full list: memory/glossary.md

## Terms
| Term | Meaning |
|------|---------|
| **seller** | One business with its own bot + site at `/s/<slug>/` |
| **KB** | A seller's knowledge base. **Uploaded JSON** (preferred) or the KB folder files |
| **KB JSON / export** | Seller export v3.0: `seller`, `company_pages`, `photo_gallery`, `categories`, `products` |
| **ISQ** | Item Specification Question: asked one per message, options shown as chips |
| **chips** | Tap-to-reply buttons in the chat (`show_options` tool) |
| **cards / carousel** | Product, photo, video and PDF cards in the chat (`share_media` tool) |
| **persona** | A seller's brand persona: system part + user (per-turn) part |
| **common prompts** | The shared system prompt + chat guardrails for all sellers (`/admin/prompts`) |
| **G1–G9** | The 9 guardrails (G1 price … G9 other products), in `prompts/guardrails.md` |
| **repo seller / admin seller** | Seller from `kb/sellers/<slug>/` vs one added via **+ Add seller** (stored on the data disk) |
| **large catalogue** | KB over ~300k chars: prompt keeps categories, ISQs and a product index; details come per message from catalogue search |
| **prompt versions** | Every save/reset/restore of common prompts and personas, plus each shipped default, kept with View (diff) and Restore |
| **traces** | Langfuse: one per buyer message, chats as Sessions; mobiles masked, OTPs never sent; off without `LANGFUSE_*` keys |
| **seller row / Manage** | `/admin` lists sellers as one-line rows; **Manage** expands the controls |
| **demo OTP** | `12345`; no SMS gateway yet |
→ Full glossary: memory/glossary.md

## Projects
| Name | What |
|------|------|
| **Seller assistants** | This platform: bot, websites, admin. memory/projects/seller-assistants.md |
| **Jayshree** | First seller, `jayshree-machinetools`. memory/projects/jayshree-machinetools.md |
| **More sellers** | 5+ coming, added by uploading their JSON on `/admin` |

## Hard rules (product decisions)
- **The bot never states, confirms or estimates a price**; it says the seller's team confirms prices. The **website still shows** listed starting prices.
- The bot is grounded only in the seller's KB (business card, product cards, crawled catalogue). Guardrails win over the persona and seller notes.
- **Never feed the bot** the export's prices, delivery or payment terms, turnover, staff, year of establishment, GST, bank or rating data. Never commit a seller's raw export to git: it holds GST, bank and turnover details. Upload it on `/admin`.
- Enquiry order: machine → mobile → OTP → name (lead saved) → ISQ chips → lead updated. OTP and save rules enforced on the server. Replies short (1–2 sentences).
- Chat widget sits **bottom-right**. The public directory `/` is **visit-only** (no chat there).

## How we work
- Develop on branch `claude/practical-clarke-0tbalp`, restarted from `origin/main` after each merge. Open a PR and **merge it to `main`**; Render then auto-deploys production.
- Before a push: `npm test`, `npm run build`, `npm run kb:check`, plus a Chromium check for UI changes.
- Bigger asks often come in plan mode: ask a few sharp questions, then build.
- Reply in plain language with short summaries. Nitin checks production directly and sends screenshots of problems.

## Environment gotchas (cloud sessions)
- The agent proxy **blocks** jayshreemachinetools.in, imimg.com images and the Render URL, so production and live crawls can't be checked from here.
- There is no `ANTHROPIC_API_KEY` here. Run the local server with `env -u ANTHROPIC_BASE_URL` and test chat with a scripted fake client.
- Never `pkill -f src/server.ts`: it kills the shell. Find PIDs with `ps -eo pid,args | grep -E "node.*src/server\.ts"`.
- Playwright: `$(npm root -g)/playwright/index.mjs` with `executablePath: "/opt/pw-browsers/chromium"`.
→ More: memory/context/stack.md
