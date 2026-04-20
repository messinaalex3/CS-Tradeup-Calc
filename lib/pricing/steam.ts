import type { PriceData, Wear } from "../types";
import { WEAR_LABELS } from "../types";
import { getSkinById } from "../catalog";

// Steam Market App ID for CS2
const CSGO_APP_ID = 730;
// Steam Market API currency: 1 = USD
const CURRENCY = 1;

// In-memory cache for prices during a request cycle (avoids duplicate fetches)
const priceCache = new Map<string, { data: PriceData; expiresAt: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Build the Steam Market hash name for a skin and wear tier.
 * e.g. "AK-47 | Redline (Field-Tested)"
 */
export function buildMarketHashName(skinId: string, wear: Wear): string {
  const skin = getSkinById(skinId);
  if (!skin) throw new Error(`Skin not found: ${skinId}`);
  return `${skin.name} (${WEAR_LABELS[wear]})`;
}

/**
 * Fetch the price for a skin from the Steam Community Market.
 *
 * Uses the public priceoverview endpoint.
 */
export async function fetchSteamPrice(
  skinId: string,
  wear: Wear,
): Promise<PriceData> {
  const cacheKey = `${skinId}:${wear}`;
  const cached = priceCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return { ...cached.data, source: "cache" };
  }

  const skin = getSkinById(skinId);
  if (!skin) {
    return {
      skinId,
      wear,
      lowestPrice: null,
      medianPrice: null,
      volume: null,
      currency: "USD",
      fetchedAt: new Date().toISOString(),
      source: "steam",
    };
  }

  // Check if the wear tier is within the skin's float range
  const { WEAR_FLOAT_RANGES } = await import("../types");
  const [wearMin, wearMax] = WEAR_FLOAT_RANGES[wear];
  if (wearMax <= skin.minFloat || wearMin >= skin.maxFloat) {
    // This wear is not available for this skin
    return {
      skinId,
      wear,
      lowestPrice: null,
      medianPrice: null,
      volume: null,
      currency: "USD",
      fetchedAt: new Date().toISOString(),
      source: "steam",
    };
  }

  const marketHashName = buildMarketHashName(skinId, wear);
  const url = new URL(
    "https://steamcommunity.com/market/priceoverview/",
  );
  url.searchParams.set("appid", String(CSGO_APP_ID));
  url.searchParams.set("currency", String(CURRENCY));
  url.searchParams.set("market_hash_name", marketHashName);

  try {
    const response = await fetch(url.toString(), {
      headers: {
        "User-Agent": "CS2-Tradeup-Calculator/1.0",
      },
      // Add a reasonable timeout
      signal: AbortSignal.timeout(8000),
    });

    if (!response.ok) {
      throw new Error(`Steam API returned ${response.status}`);
    }

    const data = await response.json() as {
      success: boolean;
      lowest_price?: string;
      median_price?: string;
      volume?: string;
    };

    if (!data.success) {
      return {
        skinId,
        wear,
        lowestPrice: null,
        medianPrice: null,
        volume: null,
        currency: "USD",
        fetchedAt: new Date().toISOString(),
        source: "steam",
      };
    }

    const parsePrice = (s?: string): number | null => {
      if (!s) return null;
      // Steam returns prices like "$1.23" or "1,23€"
      const cleaned = s.replace(/[^0-9.,]/g, "").replace(",", ".");
      const value = parseFloat(cleaned);
      return isNaN(value) ? null : value;
    };

    const result: PriceData = {
      skinId,
      wear,
      lowestPrice: parsePrice(data.lowest_price),
      medianPrice: parsePrice(data.median_price),
      volume: data.volume ? parseInt(data.volume.replace(/[^0-9]/g, ""), 10) : null,
      currency: "USD",
      fetchedAt: new Date().toISOString(),
      source: "steam",
    };

    priceCache.set(cacheKey, { data: result, expiresAt: Date.now() + CACHE_TTL_MS });
    return result;
  } catch {
    return {
      skinId,
      wear,
      lowestPrice: null,
      medianPrice: null,
      volume: null,
      currency: "USD",
      fetchedAt: new Date().toISOString(),
      source: "steam",
    };
  }
}

/**
 * Get the best available price (lowest price, then median price) for a skin.
 */
export async function getBestPrice(
  skinId: string,
  wear: Wear,
): Promise<number | null> {
  const data = await fetchSteamPrice(skinId, wear);
  return data.lowestPrice ?? data.medianPrice;
}
