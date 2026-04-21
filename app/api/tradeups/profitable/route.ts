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

      contracts.sort((a, b) => b.roi - a.roi);
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
        `[profitable] Cache entry is corrupted (${err instanceof Error ? err.message : String(err)}), falling through to recompute`,
      );
    }
  } else {
    console.log("[profitable] Cache miss — starting fresh");
  }

  // ── 2. Cache miss: compute on the fly and populate the cache ─────────────
  const priceGetter = (skinId: string, wear: Wear) =>
    getBestPrice(skinId, wear, env);

  console.log("[profitable] Starting full scan across all rarities…");
  const computeStart = Date.now();

  // Create a map of existing contracts to enable per-contract overwriting
  const contractMap = new Map<string, ProfitableContract>();
  for (const c of initialContracts) {
    contractMap.set(getContractKey(c.inputs), c);
  }

  const onUpdate = async (newContracts: ProfitableContract[]) => {
    // Merge new findings into our map (overwriting by unique key)
    for (const c of newContracts) {
      contractMap.set(getContractKey(c.inputs), c);
    }

    const merged = [...contractMap.values()];
    const cachedAt = new Date().toISOString();
    const payload: TradeupCachePayload = { contracts: merged, cachedAt };
    await setCachedProfitableTradeups(env, JSON.stringify(payload));
    console.log(`[profitable] Incremental cache update: ${merged.length} total contracts (including ${newContracts.length} new/updated).`);
  };

  const allProfitable = await computeProfitableContracts(priceGetter, onUpdate);

  console.log(
    `[profitable] Scan complete in ${Date.now() - computeStart}ms — ` +
    `${allProfitable.length} profitable contract(s) found in this run`,
  );

  // Apply request-time filters before returning
  let filtered = allProfitable;
  if (rarityParam) {
    const before = filtered.length;
    filtered = filtered.filter((c) => c.rarity === rarityParam);
    console.log(
      `[profitable] Rarity filter "${rarityParam}": ${before} → ${filtered.length} contract(s)`,
    );
  }
  if (maxBudget !== undefined) {
    const before = filtered.length;
    filtered = filtered.filter((c) => c.totalCost <= maxBudget);
    console.log(
      `[profitable] Budget filter ≤$${maxBudget}: ${before} → ${filtered.length} contract(s)`,
    );
  }

  const returned = Math.min(filtered.length, MAX_RESULTS);
  console.log(
    `[profitable] Returning ${returned} of ${filtered.length} contract(s) — ` +
    `total elapsed ${Date.now() - requestStart}ms`,
  );

  return NextResponse.json({
    contracts: filtered.slice(0, MAX_RESULTS),
    total: filtered.length,
    scannedRarities: scannableRarities.map((r) => RARITY_LABELS[r]),
    fromCache: false,
    cachedAt,
  });
}
