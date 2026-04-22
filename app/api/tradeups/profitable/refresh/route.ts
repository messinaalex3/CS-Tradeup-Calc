import { NextRequest, NextResponse } from "next/server";
import type { Wear } from "@/lib/types";
import { getBestPrice } from "@/lib/pricing";
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

const INCREMENTAL_WRITE_MIN_INTERVAL_MS = 15000;
const MAX_KV_RETRIES = 5;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isLikelyRateLimitError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return /429|rate.?limit|too many/i.test(msg);
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
        `[refresh] KV write rate-limited, retrying in ${backoffMs}ms (attempt ${attempt + 1}/${MAX_KV_RETRIES})`,
      );
      await sleep(backoffMs);
    }
  }
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
  const authHeader = request.headers.get("Authorization");
  const cronSecret = process.env.CRON_SECRET;

  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
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
    return NextResponse.json(
      { error: `Scan already in progress (started at ${lockTime})` },
      { status: 409 },
    );
  }

  // Set the lock
  await env.TRADEUP_CACHE.put(LOCK_KEY, new Date().toISOString(), {
    expirationTtl: LOCK_TTL,
  });

  try {
    const priceGetter = (skinId: string, wear: Wear) =>
      getBestPrice(skinId, wear, env);

    // 1. Fetch existing cache to enable "merged" updates (overwrite by combination key)
    const cached = await getCachedProfitableTradeups(env);
    const contractMap = new Map<string, ProfitableContract>();

    if (cached) {
      try {
        const payload = JSON.parse(cached) as TradeupCachePayload;
        for (const c of payload.contracts) {
          contractMap.set(getContractKey(c.inputs), c);
        }
        console.log(`[refresh] Initialized with ${contractMap.size} existing contracts from cache.`);
      } catch {
        console.warn("[refresh] Failed to parse existing cache, starting fresh.");
      }
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

      console.log(`[refresh] Incremental update: ${mergedList.length} total contracts (${newlyFound.length} new/updated in this batch)`);

      const payload: TradeupCachePayload = {
        contracts: mergedList,
        cachedAt: new Date().toISOString(),
      };
      await writeTradeupsWithBackoff(env, payload);
      lastIncrementalWriteAt = now;
      lastWrittenContractCount = mergedList.length;
    };

    const runResults = await computeProfitableContracts(
      priceGetter,
      onUpdate,
    );

    // Final merge and cleanup
    for (const c of runResults) {
      contractMap.set(getContractKey(c.inputs), c);
    }

    const finalMerged = [...contractMap.values()];
    const cachedAt = new Date().toISOString();
    const payload: TradeupCachePayload = { contracts: finalMerged, cachedAt };

    await writeTradeupsWithBackoff(env, payload);

    return NextResponse.json({
      success: true,
      totalContractsStored: finalMerged.length,
      newlyFoundInThisRun: runResults.length,
      cachedAt,
    });
  } finally {
    // Always clear the lock, even if we crash
    await env.TRADEUP_CACHE.delete(LOCK_KEY);
  }
}
