import { NextRequest, NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import type { CloudflareEnv } from "@/lib/storage";
import { refreshCatalogFromApi } from "@/lib/catalog/dynamic";

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("Authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { env: rawEnv } = await getCloudflareContext();
  const env = rawEnv as unknown as CloudflareEnv;

  try {
    const snapshot = await refreshCatalogFromApi(env);
    return NextResponse.json({
      success: true,
      collectionsCount: snapshot.collections.length,
      skinsCount: snapshot.skins.length,
      cachedAt: snapshot.cachedAt,
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
