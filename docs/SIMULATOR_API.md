# Simulator API

Chat simulators, such as the AI Assistant Auditor, use this API to run scripted buyer conversations against a seller's bot. Each request carries one buyer message, and the response is the bot's whole reply as JSON. A simulated chat goes through the same bot as a real one: the same prompts, knowledge, guardrails, OTP rules and lead saving.

## Connect a bot

| Field | Value |
|---|---|
| Base URL | The platform's address, e.g. `https://<your-app>.onrender.com` |
| Bot slug | The seller's slug, e.g. `jayshree-machinetools`. It is shown on each seller row in `/admin`. |
| Key | Generate it in `/admin` → the seller's row → **Manage** → **Simulator API** → **Generate key**. The key is shown once; only its hash is stored. |
| Header | `X-Bot-Key: sa_live_…` |

Each key works for one bot only. You can give a seller several keys (one per simulator, say) and revoke them one at a time. A revoked key stops working immediately.

For the Auditor, add **Seller assistants** as a vendor with four fields: Base URL, bot slug, X-Bot-Key and seller name (optional). This mirrors the NIVA bots form.

## Endpoints

### `GET /api/v1/bots/:slug`

Returns the bot's details. Show `greeting` as the bot's first message. In the widget, the buyer sees this welcome before they type anything.

```bash
curl -H "X-Bot-Key: $KEY" https://<base>/api/v1/bots/jayshree-machinetools
```
```json
{
  "slug": "jayshree-machinetools",
  "name": "Jayshree Machinetools Private Limited",
  "greeting": "Welcome to Jayshree Machinetools Private Limited. I can tell you about our machines, share photos and brochures, and pass your enquiry to our team.",
  "demoOtp": "12345"
}
```

No SMS gateway is connected yet, so the OTP is always `demoOtp`. A simulated buyer should send it when the bot asks for the code.

### `POST /api/v1/bots/:slug/chat`

Sends one buyer message. The request body:

| Field | Required | Meaning |
|---|---|---|
| `message` | yes | What the buyer types (up to 1,000 characters). To tap a reply button, send that chip's text. |
| `sessionId` | no | Your id for the conversation: 8–64 letters, digits, `-` or `_`. Send the same id on every turn. If you leave it out on the first turn, use the id that comes back in the response. |
| `pageUrl` | no | The page the buyer is "on", e.g. a product page URL. The bot uses it as context. |
| `meta` | no | `{ runId?, scenarioId?, label? }`. These are stored on the Langfuse trace so you can find a run there. |

```bash
curl -H "X-Bot-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"sessionId":"auditor-run-001","message":"do you make press brakes?","meta":{"runId":"r1","scenarioId":"lead_capture-1"}}' \
  https://<base>/api/v1/bots/jayshree-machinetools/chat
```

The response:

| Field | Meaning |
|---|---|
| `sessionId` | The conversation id to send on the next turn |
| `reply` | The bot's text |
| `chips` | Reply buttons shown under the reply (`[]` if none). The simulated buyer can answer with one of them. |
| `cards` | Cards the bot shared: `{ type: "product" \| "image" \| "video" \| "document", title, url }` |
| `summary` | Only present once requirement gathering is done: `{ rows: [{label, value}], note }`. This is the enquiry summary card. |
| `askFor` | What the chat window asks for next: `"mobile"`, `"otp"`, `"name"` or `null` |
| `leadStage` | `none` → `otp_sent` → `verified` → `captured` (lead saved) → `locked` (too many wrong OTPs) |
| `traceId` | The Langfuse trace id, when tracing is on |
| `test` | Always `true`: this chat is saved as a test |

### A typical conversation

| Buyer sends | Bot (`reply`, then `askFor` / `leadStage`) |
|---|---|
| *(shows `greeting`)* | |
| `do you make press brakes?` | "Please share your 10-digit mobile number." · `mobile` / `none` |
| `9876543210` | "OTP sent…" · `otp` / `otp_sent` |
| `12345` | "Verified. May I have your name?" · `name` / `verified` |
| `Ramesh` | Lead saved; the first spec question, with `chips` · `null` / `captured` |
| a chip, e.g. `CNC` | The next spec question… |
| the last answer | `summary` card; the lead is updated |

## Errors

| Status | When |
|---|---|
| 400 | Empty or overlong `message`, or a malformed `sessionId` |
| 401 | `X-Bot-Key` is missing, unknown or revoked |
| 403 | The key belongs to a different bot slug |
| 404 | Unknown bot slug |
| 409 | The previous message in this conversation is still being answered. Send one turn at a time per `sessionId`. |
| 429 | Too fast: more than 15 messages a minute in one conversation, or more than 120 a minute on one key |
| 500 | The bot failed on this turn. Retry the turn. |

Run different conversations in parallel (with different `sessionId`s) rather than sending turns of one conversation at the same time.

## How simulated chats are kept apart

- **Leads:**
  - Leads from simulated chats are saved with a **test** flag.
  - `/admin/leads` hides them unless you tick **Show test chats**; then they carry a "Test" badge.
  - The lead counts on `/admin` count real buyers only.
  - The CSV download follows the same filter.
- **Conversations:** a simulator `sessionId` can never continue a real buyer's chat. On the server it is stored as `sim-<sessionId>`.
- **Langfuse:**
  - Each turn is a normal `chat-turn` trace in the conversation's session (`<seller>:<chatId>`).
  - It is tagged `eval` and `simulator`, with metadata `source: "simulator"` plus your `meta`.
  - Filter on the `eval` tag to include or exclude simulated chats. The per-chat cost score (`chat_cost_usd`) works the same way as for real chats.
- **The bot itself** isn't told the chat is simulated, so it behaves exactly as it does with a real buyer.

The browser can call this API from any site (CORS is open, and `X-Bot-Key` is allowed). Still, keep keys on the simulator's server: anyone with a key can chat with that bot.
