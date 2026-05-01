# CS2 Trade-up Calculator

A web application for looking up CS2 skin prices and finding the most profitable trade-up contracts.

![Home Page](https://github.com/user-attachments/assets/e687ec14-3a8f-4929-b991-2943214bc10a)

## Features

- **Price Lookup** — prices sourced from the Skinport API, refreshed hourly via a cron job; float-precise prices for high-value skins sourced from CSFloat
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
4. Looks up cached prices (sourced from Skinport) for each possible output
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

1. **Input cost** — look up the cached Skinport price for each input item (skin + wear tier derived from its float) and sum them to get `totalCost`.
2. **Output pool** — `lib/tradeup/pool.ts` identifies all items of the next rarity tier that belong to the same collections as the inputs, and assigns each a probability proportional to how many inputs came from its collection.
3. **Output float** — the output float is the same for every item in the pool and is computed as:
   ```
   normalizedAvg = average((inputFloat − skinMin) / (skinMax − skinMin))
   outputFloat   = outputMin + normalizedAvg × (outputMax − outputMin)
   ```
4. **Output prices** — for classified and covert outputs (and their knife/glove drops), the app first checks the CSFloat snapshot for a float-bucketed listing price; if unavailable it falls back to Skinport interpolation.
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
- Discards any contract with `ROI < 0` (the `MIN_ROI` threshold, currently `0`).
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
| **CSFloat availability** | CSFloat prices are fetched for classified/covert/extraordinary skins only, and only for the pre-defined float buckets. Skins not covered fall back to Skinport price interpolation. |
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

### Prerequisites

- [Node.js](https://nodejs.org/) (v20 or later)
- A Cloudflare account — run `npx wrangler login` once to authenticate

### Local Development

You have two options:

**Option A — Next.js dev server** (fast iteration, Cloudflare bindings available via `initOpenNextCloudflareForDev`)
```bash
npm install
npm run dev        # http://localhost:3000
```

**Option B — Full Workers preview** (same runtime as production)
```bash
npm install
npm run preview    # builds then serves at http://localhost:8787
```

> `npm run preview` runs `opennextjs-cloudflare build && opennextjs-cloudflare preview`. KV and R2 are simulated locally by Wrangler — no real Cloudflare resources are required for local development.

### Deployment to Cloudflare Workers

1.  **Create your Cloudflare resources** (one-time setup)
    ```bash
    # Create the KV namespace for price caching
    npx wrangler kv namespace create PRICE_CACHE

    # Create the KV namespace for profitable tradeup caching
    npx wrangler kv namespace create TRADEUP_CACHE

    # Create the R2 bucket for price snapshots
    npx wrangler r2 bucket create cs-tradeup-prices
    ```

2.  **Update `wrangler.jsonc` with the real KV namespace IDs**
    Each `kv namespace create` command prints an `id`. Replace the placeholders in `wrangler.jsonc`:
    ```jsonc
    "kv_namespaces": [
      { "binding": "PRICE_CACHE",    "id": "<paste-price-cache-id-here>" },
      { "binding": "TRADEUP_CACHE",  "id": "<paste-tradeup-cache-id-here>" }
    ]
    ```
    > **Important:** Deploying with placeholder IDs will cause the Worker to crash at runtime with a binding error.

3.  **Add secrets via Wrangler** (never put secrets in `wrangler.jsonc`)
    ```bash
    # Protects the /api/prices/refresh, /api/tradeups/profitable/refresh,
    # /api/prices/refresh-csfloat, and /api/catalog/refresh endpoints
    npx wrangler secret put CRON_SECRET

    # Optional: CSFloat API key for float-bucketed listing prices on high-value skins
    # Get your key at https://csfloat.com/developer
    npx wrangler secret put CSFLOAT_API_KEY
    ```
    > If `CSFLOAT_API_KEY` is not set, the app still works — all prices fall back to Skinport interpolation.

4.  **Deploy**
    ```bash
    npm run deploy   # runs opennextjs-cloudflare build then deploys to Cloudflare Workers
    ```

## Architecture & Storage Strategy

Prices are sourced from the **Skinport public items API** in a single bulk request and stored in Cloudflare's edge infrastructure:

- **Cloudflare R2 (Object Storage):** Stores a full JSON snapshot of all Skinport skin prices (`latest_prices.json`), updated hourly by the cron job. Also stores float-bucketed CSFloat prices for high-value skins (`csfloat_prices.json`), updated by the `/api/prices/refresh-csfloat` cron job.
- **Cloudflare KV — `PRICE_CACHE`:** Acts as a high-speed edge cache for individual skin prices. When a price is requested, the app checks KV first. On a miss it pulls the price from the R2 snapshot and back-populates KV with a 1-hour TTL.
- **Cloudflare KV — `TRADEUP_CACHE`:** Stores the pre-computed list of profitable trade-up contracts. Written by `/api/tradeups/profitable/refresh` (or auto-populated on the first cache miss) and read by `/api/tradeups/profitable`. Expires after 1 hour.
- **Edge Runtime:** All API routes run on the Cloudflare Edge, ensuring fast response times for cached data.

## Price Refresh — Cron Job Setup

Prices are refreshed by two endpoints that should be called in sequence each hour:

1. `GET /api/prices/refresh` — fetches all CS2 prices from Skinport and writes `latest_prices.json` to R2.
2. `GET /api/prices/refresh-csfloat` — fetches float-bucketed listing prices from CSFloat for classified, covert, and extraordinary (knife/glove) skins and writes `csfloat_prices.json` to R2. Requires `CSFLOAT_API_KEY`; skipped safely if the key is absent.

## Profitable Trade-ups Refresh — Cron Job Setup

Pre-computed profitable trade-up results are refreshed by calling `GET /api/tradeups/profitable/refresh`. This endpoint runs the full candidate scan with the latest prices and writes the result to `TRADEUP_CACHE` KV. It should be run after each price refresh so the displayed contracts always reflect current market prices.

### 1. Set a `CRON_SECRET` environment variable

All refresh endpoints are protected by the same secret. Set it once using Wrangler (see Deployment step 3 above) or in the Cloudflare dashboard:

**Dashboard:** Workers & Pages → your project → Settings → Variables and Secrets → add `CRON_SECRET` (and optionally `CSFLOAT_API_KEY`).

Then call either endpoint with:
```
Authorization: Bearer <your-secret>
```

### 2. Cloudflare Pages Cron Trigger (recommended)

Add a cron trigger in `wrangler.jsonc`:

```jsonc
{
  "triggers": {
    "crons": ["0 * * * *"]
  }
}
```

Then create `app/api/cron/route.ts` (or handle it in a Cloudflare scheduled worker) that calls both refresh endpoints in sequence:

```ts
await fetch('/api/prices/refresh', { headers: { Authorization: 'Bearer ...' } });
await fetch('/api/prices/refresh-csfloat', { headers: { Authorization: 'Bearer ...' } });
await fetch('/api/catalog/refresh', { headers: { Authorization: 'Bearer ...' } });
await fetch('/api/tradeups/profitable/refresh', { headers: { Authorization: 'Bearer ...' } });
```

Alternatively, configure the trigger directly in the Cloudflare dashboard under **Workers & Pages → your project → Triggers → Cron Triggers**, and add `0 * * * *` (every hour on the hour).

### 3. External cron service (alternative)

If you prefer not to use Cloudflare cron triggers, any external scheduler (GitHub Actions, cron-job.org, etc.) can call the endpoints:

```bash
# GitHub Actions example (.github/workflows/refresh-prices.yml)
on:
  schedule:
    - cron: '0 * * * *'
jobs:
  refresh:
    runs-on: ubuntu-latest
    steps:
      - run: |
          curl -s -X GET "https://<your-domain>/api/prices/refresh" \
            -H "Authorization: Bearer ${{ secrets.CRON_SECRET }}"
          curl -s -X GET "https://<your-domain>/api/prices/refresh-csfloat" \
            -H "Authorization: Bearer ${{ secrets.CRON_SECRET }}"
          curl -s -X GET "https://<your-domain>/api/catalog/refresh" \
            -H "Authorization: Bearer ${{ secrets.CRON_SECRET }}"
          curl -s -X GET "https://<your-domain>/api/tradeups/profitable/refresh" \
            -H "Authorization: Bearer ${{ secrets.CRON_SECRET }}"
```

## Project Structure

```
app/
  page.tsx                        # Home page
  calculator/page.tsx             # Trade-up calculator UI
  profitable/page.tsx             # Profitable trade-ups browser
  api/
    catalog/
      refresh/route.ts            # GET /api/catalog/refresh  (cron target)
    prices/route.ts               # GET /api/prices?skinId=&wear=
    prices/refresh/route.ts       # GET /api/prices/refresh  (cron target, Skinport)
    prices/refresh-csfloat/
      route.ts                    # GET /api/prices/refresh-csfloat  (cron target, CSFloat)
    tradeups/evaluate/route.ts    # POST /api/tradeups/evaluate
    tradeups/profitable/
      route.ts                    # GET /api/tradeups/profitable  (cache-first)
      refresh/route.ts            # GET /api/tradeups/profitable/refresh  (cron target)
lib/
  types.ts                        # Shared TypeScript types (Rarity, Wear, Skin, …)
  catalog.ts                      # Static CS2 skin catalog (~1 400 skins, 92 collections) — auto-updated weekly by GitHub Actions
  catalog/
    dynamic.ts                    # Dynamic catalog loader: KV cache → ByMykel API → static fallback
  storage.ts                      # Cloudflare KV/R2 helpers (prices, tradeup cache, catalog cache)
  tradeup/
    pool.ts                       # Output pool + probability calculation
    float.ts                      # Float normalization & output float math
    ev.ts                         # EV / ROI evaluation engine
    scanner.ts                    # Candidate generation + profitable contract scanner
  pricing/
    index.ts                      # Cache-only price lookup (reads from KV/R2, prefers CSFloat for high-value skins)
    csfloat.ts                    # CSFloat API client — float-bucketed listing prices
scripts/
  generate_catalog.py             # Regenerate lib/catalog.ts from ByMykel CSGO-API
```

## API

### `GET /api/prices?skinId=<id>&wear=<FN|MW|FT|WW|BS>`
Returns the current Skinport price for a skin.

### `GET /api/prices/refresh`
Fetches all CS2 prices from Skinport and writes `latest_prices.json` to R2/KV. Protected by `Authorization: Bearer <CRON_SECRET>`.

### `GET /api/prices/refresh-csfloat`
Fetches float-bucketed listing prices from CSFloat for classified, covert, and extraordinary (knife/glove) skins and writes `csfloat_prices.json` to R2. Requires `CSFLOAT_API_KEY` and `CRON_SECRET`. Rate-limited at ~1 req/s; may take several minutes on a large catalog.

### `POST /api/tradeups/evaluate`
```json
{ "inputs": [{ "skinId": "p2000-ivory", "float": 0.20 }, ...] }
```
Returns EV, ROI, output pool, and per-item probabilities.

### `GET /api/tradeups/profitable?rarity=mil_spec&maxBudget=50`
Returns profitable trade-up contracts sorted by ROI descending. Serves from `TRADEUP_CACHE` KV if available (response includes `fromCache: true` and `cachedAt`); falls back to on-demand computation on a cold cache.

### `GET /api/tradeups/profitable/refresh`
Recomputes all profitable contracts and writes them to `TRADEUP_CACHE` KV. Protected by `Authorization: Bearer <CRON_SECRET>` when `CRON_SECRET` is set. Intended to be called on a cron schedule after each price refresh.

### `GET /api/catalog/refresh`
Fetches the latest skin catalog from the ByMykel CSGO-API, processes it, and stores it in the `CATALOG_CACHE` KV namespace (24-hour TTL). Protected by `Authorization: Bearer <CRON_SECRET>` when `CRON_SECRET` is set. Returns `{ success, collectionsCount, skinsCount, cachedAt }`. After this endpoint is called, all subsequent requests to `/api/tradeups/evaluate`, `/api/tradeups/profitable/refresh`, and `/api/inventory` will use the freshly-cached catalog data instead of the bundled static file.

> **No static catalog required** — the `lib/catalog/dynamic.ts` loader tries the KV cache first, then falls back to a live ByMykel API fetch, then falls back to the bundled `lib/catalog.ts` as a last resort. The static catalog file is regenerated weekly by the `Update Catalog` GitHub Actions workflow.
