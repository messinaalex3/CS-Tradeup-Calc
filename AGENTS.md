<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# CS2 Trade-up Calculator — Agent Guide

## Project Overview

A Next.js 16 app deployed to **Cloudflare Workers** via `@opennextjs/cloudflare`. Calculates expected value and ROI of CS2 trade-up contracts; surfaces the most profitable ones automatically.

See [README.md](README.md) for a full feature description and deep-dive into the scanner algorithm.

## Commands

| Task | Command |
|---|---|
| Dev server | `npm run dev` |
| Build for Cloudflare (preview) | `npm run preview` |
| Deploy to Cloudflare | `npm run deploy` |
| Lint | `npm run lint` |
| Fetch prices locally | `npm run fetch-prices` |
| Regenerate Cloudflare types | `npm run cf-typegen` |

> **No test suite exists yet.** Validate logic changes by running `npm run lint` and manually testing the affected route.

## Architecture

```
app/                     Next.js App Router pages and API routes
lib/
  catalog.ts             Static skin/collection data (the catalog)
  types.ts               Shared types: Rarity, Wear, Skin, Collection, TradeupInput, …
  storage.ts             Cloudflare KV/R2 helpers + CloudflareEnv interface
  steam.ts               Steam ID parsing + inventory matching utilities
  pricing/index.ts       Price lookup (KV → R2 fallback)
  tradeup/
    ev.ts                Core EV/ROI computation
    float.ts             Float ↔ wear conversion
    pool.ts              Output pool + probability calculation
    scanner.ts           Candidate generation + profitable contract scanning
```

### Cloudflare Bindings

Declared in `wrangler.jsonc` and typed in `lib/storage.ts` (`CloudflareEnv`):

| Binding | Type | Purpose |
|---|---|---|
| `PRICE_CACHE` | KV | Per-skin price points (high-frequency reads) |
| `TRADEUP_CACHE` | KV | Pre-computed profitable contracts (1 h TTL) |
| `PRICE_SNAPSHOTS` | R2 | Hourly Skinport price snapshots |

Always obtain `env` via `getCloudflareContext()` from `@opennextjs/cloudflare` in Route Handlers — **never** use `process.env` for bindings.

```ts
import { getCloudflareContext } from "@opennextjs/cloudflare";
const { env: rawEnv } = await getCloudflareContext();
const env = rawEnv as unknown as CloudflareEnv;
```

## Key Conventions

- **Prices come from Skinport** — refreshed hourly via `GET /api/prices/refresh` (cron-triggered). Skin names are matched using `"<name> (<wear label>)"` market hash names.
- **Trade-up cache** — `TRADEUP_CACHE` stores a `TradeupCachePayload` JSON under `tradeups:profitable`. On a cache miss the route computes live; the `/refresh` endpoint always recomputes and repopulates.
- **Catalog is static** — `lib/catalog.ts` is a hand-curated list of ~60 skins across 6 collections. Extend it to cover more trade-up opportunities.
- **ROI threshold** — `MIN_ROI = 1.0` (break-even). Adjust in `scanner.ts`.
- **`@/` alias** — resolves to the repo root; use `@/lib/…` for all lib imports.
- **Tailwind v4** — utility-first CSS; no `tailwind.config.js` (config is in `postcss.config.mjs`).

## Known Pitfalls

- **KV rate limits** — the profitable scanner does many incremental KV writes during a full refresh. Writes are throttled with exponential backoff + jitter; treat incremental cache writes as best-effort (see `lib/tradeup/scanner.ts`). See also `/memories/repo/kv-throttle-note.md`.
- **Cloudflare local dev** — `npm run dev` wraps `initOpenNextCloudflareForDev()` to emulate bindings locally. If KV/R2 look empty locally, run `wrangler kv:key list` to inspect or seed data.
- **Scanner candidates** — only two float values (`0.20`) and two strategies (10× same skin, 5+5 cross-collection) are tried. Float sweeps or 3-skin mixes require extending `generateCandidates` in `scanner.ts`.
- **`getBestPrice` vs `getCachedPriceBySide`** — `getBestPrice` is the high-level pricing function; `getCachedPriceBySide` is the low-level KV/R2 primitive. Prefer `getBestPrice` in new code unless you need a specific buy/sell side.
