import { NextRequest, NextResponse } from "next/server";
import { refreshProfitableTradeups } from "@/lib/api/tradeup-refresh";
import { getAuthorizedCloudflareEnv } from "@/lib/api/request";

/**
 * Authenticated endpoint that (re-)computes all profitable trade-up contracts
 * and stores the results in the TRADEUP_CACHE KV namespace.
 *
 * Intended to be called by a scheduled cron job (or manually) so that user
 * requests to /api/tradeups/profitable are served from cache instead of
 * recomputing on every page load.
 */
export async function GET(request: NextRequest) {
  const envOrResponse = await getAuthorizedCloudflareEnv(request);
  if (envOrResponse instanceof NextResponse) {
    return envOrResponse;
  }

  try {
    const result = await refreshProfitableTradeups(envOrResponse);
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = message.includes("already in progress") ? 409 : message.includes("Price snapshot") ? 503 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
