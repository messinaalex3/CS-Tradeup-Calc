import type { PriceData, Wear } from "../types";
import {
    getCachedPriceBySide,
    type CloudflareEnv,
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
