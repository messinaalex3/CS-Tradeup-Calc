import type { CloudflareEnv } from "@/lib/storage";
import { refreshCatalogFromApi } from "@/lib/catalog/dynamic";

export async function refreshCatalogData(env: CloudflareEnv) {
    const refreshStart = Date.now();
    console.log("[catalog/refresh] Fetching catalog from API…");

    const snapshot = await refreshCatalogFromApi(env);
    const totalDuration = Date.now() - refreshStart;

    console.log(
        `[catalog/refresh] Successfully completed in ${totalDuration}ms — ` +
        `${snapshot.collections.length} collection(s), ${snapshot.skins.length} skin(s), cachedAt: ${snapshot.cachedAt}`,
    );

    return {
        success: true,
        collectionsCount: snapshot.collections.length,
        skinsCount: snapshot.skins.length,
        cachedAt: snapshot.cachedAt,
        durationMs: totalDuration,
    };
}
