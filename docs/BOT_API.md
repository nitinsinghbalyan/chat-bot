# Bot API

How another platform, app or chat simulator talks to a seller's bot. Three calls, all JSON, all authenticated with a per-seller key:

| # | Call | What it does |
|---|---|---|
| 1 | `GET /api/v1/bots/<slug>` | The bot's name, welcome message, seller id and demo OTP |
| 2 | `POST /api/v1/bots/<slug>/conversations` | Opens a conversation and passes what you already know about the buyer (name, mobile, buyer id), so the bot doesn't ask for it again. Optional. |
| 3 | `POST /api/v1/bots/<slug>/chat` | Sends one buyer message and returns the bot's whole reply |

A chat through this API goes through the same bot as the website widget: the same knowledge, prompts, guardrails, OTP rules, spec questions and lead saving. The bot never states a price.

## If you are coming from another vendor's API

| Vendor call | Here |
|---|---|
| Create user (`POST /users`, returns an `x-user-key`) | Not needed. Your `X-Bot-Key` identifies you; the buyer is identified in call 2. |
| Create conversation (`POST /conversations`) | Call 2, `POST /api/v1/bots/<slug>/conversations` |
| Webhook with `name`, `seller_id`, `buyer_id` | Also call 2: send `name`, `sellerId`, `buyerId` (and `mobile` if you have it) in the same body |
| Send message (`POST /messages` with `conversationId`) | Call 3, `POST /api/v1/bots/<slug>/chat` with `sessionId` |

Two differences worth knowing. The bot is addressed by its **slug** in the URL, not by a seller id in the body: the slug is on the seller's page in `/admin`, and `sellerId` is accepted as a check (a mismatch is refused). And the reply comes back in the same response, so there is no polling for messages.

## Connect

| Field | Value |
|---|---|
| Base URL | The platform's address, e.g. `https://<your-app>.onrender.com` |
| Bot slug | The seller's slug, e.g. `jayshree-machinetools`. Shown on the seller's page in `/admin` (Bot API card). |
| Seller id | The IndiaMART seller id from the seller's export, shown on the same card. `null` until an export is uploaded. |
| Key | Generated on the seller's page in `/admin` (**API key** on the seller's row opens the **Bot API** card). Pick the kind: **Live** for real buyers, **Test** for simulators. The key is shown once; only its hash is stored. Revoke it any time. |
| Header | `X-Bot-Key: sa_live_…` on every call |

A key works for one bot only. Keep it on your server: anyone holding it can chat with that bot. The browser can call the API from any site (CORS is open and `X-Bot-Key` is allowed), but don't ship a key to the browser.

**Live or Test.** The two kinds run the same journey. A **Live** key's chats are real: their leads appear on the Leads page and count for the seller, and their traces are tagged `api`. A **Test** key's chats are simulations: their leads are saved as **test** leads (hidden on the Leads page unless "Show test chats" is ticked) and their traces are tagged `eval` and `simulator`. Use a Test key for the AI Assistant Auditor and any scripted testing.

## 1. Bot details

```bash
curl --location 'https://<base>/api/v1/bots/jayshree-machinetools' \
--header 'X-Bot-Key: sa_live_…'
```

```json
{
  "slug": "jayshree-machinetools",
  "name": "Jayshree Machinetools Private Limited",
  "sellerId": "14321376",
  "greeting": "Welcome to Jayshree Machinetools Private Limited. I can tell you about our machines, share photos and brochures, and pass your enquiry to our team.",
  "demoOtp": "12345",
  "keyKind": "live"
}
```

Show `greeting` as the bot's first message: it asks nothing and has no buttons. `sellerId` is `null` when the seller has no uploaded export. No SMS gateway is connected yet, so when the bot asks for an OTP the code is always `demoOtp`.

## 2. Start a conversation (optional)

Call this before the first message when you already know who the buyer is. Everything in the body is optional; send what you have.

```bash
curl --location 'https://<base>/api/v1/bots/jayshree-machinetools/conversations' \
--header 'X-Bot-Key: sa_live_…' \
--header 'Content-Type: application/json' \
--data '{
    "sessionId": "im-65857057-20261026-01",
    "name": "Rahul",
    "mobile": "9876543210",
    "mobileVerified": true,
    "buyerId": "65857057",
    "sellerId": "14321376"
}'
```

| Field | Meaning |
|---|---|
| `sessionId` | Your id for the conversation: 8–64 letters, digits, `-` or `_`. Send the same id on every chat call. Left out, one is generated and returned. |
| `name` | The buyer's name (2–80 characters). The bot won't ask for it. |
| `mobile` | The buyer's 10-digit Indian mobile number (`+91`, `91` or `0` prefixes are accepted). |
| `mobileVerified` | `true` when your platform has already verified this number (OTP done on your side). The bot then skips its own OTP. Without it, the bot asks the buyer for the OTP on their first message (demo OTP, see above), so the number is still confirmed in the chat. |
| `buyerId` | The buyer's id on your platform (up to 64 characters). Stored on the lead, shown on the Leads page and in the CSV, and attached to the chat's traces. |
| `sellerId` | Your seller id for this bot. Checked against the seller's export when known; a mismatch is refused with 409. |

What the bot skips depends on what you send:

| You send | The bot's first reply |
|---|---|
| `name` + `mobile` + `mobileVerified: true` | Goes straight to the product and its spec questions. No contact questions at all. |
| `mobile` + `mobileVerified: true`, no name | Asks only the buyer's name. |
| `mobile` without `mobileVerified` | Asks the buyer for the OTP (then the name, if not sent). |
| `name` only | Asks for the mobile number; the name is kept for the lead and not asked again. |
| nothing | The full journey: mobile → OTP → name → product → spec questions. |

Response:

```json
{
  "sessionId": "im-65857057-20261026-01",
  "greeting": "Welcome to Jayshree Machinetools Private Limited. …",
  "leadStage": "captured",
  "askFor": null,
  "buyer": { "name": "Rahul", "mobile": "xxxxxx3210", "buyerId": "65857057" },
  "test": false
}
```

`leadStage` and `askFor` tell you where the buyer starts (see call 3 for their values). Calling this again for the same `sessionId` is fine until the first message has been sent; after that it is refused with 409, so open a new `sessionId` for a new conversation. A conversation that has been silent for 2 hours expires; start a new one.

## 3. Send a message

```bash
curl --location 'https://<base>/api/v1/bots/jayshree-machinetools/chat' \
--header 'X-Bot-Key: sa_live_…' \
--header 'Content-Type: application/json' \
--data '{
    "sessionId": "im-65857057-20261026-01",
    "message": "i need cnc cutting machine"
}'
```

| Field | Required | Meaning |
|---|---|---|
| `message` | yes | What the buyer typed (up to 1,000 characters). To tap a reply button, send that chip's text. |
| `sessionId` | no | The conversation id from call 2, or your own id (same rules). Left out on a first message, use the id that comes back. |
| `pageUrl` | no | The product or category page the buyer is on, e.g. a product page URL. The bot uses it as context ("is this available in 3 m?"). |
| `meta` | no | `{ runId?, scenarioId?, label? }`, stored on the chat's trace so a test run can be found in Langfuse. |

Response:

```json
{
  "sessionId": "im-65857057-20261026-01",
  "reply": "Which cutting capacity do you need?",
  "chips": ["Up to 6 mm", "6–12 mm", "Above 12 mm"],
  "cards": [],
  "askFor": null,
  "leadStage": "captured",
  "traceId": "4f0c…",
  "test": false
}
```

| Field | Meaning |
|---|---|
| `reply` | The bot's text. Show it as one message. |
| `chips` | Reply buttons to show under the reply (`[]` if none). Sending a chip's text as the next `message` is the tap. |
| `cards` | Product, photo, video or brochure cards the bot shared: `{ type: "product" \| "image" \| "video" \| "document", title, url }` |
| `summary` | Present once requirement gathering is done: `{ rows: [{ label, value }], note }`, the enquiry summary card. Show it; the buyer can still correct a detail. |
| `askFor` | What the bot is waiting for: `"mobile"`, `"otp"`, `"name"` or `null`. Useful for input hints (numeric keypad, one-time-code field). |
| `leadStage` | `none` → `otp_sent` → `verified` → `captured` (lead saved) → `locked` (too many wrong OTPs) |
| `traceId` | The Langfuse trace id of this reply, when tracing is on |
| `test` | `true` for a Test key: the chat's lead is a test lead |

Send one message at a time per `sessionId` and wait for the reply. Different conversations can run in parallel.

## A typical conversation with buyer context

| Step | You send | Bot (`reply` · `leadStage`) |
|---|---|---|
| 1 | call 2 with name, verified mobile, buyer id | `greeting` shown · `captured` |
| 2 | `i need cnc cutting machine` | "Which cutting capacity do you need?" with `chips` · `captured` |
| 3 | a chip, e.g. `6–12 mm` | the next spec question with `chips` |
| … | the last answer | `summary` card; lead updated; "Anything to change?" with chips All correct / Change a detail |

The lead is saved on the seller's Leads page with the name, mobile, product, specs, quantity, city and your `buyerId`. Without call 2 the same conversation starts with "Please share your 10-digit mobile number" (`askFor: "mobile"`), then the OTP (`demoOtp`), then the name.

## Errors

| Status | When |
|---|---|
| 400 | Empty or overlong `message`; malformed `sessionId`; a `mobile` that is not a 10-digit Indian number; a `name` under 2 characters |
| 401 | `X-Bot-Key` missing, unknown or revoked |
| 403 | The key belongs to a different bot slug |
| 404 | Unknown bot slug |
| 409 | `sellerId` does not match this bot; the conversation has already started (call 2 after a message); or the previous message in this conversation is still being answered |
| 429 | Too fast: more than 15 messages a minute in one conversation, or more than 120 calls a minute on one key |
| 500 | The bot failed on this turn. Retry the message. |

Every error body is `{ "error": "…" }`, with `sessionId` when one applies.

## What you will see on our side

- **Leads:** Live keys → real leads on `/admin/leads` and in the CSV, with a "Buyer id" line under the name. Test keys → test leads, hidden unless "Show test chats" is ticked, and left out of the seller's lead count.
- **Conversations:** an API `sessionId` never continues a website visitor's chat. Internally it is stored as `api-<sessionId>` (Live) or `sim-<sessionId>` (Test); the transcript is on `/admin/leads` → Chat.
- **Langfuse:** one trace per message in one session per conversation (`<seller>:<chatId>`), tagged `api` (Live) or `eval` + `simulator` (Test), with `buyerId` and your `meta` in the metadata. Mobiles are masked; OTPs are never recorded.
- **The bot itself** isn't told who is calling: it behaves exactly as with a website visitor, except that it skips the contact details you supplied.
