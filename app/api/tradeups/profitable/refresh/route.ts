import { NextRequest, NextResponse } from "next/server";
import type { Wear } from "@/lib/types";
import { getBestPrice } from "@/lib/pricing";
import {
  type CloudflareEnv,
  setCachedProfitableTradeups,
} from "@/lib/storage";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import {
  computeProfitableContracts,
  type TradeupCachePayload,
} from "@/lib/tradeup/scanner";

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

  const priceGetter = (skinId: string, wear: Wear) =>
    getBestPrice(skinId, wear, env);

  const allProfitable = await computeProfitableContracts(priceGetter);

  const cachedAt = new Date().toISOString();
  const payload: TradeupCachePayload = { contracts: allProfitable, cachedAt };

  await setCachedProfitableTradeups(env, JSON.stringify(payload));

  return NextResponse.json({
    success: true,
    contractsStored: allProfitable.length,
    cachedAt,
  });
}
