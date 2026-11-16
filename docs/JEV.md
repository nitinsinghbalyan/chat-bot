# How Jev picks the product

Jev (TypeSafe AI, `jev-1.14.0`) is a **decision model**: it answers typed questions about a given state with probabilities and writes no text. The bot uses it for one decision only: which of the seller's products the buyer means this turn. Claude (Haiku) still writes every reply. Code: `src/jev.ts`. Switch: `/admin` → Jev product pick (Off / Shadow / On).

## The request (one per buyer message, after login)

- **State:**
  - `buyer_message`, with digit runs masked as `[number]`;
  - `bot_previous_message`;
  - `buttons_shown`;
  - `current_product`, when the chat has one;
  - `seller_products`: up to 30 options, built from the search matches (one per product card or category), then the card the buyer's words name, then the seller's other products. They are **shuffled**, because Jev leans toward the first option.
- **Questions:**
  - `product`, a **Choice**: which of `seller_products` the buyer means. It always picks one.
  - `about_product`, a companion **Noul**: is the message about one of the seller's products, or the same kind of product? Greetings, answers to the bot, city, price-only questions and other kinds of product are "no".
  - `other_product`, a **Noul**, only when the chat has a product: does the message move to a different one?

## The answer and the decision

- **What a Choice returns:** `probabilities` over the options and a `confidence`, which is `(p_max − 1/n) / (1 − 1/n)`. It is 1 when all the probability is on one option and 0 when it is spread evenly.
- **What a Noul returns:** a probability of "yes". 0.7 counts as a clear yes and 0.3 as a clear no (TypeSafe's suggested starting points).
- **How the answer becomes a decision:**

| Answer | Decision |
|---|---|
| `about_product` < 0.3 | keep the chat as it is |
| `about_product` < 0.7, Choice confidence < `JEV_MIN_CONFIDENCE` (0.5), an error, or over `JEV_TIMEOUT_MS` (1.5 s) | unsure: the word rules decide |
| no product yet | pick Jev's product |
| same product, or `other_product` < 0.3 | keep the current product |
| `other_product` 0.3–0.7 | unsure: the word rules decide |
| `other_product` ≥ 0.7 | switch to Jev's product |

- **When Jev is never asked:**
  - while the buyer is logging in;
  - for a tapped button;
  - for a closing-step answer;
  - for a message with no words;
  - when the buyer is on a product page (the page wins).
- **Modes:** in **Shadow** the decision is logged and compared with the word rules; in **On** it is used.
- **Answers vary:** they can differ slightly between identical calls. In one example `about_product` came back 0.81, then 0.69. The thresholds and the fallback make that harmless.

## Measuring it

- **Langfuse:** each trace has a `jev-product-pick` generation, with the options, the answer, the decision, tokens, cost ($0.042 per million input tokens) and latency.
- **Test chats:** Bot API Test keys also ask Haiku the same question, with the same options in the same order. That is the `haiku-product-pick` generation (`src/productPick.ts`), which is never used for the decision. Each reply's `debug` block lists every call.
- **`npm run retrieval:eval -- <dir> --jev [--haiku]`** scores the pickers on the sellers' single-message test cases.
- **`npm run simulate`** plus **`npm run sim:report`** score them in full simulated conversations (docs/SIMULATE.md).

Results so far (481 cases): word rules → Jev at 0.5:
- right product 72% → 79%;
- wrong 8% → 4%;
- need described without the product's name 32% → 65%;
- Hinglish 65% → 73%;
- off-topic picks 35 → 12.

Jev takes 241 ms on average and costs about $0.0001 per call. Details: `memory/projects/seller-assistants.md`.

## Known weak spots (TypeSafe's list) and how the bot handles them

- **Leans toward the first option:** we shuffle the options.
- **Reads questions literally:** the `about_product` wording names "the seller's products", so "brake pads for my car" isn't a press brake.
- **Weak at numbers, counting and dates:** it is never asked about quantities, sizes or prices.
- **Large, noisy state:** only what the question needs is sent.
- **Adversarial text:** its only power is choosing a product; the server still guards prices, contacts and the enquiry steps.
- **Hindi and Hinglish not verified by TypeSafe:** in our test set, Hinglish accuracy went up.
