# Simulating the test scenarios

`npm run simulate` plays one conversation per test scenario against a running bot, through the Bot API. Claude (Haiku) plays the buyer from each scenario's persona brief (`*_Scenarios.json`). `npm run sim:report` then turns the run into two tables:
- **tokens, latency and cost per model call**;
- **product-pick accuracy:** word rules vs Jev vs Haiku asked the same question, scored against each scenario's `focus_product`.

## What you need

1. **A Test key per seller.** On each seller's page in `/admin`, open the **Bot API** card, choose **Test** and press **Generate key**. Test chats save test leads, which are hidden on the Leads page. Their traces are tagged `eval` and `simulator`, and each reply carries a `debug` block with every model call of the turn (see BOT_API.md).
2. **Jev in Shadow or On** (`/admin` → Jev product pick). With Jev Off, neither Jev nor the Haiku comparison runs.
3. **An Anthropic API key** for the simulated buyer, in `ANTHROPIC_API_KEY`.
4. **The scenario files** (`*_Scenarios.json`), kept locally. They are never committed.

## Run it

Copy `scripts/sim.config.example.json` to `sim.config.json`, which git ignores. Set:
- `baseUrl`: the bot's address;
- each seller's `slug`, copied from `/admin`;
- the environment variable that holds its key;
- the path to its scenarios file, relative to the config.

Then:

```bash
export ANTHROPIC_API_KEY=…          # for the simulated buyer
export KEY_JAYSHREE=sa_live_…       # one Test key per seller, as named in sim.config.json
export KEY_EXOTICA=sa_live_…        # …

npm run simulate -- --config sim.config.json --limit 3        # a small first run
npm run simulate -- --config sim.config.json --run-id full-1  # all scenarios
npm run sim:report -- runs/full-1
```

Options:
- `--seller <slug>` and `--scenario <text>` filter which chats run.
- `--concurrency 4` sets how many chats run at once per seller.
- `--max-turns 14` sets the bot turns per chat.
- `--buyer-model claude-haiku-5-5` sets the model that plays the buyer.
- `--buyer scripted` uses a rule-based buyer instead of a model, so it needs no Anthropic key and costs nothing extra. It:
  - logs in with the test identity;
  - sends the scenario's own messages from the seller's `*_Bot_Test_Cases.csv` (`Buyer_Input`; "Turn 1: … -> Turn 2: …" scripts are split into turns), which you add as `testCases` per seller in the config;
  - taps the first button the bot shows;
  - answers the closing steps: quantity 2, firm "Test Traders", the scenario's city.

  It is less natural than a model buyer, but the product signal comes from the real test messages.
- `--out runs` sets where results go.

Rerunning with the same `--run-id` continues a cut-off run. Finished scenarios are skipped, and an unfinished one starts again as a new chat.

## What a conversation looks like

1. The buyer gets the bot's greeting and the scenario brief, plus a fixed test identity: a made-up mobile per scenario, the demo OTP, and the scenario's name and city.
2. It writes one message at a time, in the scenario's language style, and may tap a button by sending its text.
3. The chat stops when:
   - the summary card appears;
   - the buyer ends it;
   - the turn limit is reached;
   - three sends in a row fail.

   The simulator waits and retries on 409 (busy) and 429 (rate limit).

## What you get (`runs/<run-id>/`)

| File | Holds |
|---|---|
| `run.json` | Run id, start time, base URL, buyer model, and the bot's `/health` (build, reply model, Jev mode) |
| `turns.jsonl` | One row per bot turn: buyer message, reply, buttons, lead stage, the turn's model calls (`calls`: kind, model, tokens, cache, latency, time to first token, cost, decision), each picker's product (`product`) and the Langfuse trace id |
| `conversations.jsonl` | One row per finished chat: turns, whether the summary was reached, the final product, why it stopped |
| `report.md` | The tables below (written by `sim:report`) |
| `calls.csv` | One row per model call, for a spreadsheet |
| `accuracy.csv` | One row per compared turn: what the word rules, Jev and Haiku chose, and whether each was right |

## Reading the report

- **Tokens, latency and cost per call**, for:
  - Haiku reply calls (each call, and the whole turn);
  - the Jev pick;
  - the Haiku pick (the same question as Jev);
  - the simulated buyer, which is not part of the bot.

  The report also gives the bot's cost per conversation and per 1,000 buyer messages.
- **Product pick:**
  - **Which turns count:** only those where both Jev and Haiku were asked, which means after login and not for a tapped button or a closing-step answer.
  - **What each picker's product is:** what the chat would get if that picker decided. That is its own pick, or the current product on "keep", or the word rules' choice when it is unsure.
  - **What it reports:** right, wrong and no product, plus the first product each picker would set per chat. It also gives the false picks in scenarios with no product, and the agreement between Jev and Haiku. Each is split by language, suite and seller, with examples where only one of them was right.
- **A note on Shadow:** with Jev in Shadow, the bot follows the word rules, so later turns build on their choice. For single messages scored the same way, run the retrieval eval with `--jev --haiku`; it uses the same files.

Every turn is also a Langfuse trace, filterable by tag `simulator` and `runId`. Each trace holds the `claude round N` generations, `jev-product-pick` and `haiku-product-pick`, all with tokens, latency and cost.
