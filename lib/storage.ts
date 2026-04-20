import type { KVNamespace, R2Bucket } from "@cloudflare/workers-types/2023-07-01";
import type { Wear } from "./types";

/**
 * Common shape for our Price Storage Snapshot.
 * A simple record of SkinId -> { Wear -> Price }
 */
export type PriceSnapshot = Record<string, Partial<Record<Wear, number>>>;

/**
 * The expected environment with Cloudflare Bindings.
 * This can be used in Next.js Route Handlers.
 */
export interface CloudflareEnv {
    // KV Cache for individual price points (high frequency)
    PRICE_CACHE: KVNamespace;
    // R2 Bucket for hourly snapshots (high volume)
    PRICE_SNAPSHOTS: R2Bucket;
}

/**
 * Format a KV key for a specific skin price.
 */
export function getPriceKey(skinId: string, wear: Wear): string {
    return `price:${skinId}:${wear}`;
}

/**
 * Get a single price from KV or fallback to R2 if available.
 */
export async function getCachedPrice(
    env: CloudflareEnv,
    skinId: string,
    wear: Wear
): Promise<number | null> {
    const key = getPriceKey(skinId, wear);

    // 1. Try KV
    const cachedValue = await env.PRICE_CACHE.get(key);
    if (cachedValue) {
        return parseFloat(cachedValue);
    }

    // 2. Try R2 if not in KV (this would be expensive if done thousands of times, 
    // but fine for individual Lookups if we populate KV after)
    const snapshot = await env.PRICE_SNAPSHOTS.get("latest_prices.json");
    if (snapshot) {
        const data: PriceSnapshot = await snapshot.json();
        const price = data[skinId]?.[wear];
        if (price !== undefined) {
            // Background populate KV cache (1 hour TTL)
            await env.PRICE_CACHE.put(key, price.toString(), { expirationTtl: 3600 });
            return price;
        }
    }

    return null;
}

/**
 * Update the full R2 snapshot and invalidate/refresh KV selectively
 * if needed (usually handled by TTL).
 */
export async function updatePriceSnapshot(
    env: CloudflareEnv,
    prices: PriceSnapshot
): Promise<void> {
    const content = JSON.stringify(prices);
    await env.PRICE_SNAPSHOTS.put("latest_prices.json", content, {
        httpMetadata: { contentType: "application/json" },
    });
}
