# CS2 Trade-up Calculator

A web application for looking up CS2 skin prices and finding the most profitable trade-up contracts.

![Home Page](https://github.com/user-attachments/assets/e687ec14-3a8f-4929-b991-2943214bc10a)

## Features

- **Price Lookup** — prices sourced from the CS2Cap API (default provider: Skinport), refreshed hourly via a cron job; float-precise prices for high-value skins sourced from CSFloat
- **Trade-up Calculator** — select same-rarity items (10 for mil-spec through classified; 5 for covert → knife/glove), set float values, and compute EV/ROI
- **Profitable Trade-ups** — automatically scans the catalog and surfaces the highest-ROI contracts; results are cached in KV and served instantly on subsequent loads
- **Covert → Knife/Glove contracts** — the scanner models the October 2025 CS2 update: 5 covert inputs produce a knife or glove from the case's rare-drop pool
- **Liquidity filter** — contracts whose likely outputs have fewer than 3 active Skinport listings are skipped to avoid phantom profits on illiquid skins

## How it works

CS2 trade-up contracts let you exchange same-rarity items for one item of the next rarity tier. The number of inputs depends on rarity:

- **10 inputs** for industrial grade, mil-spec, restricted, and classified
- **5 inputs** for covert — the October 2025 CS2 update allows 5 covert items to produce a knife or glove from the same case's rare-drop pool

The output item is drawn from the same collections as the inputs, weighted by how many inputs came from each collection.

The calculator:
1. Validates inputs (correct count for the rarity, same rarity, valid float values)
2. Determines the output pool and each item's probability
3. Computes the output float using CS2's formula: `outputFloat = outputMin + avg(normalizedInputFloats) × (outputMax − outputMin)`
4. Looks up cached prices (sourced from CS2Cap) for each possible output
5. Calculates **EV** (Σ probability × price) and **ROI** ((EV − cost) / cost × 100%)

## Profitable Trade-ups — Deep Dive

The **Browse Profitable Trade-ups** page (`/profitable`) is the main selling point of this tool. It automatically discovers trade-up contracts with positive expected ROI without any manual input from the user.

### How the scanner works

The scanner logic lives in `lib/tradeup/scanner.ts` and is shared between two endpoints: the main read endpoint (`app/api/tradeups/profitable/route.ts`) and the cache-refresh endpoint (`app/api/tradeups/profitable/refresh/route.ts`). Results are cached in the `TRADEUP_CACHE` KV namespace so that most page loads are served in milliseconds from the edge without recomputing.

#### Cache flow

```
GET /api/tradeups/profitable
  └─ TRADEUP_CACHE hit  → apply filters in-memory → return  (fast, ~ms)
  └─ TRADEUP_CACHE miss → computeProfitableContracts()
                           → store in TRADEUP_CACHE (1 h TTL)
                           → apply filters → return  (slow, first hit only)

GET /api/tradeups/profitable/refresh  (cron or manual)
  └─ computeProfitableContracts() → store in TRADEUP_CACHE
```

Responses include `fromCache: true/false` and a `cachedAt` ISO timestamp so you can always tell whether data is fresh. The UI displays this information below the result count.

#### 1. Candidate generation (`generateCandidates`)

For each scannable rarity tier (`industrial_grade`, `mil_spec`, `restricted`, `classified`, `covert`), the scanner generates a list of candidate contracts. The strategies differ by rarity:

**For industrial grade through classified (10-item contracts)**

**Strategy A — 10× same item**
For every skin of the given rarity in the catalog, create a contract that uses 10 copies of that skin at float `0.20` (or the nearest valid float for skins with a restricted range). This produces one candidate per skin and is the simplest possible trade-up structure.

**Strategy B — 5+5 cross-collection mix**
For every *pair* of collections that contain skins of the given rarity, create a contract using 5 copies from one collection and 5 copies from the other, both at float `0.20`. Mixing collections changes which output items are in the pool and their relative probabilities, which can unlock more profitable outputs that a single-collection contract would miss.

**For covert (5-item contracts, output is knife/glove)**

Covert inputs follow the October 2025 CS2 rule: 5 covert items produce one knife or glove (`extraordinary` rarity) from the case's rare-drop pool.

**Strategy A — 5× same item**
Five copies of the same covert skin at float `0.20`.

**Strategy B — 4+1 and 3+2 cross-collection splits**
For every pair of collections containing covert skins, create contracts with 4+1 and 3+2 splits to vary the output knife/glove probabilities.

#### 2. Evaluation (`evaluateTradeup`)

Each candidate contract is evaluated by `lib/tradeup/ev.ts`:

1. **Input cost** — look up the cached market price for each input item (skin + wear tier derived from its float) and sum them to get `totalCost`.
2. **Output pool** — `lib/tradeup/pool.ts` identifies all items of the next rarity tier that belong to the same collections as the inputs, and assigns each a probability proportional to how many inputs came from its collection.
3. **Output float** — the output float is the same for every item in the pool and is computed as:
   ```
   normalizedAvg = average((inputFloat − skinMin) / (skinMax − skinMin))
   outputFloat   = outputMin + normalizedAvg × (outputMax − outputMin)
   ```
4. **Output prices** — for classified and covert outputs (and their knife/glove drops), the app first checks the CSFloat snapshot for a float-bucketed listing price; if unavailable it falls back to interpolation from the main price snapshot.
5. **EV & ROI** —
   ```
   EV  = Σ (probability × price)  for each output item
   ROI = (EV − totalCost) / totalCost × 100%
   ```
6. **Additional metrics**
   - `guaranteedProfit` — `true` when the cheapest possible output is still more expensive than `totalCost`.
   - `chanceToProfit` — the sum of probabilities for output items priced above `totalCost`.

#### 3. Filtering and ranking

After evaluation, the scanner:
- Discards any contract with `ROI < 1.0` (the `MIN_ROI` threshold, where `1.0` = break-even).
- Discards contracts where any output item with a probability ≥ 5% has fewer than `MIN_SELL_QUANTITY` (3) active Skinport listings — these are flagged as **illiquid** to avoid phantom profits on paper-priced skins.
- Discards contracts whose `totalCost` exceeds the user's optional **Max Budget** filter.
- Sorts the remaining contracts by ROI descending.
- Returns the top 20 results.

### What the UI shows

Each result card on the `/profitable` page displays:
- **ROI badge** — green (> 15%), yellow (0–15%), or red (< 0%).
- **Guaranteed ✅** badge — shown when every possible output is profitable.
- Rarity tier, input skin name, total cost, EV, and probability of profit.
- An expandable details panel listing every input item with its wear and float.

### Current limitations

| Limitation | Detail |
|---|---|
| **Float sweep coverage** | Only float `0.20` is tried. A contract at float 0.05 or 0.35 may have a meaningfully different ROI profile. |
| **Single- and two-skin inputs only** | Strategies use at most two distinct skins. Contracts built from 3 or more distinct skins are not generated. |
| **CSFloat availability** | CSFloat prices are fetched for classified/covert/extraordinary skins only, and only for the pre-defined float buckets. Skins not covered fall back to interpolation from the main price snapshot. |
| **On-demand scanning** | ~~Results are computed fresh on every page load. There is no background refresh or persistent storage of discovered contracts.~~ **Resolved** — results are now cached in `TRADEUP_CACHE` KV and recomputed in the background via the `/api/tradeups/profitable/refresh` endpoint. |

### Ideas for improvement

- **Broader candidate generation** — sweep over multiple float values (e.g. 0.05, 0.15, 0.20, 0.35) and all permutations of 2–4 distinct skins from the same rarity tier to find contracts the current strategies miss.
- **Exhaustive mixed-input contracts** — enumerate all combinations of *k* distinct skins (k = 2…5) rather than only pairs, giving a much richer search space.
- **Expand the catalog** — ✅ *Implemented.* The catalog now covers 92 collections and ~1 400 weapon skins sourced from the ByMykel CSGO-API. A dynamic catalog loader (`lib/catalog/dynamic.ts`) fetches the latest data on demand and caches it in the `CATALOG_CACHE` KV namespace, so new skins become available without redeploying. The static `lib/catalog.ts` is regenerated weekly by a GitHub Actions workflow.
- **Background / scheduled scanning** — ✅ *Implemented.* The `/api/tradeups/profitable/refresh` endpoint runs the scanner and stores results in the `TRADEUP_CACHE` KV namespace. Schedule it hourly alongside the price-refresh cron job to keep results up-to-date without any per-request computation overhead.
- **Multiple price sources** — incorporate additional marketplace prices (e.g. Buff163) to find arbitrage opportunities where buying inputs on one platform and receiving outputs on another is profitable.
- **StatTrak support** — StatTrak trade-ups have separate price curves; modelling them can reveal additional profitable contracts.
- **Adjustable ROI threshold** — expose the `MIN_ROI` constant as a UI slider so users can filter for only high-confidence contracts.

## Getting Started

This app runs on the **Cloudflare Workers** runtime using [`@opennextjs/cloudflare`](https://opennext.js.org/cloudflare) v1.x. There is no Cloudflare Pages mode in v1.x — the adapter exclusively targets Workers.

### Cloudflare tech used by this repo

| Item | Type | How it is used | Do you create it manually? |
|---|---|---|---|
| Cloudflare Workers | Runtime | Runs the Next.js server and API routes | Yes |
| Wrangler | CLI / local emulator | Deploys the worker and simulates bindings locally | Installed via `devDependencies` |
| `PRICE_CACHE` | KV namespace | Fast per-skin price cache for read-heavy lookups | Yes |
| `TRADEUP_CACHE` | KV namespace | Cached profitable trade-up payload | Yes |
| `CATALOG_CACHE` | KV namespace | Cached dynamic catalog snapshot | Yes |
| `PRICE_SNAPSHOTS` | R2 bucket | Stores `latest_prices.json` and `csfloat_prices.json` | Yes |
| `WORKER_SELF_REFERENCE` | Service binding | Required by the OpenNext Cloudflare adapter | No extra storage to seed |
| `ASSETS` | Assets binding | Serves the built Next.js static assets | No extra storage to seed |
| `IMAGES` | Images binding | Enables Next.js image optimization on Workers | No extra storage to seed |

### What is actually required?

- **Local development:** no real Cloudflare resources are required. `npm run dev` and `npm run preview` use Wrangler's local emulation for KV/R2.
- **Production with the current codebase:** all **three KV namespaces** and the **one R2 bucket** are actively used and should be treated as required.
  - `PRICE_CACHE` is used for fast individual price lookups.
  - `PRICE_SNAPSHOTS` is the source of truth for the hourly price snapshots.
  - `TRADEUP_CACHE` avoids recomputing the scanner payload on every request.
  - `CATALOG_CACHE` stores the dynamic catalog used by refresh, evaluation, profitable, and inventory flows.
- **Optional secret:** `CSFLOAT_API_KEY` improves float-aware pricing, but the app still works without it by falling back to interpolation from the main snapshot.
- **Near-free setup:** if you want the cheapest setup, skip `CSFLOAT_API_KEY` and use local emulation for development. In production, removing any of the current KV/R2 resources would require code changes because the repo reads and writes all of them today.

### Prerequisites

- [Node.js](https://nodejs.org/) (v20 or later)
- npm
- For deployment only: a Cloudflare account and `npx wrangler login`
- For full data refreshes: a CS2Cap API key (`CS2C_API_KEY`)
- Optional for float-accurate pricing: a CSFloat API key (`CSFLOAT_API_KEY`)

### Local Development

Install dependencies once:

```bash
npm install
```

You have two supported local runtimes:

**Option A — Next.js dev server** (fast iteration, Cloudflare bindings available via `initOpenNextCloudflareForDev`)
```bash
npm run dev        # http://localhost:3000
```

**Option B — Full Workers preview** (closest to production)
```bash
npm run preview    # http://localhost:8787
```

> `npm run preview` runs `opennextjs-cloudflare build && opennextjs-cloudflare preview`.

### Seeding local data

There is **no separate seed script** in the current repo. The supported way to seed local KV/R2 data is to run the same refresh endpoints the deployed app uses.

1. Optionally add local secrets to `.dev.vars`:
   ```dotenv
   NEXTJS_ENV=development
   CS2C_API_KEY=...
   CSFLOAT_API_KEY=...   # optional
   CRON_SECRET=...       # optional locally; if set, include Authorization headers below
   ```
2. Start the app with `npm run dev` or `npm run preview`.
3. Call the refresh endpoints in this order:
   ```bash
   # 1. Seed the catalog cache
   curl -X GET "http://localhost:3000/api/catalog/refresh"

   # 2. Seed the main CS2Cap price snapshot + warm the price KV cache
   curl -X GET "http://localhost:3000/api/prices/refresh"

   # 3. Optional: seed float-bucketed CSFloat prices
   curl -X GET "http://localhost:3000/api/prices/refresh-csfloat"

   # 4. Seed the profitable trade-up cache
   curl -X GET "http://localhost:3000/api/tradeups/profitable/refresh"
   ```
4. If you set `CRON_SECRET`, include `Authorization: Bearer <CRON_SECRET>` on each request. If you use `npm run preview`, replace port `3000` with `8787`.

If you do **not** set `CS2C_API_KEY`, the app still boots, but price-dependent routes cannot populate `latest_prices.json`, so calculator and profitable results will be incomplete.

### Deployment to Cloudflare Workers

1. **Create the Cloudflare storage resources used by the app**
   ```bash
   npx wrangler kv namespace create PRICE_CACHE
   npx wrangler kv namespace create TRADEUP_CACHE
   npx wrangler kv namespace create CATALOG_CACHE
   npx wrangler r2 bucket create cs-tradeup-prices
   ```

2. **Update `wrangler.jsonc` with the real binding IDs**
   ```jsonc
   "kv_namespaces": [
     { "binding": "PRICE_CACHE", "id": "<paste-price-cache-id-here>" },
     { "binding": "TRADEUP_CACHE", "id": "<paste-tradeup-cache-id-here>" },
     { "binding": "CATALOG_CACHE", "id": "<paste-catalog-cache-id-here>" }
   ],
   "r2_buckets": [
     { "binding": "PRICE_SNAPSHOTS", "bucket_name": "cs-tradeup-prices" }
   ]
   ```
   > **Important:** deploying with missing bindings causes runtime errors when the app touches KV/R2.

3. **Add secrets via Wrangler** (never commit secrets into `wrangler.jsonc`)
   ```bash
   # Recommended in production to protect the refresh endpoints
   npx wrangler secret put CRON_SECRET

   # Required to build the main market-price snapshot
   npx wrangler secret put CS2C_API_KEY

   # Optional: only needed for /api/prices/refresh-csfloat
   npx wrangler secret put CSFLOAT_API_KEY
   ```

4. **Deploy**
   ```bash
   npm run deploy
   ```

5. **Seed production data** by calling the refresh endpoints in the order documented below.

## Architecture & Storage Strategy

Prices and catalog data are stored in Cloudflare's edge services:

- **Cloudflare R2 (`PRICE_SNAPSHOTS`)** — stores the full CS2Cap snapshot (`latest_prices.json`) and the optional CSFloat snapshot (`csfloat_prices.json`).
- **Cloudflare KV — `PRICE_CACHE`** — a 1-hour edge cache for individual skin prices. On a miss, the app falls back to the R2 snapshot and back-populates KV.
- **Cloudflare KV — `TRADEUP_CACHE`** — stores the pre-computed profitable trade-up list so `/api/tradeups/profitable` is usually cache-only.
- **Cloudflare KV — `CATALOG_CACHE`** — stores the dynamic catalog snapshot created by `/api/catalog/refresh`.
- **Cloudflare Workers runtime** — serves the UI and all API routes.
- **OpenNext Cloudflare adapter bindings** — `WORKER_SELF_REFERENCE`, `ASSETS`, and `IMAGES` are part of the runtime integration; they are not user-managed application data stores.

## Refresh Call Order

Use the following order whenever you seed or refresh data:

| Step | Endpoint | Required? | Why it comes here |
|------|----------|-----------|-------------------|
| 1 | `GET /api/catalog/refresh` | Yes | Refreshes the catalog used by the other refresh routes. |
| 2 | `GET /api/prices/refresh` | Yes | Builds `latest_prices.json` in R2 and warms `PRICE_CACHE`. |
| 3 | `GET /api/prices/refresh-csfloat` | Optional | Adds `csfloat_prices.json` for more accurate high-value output pricing. |
| 4 | `GET /api/tradeups/profitable/refresh` | Yes | Computes the profitable contracts from the latest catalog and price snapshots. |

Notes:

- Step 4 must always be last.
- Step 3 is optional. If you skip it, the profitable scanner still works and falls back to interpolated prices from the main CS2Cap snapshot.
- The `/api/prices/refresh-csfloat` endpoint itself returns `503` if `CSFLOAT_API_KEY` is not configured, so omit that step entirely unless you set the key.

## Scheduling refreshes

This repo currently exposes **HTTP refresh endpoints** only. It does **not** ship a `scheduled()` handler or an in-repo cron orchestrator route, so the simplest supported scheduler is an external job that calls the endpoints in order.

### Protect the refresh endpoints

Set `CRON_SECRET` in Cloudflare (or `.dev.vars` locally) and send:

```http
Authorization: Bearer <CRON_SECRET>
```

### Recommended: external scheduler

GitHub Actions, cron-job.org, or another Worker can call the endpoints in order:

```bash
# 1. Refresh the catalog
curl -s "https://<your-domain>/api/catalog/refresh" \
  -H "Authorization: Bearer <CRON_SECRET>"

# 2. Refresh the main CS2Cap snapshot
curl -s "https://<your-domain>/api/prices/refresh" \
  -H "Authorization: Bearer <CRON_SECRET>"

# 3. Optional: refresh CSFloat prices
curl -s "https://<your-domain>/api/prices/refresh-csfloat" \
  -H "Authorization: Bearer <CRON_SECRET>"

# 4. Refresh the profitable-tradeup cache
curl -s "https://<your-domain>/api/tradeups/profitable/refresh" \
  -H "Authorization: Bearer <CRON_SECRET>"
```

If you want a pure-Cloudflare scheduler, add a separate scheduled handler or orchestrator Worker outside the current repo.

## Project Structure

```
app/
  page.tsx                        # Home page
  calculator/page.tsx             # Trade-up calculator UI
  inventory/page.tsx              # Inventory-based trade-up finder UI
  profitable/page.tsx             # Profitable trade-ups browser
  api/
    catalog/
      refresh/route.ts            # GET /api/catalog/refresh
    inventory/route.ts            # POST /api/inventory
    prices/route.ts               # GET /api/prices?skinId=&wear=
    prices/refresh/route.ts       # GET /api/prices/refresh
    prices/refresh-csfloat/
      route.ts                    # GET /api/prices/refresh-csfloat
    tradeups/evaluate/route.ts    # POST /api/tradeups/evaluate
    tradeups/profitable/
      route.ts                    # GET /api/tradeups/profitable
      refresh/route.ts            # GET /api/tradeups/profitable/refresh
lib/
  types.ts                        # Shared TypeScript types (Rarity, Wear, Skin, …)
  catalog.ts                      # Bundled static catalog fallback, regenerated by GitHub Actions
  catalog/
    dynamic.ts                    # KV cache → ByMykel API → static fallback
  storage.ts                      # Cloudflare KV/R2 helpers and env typing
  steam.ts                        # Steam inventory parsing and matching
  tradeup/
    pool.ts                       # Output pool + probability calculation
    float.ts                      # Float normalization & output float math
    ev.ts                         # EV / ROI evaluation engine
    scanner.ts                    # Candidate generation + profitable contract scanner
  pricing/
    index.ts                      # Price lookup helpers
    csfloat.ts                    # CSFloat API client
scripts/
  generate_catalog.py             # Regenerate lib/catalog.ts from ByMykel CSGO-API
  prices-snapshot.json            # Sample/offline snapshot data checked into the repo
```

## API

### `GET /api/prices?skinId=<id>&wear=<FN|MW|FT|WW|BS>`
Returns the current cached price for a skin.

### `GET /api/prices/refresh`
Fetches CS2Cap prices and writes `latest_prices.json` to R2, while warming `PRICE_CACHE`. Protected by the `Authorization` header when `CRON_SECRET` is set. Requires `CS2C_API_KEY`.

### `GET /api/prices/refresh-csfloat`
Fetches float-bucketed listing prices from CSFloat for classified, covert, and extraordinary skins and writes `csfloat_prices.json` to R2. Protected by the `Authorization` header when `CRON_SECRET` is set. Requires `CSFLOAT_API_KEY`; without that secret, this endpoint returns `503`.

### `POST /api/tradeups/evaluate`
```json
{ "inputs": [{ "skinId": "p2000-ivory", "float": 0.20 }, ...] }
```
Returns EV, ROI, output pool, and per-item probabilities.

### `GET /api/tradeups/profitable?rarity=mil_spec&maxBudget=50`
Returns profitable trade-up contracts sorted by ROI descending. Serves from `TRADEUP_CACHE` when available and computes on demand on a cold cache.

### `GET /api/tradeups/profitable/refresh`
Recomputes all profitable contracts and writes them to `TRADEUP_CACHE`. Intended to be called after the catalog and price refreshes.

### `GET /api/catalog/refresh`
Fetches the latest catalog from the ByMykel CSGO-API, stores it in `CATALOG_CACHE`, and returns `{ success, collectionsCount, skinsCount, cachedAt }`.

### `POST /api/inventory`
Accepts `{ "profileUrl": "..." }`, fetches the user's public Steam inventory, matches items against the catalog, and returns inventory-based trade-up recommendations.

> `lib/catalog/dynamic.ts` loads data in this order: `CATALOG_CACHE` KV → live ByMykel API refresh → bundled `lib/catalog.ts` fallback.
