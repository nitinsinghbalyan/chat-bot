# Repository structure

Each file and folder with its job. Line counts are approximate (October 2026). How the parts fit together is in [ARCHITECTURE.md](ARCHITECTURE.md).

```
chat-bot/
├── CLAUDE.md                  Hot-cache memory for Claude sessions: people, terms, hard rules, how we work
├── README.md                  Setup, run, deploy, admin guide and seller onboarding
├── package.json               Scripts (dev, start, build, test, kb:check, crawl, eval) and dependencies
├── package-lock.json          Locked dependency versions
├── tsconfig.json              TypeScript settings (Node 22 ESM, strict)
├── vitest.config.ts           Test runner settings
├── render.yaml                Render blueprint: web service, persistent disk at DATA_DIR, env vars
├── .env.example               Every environment variable, with a comment (copy to .env locally)
├── .node-version              Node 22
├── .gitignore                 node_modules, dist, data, .env, logs
│
├── docs/
│   ├── ARCHITECTURE.md        System design: context, buyer journey, chat turn, knowledge, prompts, guardrails, data, routes
│   ├── SIMULATOR_API.md       For chat simulators (AI Assistant Auditor): keys, JSON chat endpoint, errors, test leads
│   └── REPO_STRUCTURE.md      This file
│
├── memory/                    Long-term project memory (CLAUDE.md is the short version)
│   ├── glossary.md            Every term, person and shorthand
│   ├── context/stack.md       Stack, environment gotchas, how to test locally
│   ├── people/nitin.md        Project owner: how he works and decides
│   └── projects/
│       ├── seller-assistants.md     The platform: what it does, decisions, history of PRs, open items
│       └── jayshree-machinetools.md The first seller: facts, KB notes, contacts
│
├── prompts/                   Shipped defaults for the common prompts (admin edits override; newer defaults auto-apply on deploy)
│   ├── system.md              Common system prompt template: role, journey (mobile → OTP → name → ISQs → summary), tools, trusted tags
│   ├── guardrails.md          The 9 guardrails G1–G9 (price, grounding, phones, OTP, …)
│   └── user.md                Per-turn wrapper text added to each buyer message
│
├── kb/sellers/<slug>/         Repo sellers (admin sellers live on the data disk instead)
│   └── jayshree-machinetools/
│       ├── seller.json        Name, slug, allowed origins, sitemap URL, theme
│       ├── persona.json       Brand persona: system part + per-turn user part
│       ├── business_card.json Company facts the bot may use (evidence fields stripped before the prompt)
│       ├── product_cards.json Product cards with their qualification questions
│       └── sitemap.xml        Pages to crawl into the catalogue
│
├── public/                    Static files served as-is
│   ├── widget.js        ~650  Chat widget (bottom-right): SSE stream, chips, cards, OTP, summary card, one feedback vote
│   ├── site.css         ~220  Styles for the generated seller websites and directory
│   ├── admin.css        ~250  Styles for /admin
│   └── demo.html              Local page to try the widget
│
├── scripts/
│   ├── crawl.ts               CLI: crawl sellers' sitemaps into their catalogues
│   ├── kb-check.ts            CLI (`npm run kb:check`): validate every kb/sellers folder without starting the server
│   └── eval.ts          ~240  Live-model scenario checks per guardrail and journey step (needs ANTHROPIC_API_KEY)
│
├── src/
│   ├── server.ts         ~80  Entry point: config, DB, registry, tracing, crawl schedule, graceful shutdown (flushes traces)
│   ├── config.ts         ~70  Reads environment variables (DATA_DIR, ADMIN_PASSWORD, model, LANGFUSE_*, …)
│   ├── app.ts           ~560  Express app: chat turn (shared), widget API (SSE), simulator API (/api/v1, JSON), feedback, sites, /health
│   ├── botKeys.ts        ~20  Simulator API keys: generate, hash, shape check
│   ├── claude.ts        ~370  The chat turn loop: builds per-turn blocks, streams Claude, runs tools, ends on show_options
│   ├── tools.ts         ~345  Tool definitions and handlers: save_lead, show_options, share_media; lead status text; summary card
│   ├── guardrails.ts    ~260  Code guardrails that back the prompt: price scrub, phone allow-list, OTP/save rules, logging
│   ├── session.ts       ~160  In-memory chat state: chat id, lead stage, category, asked ISQs, usage and cost
│   ├── db.ts            ~480  SQLite (better-sqlite3): sessions, transcript, leads (+ test flag), guardrail events, prompts, versions, bot keys; migrations
│   ├── isqTracker.ts    ~100  Server-side category per turn and asked/answered ISQs; builds <spec_questions>
│   ├── faq.ts           ~240  Common FAQ: parse Excel/CSV, search per message (stopwords, stemming), build <faq>
│   │
│   ├── sellers.ts       ~575  Seller registry: loads repo + admin sellers, merges KB JSON + extra files, builds cached system prompts
│   ├── kb.ts            ~130  KB folder loader: business card, product cards, allowed phones
│   ├── sellerKb.ts      ~910  KB JSON (export v3.0): sanitised view, MCAT families, ISQ plans, large-catalogue index, prompt text
│   ├── sellerFiles.ts   ~270  Extra files: business card .md, MCAT specs JSON, product cards JSON; name matching; ISQ gap filling
│   ├── prompts.ts       ~100  Loads common prompt defaults and checks required placeholders
│   ├── promptVersions.ts~115  Version history for common prompts and personas; auto-applies newer shipped defaults
│   ├── diff.ts           ~25  Line diff for the Versions "View" screen
│   │
│   ├── crawler.ts       ~480  Crawls a seller's sitemap pages into catalogue entries (the RAG source and website data)
│   ├── catalogue.ts     ~160  Catalogue store and search (minisearch); loads crawled or bundled files
│   ├── media.ts          ~65  Media card types (product, photo, video, PDF), built only from seller data
│   ├── shareMedia.ts    ~175  Resolves share_media ids to cards from the KB JSON and catalogue
│   │
│   ├── tracing.ts       ~580  Langfuse (OTLP): one trace per buyer message, session <seller>:<chatId>, cost score, test button
│   ├── admin.ts        ~1160  /admin pages: seller rows + Manage, uploads, crawls, personas, simulator keys, common prompts, FAQ, leads, versions
│   └── site/
│       ├── html.ts       ~60  Escaping helpers and safe URL checks
│       └── pages.ts     ~635  Server-rendered directory (/) and seller websites (/s/<slug>/…)
│
└── tests/                     Vitest (`npm test`); no network, scripted fake Claude client
    ├── app.test.ts            API, OTP, lead save rules, intro, sites, health
    ├── claude.test.ts         Turn loop, tool rounds, per-turn blocks
    ├── tools.test.ts          Tool handlers, lead status text, summary card
    ├── guardrails.test.ts     Price scrub, phone allow-list, logging
    ├── isq.test.ts            ISQ derivation, MCAT families, category switching
    ├── sellerKb.test.ts       KB JSON view, sanitising, large-catalogue mode
    ├── sellerFiles.test.ts    Extra-file parsers and name matching
    ├── extraFiles.test.ts     Extra files in the registry and admin, common FAQ end to end
    ├── faq.test.ts            FAQ parsing and search
    ├── sellers.test.ts        Registry loading and prompt building
    ├── prompts.test.ts        Common prompt defaults and placeholders
    ├── promptVersions.test.ts Versions, restore, auto-apply of newer defaults
    ├── db.test.ts             Schema, migrations, queries
    ├── feedback.test.ts       Feedback vote and Langfuse scores
    ├── simulatorApi.test.ts   Simulator API: key checks, JSON journey, test leads, admin keys
    ├── tracing.test.ts        Spans, session ids, masking, export errors
    ├── crawler.test.ts        Sitemap parsing and page extraction
    ├── catalogue.test.ts      Catalogue search
    └── fixtures/              Two fake sellers (alpha-presses, beta-pumps), a small KB JSON, a FAQ .xlsx, HTML pages
```

## Not in git

| Path | What |
|------|------|
| `data/` (`DATA_DIR`) | SQLite DB, crawled catalogues, admin sellers, uploaded KB JSON and extra files, common FAQ. A persistent disk on Render. |
| `.env` | Local secrets (API keys, admin password, Langfuse keys) |
| Seller raw exports | Hold GST, bank and turnover data: upload on `/admin`, never commit |
