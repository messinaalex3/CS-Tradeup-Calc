import type { KVNamespace, R2Bucket } from "@cloudflare/workers-types/2023-07-01";
import type { Wear } from "./types";

export type PriceSide = "buy" | "sell";

export interface PricePoint {
    minPrice: number | null;
    maxPrice: number | null;
    meanPrice: number | null;
    suggestedPrice: number | null;
    /** Number of Skinport listings available for this skin/wear. Used for liquidity filtering. */
    quantity: number | null;
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
    // KV Cache for the dynamic skin catalog (refreshed weekly)
    CATALOG_CACHE: KVNamespace;
    /** Optional Cloudflare secret: CSFloat API key for float-bucketed pricing. */
    CSFLOAT_API_KEY?: string;
}

/** R2 key for the CSFloat float-bucketed price snapshot. */
export const CSFLOAT_PRICES_KEY = "csfloat_prices.json";

/** Minimum Skinport listing count for an output skin to be considered liquid in the scanner. */
export const MIN_SELL_QUANTITY = 3;

/** KV key under which the profitable tradeup list is stored. */
export const TRADEUP_CACHE_KEY = "tradeups:profitable";

/** TTL in seconds for the tradeup cache (1 hour). */
export const TRADEUP_CACHE_TTL = 3600;

/** KV key under which the catalog snapshot is stored. */
export const CATALOG_CACHE_KEY = "catalog:v1";

/** TTL in seconds for the catalog cache (24 hours). */
export const CATALOG_CACHE_TTL = 86400;

export interface CatalogData {
    collections: Array<{ id: string; name: string }>;
    skins: Array<{
        id: string;
        name: string;
        weaponName: string;
        skinName: string;
        collectionId: string;
        rarity: string;
        minFloat: number;
        maxFloat: number;
        stattrak: boolean;
    }>;
    cachedAt: string;
}

export async function getCachedCatalog(env: CloudflareEnv): Promise<string | null> {
    return env.CATALOG_CACHE.get(CATALOG_CACHE_KEY);
}

export async function setCachedCatalog(env: CloudflareEnv, json: string): Promise<void> {
    await env.CATALOG_CACHE.put(CATALOG_CACHE_KEY, json, { expirationTtl: CATALOG_CACHE_TTL });
}

function normalizePricePoint(raw: PricePoint | number | undefined): PricePoint | null {
    if (raw === undefined) return null;

    if (typeof raw === "number") {
        // Legacy snapshot format: single numeric price.
        return {
            minPrice: raw,
            maxPrice: raw,
            meanPrice: raw,
            suggestedPrice: raw,
            quantity: null,
        };
    }

    return {
        minPrice: raw.minPrice ?? null,
        maxPrice: raw.maxPrice ?? null,
        meanPrice: raw.meanPrice ?? null,
        suggestedPrice: raw.suggestedPrice ?? null,
        quantity: raw.quantity ?? null,
    };
}

function pickPriceForSide(pricePoint: PricePoint, side: PriceSide): number | null {
    if (side === "buy") {
        // For input purchase cost use the mean (typical transaction price) so we
        // don't wildly over-estimate cost with max_price outlier listings.
        // Fallback chain: mean → min → suggested → max.
        return pricePoint.meanPrice ?? pricePoint.minPrice ?? pricePoint.suggestedPrice ?? pricePoint.maxPrice;
    }
    // For output sell value we want the floor — the cheapest listing we'd have
    // to undercut to actually move the item quickly.
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
 * Load the full price snapshot from R2 into memory.
 * Returns null if the snapshot doesn't exist yet.
 *
 * Use this for batch operations (e.g. the scanner) to avoid repeatedly
 * downloading the full JSON file once per price query.
 */
export async function getPriceSnapshot(
    env: CloudflareEnv,
): Promise<PriceSnapshot | null> {
    const object = await env.PRICE_SNAPSHOTS.get("latest_prices.json");
    if (!object) return null;
    return object.json() as Promise<PriceSnapshot>;
}

/**
 * Look up a single price from an already-loaded in-memory snapshot.
 * Returns null when the skin/wear combo is absent or has no valid price.
 */
export function getPriceFromSnapshot(
    snapshot: PriceSnapshot,
    skinId: string,
    wear: Wear,
    side: PriceSide,
): number | null {
    const pricePoint = normalizePricePoint(snapshot[skinId]?.[wear]);
    if (!pricePoint) return null;
    const price = pickPriceForSide(pricePoint, side);
    return price !== null && price > 0 ? price : null;
}

/**
 * Look up the Skinport listing quantity for a skin/wear from an in-memory snapshot.
 * Returns null when the data is absent or in legacy numeric format.
 */
export function getQuantityFromSnapshot(
    snapshot: PriceSnapshot,
    skinId: string,
    wear: Wear,
): number | null {
    const raw = snapshot[skinId]?.[wear];
    if (raw === undefined || typeof raw === "number") return null;
    return raw.quantity ?? null;
}

/**
 * Update the full R2 snapshot and proactively populate KV so that
 * individual lookups are fast without a subsequent R2 round-trip.
 *
 * KV writes are rate-limited, so we use a best-effort fire-and-forget
 * batch: failures are logged but do not abort the snapshot update.
 */
export async function updatePriceSnapshot(
    env: CloudflareEnv,
    prices: PriceSnapshot,
): Promise<void> {
    const content = JSON.stringify(prices);
    await env.PRICE_SNAPSHOTS.put("latest_prices.json", content, {
        httpMetadata: { contentType: "application/json" },
    });

    // Proactively warm KV so every subsequent individual lookup is a KV hit
    // rather than a full R2 download.  We write in small concurrent batches
    // to stay well under Cloudflare's KV write-rate limit.
    const BATCH = 50;
    const TTL = 3700; // slightly longer than the 1-hour price-refresh cadence
    const entries: Array<[string, string]> = [];

    for (const [skinId, wearMap] of Object.entries(prices)) {
        for (const [wear, raw] of Object.entries(wearMap) as Array<[Wear, PricePoint | number | undefined]>) {
            const pricePoint = normalizePricePoint(raw);
            if (!pricePoint) continue;
            for (const side of ["sell", "buy"] as PriceSide[]) {
                const price = pickPriceForSide(pricePoint, side);
                if (price !== null && price > 0) {
                    entries.push([getPriceKey(skinId, wear, side), price.toString()]);
                }
            }
        }
    }

    for (let i = 0; i < entries.length; i += BATCH) {
        const batch = entries.slice(i, i + BATCH);
        await Promise.allSettled(
            batch.map(([key, value]) =>
                env.PRICE_CACHE.put(key, value, { expirationTtl: TTL }),
            ),
        );
    }
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
