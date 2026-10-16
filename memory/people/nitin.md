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

## Notes
- Personal-assistant preferences, such as the #brain vault rules, apply to Nitin's own chats and are not part of this project. Don't copy personal data into this repo.
