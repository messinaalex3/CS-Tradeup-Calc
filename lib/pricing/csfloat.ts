/**
 * CSFloat API client for fetching float-bucketed skin listing prices.
 *
 * CSFloat lists individual CS2 items with exact float values and per-listing
 * prices, making it ideal for accurate output price estimation at specific
 * floats — much more precise than Skinport's per-wear-tier aggregates.
 */

const CSFLOAT_API_BASE = "https://csfloat.com/api/v1";

/** Number of cheapest listings to retrieve per float bucket. */
const LISTINGS_PER_BUCKET = 3;

export interface CsfloatBucket {
    minFloat: number;
    maxFloat: number;
    /** Lowest listing price in USD (null if no listings found for this bucket). */
    price: number | null;
}

/** Per-skin CSFloat price data: ordered list of float-bucketed prices. */
export type CsfloatSkinPrices = CsfloatBucket[];

/**
 * Full CSFloat snapshot stored in R2.
 * Keyed by skin ID (same IDs as the catalog), not market hash name.
 */
export type CsfloatSnapshot = Record<string, CsfloatSkinPrices>;

/**
 * Float buckets used for CSFloat price fetching.
 * Finer-grained than Skinport's five wear tiers to capture float-sensitive pricing
 * (e.g., FN 0.00-0.03 "clean" vs 0.04-0.07 "dirty" can differ significantly).
 */
export const CSFLOAT_FLOAT_BUCKETS: ReadonlyArray<{ minFloat: number; maxFloat: number }> = [
    { minFloat: 0.00, maxFloat: 0.03 }, // FN clean
    { minFloat: 0.03, maxFloat: 0.07 }, // FN dirty
    { minFloat: 0.07, maxFloat: 0.11 }, // MW clean
    { minFloat: 0.11, maxFloat: 0.15 }, // MW dirty
    { minFloat: 0.15, maxFloat: 0.20 }, // FT low
    { minFloat: 0.20, maxFloat: 0.28 }, // FT mid
    { minFloat: 0.28, maxFloat: 0.38 }, // FT high
    { minFloat: 0.38, maxFloat: 0.45 }, // WW
    { minFloat: 0.45, maxFloat: 0.60 }, // BS low
    { minFloat: 0.60, maxFloat: 1.00 }, // BS high
];

/**
 * Fetch the lowest CSFloat listing price for a skin within a float range.
 * Prices from the CSFloat API are in cents (divide by 100 for USD).
 *
 * @returns Lowest price in USD, or null if no listings or the request fails.
 */
export async function fetchCsfloatBucketPrice(
    apiKey: string,
    /** Skin name as listed on CSFloat, e.g. "AK-47 | Redline" (no wear suffix). */
    skinName: string,
    minFloat: number,
    maxFloat: number,
): Promise<number | null> {
    const url = new URL(`${CSFLOAT_API_BASE}/listings`);
    url.searchParams.set("market_hash_name", skinName);
    url.searchParams.set("min_float", String(minFloat));
    url.searchParams.set("max_float", String(maxFloat));
    url.searchParams.set("sort_by", "lowest_price");
    url.searchParams.set("limit", String(LISTINGS_PER_BUCKET));

    try {
        const response = await fetch(url.toString(), {
            headers: { Authorization: apiKey },
            signal: AbortSignal.timeout(10_000),
        });

        if (response.status === 429) {
            throw new Error("CSFloat rate limit hit");
        }
        if (!response.ok) {
            // e.g. 404 = no listings, not an error we should throw on
            return null;
        }

        const data = (await response.json()) as { data?: Array<{ price: number }> };
        const listings = data?.data;
        if (!listings || listings.length === 0) return null;

        // CSFloat prices are in cents — convert to USD
        return Math.min(...listings.map((l) => l.price)) / 100;
    } catch (err) {
        console.warn(
            `[csfloat] Fetch failed for "${skinName}" [${minFloat.toFixed(2)}-${maxFloat.toFixed(2)}]: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
        return null;
    }
}

/**
 * Look up the best (lowest) price for a skin at a specific float from an
 * in-memory CSFloat snapshot.
 *
 * @param snapshot  CSFloat snapshot loaded from R2
 * @param skinId    Catalog skin ID
 * @param float     Exact output float (0–1)
 * @returns Price in USD, or null if no matching bucket or no listing.
 */
export function getPriceFromCsfloatSnapshot(
    snapshot: CsfloatSnapshot,
    skinId: string,
    float: number,
): number | null {
    const buckets = snapshot[skinId];
    if (!buckets || buckets.length === 0) return null;
    const bucket = buckets.find((b) => float >= b.minFloat && float < b.maxFloat);
    return bucket?.price ?? null;
}
