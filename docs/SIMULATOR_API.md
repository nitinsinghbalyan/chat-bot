# Simulator setup (AI Assistant Auditor)

Chat simulators run scripted buyer conversations against a seller's bot through the **Bot API**. The full reference (calls, fields, errors, leads, Langfuse) is in [BOT_API.md](BOT_API.md); this page keeps only what a simulator needs.

## Connect a bot in the Auditor

| Field | Value |
|---|---|
| Base URL | The platform's address, e.g. `https://<your-app>.onrender.com` |
| Bot slug | The seller's slug, shown on the seller's page in `/admin` |
| Key | On the seller's page, **Bot API** card (`/admin/sellers/<slug>#keys`, or **API key** on the seller's row): add a label, choose **Test**, press **Generate key**. The key is shown once. |
| Header | `X-Bot-Key: sa_live_…` |

For the Auditor, add **Seller assistants** as a vendor with Base URL, bot slug, X-Bot-Key and seller name (optional), mirroring the NIVA bots form. One key per simulator is a good habit: each can be revoked on its own.

**Use a Test key.** Its chats run the real journey, but their leads are saved as **test** leads (hidden on `/admin/leads` unless "Show test chats" is ticked, left out of lead counts) and their traces are tagged `eval` and `simulator`, so simulations never mix with real buyers. A Live key would create real leads.

## The two calls a simulator makes

1. `GET /api/v1/bots/<slug>`: show `greeting` as the bot's first message; `demoOtp` is the code to send when the bot asks for the OTP (no SMS gateway yet).
2. `POST /api/v1/bots/<slug>/chat` with `{ sessionId, message, meta? }` for every buyer turn. `meta: { runId, scenarioId, label }` is stored on the Langfuse trace, so a run can be found there. To tap a reply button, send the chip's text. Keep one `sessionId` per scripted conversation and send one turn at a time; different conversations can run in parallel.

A simulator that wants to start a scenario with the buyer already identified (name, mobile, buyer id) can call `POST /api/v1/bots/<slug>/conversations` first; see BOT_API.md.

## A typical scripted conversation

| Buyer sends | Bot (`reply`, then `askFor` / `leadStage`) |
|---|---|
| *(shows `greeting`)* | |
| `do you make press brakes?` | "Please share your 10-digit mobile number." · `mobile` / `none` |
| `9876543210` | "OTP sent…" · `otp` / `otp_sent` |
| `12345` | "Verified. May I have your name?" · `name` / `verified` |
| `Ramesh` | Lead saved; the first spec question, with `chips` · `null` / `captured` |
| a chip, e.g. `CNC` | The next spec question… |
| the last answer | `summary` card; the lead is updated |

Errors and rate limits: see BOT_API.md (409 means the previous turn of that conversation is still being answered; 429 means more than 15 messages a minute in one conversation or 120 a minute on one key).
