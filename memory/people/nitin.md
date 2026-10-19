# Nitin

**Also known as:** `nitinsinghbalyan` (GitHub)
**Role:** Project owner of Seller assistants; decides scope and checks production.

## Working style
- Gives short, outcome-focused asks ("make ui proper", "push changes to production"). Production means merging to `main` (Render auto-deploys).
- Often switches on plan mode for bigger changes and answers 1–3 multiple-choice questions. Recommended options are usually accepted.
- Tests on production and sends screenshots of what looks wrong. Fix the issue in the screenshot and anything clearly related (e.g. the partial crawl seen in an admin screenshot).
- Wants plain-language summaries: what changed, what to do next, what couldn't be verified.

## Preferences seen so far
- Prefers a UI for operations over editing files: KB upload, add seller, persona and common prompts all happen in admin.
- Is scaling to 5+ sellers, so wants shared defaults with per-seller overrides.
- Wants the bot strict on guardrails: no prices, grounded answers only.
- Wants compact, scannable lists as the seller count grows: the admin seller cards became one-line rows with a Manage toggle.
- Wants leads captured early (mobile right after the machine is named) and bot replies short and to the point.
- Wants observability: Langfuse traces, cost per call, buyer feedback.
- Asks for a project memory update after each milestone.
- Wants Claude to make prompt changes itself and have them go live on deploy, without manual steps in admin.
- Audits chats in Langfuse: every trace must sit in a unique per-conversation session.
- Wants the first reply to be only the mobile number ask; no confirming the machine first.
- Wants the chat to feel fast: chips with the message, no extra round trips; feedback asked once, not on every reply.
- Wants spec questions that fit the buyer's machine (category), not a mix across categories.
- Asks capacity and model questions ("which model", "is the context window enough"): answer with the configured values and sourced numbers, and say what is an estimate.
- Wants the bot to ask the specs of the buyer's **actual product** (its MCAT), only those the seller's products carry, and a **foolproof mapping** between the export, MCAT file, product cards, FAQs and policy card: hence the Knowledge mapping report he can read per seller.
- Shares seller files as a zip attached in chat when asked (Oct 18: five sellers' v5 files). They hold GST and bank data: keep them local, never commit.
- Runs chat-turn simulations in IndiaMART's AI Assistant Auditor against his bots; wants our bots reachable there as their own vendor with per-seller keys.
- Says "update project memory folder" after a milestone: refresh `memory/` + CLAUDE.md, ship it as its own small PR.

## Notes
- Personal-assistant preferences, such as the #brain vault rules, apply to Nitin's own chats and are not part of this project. Don't copy personal data into this repo.
