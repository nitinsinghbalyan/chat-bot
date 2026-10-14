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
| vitest, tsx | Tests, scripts and dev |
| Render | Hosting: Blueprint `render.yaml`, auto-deploy `main`, disk `/var/data` |
| GitHub MCP tools | PRs and merges (no `gh` CLI in cloud sessions) |

## Commands
| Command | What |
|---------|------|
| `npm test` | All unit and HTTP tests (fixture sellers `alpha-presses`, `beta-pumps`; fixture KB `tests/fixtures/kb/alpha-kb.json`) |
| `npm run build` / `npx tsc --noEmit -p .` | Type-check and build |
| `npm run kb:check` | Validate repo KB folders |
| `npm run crawl -- <slug> [--runtime]` | Crawl a seller |
| `npm run eval` | Live-model scenarios (needs an API key; costs money) |
| `npm run dev` | Local server, port 3000 |

## Environment variables
`ANTHROPIC_API_KEY`, `ADMIN_PASSWORD` (8+ characters; enables `/admin`), `BOT_MODEL`, `BOT_EFFORT`, `BOT_FALLBACKS`, `DATA_DIR`, `SELLERS_DIR`, `ALLOWED_ORIGINS`, `CRAWL_ON_START`, `CRAWL_INTERVAL_HOURS`, `DEMO_OTP`, `PORT`.
Don't call them `CLAUDE_*`: the harness sets `CLAUDE_EFFORT`, which once clashed.

## Data on the Render disk (`/var/data`)
- `chatbot.db`: sessions, transcript, leads, guardrail_events, seller_prompts (personas), platform_prompts (common prompts), prompt_versions (history of both).
- `sellers/<slug>/catalogue.json`: runtime crawl.
- `sellers/<slug>/seller_kb.json`: uploaded KB JSON.
- Admin-added sellers: `sellers/<slug>/seller.json` + `seller_kb.json`.

## Cloud session gotchas
- The proxy blocks the seller sites, imimg.com and onrender.com, so production can't be checked. Tell Nitin what to check instead.
- No API key: test chat with a scripted fake client. A preview server script pattern is `createApp({ client: fakeClient, ... })` on a spare port.
- Unset `ANTHROPIC_BASE_URL` when running the server or eval (`env -u ANTHROPIC_BASE_URL`).
- Never `pkill -f` a pattern that appears in your own command line; it kills the shell.
- Playwright is global: import `$(npm root -g)/playwright/index.mjs`, launch with `executablePath: "/opt/pw-browsers/chromium"`.
- Branch workflow: after a PR merges, `git fetch origin main && git checkout -B claude/practical-clarke-0tbalp origin/main`, then push with `--force-with-lease`. Always fetch first: local `origin/main` goes stale after a merge done through the GitHub tools.
- Testing big imports: copy a real export in the scratchpad and multiply its products (new ids and URLs); never commit it. Post it to the local server's `POST /admin/sellers` with `{config: {slug, name, siteUrl, color}, kb}`.
- Chat flow checks: `e2e/flow.ts` in the scratchpad is a stateful fake model that walks machine → mobile → OTP → name → ISQ chips (recreate it if the scratchpad is gone).
- Admin browser checks: add 3+ sellers through the API so the seller filter box shows (it appears above 3).
