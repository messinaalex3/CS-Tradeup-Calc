# BACKLOG.md  
**CS2 Trade‑up Profiler – Full Project Backlog**  
Cloudflare‑Optimized Architecture

This backlog is organized into **Epics → Issue Seeds**.  
Each issue seed includes a **title**, **description**, and **acceptance criteria** so Copilot can auto‑generate full GitHub issues.

---

# 📘 Epic 1 — Cloudflare Backend Setup

## Issue: Initialize Cloudflare Pages project with Functions
**Description:**  
Set up a new Cloudflare Pages project with support for Pages Functions. Configure project structure for API routes and Workers.

**Acceptance Criteria:**  
- Cloudflare Pages project created  
- Functions directory initialized  
- Local dev environment works (`wrangler pages dev`)  
- Deployment pipeline to Cloudflare Pages verified  

---

## Issue: Configure D1 database and migrations
**Description:**  
Create the D1 database, schema migration scripts, and connection utilities.

**Acceptance Criteria:**  
- D1 database created  
- Migration system added (schema.sql or migration runner)  
- Local + production bindings configured  
- Test query successfully runs  

---

## Issue: Configure KV namespaces
**Description:**  
Create Cloudflare KV namespaces for caching prices and trade-up evaluations.

**Acceptance Criteria:**  
- KV namespaces created in Cloudflare dashboard  
- Bindings added to project config  
- Read/write test verified  

---

## Issue: Add health check endpoint
**Description:**  
Create `/api/health` endpoint to verify API availability.

**Acceptance Criteria:**  
- Endpoint returns `{ status: "ok" }`  
- Works locally and in production  

---

# 📘 Epic 2 — Catalog Service

## Issue: Create D1 tables for items and collections
**Description:**  
Implement schema for `Item` and `Collection` tables.

**Acceptance Criteria:**  
- Tables created in D1  
- Indexes added for search fields  
- Migration tested  

---

## Issue: Implement Catalog repository utilities
**Description:**  
Create functions for querying items, collections, and metadata.

**Acceptance Criteria:**  
- Functions for `getItem`, `listItems`, `getCollection`, `listCollections`  
- Error handling and validation included  

---

## Issue: Implement `/api/items` and `/api/items/:id`
**Description:**  
Expose catalog data via API endpoints.

**Acceptance Criteria:**  
- Supports filtering by rarity, collection, search  
- Returns JSON with item metadata  
- Handles missing IDs gracefully  

---

## Issue: Implement `/api/collections` and `/api/collections/:id/items`
**Description:**  
Expose collection data and associated items.

**Acceptance Criteria:**  
- Returns list of collections  
- Returns items belonging to a collection  
- Pagination supported  

---

## Issue: Seed initial catalog data
**Description:**  
Create a script to populate D1 with CS2/CSGO collections, items, rarities, and float ranges.

**Acceptance Criteria:**  
- Script runs locally and in CI  
- Data validated and consistent  
- Items linked to correct collections  

---

# 📘 Epic 3 — Pricing Service

## Issue: Implement Steam price fetcher
**Description:**  
Create a Worker function that fetches prices from Steam Community Market public endpoints.

**Acceptance Criteria:**  
- Fetches lowest listing price  
- Normalizes currency  
- Handles rate limits and errors  

---

## Issue: Implement third‑party marketplace price fetcher
**Description:**  
Add support for one additional marketplace or aggregator.

**Acceptance Criteria:**  
- Fetcher implemented  
- Price normalization consistent with Steam  
- Errors logged and handled  

---

## Issue: Implement price normalization utilities
**Description:**  
Normalize currency, fees, and data shape across sources.

**Acceptance Criteria:**  
- All prices stored in USD  
- Fee-adjusted price available  
- Utility tested with sample data  

---

## Issue: Store prices in D1 and cache in KV
**Description:**  
Persist normalized prices and cache hot items.

**Acceptance Criteria:**  
- D1 insert/update logic implemented  
- KV caching layer implemented  
- Cache invalidation rules defined  

---

## Issue: Implement `/api/items/:id/prices` and `/api/prices/best`
**Description:**  
Expose price data via API.

**Acceptance Criteria:**  
- Returns price history and current best price  
- Supports filtering by source  
- Uses KV cache when available  

---

# 📘 Epic 4 — Trade‑up Engine

## Issue: Implement output pool calculation
**Description:**  
Determine eligible output items and probabilities based on input collections.

**Acceptance Criteria:**  
- Correct probability distribution  
- Supports StatTrak and non‑StatTrak  
- Unit tests included  

---

## Issue: Implement float normalization and mapping
**Description:**  
Compute output float values using normalized input floats.

**Acceptance Criteria:**  
- Correct float math  
- Supports all rarity tiers  
- Tested with known examples  

---

## Issue: Implement EV/ROI calculations
**Description:**  
Compute expected value, ROI, min/max output value, and chance to profit.

**Acceptance Criteria:**  
- EV formula implemented  
- ROI formula implemented  
- Guaranteed profit detection implemented  

---

## Issue: Implement `/api/tradeups/evaluate`
**Description:**  
Expose trade-up evaluation via API.

**Acceptance Criteria:**  
- Accepts list of input items + floats  
- Returns outputs, probabilities, EV, ROI  
- Handles invalid inputs gracefully  

---

# 📘 Epic 5 — Profitable‑Contract Scanner

## Issue: Implement cron-triggered Worker for scanning
**Description:**  
Use Cloudflare Cron to run periodic profitable-contract scans.

**Acceptance Criteria:**  
- Cron schedule configured  
- Worker executes on schedule  
- Logs visible in Cloudflare dashboard  

---

## Issue: Implement candidate contract enumeration
**Description:**  
Generate all valid trade-up combinations within constraints.

**Acceptance Criteria:**  
- Supports rarity, StatTrak, budget filters  
- Efficient enumeration strategy  
- Tested with sample data  

---

## Issue: Evaluate candidate contracts and store results
**Description:**  
Run trade-up engine on each candidate and store profitable ones.

**Acceptance Criteria:**  
- Results stored in D1  
- KV cache updated  
- Duplicate detection implemented  

---

## Issue: Implement `/api/tradeups/profitable`
**Description:**  
Expose profitable trade-ups via API.

**Acceptance Criteria:**  
- Supports filtering by ROI, budget, rarity  
- Returns summary + evaluation details  
- Pagination supported  

---

# 📘 Epic 6 — Frontend (Astro or Next.js)

## Issue: Initialize frontend project on Cloudflare Pages
**Description:**  
Set up Astro or Next.js with Tailwind CSS.

**Acceptance Criteria:**  
- Project builds locally  
- Deploys to Cloudflare Pages  
- Tailwind configured  

---

## Issue: Implement global layout and navigation
**Description:**  
Create header, footer, and navigation structure.

**Acceptance Criteria:**  
- Responsive layout  
- Navigation links to all major pages  

---

## Issue: Implement `/calculator` page
**Description:**  
UI for manual trade-up evaluation.

**Acceptance Criteria:**  
- Item selector  
- Float input  
- Results panel with EV/ROI  
- Calls backend API  

---

## Issue: Implement `/profitable` page
**Description:**  
UI for browsing profitable trade-ups.

**Acceptance Criteria:**  
- Filters for ROI, budget, rarity  
- Paginated results  
- Links to detailed evaluation  

---

## Issue: Implement `/items` and item detail pages
**Description:**  
Searchable item list and detail view.

**Acceptance Criteria:**  
- Search bar  
- Item detail page with price history  
- Links to trade-up opportunities  

---

# 📘 Epic 7 — CI/CD & Deployment

## Issue: Configure GitHub Actions for backend
**Description:**  
Add workflows for linting, testing, and deploying Cloudflare Pages Functions.

**Acceptance Criteria:**  
- CI runs on PRs  
- Deploys on merge to main  

---

## Issue: Configure GitHub Actions for frontend
**Description:**  
Add workflows for building and deploying frontend.

**Acceptance Criteria:**  
- Build step validated  
- Deployment to Cloudflare Pages automated  

---

## Issue: Document deployment steps
**Description:**  
Create `DEPLOYMENT.md` with instructions for local dev and production deployment.

**Acceptance Criteria:**  
- Includes Cloudflare setup  
- Includes environment variable configuration  

---

# ✔️ Backlog Complete
