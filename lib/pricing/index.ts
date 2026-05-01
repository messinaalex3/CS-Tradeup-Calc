import { WEAR_FLOAT_RANGES } from "../types";
import type { PriceData, Wear } from "../types";
import {
    getCachedPriceBySide,
    getPriceSnapshot,
    getPriceFromSnapshot,
    getQuantityFromSnapshot,
    type CloudflareEnv,
    type PriceSnapshot,
    type PriceSide,
    CSFLOAT_PRICES_KEY,
} from "../storage";
import { floatToWear } from "../tradeup/float";
import {
    getPriceFromCsfloatSnapshot,
    type CsfloatSnapshot,
} from "./csfloat";

/**
 * Wear tiers ordered from best (lowest float) to worst, used for adjacent-tier
 * price interpolation in getFloatAdjustedPriceFromSnapshot.
 */
const WEAR_TIER_ORDER: Wear[] = ["FN", "MW", "FT", "WW", "BS"];

/**
 * Get a float-adjusted price for a skin by blending toward adjacent wear-tier
 * prices when the exact output float falls near a tier boundary.
 *
 * Skinport only stores one price per wear tier, but a Field-Tested at float
 * 0.16 (cleanest possible FT) typically sells for significantly more than a
 * FT at 0.37 (near-WW). This function linearly interpolates toward the better
 * or worse tier price within a configurable blend zone at each boundary.
 *
 * @param snapshot  Full price snapshot from R2
 * @param skinId    Skin ID to look up
 * @param float     Exact output float (0–1)
 * @param side      "sell" for output EV estimation (default), "buy" for input cost
 * @param blendZone Fraction of the tier width at each boundary over which to
 *                  blend. Default 0.20 = 20% (e.g. bottom 20% of FT blends
 *                  toward MW price, top 20% blends toward WW price).
 * @returns Float-adjusted price, or null if no price data available.
 */
export function getFloatAdjustedPriceFromSnapshot(
    snapshot: PriceSnapshot,
    skinId: string,
    float: number,
    side: PriceSide = "sell",
    blendZone = 0.20,
): number | null {
    const wear = floatToWear(float);
    const basePrice = getPriceFromSnapshot(snapshot, skinId, wear, side);
    if (basePrice === null) return null;

    const [wearMin, wearMax] = WEAR_FLOAT_RANGES[wear];
    const wearRange = wearMax - wearMin;
    if (wearRange <= 0) return basePrice;

    // pos = 0 at the cleanest end of the tier, 1 at the most worn end
    const pos = (float - wearMin) / wearRange;
    const wearIdx = WEAR_TIER_ORDER.indexOf(wear);

    // Near the cleaner boundary — blend toward the better (lower-index) tier
    if (pos < blendZone && wearIdx > 0) {
        const betterWear = WEAR_TIER_ORDER[wearIdx - 1];
        const betterPrice = getPriceFromSnapshot(snapshot, skinId, betterWear, side);
        if (betterPrice !== null) {
            const blend = pos / blendZone; // 0 at boundary → 1 at blendZone inside tier
            return betterPrice * (1 - blend) + basePrice * blend;
        }
    }

    // Near the more-worn boundary — blend toward the worse (higher-index) tier
    if (pos > (1 - blendZone) && wearIdx < WEAR_TIER_ORDER.length - 1) {
        const worseWear = WEAR_TIER_ORDER[wearIdx + 1];
        const worsePrice = getPriceFromSnapshot(snapshot, skinId, worseWear, side);
        if (worsePrice !== null) {
            const blend = (pos - (1 - blendZone)) / blendZone; // 0 at (1-blendZone) → 1 at boundary
            return basePrice * (1 - blend) + worsePrice * blend;
        }
    }

    return basePrice;
}

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
    /**
     * Float-adjusted sell price getter. Uses CSFloat data when available for
     * accurate float-bucketed pricing; falls back to Skinport interpolation.
     */
    getSellPriceByFloat: (skinId: string, float: number) => Promise<number | null>;
    /**
     * Skinport listing quantity for a skin/wear combo. Returns null for legacy
     * snapshots or when the skin has no price data. Used for liquidity filtering.
     */
    getQuantity: (skinId: string, wear: Wear) => number | null;
    snapshot: PriceSnapshot | null;
}> {
    // Load Skinport snapshot and CSFloat snapshot in parallel
    const [snapshot, csfloatSnapshotRaw] = await Promise.all([
        getPriceSnapshot(env),
        (async (): Promise<CsfloatSnapshot | null> => {
            try {
                const obj = await env.PRICE_SNAPSHOTS.get(CSFLOAT_PRICES_KEY);
                if (!obj) return null;
                return await obj.json() as CsfloatSnapshot;
            } catch {
                return null;
            }
        })(),
    ]);
    const csfloatSnapshot = csfloatSnapshotRaw;

    if (!snapshot) {
        console.warn("[pricing] R2 price snapshot missing — all price lookups will return null");
        const nullGetter = async (_skinId: string, _wear: Wear): Promise<number | null> => null;
        const nullFloatGetter = async (_skinId: string, _float: number): Promise<number | null> => null;
        const nullQuantityGetter = (_skinId: string, _wear: Wear): number | null => null;
        return { getBuyPrice: nullGetter, getSellPrice: nullGetter, getSellPriceByFloat: nullFloatGetter, getQuantity: nullQuantityGetter, snapshot: null };
    }

    return {
        getBuyPrice: async (skinId: string, wear: Wear) =>
            getPriceFromSnapshot(snapshot, skinId, wear, "buy"),
        getSellPrice: async (skinId: string, wear: Wear) =>
            getPriceFromSnapshot(snapshot, skinId, wear, "sell"),
        getSellPriceByFloat: async (skinId: string, float: number) => {
            // Prefer CSFloat float-bucketed price when available (more accurate than interpolation)
            if (csfloatSnapshot) {
                const csPrice = getPriceFromCsfloatSnapshot(csfloatSnapshot, skinId, float);
                if (csPrice !== null) return csPrice;
            }
            // Fall back to Skinport per-tier price with adjacent-tier blending
            return getFloatAdjustedPriceFromSnapshot(snapshot, skinId, float, "sell");
        },
        getQuantity: (skinId: string, wear: Wear) =>
            getQuantityFromSnapshot(snapshot, skinId, wear),
        snapshot,
    };
}
