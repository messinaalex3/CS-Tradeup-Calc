import { NextRequest, NextResponse } from "next/server";
import { refreshPricesFromCs2Cap } from "@/lib/api/price-refresh";
import { getAuthorizedCloudflareEnv } from "@/lib/api/request";

/**
 * Fetches prices from CS2Cap and saves the snapshot to Cloudflare R2.
 * Uses paginated GET by default (free-tier friendly), with optional NDJSON
 * stream mode for paid tiers.
 */
export async function GET(request: NextRequest) {
    const envOrResponse = await getAuthorizedCloudflareEnv(request);
    if (envOrResponse instanceof NextResponse) {
        return envOrResponse;
    }

    try {
        const result = await refreshPricesFromCs2Cap(envOrResponse, {
            forceRefresh: request.nextUrl.searchParams.get("force") === "1",
        });
        return NextResponse.json(result);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const status = message.includes("CS2C_API_KEY") ? 503 : message.includes("snapshot") ? 503 : 502;
        return NextResponse.json({ error: message }, { status });
    }
}
