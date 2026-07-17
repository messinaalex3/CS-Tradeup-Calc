import { NextRequest, NextResponse } from "next/server";
import { refreshCatalogData } from "@/lib/api/catalog-refresh";
import { getAuthorizedCloudflareEnv } from "@/lib/api/request";

export async function GET(request: NextRequest) {
  const envOrResponse = await getAuthorizedCloudflareEnv(request);
  if (envOrResponse instanceof NextResponse) {
    return envOrResponse;
  }

  try {
    const result = await refreshCatalogData(envOrResponse);
    return NextResponse.json(result);
  } catch (err) {
    console.error(`[catalog/refresh] Failed: ${err instanceof Error ? err.message : String(err)}`);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
