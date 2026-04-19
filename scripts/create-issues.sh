#!/usr/bin/env bash
# Creates all GitHub issues from BACKLOG.md for the CS2 Trade-up Profiler project.
# Run this script with a GitHub token that has `issues:write` permission:
#   GH_TOKEN=<your-token> bash scripts/create-issues.sh
# Or trigger the included GitHub Actions workflow.

set -euo pipefail

REPO="${GITHUB_REPOSITORY:-messinaalex3/CS-Tradeup-Calc}"

create_issue() {
  local title="$1"
  local body="$2"
  local labels="${3:-}"

  # Skip if an issue with this exact title already exists (prevents duplicates on re-run)
  local existing
  existing=$(gh issue list \
    --repo "$REPO" \
    --state all \
    --limit 200 \
    --json title \
    --jq '.[].title' 2>/dev/null || true)
  if printf '%s\n' "$existing" | grep -qxF "$title"; then
    echo "Skipping (already exists): $title"
    return 0
  fi

  echo "Creating: $title"
  if [[ -n "$labels" ]]; then
    gh issue create \
      --repo "$REPO" \
      --title "$title" \
      --body "$body" \
      --label "$labels" 2>/dev/null || \
    gh issue create \
      --repo "$REPO" \
      --title "$title" \
      --body "$body"
  else
    gh issue create \
      --repo "$REPO" \
      --title "$title" \
      --body "$body"
  fi
}

# ─────────────────────────────────────────────
# Epic 1 — Cloudflare Backend Setup
# ─────────────────────────────────────────────

create_issue \
  "Epic 1 | Initialize Cloudflare Pages project with Functions" \
  "## Overview
Set up the root Cloudflare Pages project with support for Pages Functions (server-side API routes powered by Cloudflare Workers).

## Context
This is the **foundation** of the entire backend. All other backend issues depend on this being completed first.
The project uses Cloudflare Pages + Pages Functions (not standalone Workers) so that the frontend and backend share a single deployment.

## Tasks
- [ ] Create a new Cloudflare Pages project (via dashboard or Wrangler CLI)
- [ ] Initialize the \`functions/\` directory following Pages Functions conventions
  - Routes map to \`functions/api/<route>.ts\` (or \`.js\`)
- [ ] Add \`wrangler.toml\` (or \`wrangler.jsonc\`) with project config
- [ ] Verify \`wrangler pages dev\` spins up a local dev server
- [ ] Add a minimal \`functions/api/ping.ts\` handler returning \`{ pong: true }\` to validate routing
- [ ] Confirm deployment pipeline works (push to \`main\` → Cloudflare Pages deployment succeeds)
- [ ] Document setup steps in \`README.md\` under a **Setup** section

## Acceptance Criteria
- Cloudflare Pages project created and linked to this repo
- \`functions/\` directory scaffolded with at least one example route
- \`wrangler pages dev\` starts without errors
- Deployment to Cloudflare Pages verified end-to-end

## Notes
- Use **TypeScript** for all Functions (consistent with the frontend)
- Cloudflare Pages Functions docs: https://developers.cloudflare.com/pages/functions/
- Wrangler CLI docs: https://developers.cloudflare.com/workers/wrangler/" \
  "epic-1,backend,setup"

create_issue \
  "Epic 1 | Configure D1 database and schema migrations" \
  "## Overview
Create the Cloudflare D1 SQLite database, write the initial schema, and set up a migration runner.

## Context
D1 is Cloudflare's serverless SQLite offering. It is used to persist catalog items, collections, prices, and profitable trade-up results.
All other services (Catalog, Pricing, Trade-up Engine, Scanner) write to and read from this database.

## Tasks
- [ ] Create a D1 database via \`wrangler d1 create cs2-tradeup-db\`
- [ ] Add D1 binding to \`wrangler.toml\`:
  \`\`\`toml
  [[d1_databases]]
  binding = \"DB\"
  database_name = \"cs2-tradeup-db\"
  database_id = \"<id-from-creation>\"
  \`\`\`
- [ ] Create \`db/schema.sql\` with initial tables (items, collections, prices, tradeup_results)
- [ ] Create \`db/migrate.sh\` (or integrate \`wrangler d1 execute\`) for running migrations
- [ ] Apply schema locally: \`wrangler d1 execute cs2-tradeup-db --local --file db/schema.sql\`
- [ ] Apply schema to production: \`wrangler d1 execute cs2-tradeup-db --file db/schema.sql\`
- [ ] Write a simple test query to validate the connection in a Pages Function

## Acceptance Criteria
- D1 database exists in Cloudflare account
- \`db/schema.sql\` covers all core entities
- Migration can be re-run idempotently
- Local and production bindings both work

## Schema Hints
\`\`\`sql
CREATE TABLE IF NOT EXISTS collections (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT
);

CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  collection_id TEXT REFERENCES collections(id),
  rarity TEXT NOT NULL,         -- 'consumer', 'industrial', 'mil-spec', 'restricted', 'classified', 'covert'
  stattrak INTEGER DEFAULT 0,   -- 0 = false, 1 = true
  min_float REAL NOT NULL,
  max_float REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS prices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT REFERENCES items(id),
  source TEXT NOT NULL,         -- 'steam', 'buff163', etc.
  price_usd REAL NOT NULL,
  price_fee_adjusted REAL,
  fetched_at TEXT NOT NULL      -- ISO 8601
);

CREATE TABLE IF NOT EXISTS tradeup_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  input_items TEXT NOT NULL,    -- JSON array of item IDs
  output_items TEXT NOT NULL,   -- JSON array of {item_id, probability}
  ev REAL,
  roi REAL,
  cost REAL,
  evaluated_at TEXT NOT NULL
);
\`\`\`" \
  "epic-1,backend,database"

create_issue \
  "Epic 1 | Configure Cloudflare KV namespaces for caching" \
  "## Overview
Create Cloudflare KV namespaces to cache price lookups and trade-up evaluation results, reducing D1 query load and improving response latency.

## Context
KV is Cloudflare's globally-distributed key-value store. It is used as an **L1 cache** in front of D1.
Hot data (current prices, recently evaluated trade-ups) is served from KV to avoid expensive D1 reads on every request.

## Tasks
- [ ] Create two KV namespaces:
  - \`PRICE_CACHE\` — stores latest prices per item (TTL: 5–15 minutes)
  - \`TRADEUP_CACHE\` — stores evaluated trade-up results (TTL: 1 hour)
- [ ] Add bindings to \`wrangler.toml\`:
  \`\`\`toml
  [[kv_namespaces]]
  binding = \"PRICE_CACHE\"
  id = \"<id>\"

  [[kv_namespaces]]
  binding = \"TRADEUP_CACHE\"
  id = \"<id>\"
  \`\`\`
- [ ] Create \`src/lib/kv.ts\` with typed read/write helpers:
  - \`getCache(ns: KVNamespace, key: string)\`
  - \`setCache(ns: KVNamespace, key: string, value: unknown, ttlSeconds: number)\`
- [ ] Write a smoke test verifying a round-trip read/write

## Acceptance Criteria
- Both KV namespaces created in Cloudflare dashboard
- Bindings configured in \`wrangler.toml\`
- Read/write helpers available and tested

## Notes
- Cloudflare KV docs: https://developers.cloudflare.com/kv/
- Use \`expirationTtl\` option when writing to automatically expire stale cache entries" \
  "epic-1,backend,caching"

create_issue \
  "Epic 1 | Add /api/health check endpoint" \
  "## Overview
Implement a \`/api/health\` endpoint that returns a simple JSON response confirming the API is running.

## Context
Used for uptime monitoring, load-balancer health checks, and verifying deployments succeeded.

## Implementation
Create \`functions/api/health.ts\`:
\`\`\`typescript
import type { PagesFunction } from '@cloudflare/workers-types';

export const onRequestGet: PagesFunction = async () => {
  return Response.json({ status: 'ok', timestamp: new Date().toISOString() });
};
\`\`\`

## Acceptance Criteria
- \`GET /api/health\` returns \`200 { status: \"ok\" }\`
- Works in local dev (\`wrangler pages dev\`) and production
- Response includes a \`timestamp\` field for freshness verification" \
  "epic-1,backend"

# ─────────────────────────────────────────────
# Epic 2 — Catalog Service
# ─────────────────────────────────────────────

create_issue \
  "Epic 2 | Create D1 tables for items and collections" \
  "## Overview
Implement and migrate the database schema for \`items\` and \`collections\` tables, including all indexes needed for efficient catalog queries.

## Context
The catalog is the core data model. Every other service (pricing, trade-up engine) references items by their ID.
This issue expands on the schema seeds from the D1 migration issue.

## Tasks
- [ ] Add full column set to \`collections\` table:
  - \`id\`, \`name\`, \`description\`, \`created_at\`
- [ ] Add full column set to \`items\` table:
  - \`id\` (e.g. \`AK-47 | Redline\`), \`name\`, \`collection_id\` (FK), \`rarity\`, \`stattrak\` (boolean), \`min_float\`, \`max_float\`
- [ ] Add indexes:
  - \`items(collection_id)\` — for joining
  - \`items(rarity)\` — for filtering
  - \`items(name)\` — for search (LIKE queries)
- [ ] Write and apply migration
- [ ] Verify query: \`SELECT * FROM items WHERE rarity = 'classified' LIMIT 10\` returns results after seeding

## Acceptance Criteria
- Tables exist in D1 with all columns
- Indexes created
- Migration idempotent (\`IF NOT EXISTS\`)
- Test query runs successfully" \
  "epic-2,backend,database"

create_issue \
  "Epic 2 | Implement Catalog repository utilities" \
  "## Overview
Create a typed repository layer in \`src/lib/catalog.ts\` for querying items and collections from D1.

## Context
All API endpoints and the trade-up engine use these utilities to fetch catalog data. Centralizing queries here keeps D1-specific SQL out of route handlers.

## Functions to Implement
\`\`\`typescript
// src/lib/catalog.ts

export async function getItem(db: D1Database, id: string): Promise<Item | null>
export async function listItems(db: D1Database, filters?: ItemFilters): Promise<Item[]>
export async function getCollection(db: D1Database, id: string): Promise<Collection | null>
export async function listCollections(db: D1Database): Promise<Collection[]>
export async function getItemsByCollection(db: D1Database, collectionId: string, page?: number, pageSize?: number): Promise<Item[]>

interface ItemFilters {
  rarity?: string;
  collectionId?: string;
  search?: string;        // matches name via LIKE
  stattrak?: boolean;
  page?: number;
  pageSize?: number;
}
\`\`\`

## Tasks
- [ ] Create \`src/lib/catalog.ts\` with all five functions above
- [ ] Use parameterized queries (never string interpolation)
- [ ] Return \`null\` for not-found single items, never throw
- [ ] Implement pagination via \`LIMIT\` / \`OFFSET\`
- [ ] Add TypeScript types for \`Item\` and \`Collection\` in \`src/types.ts\`

## Acceptance Criteria
- All five functions implemented with proper TypeScript types
- Error handling: DB errors logged and re-thrown as typed errors
- Parameterized queries only (no SQL injection vectors)" \
  "epic-2,backend,catalog"

create_issue \
  "Epic 2 | Implement /api/items and /api/items/:id endpoints" \
  "## Overview
Expose the item catalog via two REST endpoints.

## Endpoints

### GET /api/items
Returns a paginated, filtered list of items.

**Query params:**
- \`rarity\` — filter by rarity tier (consumer, industrial, mil-spec, restricted, classified, covert)
- \`collection\` — filter by collection ID
- \`search\` — substring match on item name
- \`page\` (default 1), \`pageSize\` (default 20, max 100)
- \`stattrak\` — \`true\`/\`false\`

**Response:**
\`\`\`json
{
  \"items\": [...],
  \"page\": 1,
  \"pageSize\": 20,
  \"total\": 342
}
\`\`\`

### GET /api/items/:id
Returns a single item by ID.

**Response:** item object or \`404 { error: \"Item not found\" }\`

## Tasks
- [ ] Create \`functions/api/items.ts\` (list)
- [ ] Create \`functions/api/items/[id].ts\` (single item)
- [ ] Parse and validate query params
- [ ] Use catalog repository utilities from \`src/lib/catalog.ts\`
- [ ] Return proper HTTP status codes (200, 400, 404)

## Acceptance Criteria
- \`GET /api/items?rarity=classified\` returns filtered results
- \`GET /api/items/AK-47-Redline\` returns item or 404
- Invalid \`pageSize\` > 100 returns 400
- All responses are \`application/json\`" \
  "epic-2,backend,catalog"

create_issue \
  "Epic 2 | Implement /api/collections and /api/collections/:id/items endpoints" \
  "## Overview
Expose the collections catalog and the items within each collection.

## Endpoints

### GET /api/collections
Returns all collections.

**Response:**
\`\`\`json
{ \"collections\": [ { \"id\": \"...\", \"name\": \"...\", \"description\": \"...\" } ] }
\`\`\`

### GET /api/collections/:id/items
Returns paginated items in a collection.

**Query params:** \`page\`, \`pageSize\`

**Response:**
\`\`\`json
{ \"collection\": {...}, \"items\": [...], \"page\": 1, \"pageSize\": 20, \"total\": 15 }
\`\`\`

## Tasks
- [ ] Create \`functions/api/collections.ts\`
- [ ] Create \`functions/api/collections/[id]/items.ts\`
- [ ] Return 404 if collection not found
- [ ] Paginate items response

## Acceptance Criteria
- Collections endpoint returns all collections
- Items endpoint paginates correctly
- Missing collection returns 404" \
  "epic-2,backend,catalog"

create_issue \
  "Epic 2 | Seed initial CS2 catalog data into D1" \
  "## Overview
Write a seeding script that populates D1 with real CS2 collection and item data including rarities and float ranges.

## Context
The trade-up engine needs accurate float range data (\`min_float\`, \`max_float\`) for every item to correctly compute output floats.
Rarity tiers must be correct because trade-ups only work within items of the same rarity (upgrading from one tier up).

## Tasks
- [ ] Create \`scripts/seed-catalog.ts\` (run via \`tsx\` or \`ts-node\`)
- [ ] Include at least **3–5 complete collections** with all items, rarities, and float ranges
  - Suggested: The Clutch Collection, Spectrum Collection, Danger Zone Collection
- [ ] Each item must have: \`id\`, \`name\`, \`collection_id\`, \`rarity\`, \`stattrak\` eligibility, \`min_float\`, \`max_float\`
- [ ] Script should be idempotent (upsert, not plain insert)
- [ ] Run locally: \`wrangler d1 execute ... --local\`
- [ ] Run in CI (add to GitHub Actions workflow)

## Data Source
Float ranges and rarity data can be sourced from:
- https://csgostash.com
- https://cs.money
- Community-maintained JSON datasets

## Acceptance Criteria
- Script runs without errors locally and in CI
- At least 3 collections × ~10 items each seeded correctly
- Items linked to correct \`collection_id\`
- No duplicate inserts on re-run" \
  "epic-2,backend,data"

# ─────────────────────────────────────────────
# Epic 3 — Pricing Service
# ─────────────────────────────────────────────

create_issue \
  "Epic 3 | Implement Steam Community Market price fetcher" \
  "## Overview
Create a Cloudflare Worker function that fetches current prices from the Steam Community Market public API.

## Context
Steam is the primary source for CS2 item prices. The endpoint is public (no API key needed) but rate-limited.
Prices from Steam include a ~15% market fee baked in.

## Steam API Endpoint
\`\`\`
GET https://steamcommunity.com/market/priceoverview/?currency=1&appid=730&market_hash_name=<encoded-name>
\`\`\`
Response:
\`\`\`json
{ \"success\": true, \"lowest_price\": \"\$12.34\", \"volume\": \"142\", \"median_price\": \"\$12.10\" }
\`\`\`

## Tasks
- [ ] Create \`src/lib/pricers/steam.ts\`
- [ ] Implement \`fetchSteamPrice(itemName: string): Promise<RawPrice>\`
  - Strip the \`$\` prefix and parse to float
  - Map currency=1 → USD
  - Handle \`success: false\` responses
- [ ] Implement retry logic with exponential backoff (Steam rate-limits at ~1 req/sec)
- [ ] Add \`USER_AGENT\` header to avoid 403s
- [ ] Handle network errors gracefully (return \`null\` on failure, don't throw)

## Types
\`\`\`typescript
interface RawPrice {
  source: 'steam';
  itemName: string;
  lowestPrice: number;   // in USD cents or float dollars – pick one and document it
  medianPrice?: number;
  fetchedAt: string;     // ISO 8601
}
\`\`\`

## Acceptance Criteria
- \`fetchSteamPrice('AK-47 | Redline (Field-Tested)')\` returns a valid price
- Rate limit errors are caught and retried
- Returns \`null\` on permanent failure (item not listed, API down)" \
  "epic-3,backend,pricing"

create_issue \
  "Epic 3 | Implement third-party marketplace price fetcher (Buff163 or CSFloat)" \
  "## Overview
Add support for fetching prices from a second marketplace to enable cross-market arbitrage detection.

## Suggested Sources
- **Buff163** (\`buff.163.com\`) — China's largest CS2 market, often 20–40% cheaper than Steam
- **CSFloat** (\`csfloat.com\`) — Western market, provides float-specific listings
- **SteamAnalyst** — price aggregator with free tier

## Tasks
- [ ] Pick one source and implement \`src/lib/pricers/<source>.ts\`
- [ ] Implement \`fetch<Source>Price(itemName: string): Promise<RawPrice | null>\`
- [ ] Normalize to USD (Buff163 uses CNY — use a static or fetched exchange rate)
- [ ] Log fetch errors to \`console.error\` and return \`null\` on failure
- [ ] Add the \`source\` identifier (e.g. \`'buff163'\`) to the returned \`RawPrice\`

## Acceptance Criteria
- Fetcher returns a price for a known item
- Price is normalized to USD
- Errors are handled gracefully and don't crash the Worker" \
  "epic-3,backend,pricing"

create_issue \
  "Epic 3 | Implement price normalization utilities" \
  "## Overview
Create \`src/lib/pricing/normalize.ts\` with utilities to normalize prices from different sources into a consistent shape.

## Context
Steam prices include ~15% seller fee baked in. Buff163 prices are in CNY. Fee structures differ per market.
The trade-up engine needs a **single comparable price per item** — use the post-fee buyer price.

## Functions to Implement
\`\`\`typescript
// Remove market fees to get seller's net price
export function removeFee(price: number, source: PriceSource): number

// Convert any currency to USD
export function toUSD(price: number, currency: Currency): number

// Normalize a RawPrice into a StoredPrice
export function normalizePrice(raw: RawPrice): StoredPrice

interface StoredPrice {
  itemId: string;
  source: PriceSource;
  priceUsd: number;           // buyer pays this (with fee)
  priceFeeAdjusted: number;   // seller receives this (minus fee)
  fetchedAt: string;
}
\`\`\`

## Fee Reference
- Steam: buyer pays +10% (listed price includes it); seller receives listed - 15%
- Buff163: ~2.5% platform fee
- CSFloat: ~2% fee

## Acceptance Criteria
- All prices normalized to USD
- Fee-adjusted (seller net) price available
- Unit tests cover at least Steam and one other source" \
  "epic-3,backend,pricing"

create_issue \
  "Epic 3 | Store prices in D1 and cache in KV" \
  "## Overview
Implement the persistence layer for prices: write to D1 for history, cache in KV for fast reads.

## Context
Price fetching is done by a scheduled Worker (cron). Results must be:
1. Persisted to D1 (\`prices\` table) for historical tracking
2. Cached in KV (\`PRICE_CACHE\`) so that API requests don't hammer D1

## Tasks
- [ ] Create \`src/lib/pricing/store.ts\`
- [ ] Implement \`upsertPrice(db: D1Database, price: StoredPrice): Promise<void>\`
  - Insert or update based on \`(item_id, source)\` unique constraint
- [ ] Implement \`cachePrices(kv: KVNamespace, itemId: string, prices: StoredPrice[]): Promise<void>\`
  - Key format: \`price:{itemId}\`
  - TTL: 10 minutes (600 seconds)
- [ ] Implement \`getCachedPrices(kv: KVNamespace, itemId: string): Promise<StoredPrice[] | null>\`
- [ ] Define cache invalidation: cache is invalidated when new price is fetched for same item

## Acceptance Criteria
- \`upsertPrice\` inserts new and updates existing records correctly
- KV cache TTL expires stale data automatically
- Cached data is deserialized back to \`StoredPrice[]\` type" \
  "epic-3,backend,pricing,database"

create_issue \
  "Epic 3 | Implement /api/items/:id/prices and /api/prices/best endpoints" \
  "## Overview
Expose pricing data via two REST endpoints.

## Endpoints

### GET /api/items/:id/prices
Returns price history for a specific item.

**Query params:**
- \`source\` — filter by source (\`steam\`, \`buff163\`, etc.)
- \`limit\` — number of historical records (default 10)

**Response:**
\`\`\`json
{
  \"itemId\": \"AK-47-Redline-FT\",
  \"prices\": [
    { \"source\": \"steam\", \"priceUsd\": 12.34, \"fetchedAt\": \"2024-01-01T00:00:00Z\" }
  ]
}
\`\`\`

### GET /api/prices/best
Returns the current best (lowest) price across all sources for each item.

**Query params:** \`itemIds\` (comma-separated)

**Response:**
\`\`\`json
{
  \"prices\": { \"AK-47-Redline-FT\": { \"source\": \"buff163\", \"priceUsd\": 9.10 } }
}
\`\`\`

## Tasks
- [ ] Create \`functions/api/items/[id]/prices.ts\`
- [ ] Create \`functions/api/prices/best.ts\`
- [ ] Check KV cache first; fall back to D1
- [ ] Handle missing item IDs with 404

## Acceptance Criteria
- Price history endpoint returns chronological prices
- Best price endpoint returns lowest price across sources
- KV cache is used when available" \
  "epic-3,backend,pricing"

# ─────────────────────────────────────────────
# Epic 4 — Trade-up Engine
# ─────────────────────────────────────────────

create_issue \
  "Epic 4 | Implement output pool calculation for trade-ups" \
  "## Overview
Implement the core CS2 trade-up contract logic: given 10 input items of a certain rarity from various collections, determine the eligible output items and their probabilities.

## CS2 Trade-up Rules
1. You input exactly **10 items** of the **same rarity**
2. Output rarity = input rarity + 1 tier (e.g. Mil-Spec → Restricted)
3. Eligible outputs = all items of the output rarity across the **collections represented by the input items**
4. Probability of each output = (count of inputs from that item's collection) / 10
5. StatTrak inputs → StatTrak output; mixed StatTrak/non-StatTrak is not allowed

## Functions to Implement
\`\`\`typescript
// src/lib/tradeup/pool.ts

interface TradeupInput {
  itemId: string;
  collectionId: string;
  rarity: Rarity;
  float: number;
  stattrak: boolean;
}

interface OutputItem {
  itemId: string;
  collectionId: string;
  probability: number;   // 0–1
}

export function calculateOutputPool(inputs: TradeupInput[], catalog: Item[]): OutputItem[]
export function getOutputRarity(inputRarity: Rarity): Rarity | null  // null if covert (max tier)
export function validateInputs(inputs: TradeupInput[]): ValidationResult
\`\`\`

## Rarity Tier Order
consumer → industrial → mil-spec → restricted → classified → covert

## Tasks
- [ ] Implement all three functions above
- [ ] Unit test with known trade-up contract (verify probability distribution sums to 1.0)
- [ ] Test StatTrak validation (mixed input should return validation error)

## Acceptance Criteria
- Probability distribution sums to exactly 1.0
- StatTrak and non-StatTrak contracts handled correctly
- Invalid inputs (wrong rarity, covert input, fewer than 10 items) return validation errors
- Unit tests pass" \
  "epic-4,backend,tradeup-engine"

create_issue \
  "Epic 4 | Implement float normalization and output float mapping" \
  "## Overview
Implement the CS2 float normalization formula to compute the output item's float value from the 10 input floats.

## The Formula
CS2 uses this formula to determine the output float:
\`\`\`
outputFloat = outputMin + (outputMax - outputMin) * avgInputFloat
\`\`\`
Where:
- \`outputMin\` = the output item's minimum float value
- \`outputMax\` = the output item's maximum float value
- \`avgInputFloat\` = average of the 10 normalized input floats

**Normalizing input floats:**
\`\`\`
normalizedFloat = (inputFloat - inputMin) / (inputMax - inputMin)
\`\`\`

## Functions to Implement
\`\`\`typescript
// src/lib/tradeup/float.ts

export function normalizeFloat(float: number, min: number, max: number): number
export function averageFloats(floats: number[]): number
export function computeOutputFloat(
  normalizedAvg: number,
  outputItem: { min_float: number; max_float: number }
): number

// Determine CS2 wear tier from float value
export function floatToWear(float: number): 'FN' | 'MW' | 'FT' | 'WW' | 'BS'
\`\`\`

## Float Wear Thresholds
- Factory New (FN): 0.00 – 0.07
- Minimal Wear (MW): 0.07 – 0.15
- Field-Tested (FT): 0.15 – 0.38
- Well-Worn (WW): 0.38 – 0.45
- Battle-Scarred (BS): 0.45 – 1.00

## Tasks
- [ ] Implement all four functions
- [ ] Unit test with a known example (verify against CS2 trade-up calculators online)
- [ ] Edge case: all inputs at minimum float → output at output item's minimum

## Acceptance Criteria
- Formula matches CS2's actual behavior (verify against csgo.exchange or csgofloat.com)
- All rarity tiers supported
- Tested with at least 3 known examples" \
  "epic-4,backend,tradeup-engine"

create_issue \
  "Epic 4 | Implement EV and ROI calculation engine" \
  "## Overview
Implement the financial math to evaluate whether a trade-up contract is profitable.

## Formulas

### Expected Value (EV)
\`\`\`
EV = Σ (probability_i × price_i)
\`\`\`

### Return on Investment (ROI)
\`\`\`
ROI = (EV - totalCost) / totalCost × 100%
\`\`\`

### Guaranteed Profit
A contract is **guaranteed profitable** when \`min(output_prices) > totalCost\`

## Functions to Implement
\`\`\`typescript
// src/lib/tradeup/ev.ts

interface EvaluationResult {
  totalCost: number;
  ev: number;
  roi: number;              // percentage, e.g. 15.3 means 15.3%
  minOutput: number;        // worst-case output value
  maxOutput: number;        // best-case output value
  chanceToProfit: number;   // 0–1 probability of profitable outcome
  guaranteedProfit: boolean;
  outputs: OutputWithValue[];
}

interface OutputWithValue extends OutputItem {
  estimatedValue: number;   // price of this output item
  outputFloat: number;
  wear: string;
}

export async function evaluateTradeup(
  inputs: TradeupInput[],
  outputPool: OutputItem[],
  prices: Map<string, number>,
  catalog: Map<string, Item>
): Promise<EvaluationResult>
\`\`\`

## Tasks
- [ ] Implement \`evaluateTradeup\`
- [ ] Calculate EV, ROI, min/max output, chance to profit, guaranteed profit flag
- [ ] Unit tests with at least 2 known contracts (one profitable, one not)

## Acceptance Criteria
- EV formula correct
- ROI formula correct
- \`guaranteedProfit: true\` when cheapest possible output > total cost
- \`chanceToProfit\` correctly sums probabilities of outputs priced above cost" \
  "epic-4,backend,tradeup-engine"

create_issue \
  "Epic 4 | Implement /api/tradeups/evaluate endpoint" \
  "## Overview
Expose the trade-up evaluation engine as a REST API endpoint.

## Endpoint

### POST /api/tradeups/evaluate

**Request body:**
\`\`\`json
{
  \"inputs\": [
    { \"itemId\": \"AK-47-Redline-FT\", \"float\": 0.25 },
    ...
  ],
  \"stattrak\": false
}
\`\`\`
(exactly 10 items)

**Response:**
\`\`\`json
{
  \"valid\": true,
  \"totalCost\": 45.20,
  \"ev\": 52.10,
  \"roi\": 15.3,
  \"guaranteedProfit\": false,
  \"chanceToProfit\": 0.45,
  \"outputs\": [
    {
      \"itemId\": \"AWP | Asiimov (Field-Tested)\",
      \"probability\": 0.3,
      \"estimatedValue\": 85.00,
      \"outputFloat\": 0.22,
      \"wear\": \"FT\"
    }
  ]
}
\`\`\`

## Tasks
- [ ] Create \`functions/api/tradeups/evaluate.ts\`
- [ ] Validate request: exactly 10 items, valid IDs, floats in [0,1]
- [ ] Fetch item data from catalog (D1)
- [ ] Fetch prices from KV (fallback D1)
- [ ] Call trade-up engine functions
- [ ] Return structured JSON

## Acceptance Criteria
- Valid request returns full evaluation result
- Invalid input (wrong count, bad floats, mixed rarities) returns 400 with error message
- Missing item IDs return 404
- Response matches the schema above" \
  "epic-4,backend,tradeup-engine"

# ─────────────────────────────────────────────
# Epic 5 — Profitable-Contract Scanner
# ─────────────────────────────────────────────

create_issue \
  "Epic 5 | Implement cron-triggered Worker for profitable contract scanning" \
  "## Overview
Configure a Cloudflare Cron Trigger that runs a Worker periodically to scan for profitable trade-up contracts.

## Context
Profitable contracts change as prices fluctuate. The scanner runs on a schedule (e.g. every 30 minutes) to keep results fresh.

## Tasks
- [ ] Add cron trigger to \`wrangler.toml\`:
  \`\`\`toml
  [triggers]
  crons = [\"*/30 * * * *\"]
  \`\`\`
- [ ] Create \`src/workers/scanner.ts\` implementing the \`scheduled\` handler:
  \`\`\`typescript
  export default {
    async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
      ctx.waitUntil(runScan(env));
    }
  }
  \`\`\`
- [ ] Implement \`runScan(env)\` stub that logs start/end time
- [ ] Verify cron fires using \`wrangler dev --test-scheduled\`
- [ ] Confirm logs appear in Cloudflare dashboard

## Acceptance Criteria
- Cron schedule configured at 30-minute intervals
- Worker handler executes on schedule
- Execution logs visible in Cloudflare dashboard under Worker > Logs" \
  "epic-5,backend,scanner"

create_issue \
  "Epic 5 | Implement candidate trade-up contract enumeration" \
  "## Overview
Implement the algorithm to enumerate all valid 10-item trade-up combinations from the catalog within given constraints.

## Context
The scanner calls this function to generate candidate contracts before evaluating them.
A \"candidate\" is any valid combination of 10 same-rarity items (not necessarily unique items — duplicates allowed).

## Algorithm Sketch
For each rarity tier:
1. Fetch all items of that rarity from D1
2. Group by collection
3. Generate combinations of 10 items (allowing repeats) that span at least one collection with output items
4. Apply budget filter: skip if estimated cost > budget

## Function to Implement
\`\`\`typescript
// src/lib/scanner/enumerate.ts

interface EnumerationOptions {
  rarity?: Rarity;
  maxBudget?: number;      // USD total cost ceiling
  stattrak?: boolean;
  maxCandidates?: number;  // safety cap to prevent runaway enumeration
}

interface Candidate {
  inputs: { itemId: string; float: number }[];
  estimatedCost: number;
}

export async function enumerateCandidates(
  db: D1Database,
  kv: KVNamespace,
  options: EnumerationOptions
): Promise<Candidate[]>
\`\`\`

## Tasks
- [ ] Implement the function with at least a greedy/heuristic enumeration strategy
- [ ] Apply \`maxCandidates\` cap (default 500) to prevent Worker CPU timeout
- [ ] Test with sample data from the seeded catalog
- [ ] Log enumeration count and duration

## Acceptance Criteria
- Enumeration respects rarity, StatTrak, and budget constraints
- Output is a list of valid 10-item candidates
- Does not exceed Cloudflare Worker CPU time limit (50ms for free tier, 30s for paid)" \
  "epic-5,backend,scanner"

create_issue \
  "Epic 5 | Evaluate candidate contracts and store profitable results" \
  "## Overview
For each candidate contract from the enumerator, run the trade-up engine and persist contracts with positive ROI to D1 and KV.

## Tasks
- [ ] Create \`src/lib/scanner/evaluate.ts\`
- [ ] For each candidate:
  - Call \`evaluateTradeup()\` from the trade-up engine
  - Skip if ROI <= 0
  - Upsert to \`tradeup_results\` D1 table
  - Update \`TRADEUP_CACHE\` KV key
- [ ] Implement deduplication: hash the sorted input item IDs to detect re-evaluation of same contract
- [ ] Log: count scanned, count profitable, duration

## Schema (extend from Epic 1)
\`\`\`sql
ALTER TABLE tradeup_results ADD COLUMN input_hash TEXT;
CREATE UNIQUE INDEX idx_tradeup_hash ON tradeup_results(input_hash);
\`\`\`

## Acceptance Criteria
- Profitable contracts (ROI > 0) are saved to D1
- KV cache key \`scanner:results:latest\` is updated with top 50 contracts by ROI
- Duplicate contracts are not double-inserted (upsert by \`input_hash\`)
- Scanner logs are informative enough to debug issues from Cloudflare dashboard" \
  "epic-5,backend,scanner,database"

create_issue \
  "Epic 5 | Implement /api/tradeups/profitable endpoint" \
  "## Overview
Expose the profitable trade-up results discovered by the scanner via a paginated, filterable REST endpoint.

## Endpoint

### GET /api/tradeups/profitable

**Query params:**
- \`minRoi\` — minimum ROI percentage (e.g. \`5\` for 5%+)
- \`maxBudget\` — maximum total cost in USD
- \`rarity\` — filter by input rarity tier
- \`stattrak\` — \`true\`/\`false\`
- \`page\`, \`pageSize\` (default 20)

**Response:**
\`\`\`json
{
  \"results\": [
    {
      \"id\": 1,
      \"roi\": 18.5,
      \"ev\": 53.10,
      \"totalCost\": 44.85,
      \"guaranteedProfit\": false,
      \"inputs\": [...],
      \"outputs\": [...],
      \"evaluatedAt\": \"2024-01-01T00:00:00Z\"
    }
  ],
  \"page\": 1,
  \"pageSize\": 20,
  \"total\": 87
}
\`\`\`

## Tasks
- [ ] Create \`functions/api/tradeups/profitable.ts\`
- [ ] Check \`TRADEUP_CACHE\` KV first
- [ ] Fall back to D1 query with filters
- [ ] Sort by ROI descending by default

## Acceptance Criteria
- Filtering by all supported params works correctly
- Pagination correct
- KV cache hit served without D1 query" \
  "epic-5,backend,scanner"

# ─────────────────────────────────────────────
# Epic 6 — Frontend
# ─────────────────────────────────────────────

create_issue \
  "Epic 6 | Initialize frontend project (Astro or Next.js) on Cloudflare Pages" \
  "## Overview
Bootstrap the frontend application with Astro (preferred) or Next.js, configured for Cloudflare Pages deployment with Tailwind CSS.

## Recommended Stack
- **Astro** with \`@astrojs/cloudflare\` adapter (best Cloudflare Pages DX, zero JS by default)
  - OR **Next.js** with \`@cloudflare/next-on-pages\`
- **Tailwind CSS v3** for styling
- **TypeScript** throughout

## Tasks
- [ ] Scaffold project: \`pnpm create astro@latest\` (or \`npx create-next-app\`)
- [ ] Install and configure Tailwind: \`pnpm astro add tailwind\`
- [ ] Install Cloudflare adapter: \`pnpm astro add cloudflare\`
- [ ] Configure \`astro.config.mjs\` with \`output: 'server'\` and Cloudflare adapter
- [ ] Verify \`pnpm dev\` starts locally
- [ ] Verify \`wrangler pages dev\` or Pages CI deployment works
- [ ] Set up API base URL via environment variable (\`PUBLIC_API_BASE\`)

## Acceptance Criteria
- Project builds locally without errors (\`pnpm build\`)
- Deploys to Cloudflare Pages successfully
- Tailwind classes render correctly in browser
- \`PUBLIC_API_BASE\` environment variable consumed correctly" \
  "epic-6,frontend"

create_issue \
  "Epic 6 | Implement global layout, header, and navigation" \
  "## Overview
Create the shared layout component with header, navigation links, and footer used across all pages.

## Design Requirements
- Dark theme (CS2 aesthetic — dark grays, orange/gold accents)
- Responsive (mobile hamburger menu, desktop horizontal nav)
- Navigation links: **Calculator** | **Profitable Trades** | **Item Browser**

## Tasks
- [ ] Create \`src/layouts/Layout.astro\` (or \`components/Layout.tsx\` for Next.js)
- [ ] Create \`src/components/Header.astro\` with nav links and logo
- [ ] Create \`src/components/Footer.astro\` with attribution and links
- [ ] Implement responsive mobile menu (hamburger toggle)
- [ ] Apply Tailwind dark theme base styles

## Acceptance Criteria
- All pages use the shared layout
- Navigation links are functional
- Layout is responsive on mobile (375px) and desktop (1280px)
- Active page is highlighted in nav" \
  "epic-6,frontend"

create_issue \
  "Epic 6 | Implement /calculator page (manual trade-up evaluator)" \
  "## Overview
Build the interactive calculator page where users manually configure a 10-item trade-up contract and see the evaluation results.

## UI Components
1. **Item Selector** — search/filter items by name, rarity, collection; add to contract
2. **Contract Builder** — shows 10 slots; each slot has item name + float input (0–1)
3. **Evaluate Button** — calls \`POST /api/tradeups/evaluate\`
4. **Results Panel** — shows:
   - Total cost
   - Expected value and ROI
   - Guaranteed profit badge (if applicable)
   - Output item breakdown with probabilities and estimated values
   - Output float per item

## Tasks
- [ ] Create \`src/pages/calculator.astro\` (or \`app/calculator/page.tsx\`)
- [ ] Implement item search component (debounced calls to \`/api/items?search=...\`)
- [ ] Implement 10-slot contract builder with float inputs
- [ ] Wire up Evaluate button to \`/api/tradeups/evaluate\`
- [ ] Display results in a clear breakdown table/card

## Acceptance Criteria
- User can search and select 10 items
- Float values are validated (0–1 range, within item's float range)
- Results panel shows all fields from the API response
- Error states shown for invalid contracts or API failures" \
  "epic-6,frontend"

create_issue \
  "Epic 6 | Implement /profitable page (browse profitable trade-ups)" \
  "## Overview
Build a page that displays the profitable trade-up contracts discovered by the scanner, with filtering and pagination.

## UI Components
1. **Filter Bar** — ROI slider, budget input, rarity dropdown, StatTrak toggle
2. **Results Grid/Table** — each card shows: input summary, ROI %, EV, cost, guaranteed profit badge
3. **Pagination** controls
4. **Detail Link** — clicking a contract opens a detail view or expands inline

## Tasks
- [ ] Create \`src/pages/profitable.astro\`
- [ ] Implement filter bar components
- [ ] Fetch from \`GET /api/tradeups/profitable\` with filter params
- [ ] Implement pagination (URL-based, e.g. \`?page=2\`)
- [ ] Implement contract detail modal or expandable row showing full output breakdown

## Acceptance Criteria
- Filters correctly update the API query and results
- Pagination works with URL state (shareable links)
- Each result shows ROI, EV, total cost, and guaranteed profit indicator
- Empty state shown when no results match filters" \
  "epic-6,frontend"

create_issue \
  "Epic 6 | Implement /items page and item detail pages" \
  "## Overview
Build a searchable item browser and individual item detail pages showing price history and trade-up opportunities.

## /items Page
- Search bar (calls \`/api/items?search=...\`)
- Filter by rarity, collection
- Grid of item cards (name, rarity badge, collection, current price)
- Pagination

## /items/[id] Detail Page
- Item name, rarity, collection, float range
- Price history chart (prices from \`/api/items/:id/prices\`)
- Best current price across sources
- List of trade-up contracts this item appears in (from \`/api/tradeups/profitable\`)

## Tasks
- [ ] Create \`src/pages/items/index.astro\` (item list)
- [ ] Create \`src/pages/items/[id].astro\` (item detail)
- [ ] Implement search and filter on the list page
- [ ] Implement a simple price history table or chart on the detail page
- [ ] Link each item to its profitable trade-up appearances

## Acceptance Criteria
- Search and filters work
- Item detail page shows price history (at least tabular; chart is a bonus)
- Trade-up appearances section links back to /profitable with pre-applied filter" \
  "epic-6,frontend"

# ─────────────────────────────────────────────
# Epic 7 — CI/CD & Deployment
# ─────────────────────────────────────────────

create_issue \
  "Epic 7 | Configure GitHub Actions CI/CD for backend (Cloudflare Pages Functions)" \
  "## Overview
Set up GitHub Actions workflows for linting, type-checking, testing, and deploying the backend Pages Functions.

## Workflow 1: CI (on pull_request)
\`\`\`yaml
name: Backend CI
on: [pull_request]
jobs:
  lint-and-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: pnpm install
      - run: pnpm lint
      - run: pnpm tsc --noEmit
      - run: pnpm test
\`\`\`

## Workflow 2: Deploy (on push to main)
- Deploy via \`cloudflare/wrangler-action\` using Cloudflare API token and account ID stored as repo secrets

## Required Secrets
- \`CLOUDFLARE_API_TOKEN\`
- \`CLOUDFLARE_ACCOUNT_ID\`

## Tasks
- [ ] Create \`.github/workflows/backend-ci.yml\`
- [ ] Create \`.github/workflows/backend-deploy.yml\`
- [ ] Add required secrets to repo settings (document in README)
- [ ] Verify CI passes on a test PR
- [ ] Verify deployment completes on merge to main

## Acceptance Criteria
- CI runs on every PR and fails on lint/type/test errors
- Deployment runs on merge to main
- Secrets documented in README under **Deployment**" \
  "epic-7,ci-cd,backend"

create_issue \
  "Epic 7 | Configure GitHub Actions CI/CD for frontend" \
  "## Overview
Set up GitHub Actions workflows for building and deploying the frontend to Cloudflare Pages.

## Workflow 1: Frontend CI (on pull_request)
- Install deps, run \`pnpm build\`, fail on build errors
- Run any frontend tests (e.g. Playwright smoke tests if added)

## Workflow 2: Frontend Deploy (on push to main)
- Build and deploy via Cloudflare Pages Direct Upload or Wrangler

## Tasks
- [ ] Create \`.github/workflows/frontend-ci.yml\`
- [ ] Create \`.github/workflows/frontend-deploy.yml\`
- [ ] Set \`PUBLIC_API_BASE\` environment variable for the production build
- [ ] Verify build artifact is created correctly
- [ ] Verify deployment shows in Cloudflare Pages dashboard

## Acceptance Criteria
- Build step passes/fails correctly in CI
- Deployment to Cloudflare Pages is automated on merge to main
- \`PUBLIC_API_BASE\` correctly configured for production URL" \
  "epic-7,ci-cd,frontend"

create_issue \
  "Epic 7 | Write DEPLOYMENT.md with full setup and deployment instructions" \
  "## Overview
Create \`DEPLOYMENT.md\` documenting every step required to go from a fresh clone to a fully running local and production deployment.

## Contents Required

### Prerequisites
- Node.js 20+, pnpm, Wrangler CLI (\`npm i -g wrangler\`)
- Cloudflare account

### Local Development
1. Clone repo and \`pnpm install\`
2. \`wrangler login\`
3. Create D1 database and KV namespaces (commands included)
4. Run migrations: \`wrangler d1 execute ... --local --file db/schema.sql\`
5. Seed data: \`pnpm seed:local\`
6. Start dev server: \`wrangler pages dev\`

### Environment Variables
| Variable | Description | Example |
|---|---|---|
| \`CLOUDFLARE_API_TOKEN\` | Cloudflare API token with Pages and Workers permissions | ... |
| \`CLOUDFLARE_ACCOUNT_ID\` | Cloudflare account ID | ... |
| \`PUBLIC_API_BASE\` | Base URL of the deployed API | https://cs2tradeup.pages.dev |

### Production Deployment
1. Set GitHub secrets
2. Push to \`main\` branch — CI/CD deploys automatically

### Manual Deployment
Commands for manual deploy via Wrangler

## Tasks
- [ ] Create \`DEPLOYMENT.md\` at repo root
- [ ] Cover all sections listed above
- [ ] Test instructions on a clean environment

## Acceptance Criteria
- A developer with a fresh Cloudflare account can follow the guide end-to-end
- All environment variables documented with descriptions and examples
- Both local and production paths covered" \
  "epic-7,documentation"

echo "✅ All issues created successfully!"
