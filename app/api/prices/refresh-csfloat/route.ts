import { NextRequest, NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import type { CloudflareEnv } from "@/lib/storage";
import { CSFLOAT_PRICES_KEY } from "@/lib/storage";
import { loadCatalog } from "@/lib/catalog/dynamic";
import {
    type CsfloatSnapshot,
    CSFLOAT_FLOAT_BUCKETS,
    fetchCsfloatBucketPrice,
} from "@/lib/pricing/csfloat";

/**
 * Rarities worth fetching CSFloat prices for.
 * Covert and classified skins appear as outputs in trade-ups with high value
 * sensitivity to exact float; extraordinary (knives/gloves) are the priciest
 * outputs and benefit most from float-accurate pricing.
 */
const RELEVANT_RARITIES = new Set(["classified", "covert", "extraordinary"]);

/**
 * Delay between CSFloat API requests (ms). CSFloat enforces ~1 req/s per key.
 * Use 1100ms to stay safely under the limit.
 */
const RATE_LIMIT_DELAY_MS = 1100;

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetches float-bucketed listing prices from CSFloat for all classified,
 * covert, and extraordinary skins in the catalog, then stores the result
 * in `csfloat_prices.json` in R2.
 *
 * Intended to run less frequently than the Skinport price refresh (e.g., once
 * per day) since the CSFloat rate limit is much stricter (~1 req/s).
 *
 * Requires the `CSFLOAT_API_KEY` secret to be set in the Cloudflare Worker.
 */
export async function GET(request: NextRequest) {
    const authHeader = request.headers.get("Authorization");
    const cronSecret = process.env.CRON_SECRET;

    if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { env: rawEnv } = await getCloudflareContext();
    const env = rawEnv as unknown as CloudflareEnv;

    const apiKey = env.CSFLOAT_API_KEY;
    if (!apiKey) {
        return NextResponse.json(
            { error: "CSFLOAT_API_KEY not configured — set it as a Cloudflare Worker secret" },
            { status: 503 },
        );
    }

    const { skins } = await loadCatalog(env);

    // Only fetch prices for high-value output skins
    const relevantSkins = skins.filter((s) => RELEVANT_RARITIES.has(s.rarity));
    console.log(`[csfloat-refresh] Fetching CSFloat prices for ${relevantSkins.length} skins`);

    const snapshot: CsfloatSnapshot = {};
    let fetched = 0;
    let empty = 0;
    let skipped = 0;

    for (const skin of relevantSkins) {
        // Only fetch buckets that overlap with this skin's float range
        const applicableBuckets = CSFLOAT_FLOAT_BUCKETS.filter(
            (b) => b.maxFloat > skin.minFloat && b.minFloat < skin.maxFloat,
        );

        if (applicableBuckets.length === 0) {
            skipped++;
            continue;
        }

        const skinBuckets = [];

        for (const bucket of applicableBuckets) {
            const effectiveMin = Math.max(bucket.minFloat, skin.minFloat);
            const effectiveMax = Math.min(bucket.maxFloat, skin.maxFloat);
            if (effectiveMax <= effectiveMin) continue;

            // Rate limit: wait between requests
            await sleep(RATE_LIMIT_DELAY_MS);

            // CSFloat uses the skin name without wear suffix (e.g. "AK-47 | Redline")
            const price = await fetchCsfloatBucketPrice(apiKey, skin.name, effectiveMin, effectiveMax);

            skinBuckets.push({ minFloat: effectiveMin, maxFloat: effectiveMax, price });

            if (price !== null) fetched++;
            else empty++;
        }

        if (skinBuckets.length > 0) {
            snapshot[skin.id] = skinBuckets;
        }
    }

    console.log(
        `[csfloat-refresh] Done — ${fetched} prices fetched, ${empty} empty buckets, ${skipped} skins skipped`,
    );

    // Persist snapshot to R2
    await env.PRICE_SNAPSHOTS.put(CSFLOAT_PRICES_KEY, JSON.stringify(snapshot), {
        httpMetadata: { contentType: "application/json" },
    });

    return NextResponse.json({
        success: true,
        skinsProcessed: relevantSkins.length - skipped,
        bucketsWithPrice: fetched,
        emptyBuckets: empty,
        skinnedSkipped: skipped,
    });
}
