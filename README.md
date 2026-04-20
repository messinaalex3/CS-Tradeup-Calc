# CS2 Trade-up Calculator

A web application for looking up CS2 skin prices and finding the most profitable trade-up contracts.

![Home Page](https://github.com/user-attachments/assets/e687ec14-3a8f-4929-b991-2943214bc10a)

## Features

- **Live Price Lookup** — fetches current lowest listing prices from the Steam Community Market
- **Trade-up Calculator** — select 10 same-rarity items, set float values, and compute EV/ROI
- **Profitable Trade-ups** — automatically scans the catalog and surfaces the highest-ROI contracts

## How it works

CS2 trade-up contracts let you exchange 10 items of the same rarity for one item of the next rarity tier. The output item is drawn from the same collections as the inputs, weighted by how many inputs came from each collection.

The calculator:
1. Validates inputs (exactly 10 items, same rarity, valid float values)
2. Determines the output pool and each item's probability
3. Computes the output float using CS2's formula: `outputFloat = outputMin + avg(normalizedInputFloats) × (outputMax − outputMin)`
4. Fetches live prices from Steam Market for each possible output
5. Calculates **EV** (Σ probability × price) and **ROI** ((EV − cost) / cost × 100%)

## Profitable Trade-ups — Deep Dive

The **Browse Profitable Trade-ups** page (`/profitable`) is the main selling point of this tool. It automatically discovers trade-up contracts with positive expected ROI without any manual input from the user.

### How the scanner works

The scanner lives in `app/api/tradeups/profitable/route.ts` and runs entirely on-demand when the page is loaded (or when the user clicks **Scan Now**). It works in three stages:

#### 1. Candidate generation (`generateCandidates`)

For each scannable rarity tier (`industrial_grade`, `mil_spec`, `restricted`, `classified`), the scanner generates a list of candidate contracts using two complementary strategies:

**Strategy A — 10× same item**
For every skin of the given rarity in the catalog, create a contract that uses 10 copies of that skin at float `0.20` (or the nearest valid float for skins with a restricted range). This produces one candidate per skin and is the simplest possible trade-up structure.

**Strategy B — 5+5 cross-collection mix**
For every *pair* of collections that contain skins of the given rarity, create a contract using 5 copies from one collection and 5 copies from the other, both at float `0.20`. Mixing collections changes which output items are in the pool and their relative probabilities, which can unlock more profitable outputs that a single-collection contract would miss.

#### 2. Evaluation (`evaluateTradeup`)

Each candidate contract is evaluated by `lib/tradeup/ev.ts`:

1. **Input cost** — fetch the live Steam Market price for each input item (skin + wear tier derived from its float) and sum them to get `totalCost`.
2. **Output pool** — `lib/tradeup/pool.ts` identifies all items of the next rarity tier that belong to the same collections as the inputs, and assigns each a probability proportional to how many inputs came from its collection.
3. **Output float** — the output float is the same for every item in the pool and is computed as:
   ```
   normalizedAvg = average((inputFloat − skinMin) / (skinMax − skinMin))
   outputFloat   = outputMin + normalizedAvg × (outputMax − outputMin)
   ```
4. **Output prices** — the Steam Market price is fetched for each output item at its predicted wear tier.
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
| **Small catalog** | The built-in catalog covers 6 collections and ~60 skins. Opportunities outside these collections are not visible. |
| **Simple candidate strategies** | Only two float values are tried (0.20 for both strategies). A contract at float 0.05 might have a completely different ROI. |
| **Single-skin inputs only** | Strategy A always uses 10 copies of the *same* skin. Contracts built from 3 or more distinct skins are not generated. |
| **No price caching** | Every scan hits the Steam Market API in real time. With many candidates this is slow and may be throttled. |
| **On-demand scanning** | Results are computed fresh on every page load. There is no background refresh or persistent storage of discovered contracts. |

### Ideas for improvement

- **Broader candidate generation** — sweep over multiple float values (e.g. 0.05, 0.15, 0.20, 0.35) and all permutations of 2–4 distinct skins from the same rarity tier to find contracts the current strategies miss.
- **Exhaustive mixed-input contracts** — enumerate all combinations of *k* distinct skins (k = 2…5) rather than only pairs, giving a much richer search space.
- **Expand the catalog** — import the full CS2 skin catalog (hundreds of collections) to surface a wider range of opportunities.
- **Price caching** — cache Steam Market responses in a key-value store (e.g. Cloudflare KV) with a short TTL (5–15 minutes) so repeated scans and large candidate sets don't hit rate limits.
- **Background / scheduled scanning** — run the scanner on a cron schedule (e.g. every 30 minutes) and persist results to a database. The UI then reads pre-computed results instead of evaluating on every request, making the page nearly instant to load.
- **Multiple price sources** — incorporate third-party marketplace prices (e.g. Buff163, Skinport) to find arbitrage opportunities where buying inputs on one platform and receiving outputs on another is profitable.
- **StatTrak support** — StatTrak trade-ups have separate price curves; modelling them can reveal additional profitable contracts.
- **Adjustable ROI threshold** — expose the `MIN_ROI` constant as a UI slider so users can filter for only high-confidence contracts.

## Getting Started

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Project Structure

```
app/
  page.tsx                        # Home page
  calculator/page.tsx             # Trade-up calculator UI
  profitable/page.tsx             # Profitable trade-ups browser
  api/
    prices/route.ts               # GET /api/prices?skinId=&wear=
    tradeups/evaluate/route.ts    # POST /api/tradeups/evaluate
    tradeups/profitable/route.ts  # GET /api/tradeups/profitable
lib/
  types.ts                        # Shared TypeScript types
  catalog.ts                      # CS2 skin catalog (6 collections, 60 skins)
  tradeup/
    pool.ts                       # Output pool + probability calculation
    float.ts                      # Float normalization & output float math
    ev.ts                         # EV / ROI evaluation engine
  pricing/
    steam.ts                      # Steam Community Market price fetcher
```

## API

### `GET /api/prices?skinId=<id>&wear=<FN|MW|FT|WW|BS>`
Returns the current Steam Market price for a skin.

### `POST /api/tradeups/evaluate`
```json
{ "inputs": [{ "skinId": "p2000-ivory", "float": 0.20 }, ...] }
```
Returns EV, ROI, output pool, and per-item probabilities.

### `GET /api/tradeups/profitable?rarity=mil_spec&maxBudget=50`
Scans the catalog and returns trade-up contracts with positive ROI, sorted by ROI descending.
