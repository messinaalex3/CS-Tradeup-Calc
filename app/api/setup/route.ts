import { NextRequest, NextResponse } from "next/server";
import { refreshCatalogData } from "@/lib/api/catalog-refresh";
import { refreshPricesFromCs2Cap } from "@/lib/api/price-refresh";
import { refreshProfitableTradeups } from "@/lib/api/tradeup-refresh";
import { getAuthorizedCloudflareEnv } from "@/lib/api/request";

export async function GET(request: NextRequest) {
    const envOrResponse = await getAuthorizedCloudflareEnv(request);
    if (envOrResponse instanceof NextResponse) {
        return envOrResponse;
    }

    const results: Record<string, unknown> = {};

    try {
        results.catalog = await refreshCatalogData(envOrResponse);
    } catch (error) {
        results.catalog = { error: error instanceof Error ? error.message : String(error) };
    }

    try {
        results.prices = await refreshPricesFromCs2Cap(envOrResponse, {
            forceRefresh: request.nextUrl.searchParams.get("force") === "1",
        });
    } catch (error) {
        results.prices = { error: error instanceof Error ? error.message : String(error) };
    }

    try {
        results.tradeups = await refreshProfitableTradeups(envOrResponse);
    } catch (error) {
        results.tradeups = { error: error instanceof Error ? error.message : String(error) };
    }

    const hadErrors = Object.values(results).some((value) => typeof value === "object" && value !== null && "error" in value);
    return NextResponse.json({ success: !hadErrors, results }, { status: hadErrors ? 500 : 200 });
}
