/**
 * Local price-fetching script — uses the Skinport public items API.
 *
 * Run with:  npm run fetch-prices
 *
 * What it does:
 *  1. Fetches all CS2 item prices from Skinport in a single HTTP request.
 *  2. Maps each result back to our internal skinId + wear using the catalog.
 *  3. Uploads the snapshot to Cloudflare R2 via `wrangler`.
 *
 * Requirements:
 *  - You must be logged into wrangler (`npx wrangler login`).
 */

import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

import { SKINS } from "../lib/catalog";
import type { Wear } from "../lib/types";

// ─── Config ──────────────────────────────────────────────────────────────────

const WEARS: Wear[] = ["FN", "MW", "FT", "WW", "BS"];
const WEAR_LABELS: Record<Wear, string> = {
    FN: "Factory New",
    MW: "Minimal Wear",
    FT: "Field-Tested",
    WW: "Well-Worn",
    BS: "Battle-Scarred",
};

const SKINPORT_API =
    "https://api.skinport.com/v1/items?app_id=730&currency=USD&tradable=0";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_PATH = path.join(__dirname, "prices-snapshot.json");
const R2_BUCKET = "cs-tradeup-prices";
const R2_KEY = "latest_prices.json";

// ─── Types ────────────────────────────────────────────────────────────────────

type PriceSnapshot = Record<string, Partial<Record<Wear, number>>>;

interface SkinportItem {
    market_hash_name: string;
    /** Lowest current Skinport listing price in USD */
    min_price: number | null;
    /** Skinport's estimate of Steam Market value in USD */
    suggested_price: number | null;
    quantity: number;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
    // Build a reverse-lookup map: "AK-47 | Redline (Field-Tested)" → { skinId, wear }
    const hashToEntry = new Map<string, { skinId: string; wear: Wear }>();
    for (const skin of SKINS) {
        for (const wear of WEARS) {
            const hashName = `${skin.name} (${WEAR_LABELS[wear]})`;
            hashToEntry.set(hashName, { skinId: skin.id, wear });
        }
    }
    console.log(`Built lookup for ${hashToEntry.size} skin/wear combinations.\n`);

    // Fetch all prices from Skinport in one call
    console.log("Fetching prices from Skinport...");
    const response = await fetch(SKINPORT_API, {
        headers: { "Accept-Encoding": "br" },
        signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
        throw new Error(`Skinport API returned HTTP ${response.status}`);
    }

    const items = (await response.json()) as SkinportItem[];
    console.log(`Received ${items.length} items from Skinport.\n`);

    // Map Skinport results → our PriceSnapshot format
    const snapshot: PriceSnapshot = {};
    let matched = 0;
    let skipped = 0;

    for (const item of items) {
        const entry = hashToEntry.get(item.market_hash_name);
        if (!entry) {
            skipped++;
            continue;
        }

        // Prefer suggested_price (tracks Steam Market); fall back to min_price
        const price = item.suggested_price ?? item.min_price;
        if (price === null || price <= 0) {
            skipped++;
            continue;
        }

        if (!snapshot[entry.skinId]) snapshot[entry.skinId] = {};
        snapshot[entry.skinId]![entry.wear] = price;
        matched++;
    }

    console.log(`Matched ${matched} prices, skipped ${skipped} items not in catalog.\n`);

    // Save local copy
    fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2), "utf-8");
    console.log(`Snapshot saved to: ${SNAPSHOT_PATH}\n`);

    // Upload to R2
    console.log(`Uploading to R2 (${R2_BUCKET}/${R2_KEY})...`);
    try {
        execSync(
            `npx wrangler r2 object put ${R2_BUCKET}/${R2_KEY} --file="${SNAPSHOT_PATH}" --content-type="application/json"`,
            { stdio: "inherit", cwd: path.join(__dirname, "..") },
        );
        console.log("Upload complete.");
    } catch (err) {
        console.error("R2 upload failed:", err);
        console.error(
            `Upload manually:\n  npx wrangler r2 object put ${R2_BUCKET}/${R2_KEY} --file="${SNAPSHOT_PATH}" --content-type="application/json"`,
        );
        process.exit(1);
    }
}

main().catch((err) => {
    console.error("Unexpected error:", err);
    process.exit(1);
});
