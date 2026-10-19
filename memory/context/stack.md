# Stack, deploy and environment

## Tools & systems
| Tool | Used for |
|------|----------|
| Node 22, TypeScript (NodeNext ESM), Express 5 | Server |
| `@anthropic-ai/sdk` 0.132 | Claude (beta messages stream, strict tools) |
| better-sqlite3 | `DATA_DIR/chatbot.db` |
| cheerio | Crawler HTML parsing |
| minisearch | Catalogue search (BM25-ish) |
| zod v4 | Config, seller.json and KB JSON validation (use `z.looseObject`; `ZodSafeParseResult`) |
| read-excel-file | The common FAQ sheet (first sheet only) |
| vitest, tsx | Tests, scripts and dev |
| Render | Hosting: Blueprint `render.yaml`, auto-deploy `main`, disk `/var/data` |
| GitHub MCP tools | PRs and merges (no `gh` CLI in cloud sessions) |
| Langfuse JS v6 (`@langfuse/tracing`, `@langfuse/otel`, `@langfuse/client`) + OpenTelemetry `NodeTracerProvider` | Tracing, scores |

## Model and capacity
- `BOT_MODEL` is `claude-sonnet-5-5` (set in `render.yaml`; can be overridden in Render's Environment), effort `low`, server-side fallbacks on.
- Sonnet 5.5: 1M-token context, $2 / $10 per M tokens, cache reads $0.20, cache writes $2.50 (5-minute TTL). Prices for traces live in `src/tracing.ts` (`PRICES`).
- Jayshree system prompt ~43k tokens; large-catalogue cap ~75–85k; worst case ~200k tokens per request. Cost and capacity questions: check current numbers with the claude-api skill, don't answer from memory.

## Commands
| Command | What |
|---------|------|
| `npm test` | All unit and HTTP tests (fixture sellers `alpha-presses`, `beta-pumps`; fixture KB `tests/fixtures/kb/alpha-kb.json`) |
| `npm run build` / `npx tsc --noEmit -p .` | Type-check and build |
| `npm run kb:check` | Validate repo KB folders and print each seller's Knowledge mapping (main MCAT, others, questions, flags) |
| `npm run crawl -- <slug> [--runtime]` | Crawl a seller |
| `npm run eval` | Live-model scenarios (needs an API key; costs money) |
| `npm run dev` | Local server, port 3000 |

## Environment variables
`ANTHROPIC_API_KEY`, `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_BASE_URL`, `LANGFUSE_ENVIRONMENT`, `ADMIN_PASSWORD` (8+ characters; enables `/admin`), `BOT_MODEL`, `BOT_EFFORT`, `BOT_FALLBACKS`, `DATA_DIR`, `SELLERS_DIR`, `ALLOWED_ORIGINS`, `CRAWL_ON_START`, `CRAWL_INTERVAL_HOURS`, `DEMO_OTP`, `PORT`.
Don't call them `CLAUDE_*`: the harness sets `CLAUDE_EFFORT`, which once clashed.

## Data on the Render disk (`/var/data`)
- `chatbot.db`: sessions, transcript, leads, guardrail_events, seller_prompts (personas), platform_prompts (common prompts), prompt_versions (history of both).
- `chatbot.db` also holds `bot_keys` (simulator keys, sha256) and `leads.test`.
- `sellers/<slug>/catalogue.json`: runtime crawl.
- `sellers/<slug>/files/`: the extra files (policy card .md, MCAT specs, product cards). The FAQ sheet lives beside the common prompts.
- `sellers/<slug>/seller_kb.json`: uploaded KB JSON.
- Admin-added sellers: `sellers/<slug>/seller.json` + `seller_kb.json`.

## Cloud session gotchas
- The proxy blocks the seller sites, imimg.com and onrender.com, so production can't be checked. Tell Nitin what to check instead: the build id in the admin footer or `/health` `build.commit` says which commit is live (compare with the merge commit on `main`); Render's dashboard shows a failed deploy.
- No API key: test chat with a scripted fake client. A preview server script pattern is `createApp({ client: fakeClient, ... })` on a spare port.
- Unset `ANTHROPIC_BASE_URL` when running the server or eval (`env -u ANTHROPIC_BASE_URL`).
- Never `pkill -f` a pattern that appears in your own command line; it kills the shell.
- Playwright is global: import `$(npm root -g)/playwright/index.mjs`, launch with `executablePath: "/opt/pw-browsers/chromium"`.
- Branch workflow: after a PR merges, `git fetch origin main && git checkout -B claude/practical-clarke-0tbalp origin/main`, then push with `--force-with-lease`. Always fetch first: local `origin/main` goes stale after a merge done through the GitHub tools.
- Testing big imports: copy a real export in the scratchpad and multiply its products (new ids and URLs); never commit it. Post it to the local server's `POST /admin/sellers` with `{config: {slug, name, siteUrl, color}, kb}`.
- The scratchpad is per session: the e2e helpers (`e2e/server.ts`, `e2e/flow.ts`, `e2e/fake-langfuse.mjs`, Playwright scripts) have to be recreated in a new session.
- `npm view <package> readme` works through the proxy; use it (and the installed `.d.ts` files) to check a library's current API before coding.
- Fake models must handle the merged turn: after `show_options` the turn ends, so the next user message holds the `tool_result` blocks **and** the buyer's text. Treat a user message as a tool round only when it has no text block.
- ISQ checks on real exports: a tsx `.mts` script (top-level await needs `.mts`) that loads each seller with `SellerRegistry.addSeller` + `setSellerFile` for the three files and prints `s.mapping` (or `npm run kb:check` with the data on the disk). Nitin's zip of 5 sellers' v5 files lived in `/tmp/claude-0/v4/` for #24; it holds GST/bank data, never commit it. Files Nitin attaches in chat land under `/root/.claude/uploads/<session>/`; unzip them into an empty scratch directory and keep scripts elsewhere.
- Simulator API checks: `POST /admin/sellers/<slug>/keys` (same-origin form post, Basic auth) shows the key once; then `curl -H "X-Bot-Key: sa_live_…" -H "Content-Type: application/json" -d '{"sessionId":"auditor-run-001","message":"hi"}' /api/v1/bots/<slug>/chat`. The reply holds `sessionId`, `reply`, `chips`, `cards`, `summary`, `askFor`, `leadStage`, `traceId`, `test`. Field names and errors: `docs/SIMULATOR_API.md`.
- Measuring question coverage ("bot asks only one spec"): a `.mts` script that loads each seller's v5 JSON + MCAT file into `KbView` and prints a histogram of `isqPlan(c).isqs.length` per category with each question's `from`. Used for #29: means went from 1.3–3.0 to 3.1–4.0 per seller. Prototype a candidate rule in the script before changing `isqPlan`.
- Reproducing "the bot assumed product X": a tsx `.mts` script that builds `KbView` (KB JSON + MCAT file), `new Catalogue(view.catalogueEntries())` and calls `updateCategory` with the buyer's text and `cat.search(text)`; print the top hits and the category set. That is how "Hi" → Hing was found (prefix search) for #27. The search skips prefix matching under 4 letters and fuzzy under 5.
- Chat flow checks: `e2e/flow.ts` in the scratchpad is a stateful fake model that walks machine → mobile → OTP → name → ISQ chips (recreate it if the scratchpad is gone).
- cloud.langfuse.com is blocked by the agent proxy too, so real trace delivery can only be checked on production.
- Trace session checks: record the stand-in Langfuse's OTLP bodies and count `"key":"session.id"` and `"key":"langfuse.session.id"` per span; both should hold one `<seller>:<uuid>` per conversation.
- Tracing checks: run `e2e/fake-langfuse.mjs` (records OTLP and score requests) on port 3470 and start the app with `LANGFUSE_BASE_URL=http://127.0.0.1:3470`, test keys, `LANGFUSE_FLUSH_AT=1` and `NO_PROXY=127.0.0.1`.
- Admin browser checks: add 3+ sellers through the API so the seller filter box shows (it appears above 3).
- Architecture and flows are in `docs/ARCHITECTURE.md`; the file tree is in `docs/REPO_STRUCTURE.md`. Update them when adding files or changing the journey.
