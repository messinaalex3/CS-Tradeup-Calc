import { NextRequest, NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import type { CloudflareEnv } from "@/lib/storage";
import { refreshCatalogFromApi } from "@/lib/catalog/dynamic";

export async function GET(request: NextRequest) {
  const refreshStart = Date.now();
  console.log("[catalog/refresh] GET /api/catalog/refresh — request received");

  const authHeader = request.headers.get("Authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    console.warn("[catalog/refresh] Unauthorized request blocked — invalid CRON_SECRET");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { env: rawEnv } = await getCloudflareContext();
  const env = rawEnv as unknown as CloudflareEnv;

  try {
    console.log("[catalog/refresh] Fetching catalog from API…");
    const snapshot = await refreshCatalogFromApi(env);

    const totalDuration = Date.now() - refreshStart;
    console.log(
      `[catalog/refresh] Successfully completed in ${totalDuration}ms — ` +
      `${snapshot.collections.length} collection(s), ${snapshot.skins.length} skin(s), cachedAt: ${snapshot.cachedAt}`,
    );

    return NextResponse.json({
      success: true,
      collectionsCount: snapshot.collections.length,
      skinsCount: snapshot.skins.length,
      cachedAt: snapshot.cachedAt,
    });
  } catch (err) {
    console.error(`[catalog/refresh] Failed: ${err instanceof Error ? err.message : String(err)}`);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
