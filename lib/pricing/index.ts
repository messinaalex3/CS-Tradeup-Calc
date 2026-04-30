import type { PriceData, Wear } from "../types";
import {
    getCachedPriceBySide,
    getPriceSnapshot,
    getPriceFromSnapshot,
    type CloudflareEnv,
    type PriceSnapshot,
} from "../storage";

/**
 * Get the price for a skin from Cloudflare KV/R2 storage.
 * Prices are populated by the /api/prices/refresh endpoint (Skinport).
 */
export async function getPrice(
    skinId: string,
    wear: Wear,
    env?: CloudflareEnv,
): Promise<PriceData> {
    if (env) {
        const minPrice = await getCachedPriceBySide(env, skinId, wear, "sell");
        const maxPrice = await getCachedPriceBySide(env, skinId, wear, "buy");
        const hasPrice = minPrice !== null || maxPrice !== null;

        if (hasPrice) {
            return {
                skinId,
                wear,
                lowestPrice: minPrice,
                medianPrice:
                    minPrice !== null && maxPrice !== null
                        ? (minPrice + maxPrice) / 2
                        : (minPrice ?? maxPrice),
                minPrice,
                maxPrice,
                volume: null,
                currency: "USD",
                fetchedAt: new Date().toISOString(),
                source: "cache",
            };
        }
    }

    return {
        skinId,
        wear,
        lowestPrice: null,
        medianPrice: null,
        minPrice: null,
        maxPrice: null,
        volume: null,
        currency: "USD",
        fetchedAt: new Date().toISOString(),
        source: "cache",
    };
}

/**
 * Get the best available price for a skin from storage.
 */
export async function getBestPrice(
    skinId: string,
    wear: Wear,
    env?: CloudflareEnv,
): Promise<number | null> {
    return getSellPrice(skinId, wear, env);
}

export async function getBuyPrice(
    skinId: string,
    wear: Wear,
    env?: CloudflareEnv,
): Promise<number | null> {
    if (!env) return null;
    return getCachedPriceBySide(env, skinId, wear, "buy");
}

export async function getSellPrice(
    skinId: string,
    wear: Wear,
    env?: CloudflareEnv,
): Promise<number | null> {
    if (!env) return null;
    return getCachedPriceBySide(env, skinId, wear, "sell");
}

/**
 * Load the full price snapshot from R2 once and return a pair of price-getter
 * functions that look up values from the in-memory map.
 *
 * Use this for batch scans (e.g. the profitable-tradeup scanner) to avoid
 * downloading `latest_prices.json` once per skin/wear query.
 *
 * If R2 is unavailable (cold start / first deploy), both getters return null
 * for every lookup so the caller degrades gracefully.
 */
export async function createSnapshotPriceGetters(env: CloudflareEnv): Promise<{
    getBuyPrice: (skinId: string, wear: Wear) => Promise<number | null>;
    getSellPrice: (skinId: string, wear: Wear) => Promise<number | null>;
    snapshot: PriceSnapshot | null;
}> {
    const snapshot = await getPriceSnapshot(env);

    if (!snapshot) {
        console.warn("[pricing] R2 price snapshot missing — all price lookups will return null");
        const nullGetter = async (_skinId: string, _wear: Wear): Promise<number | null> => null;
        return { getBuyPrice: nullGetter, getSellPrice: nullGetter, snapshot: null };
    }

    return {
        getBuyPrice: async (skinId: string, wear: Wear) =>
            getPriceFromSnapshot(snapshot, skinId, wear, "buy"),
        getSellPrice: async (skinId: string, wear: Wear) =>
            getPriceFromSnapshot(snapshot, skinId, wear, "sell"),
        snapshot,
    };
}
