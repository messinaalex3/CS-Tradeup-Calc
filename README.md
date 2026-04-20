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
