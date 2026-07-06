<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# CS2 Trade-up Calculator — Agent Guide

## Project Overview

A Next.js 16 app deployed to **Cloudflare Workers** via `@opennextjs/cloudflare`. It calculates expected value and ROI of CS2 trade-up contracts and surfaces the most profitable ones automatically.

See [README.md](README.md) for the user-facing setup, deployment, and storage details.

## Commands

| Task | Command |
|---|---|
| Install dependencies | `npm install` |
| Dev server | `npm run dev` |
| Production build | `npm run build` |
| Full Workers preview | `npm run preview` |
| Deploy to Cloudflare | `npm run deploy` |
| Lint | `npm run lint` |
| Regenerate Cloudflare types | `npm run cf-typegen` |

> **No automated test suite exists yet.** Validate changes with `npm run lint`, `npm run build`, and manual route/UI checks for the area you touched.

## Architecture

```
app/                     Next.js App Router pages and API routes
  api/
    catalog/refresh      Refreshes the dynamic catalog cache
    inventory            Steam inventory to trade-up recommendations
    prices               Single cached price lookup
    prices/refresh       CS2Cap snapshot refresh
    prices/refresh-csfloat
                         Optional CSFloat snapshot refresh
    tradeups/evaluate    Ad-hoc EV / ROI evaluation
    tradeups/profitable  Cache-first profitable-contract listing + refresh
lib/
  catalog.ts             Bundled static catalog fallback
  catalog/dynamic.ts     KV cache → ByMykel API → static fallback
  pricing/index.ts       Price lookup helpers (KV/R2, CSFloat-aware)
  pricing/csfloat.ts     CSFloat API client and bucket helpers
  steam.ts               Steam ID parsing + inventory matching utilities
  storage.ts             Cloudflare bindings/types + KV/R2 helpers
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
| `PRICE_CACHE` | KV | Per-skin price cache for high-frequency reads |
| `TRADEUP_CACHE` | KV | Cached profitable-contract payload |
| `CATALOG_CACHE` | KV | Cached dynamic catalog snapshot |
| `PRICE_SNAPSHOTS` | R2 | Stores `latest_prices.json` and `csfloat_prices.json` |
| `WORKER_SELF_REFERENCE` | Service binding | OpenNext self-reference binding for Worker integration |
| `ASSETS` | Assets binding | Serves built static assets |
| `IMAGES` | Images binding | Enables Next.js image optimization |

Always obtain **bindings** via `getCloudflareContext()` from `@opennextjs/cloudflare` in Route Handlers. The refresh routes currently read `CRON_SECRET` from `process.env`, but KV/R2 bindings and Worker vars like `CS2C_API_KEY` / `CSFLOAT_API_KEY` come from the Cloudflare env object.

```ts
import { getCloudflareContext } from "@opennextjs/cloudflare";
const { env: rawEnv } = await getCloudflareContext();
const env = rawEnv as unknown as CloudflareEnv;
```

## Key Conventions

- **Prices come from CS2Cap** — refreshed via `GET /api/prices/refresh`. The provider defaults to `skinport` and the route needs `CS2C_API_KEY`.
- **CSFloat pricing is optional** — `GET /api/prices/refresh-csfloat` improves float-sensitive output pricing for classified, covert, and extraordinary skins when `CSFLOAT_API_KEY` is set.
- **Catalog loading is dynamic** — `lib/catalog/dynamic.ts` tries `CATALOG_CACHE` first, then the ByMykel API, then falls back to bundled `lib/catalog.ts`.
- **Trade-up cache** — `TRADEUP_CACHE` stores a payload under `tradeups:profitable`. The read route serves from KV when possible; the refresh route recomputes and repopulates it.
- **ROI is stored as a multiplier** — `1.0` is break-even, `1.05` is 5% gross profit.
- **`MIN_ROI = 1.0`** in `lib/tradeup/scanner.ts`, so the scanner keeps contracts at or above break-even.
- **`@/` alias** — resolves to the repo root; use `@/lib/...` imports in app code.
- **Tailwind v4** — utility-first CSS; there is no `tailwind.config.js`.

## Operational Notes

- **Local data seeding** — there is no standalone seed script. Seed local KV/R2 by running the app and calling `/api/catalog/refresh`, `/api/prices/refresh`, optional `/api/prices/refresh-csfloat`, then `/api/tradeups/profitable/refresh`.
- **Current production storage footprint** — the app actively uses 3 KV namespaces and 1 R2 bucket. `CSFLOAT_API_KEY` is optional; the storage bindings are not optional without code changes.
- **Scheduler reality** — the repo exposes HTTP refresh endpoints only. It does not include a `scheduled()` handler or in-repo cron orchestrator.

## Known Pitfalls

- **KV rate limits** — full refreshes can write many KV keys. Treat cache warming as best-effort and expect throttling safeguards in the scanner/storage layers.
- **Cloudflare local dev** — `npm run dev` calls `initOpenNextCloudflareForDev()` so KV/R2 bindings exist locally, but they start empty until you seed them.
- **CSFloat endpoint behavior** — if `CSFLOAT_API_KEY` is missing, `/api/prices/refresh-csfloat` returns `503`; skip that step entirely rather than expecting a no-op.
- **Scanner candidates are intentionally limited** — the current generator tries a constrained set of candidate mixes rather than exhaustive combinations.
