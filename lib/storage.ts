import type { KVNamespace, R2Bucket } from "@cloudflare/workers-types/2023-07-01";
import type { Wear } from "./types";

export type PriceSide = "buy" | "sell";

export interface PricePoint {
    minPrice: number | null;
    maxPrice: number | null;
    meanPrice: number | null;
    suggestedPrice: number | null;
}

/**
 * Common shape for our Price Storage Snapshot.
 * Record of SkinId -> { Wear -> PricePoint }.
 *
 * Backward compatibility: old snapshots may still contain a number.
 */
export type PriceSnapshot = Record<string, Partial<Record<Wear, PricePoint | number>>>;

/**
 * The expected environment with Cloudflare Bindings.
 * This can be used in Next.js Route Handlers.
 */
export interface CloudflareEnv {
    // KV Cache for individual price points (high frequency)
    PRICE_CACHE: KVNamespace;
    // R2 Bucket for hourly snapshots (high volume)
    PRICE_SNAPSHOTS: R2Bucket;
    // KV Cache for pre-computed profitable tradeup results (refreshed by cron)
    TRADEUP_CACHE: KVNamespace;
}

/** KV key under which the profitable tradeup list is stored. */
export const TRADEUP_CACHE_KEY = "tradeups:profitable";

/** TTL in seconds for the tradeup cache (1 hour). */
export const TRADEUP_CACHE_TTL = 3600;

function normalizePricePoint(raw: PricePoint | number | undefined): PricePoint | null {
    if (raw === undefined) return null;

    if (typeof raw === "number") {
        // Legacy snapshot format: single numeric price.
        return {
            minPrice: raw,
            maxPrice: raw,
            meanPrice: raw,
            suggestedPrice: raw,
        };
    }

    return {
        minPrice: raw.minPrice ?? null,
        maxPrice: raw.maxPrice ?? null,
        meanPrice: raw.meanPrice ?? null,
        suggestedPrice: raw.suggestedPrice ?? null,
    };
}

function pickPriceForSide(pricePoint: PricePoint, side: PriceSide): number | null {
    if (side === "buy") {
        return pricePoint.maxPrice ?? pricePoint.meanPrice ?? pricePoint.suggestedPrice ?? pricePoint.minPrice;
    }
    return pricePoint.minPrice ?? pricePoint.meanPrice ?? pricePoint.suggestedPrice ?? pricePoint.maxPrice;
}

/**
 * Format a KV key for a specific skin price side.
 */
export function getPriceKey(skinId: string, wear: Wear, side: PriceSide = "sell"): string {
    return `price:${skinId}:${wear}:${side}`;
}

/**
 * Get a single sided price from KV or fallback to R2 if available.
 */
export async function getCachedPriceBySide(
    env: CloudflareEnv,
    skinId: string,
    wear: Wear,
    side: PriceSide,
): Promise<number | null> {
    const key = getPriceKey(skinId, wear, side);

    // 1. Try KV
    const cachedValue = await env.PRICE_CACHE.get(key);
    if (cachedValue) {
        const parsed = parseFloat(cachedValue);
        return Number.isFinite(parsed) ? parsed : null;
    }

    // 2. Try R2 if not in KV (this would be expensive if done thousands of times,
    // but fine for individual Lookups if we populate KV after)
    const snapshot = await env.PRICE_SNAPSHOTS.get("latest_prices.json");
    if (snapshot) {
        const data: PriceSnapshot = await snapshot.json();
        const pricePoint = normalizePricePoint(data[skinId]?.[wear]);
        if (pricePoint) {
            const price = pickPriceForSide(pricePoint, side);
            if (price === null || price <= 0) {
                return null;
            }

            // Background populate KV cache (1 hour TTL)
            await env.PRICE_CACHE.put(key, price.toString(), { expirationTtl: 3600 });
            return price;
        }
    }

    return null;
}

/**
 * Backward-compatible default accessor.
 * Defaults to sell-side (min/most conservative realized value).
 */
export async function getCachedPrice(
    env: CloudflareEnv,
    skinId: string,
    wear: Wear,
): Promise<number | null> {
    return getCachedPriceBySide(env, skinId, wear, "sell");
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

/**
 * Read the cached profitable tradeup payload from KV.
 * Returns the raw JSON string or null if not present / expired.
 */
export async function getCachedProfitableTradeups(
    env: CloudflareEnv,
): Promise<string | null> {
    return env.TRADEUP_CACHE.get(TRADEUP_CACHE_KEY);
}

/**
 * Write the profitable tradeup payload to KV with a 1-hour TTL.
 * @param json Serialised JSON string to persist.
 */
export async function setCachedProfitableTradeups(
    env: CloudflareEnv,
    json: string,
): Promise<void> {
    await env.TRADEUP_CACHE.put(TRADEUP_CACHE_KEY, json, {
        expirationTtl: TRADEUP_CACHE_TTL,
    });
}
