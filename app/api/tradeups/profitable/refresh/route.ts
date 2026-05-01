import { NextRequest, NextResponse } from "next/server";
import type { Wear } from "@/lib/types";
import { createSnapshotPriceGetters } from "@/lib/pricing";
import {
  type CloudflareEnv,
  getCachedProfitableTradeups,
  setCachedProfitableTradeups,
} from "@/lib/storage";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import {
  computeProfitableContracts,
  getContractKey,
  type ProfitableContract,
  type TradeupCachePayload,
} from "@/lib/tradeup/scanner";
import { loadCatalog } from "@/lib/catalog/dynamic";

const INCREMENTAL_WRITE_MIN_INTERVAL_MS = 15000;
const MAX_KV_RETRIES = 5;
const MAX_CONTRACTS_TO_CACHE = 4000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isLikelyRateLimitError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return /429|rate.?limit|too many/i.test(msg);
}

function isLikelyPayloadTooLargeError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return /413|payload too large|too large|max(imum)? size|value.*exceeds/i.test(msg);
}

function sortContractsForCache(contracts: ProfitableContract[]): ProfitableContract[] {
  return [...contracts].sort((a, b) => {
    if (a.guaranteedProfit && !b.guaranteedProfit) return -1;
    if (!a.guaranteedProfit && b.guaranteedProfit) return 1;
    if (b.chanceToProfit !== a.chanceToProfit) {
      return b.chanceToProfit - a.chanceToProfit;
    }
    return b.roi - a.roi;
  });
}

async function writeTradeupsWithBackoff(
  env: CloudflareEnv,
  payload: TradeupCachePayload,
): Promise<void> {
  const json = JSON.stringify(payload);

  for (let attempt = 0; attempt <= MAX_KV_RETRIES; attempt++) {
    try {
      await setCachedProfitableTradeups(env, json);
      return;
    } catch (error) {
      const isLast = attempt === MAX_KV_RETRIES;
      if (isLast || !isLikelyRateLimitError(error)) {
        throw error;
      }

      const backoffMs = 500 * 2 ** attempt + Math.floor(Math.random() * 250);
      console.warn(
        `[tradeups/refresh] KV write rate-limited, retrying in ${backoffMs}ms (attempt ${attempt + 1}/${MAX_KV_RETRIES})`,
      );
      await sleep(backoffMs);
    }
  }
}

async function writeContractsToCacheSafely(
  env: CloudflareEnv,
  allContracts: ProfitableContract[],
  cachedAt: string,
  phase: "incremental" | "final",
): Promise<number> {
  const sorted = sortContractsForCache(allContracts);
  let writeCount = Math.min(sorted.length, MAX_CONTRACTS_TO_CACHE);

  while (writeCount > 0) {
    const payload: TradeupCachePayload = {
      contracts: sorted.slice(0, writeCount),
      cachedAt,
    };

    try {
      await writeTradeupsWithBackoff(env, payload);
      if (writeCount < sorted.length) {
        console.warn(
          `[tradeups/refresh] ${phase} cache write stored top ${writeCount}/${sorted.length} contract(s) to stay within KV limits.`,
        );
      }
      return writeCount;
    } catch (error) {
      if (!isLikelyPayloadTooLargeError(error) || writeCount === 1) {
        throw error;
      }

      const nextCount = Math.max(1, Math.floor(writeCount * 0.75));
      console.warn(
        `[tradeups/refresh] ${phase} cache payload likely too large at ${writeCount} contracts, retrying with ${nextCount}.`,
      );
      writeCount = nextCount;
    }
  }

  return 0;
}

/**
 * Authenticated endpoint that (re-)computes all profitable trade-up contracts
 * and stores the results in the TRADEUP_CACHE KV namespace.
 *
 * Intended to be called by a scheduled cron job (or manually) so that user
 * requests to /api/tradeups/profitable are served from cache instead of
 * recomputing on every page load.
 *
 * Set CRON_SECRET as a Cloudflare Worker secret and pass it as:
 *   Authorization: Bearer <CRON_SECRET>
 *
 * Schedule via `wrangler.jsonc` triggers.crons or an external HTTP scheduler.
 */
export async function GET(request: NextRequest) {
  const refreshStart = Date.now();
  console.log("[tradeups/refresh] GET /api/tradeups/profitable/refresh — request received");

  const authHeader = request.headers.get("Authorization");
  const cronSecret = process.env.CRON_SECRET;

  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    console.warn("[tradeups/refresh] Unauthorized request blocked — invalid CRON_SECRET");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { env: rawEnv } = await getCloudflareContext();
  const env = rawEnv as unknown as CloudflareEnv;

  // ── Locking Mechanism ────────────────────────────────────────────────────
  // Check if a scan is already in progress by looking for a lock key in KV.
  const LOCK_KEY = "tradeups:lock";
  const LOCK_TTL = 300; // 5 minutes max for a lock
  const isLocked = await env.TRADEUP_CACHE.get(LOCK_KEY);
  if (isLocked) {
    const lockTime = new Date(isLocked).toLocaleTimeString();
    console.warn(`[tradeups/refresh] Scan already in progress (started at ${lockTime}), returning 409`);
    return NextResponse.json(
      { error: `Scan already in progress (started at ${lockTime})` },
      { status: 409 },
    );
  }

  // Set the lock
  await env.TRADEUP_CACHE.put(LOCK_KEY, new Date().toISOString(), {
    expirationTtl: LOCK_TTL,
  });
  console.log("[tradeups/refresh] Scan lock acquired");

  try {
    // Load the full price snapshot ONCE from R2 so every skin/wear lookup during
    // the scan is an in-memory map access instead of a separate R2 download.
    const { getBuyPrice: snapshotBuy, getSellPrice: snapshotSell, getSellPriceByFloat: snapshotSellByFloat, getQuantity: snapshotGetQuantity, snapshot } =
      await createSnapshotPriceGetters(env);

    if (!snapshot) {
      return NextResponse.json(
        { error: "Price snapshot not found — run /api/prices/refresh first" },
        { status: 503 },
      );
    }

    const inputPriceGetter = (skinId: string, wear: Wear) => snapshotBuy(skinId, wear);
    const outputPriceGetter = (skinId: string, wear: Wear) => snapshotSell(skinId, wear);
    const outputPriceByFloatGetter = (skinId: string, float: number) => snapshotSellByFloat(skinId, float);

    const { skins } = await loadCatalog(env);
    console.log(`[tradeups/refresh] Catalog loaded — ${skins.length} skin(s)`);

    // 1. Fetch existing cache to enable "merged" updates (overwrite by combination key)
    const cached = await getCachedProfitableTradeups(env);
    const contractMap = new Map<string, ProfitableContract>();

    if (cached) {
      try {
        const payload = JSON.parse(cached) as TradeupCachePayload;
        for (const c of payload.contracts) {
          contractMap.set(getContractKey(c.inputs), c);
        }
        console.log(`[tradeups/refresh] Initialized with ${contractMap.size} existing contracts from cache.`);
      } catch {
        console.warn("[tradeups/refresh] Failed to parse existing cache, starting fresh.");
      }
    } else {
      console.log("[tradeups/refresh] No existing cache found, starting fresh.");
    }

    let lastIncrementalWriteAt = 0;
    let lastWrittenContractCount = contractMap.size;

    const onUpdate = async (newlyFound: ProfitableContract[]) => {
      // Merge: Overwrite if the combination (key) exists, otherwise add.
      for (const c of newlyFound) {
        contractMap.set(getContractKey(c.inputs), c);
      }

      const mergedList = [...contractMap.values()];

      const now = Date.now();
      if (mergedList.length === lastWrittenContractCount) {
        return;
      }
      if (now - lastIncrementalWriteAt < INCREMENTAL_WRITE_MIN_INTERVAL_MS) {
        return;
      }

      console.log(`[tradeups/refresh] Incremental update: ${mergedList.length} total contracts (${newlyFound.length} new/updated in this batch)`);

      try {
        await writeContractsToCacheSafely(
          env,
          mergedList,
          new Date().toISOString(),
          "incremental",
        );
        lastIncrementalWriteAt = now;
        lastWrittenContractCount = mergedList.length;
      } catch (error) {
        console.error(
          `[tradeups/refresh] Incremental cache write failed; continuing scan. ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    };

    console.log("[tradeups/refresh] Starting profitable contract scan…");
    const scanStart = Date.now();
    const runResults = await computeProfitableContracts(
      inputPriceGetter,
      outputPriceGetter,
      onUpdate,
      skins,
      undefined, // use default SCANNABLE_RARITIES
      outputPriceByFloatGetter,
      snapshotGetQuantity,
    );
    console.log(`[tradeups/refresh] Scan finished in ${Date.now() - scanStart}ms — ${runResults.length} contract(s) found in this run`);

    // Final merge and cleanup
    for (const c of runResults) {
      contractMap.set(getContractKey(c.inputs), c);
    }

    const finalMerged = [...contractMap.values()];
    const cachedAt = new Date().toISOString();
    const persistedCount = await writeContractsToCacheSafely(
      env,
      finalMerged,
      cachedAt,
      "final",
    );

    console.log(`[tradeups/refresh] Final cache write: ${finalMerged.length} total contract(s) (${persistedCount} persisted).`);

    const totalDuration = Date.now() - refreshStart;
    console.log(`[tradeups/refresh] Successfully completed in ${totalDuration}ms total.`);

    return NextResponse.json({
      success: true,
      totalContractsStored: persistedCount,
      totalContractsFound: finalMerged.length,
      newlyFoundInThisRun: runResults.length,
      cachedAt,
    });
  } finally {
    // Always clear the lock, even if we crash
    await env.TRADEUP_CACHE.delete(LOCK_KEY);
    console.log("[tradeups/refresh] Scan lock released.");
  }
}
