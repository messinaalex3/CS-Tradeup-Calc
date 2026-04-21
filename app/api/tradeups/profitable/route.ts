import { NextRequest, NextResponse } from "next/server";
import type { Rarity, Wear } from "@/lib/types";
import { RARITY_LABELS } from "@/lib/types";
import { getBestPrice } from "@/lib/pricing";
import {
  type CloudflareEnv,
  getCachedProfitableTradeups,
  setCachedProfitableTradeups,
} from "@/lib/storage";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import {
  computeProfitableContracts,
  SCANNABLE_RARITIES,
  type ProfitableContract,
  type TradeupCachePayload,
} from "@/lib/tradeup/scanner";

// Re-export shared types for use by the /refresh sub-route
export type { ProfitableContract, TradeupCachePayload };

// Maximum number of profitable contracts to return per request
const MAX_RESULTS = 20;

export async function GET(request: NextRequest) {
  const { env: rawEnv } = await getCloudflareContext();
  const env = rawEnv as unknown as CloudflareEnv;

  const { searchParams } = request.nextUrl;
  const rarityParam = searchParams.get("rarity") as Rarity | null;
  const maxBudget = searchParams.get("maxBudget")
    ? parseFloat(searchParams.get("maxBudget")!)
    : undefined;

  // Determine which rarities are relevant for this request
  const scannableRarities: Rarity[] = rarityParam
    ? [rarityParam]
    : SCANNABLE_RARITIES;

  // ── 1. Try the KV cache ──────────────────────────────────────────────────
  const cached = await getCachedProfitableTradeups(env);
  if (cached) {
    try {
      const payload = JSON.parse(cached) as TradeupCachePayload;
      let contracts = payload.contracts;

      // Apply request-time filters on the full cached set
      if (rarityParam) {
        contracts = contracts.filter((c) => c.rarity === rarityParam);
      }
      if (maxBudget !== undefined) {
        contracts = contracts.filter((c) => c.totalCost <= maxBudget);
      }

      contracts.sort((a, b) => b.roi - a.roi);

      return NextResponse.json({
        contracts: contracts.slice(0, MAX_RESULTS),
        total: contracts.length,
        scannedRarities: scannableRarities.map((r) => RARITY_LABELS[r]),
        fromCache: true,
        cachedAt: payload.cachedAt,
      });
    } catch {
      // Corrupted cache entry — fall through to recompute
    }
  }

  // ── 2. Cache miss: compute on the fly and populate the cache ─────────────
  const priceGetter = (skinId: string, wear: Wear) =>
    getBestPrice(skinId, wear, env);

  // Always compute across ALL rarities so the cached payload covers every filter
  // combination (rarity + budget).  The overhead is intentional: a fully
  // populated cache means all subsequent requests — regardless of filters —
  // are served from KV.
  const allProfitable = await computeProfitableContracts(priceGetter);

  const cachedAt = new Date().toISOString();
  const payload: TradeupCachePayload = { contracts: allProfitable, cachedAt };
  await setCachedProfitableTradeups(env, JSON.stringify(payload));

  // Apply request-time filters before returning
  let filtered = allProfitable;
  if (rarityParam) {
    filtered = filtered.filter((c) => c.rarity === rarityParam);
  }
  if (maxBudget !== undefined) {
    filtered = filtered.filter((c) => c.totalCost <= maxBudget);
  }

  return NextResponse.json({
    contracts: filtered.slice(0, MAX_RESULTS),
    total: filtered.length,
    scannedRarities: scannableRarities.map((r) => RARITY_LABELS[r]),
    fromCache: false,
    cachedAt,
  });
}
