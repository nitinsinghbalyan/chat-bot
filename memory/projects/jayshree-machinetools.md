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
- **KB JSON (export v3.0):** 143 products, 28 categories, 786 photos, 66 videos, 73 PDFs. About 170k characters of prompt text, roughly 43k tokens, cached.
- Uploaded on production via `/admin`. It is **not** in git (sensitive fields), and lives at `/var/data/sellers/jayshree-machinetools/seller_kb.json`.
- KB folder fallback: `business_card.json`, `product_cards.json` (4 cards: Hydraulic Press, Laser Cutting, Press Brake, Shearing), `sitemap.xml` (179 URLs, 174 crawlable).
- The export also contains, **never used by the bot**: prices, delivery and payment terms, turnover, employee counts, year established (1995), GST/CIN/IEC numbers, bankers, ratings and key customers.

## Persona (`kb/sellers/jayshree-machinetools/persona.json`)
- **System part:** a practical, concise machine-tool sales engineer. Mentions the KISHAN brand and the range, warm and brief greetings, matches the buyer's language (English, Hindi, Hinglish, Gujarati). Starts from the buyer's job: material, maximum sheet thickness, working length.
- **User part:** ask material, thickness and length first using the ISQ buttons; share media with `share_media`; prices only via the team.

## Site settings (`seller.json`)
- Tagline: "Manufacturer of press brakes, shearing machines, hydraulic presses and fiber laser cutting machines in Rajkot, Gujarat"
- `widgetPosition: right`; chips: Press Brake, Shearing Machine, Laser Cutting Machine, Hydraulic Press.

## Known issues
- Their site rate-limits or blocks the crawler from Render. One crawl reached only 64 of 146 pages, and later ones failed. Since PR #7 a partial crawl no longer replaces the catalogue, and the website is built from the JSON.
