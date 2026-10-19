# Jayshree Machinetools Private Limited

**Slug:** `jayshree-machinetools` (repo seller, `kb/sellers/jayshree-machinetools/`)
**Website:** https://www.jayshreemachinetools.in/ (an IndiaMART-hosted catalogue site)
**Brand colour:** `#0b5cad` · **Listed contact:** +91-8048264349 · **Brand:** KISHAN
**Location:** Rajkot, Gujarat, India (Lodhika Metoda, 360021)

## Business card facts (OK for the bot to share, G7)
- Manufacturer (also exporter and supplier) of sheet-metal machinery.
- CEO: Nalinbhai Harsora. Contact person: Kishan Harsora (owner).
- Range: press brakes (NC/CNC, hydraulic, tandem), shearing machines (hydraulic, NC, under-crank, variable rake), hydraulic presses (C-frame, H-frame, deep drawing), ironworkers, fiber laser cutting machines.

## Knowledge base
- **KB JSON (export v3.0):** 143 products, 28 categories, 786 photos, 66 videos, 73 PDFs. About 170k characters of prompt text, roughly 43k tokens, cached; prompt mode `full` (under the 300k budget). Still v3: a **v5** re-export would add `seller_id` (needed for glid matching in the FAQ sheet) and product FAQs.
- Uploaded on production via `/admin`. It is **not** in git (sensitive fields), and lives at `/var/data/sellers/jayshree-machinetools/seller_kb.json`.
- KB folder fallback: `business_card.json`, `product_cards.json` (4 cards: Hydraulic Press, Laser Cutting, Press Brake, Shearing), `sitemap.xml` (179 URLs, 174 crawlable).
- The export also contains, **never used by the bot**: prices, delivery and payment terms, turnover, employee counts, year established (1995), GST/CIN/IEC numbers, bankers, ratings and key customers.

## Persona (`kb/sellers/jayshree-machinetools/persona.json`)
- **System part:** a practical, concise machine-tool sales engineer. Mentions the KISHAN brand and the range, warm and brief greetings, matches the buyer's language (English, Hindi, Hinglish, Gujarati). Starts from the buyer's job: material, maximum sheet thickness, working length.
- **User part:** once the mobile number and name are captured, ask the specification questions in `<spec_questions>` (the server picks them for the buyer's machine), one at a time with the options as buttons; share media with `share_media`; prices only via the team; keep replies short. (Changed Oct 16 from "ask material, thickness and length", which clashed with per-machine questions.)

Since #27 the common prompt, tools and summary card say "product" (the platform serves herb and cookware sellers too); Jayshree's persona still says "machine", which is fine as it layers on top.

## Spec questions (ISQs)
- Since #24 questions are planned per **MCAT within a category** (`taxonomy.glmcat_ids`): the buyer's product's MCAT, else the category's main one. Press brake MCATs are 25058 (CNC PRESS BRAKE, Cnc Press Brake Machine, Cnc Hydraulic Press Brake, CNC), 1669 (hydraulic Press Brake Machine, METAL SHEET BENDING MACHINE, Press Brake) and 123956 (Hydraulic Press Brake, NC PRESS BRAKE). Shears are 185336 and 148563, laser 182186.
- The MCAT file uploaded earlier is mostly construction MCATs, so only the ironworker categories (85047, 117370, 150508) get MCAT questions; the others show as **derived** in the Knowledge mapping block (e.g. CNC press brakes: Automation Grade, Capacity, Control Axis, Max Sheet Width; laser: Laser Power, Cutting Material, Automation Level, Cooling Type). A generated MCAT file for the ids above would fix that.
- Several single-product categories (H Frame Hydraulic Press, Hydraulic Press Machine, Sheet Shearing Machine) have no ISQs; the bot then asks only quantity and city.
- Extra files shared earlier (business card .md, MCAT specs, product cards) were tested locally; whether they're uploaded on production is up to Nitin. The old business card .md is a plain fact card, not a policy card; both parse.

## Site settings (`seller.json`)
- Tagline: "Manufacturer of press brakes, shearing machines, hydraulic presses and fiber laser cutting machines in Rajkot, Gujarat"
- `widgetPosition: right`; chips: Press Brake, Shearing Machine, Laser Cutting Machine, Hydraulic Press.

## Known issues
- Their site rate-limits or blocks the crawler from Render. One crawl reached only 64 of 146 pages, and later ones failed. Since PR #7 a partial crawl no longer replaces the catalogue, and the website is built from the JSON.
