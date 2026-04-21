import type { PriceData, Wear } from "../types";
import { getCachedPrice, type CloudflareEnv } from "../storage";

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
        const cachedPrice = await getCachedPrice(env, skinId, wear);
        if (cachedPrice !== null) {
            return {
                skinId,
                wear,
                lowestPrice: cachedPrice,
                medianPrice: null,
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
    const data = await getPrice(skinId, wear, env);
    return data.lowestPrice;
}
