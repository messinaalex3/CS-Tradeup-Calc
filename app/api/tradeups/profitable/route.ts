import { NextRequest, NextResponse } from "next/server";
import type { Rarity, Wear } from "@/lib/types";
import { RARITY_LABELS } from "@/lib/types";
import {
  type CloudflareEnv,
  getCachedProfitableTradeups,
  setCachedProfitableTradeups,
} from "@/lib/storage";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import {
  computeProfitableContracts,
  SCANNABLE_RARITIES,
  getContractKey,
  type ProfitableContract,
  type TradeupCachePayload,
} from "@/lib/tradeup/scanner";

// Re-export shared types for use by the /refresh sub-route
export type { ProfitableContract, TradeupCachePayload };

// Maximum number of profitable contracts to return per request
const MAX_RESULTS = 20;

export async function GET(request: NextRequest) {
  const requestStart = Date.now();
  console.log("[profitable] GET /api/tradeups/profitable — request received");

  const { env: rawEnv } = await getCloudflareContext();
  const env = rawEnv as unknown as CloudflareEnv;

  const { searchParams } = request.nextUrl;
  const rarityParam = searchParams.get("rarity") as Rarity | null;
  const maxBudget = searchParams.get("maxBudget")
    ? parseFloat(searchParams.get("maxBudget")!)
    : undefined;

  console.log(
    `[profitable] Filters — rarity: ${rarityParam ?? "all"}, maxBudget: ${maxBudget ?? "none"}`,
  );

  // Determine which rarities are relevant for this request
  const scannableRarities: Rarity[] = rarityParam
    ? [rarityParam]
    : SCANNABLE_RARITIES;

  // ── 1. Try the KV cache ──────────────────────────────────────────────────
  console.log("[profitable] Checking KV cache…");
  const cached = await getCachedProfitableTradeups(env);
  let initialContracts: ProfitableContract[] = [];

  if (cached) {
    console.log("[profitable] Cache hit — parsing existing results");
    try {
      const payload = JSON.parse(cached) as TradeupCachePayload;
      initialContracts = payload.contracts;

      // If we're not force-refreshing and have cached data, we can return early
      // (This logic might be expanded if we add a 'force' param later)

      let contracts = [...initialContracts];

      // Apply request-time filters on the full cached set
      if (rarityParam) {
        const before = contracts.length;
        contracts = contracts.filter((c) => c.rarity === rarityParam);
        console.log(
          `[profitable] Rarity filter "${rarityParam}": ${before} → ${contracts.length} contract(s)`,
        );
      }
      if (maxBudget !== undefined) {
        const before = contracts.length;
        contracts = contracts.filter((c) => c.totalCost <= maxBudget);
        console.log(
          `[profitable] Budget filter ≤$${maxBudget}: ${before} → ${contracts.length} contract(s)`,
        );
      }

      // ── Sorting ──────────────────────────────────────
      // 1. Guaranteed Profit first
      // 2. Then highest chance to profit (percentage)
      // 3. Then highest ROI
      contracts.sort((a, b) => {
        if (a.guaranteedProfit && !b.guaranteedProfit) return -1;
        if (!a.guaranteedProfit && b.guaranteedProfit) return 1;
        if (b.chanceToProfit !== a.chanceToProfit)
          return b.chanceToProfit - a.chanceToProfit;
        return b.roi - a.roi;
      });

      const returned = Math.min(contracts.length, MAX_RESULTS);
      console.log(
        `[profitable] Returning ${returned} of ${contracts.length} from cache — ` +
        `elapsed ${Date.now() - requestStart}ms`,
      );

      return NextResponse.json({
        contracts: contracts.slice(0, MAX_RESULTS),
        total: contracts.length,
        scannedRarities: scannableRarities.map((r) => RARITY_LABELS[r]),
        fromCache: true,
        cachedAt: payload.cachedAt,
      });
    } catch (err) {
      console.warn(
        `[profitable] Cache entry is corrupted (${err instanceof Error ? err.message : String(err)})`,
      );
    }
  } else {
    console.log("[profitable] Cache miss — no results found");
  }

  // ── 2. Cache miss: no fallback computation ────────────────────────────────
  // In the past, this performed a full compute on-the-fly, but this is now 
  // handled strictly by the /refresh route and scheduled cron jobs.

  return NextResponse.json({
    contracts: [],
    total: 0,
    scannedRarities: scannableRarities.map((r) => RARITY_LABELS[r]),
    fromCache: false,
    message: "No cached results found. A refresh may be in progress or required.",
  });
}
