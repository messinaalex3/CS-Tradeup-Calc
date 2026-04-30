import { NextRequest, NextResponse } from "next/server";
import { WEAR_LABELS, type Wear } from "@/lib/types";
import { updatePriceSnapshot, type PriceSnapshot, type CloudflareEnv } from "@/lib/storage";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { loadCatalog } from "@/lib/catalog/dynamic";

const SKINPORT_API = "https://api.skinport.com/v1/items?app_id=730&currency=USD";
const WEARS: Wear[] = ["FN", "MW", "FT", "WW", "BS"];

interface SkinportItem {
    market_hash_name: string;
    /** Skinport's estimate of Steam Market value in USD */
    suggested_price: number | null;
    /** Lowest current Skinport listing price in USD */
    min_price: number | null;
    /** Highest current Skinport listing price in USD */
    max_price: number | null;
    /** Average sales/listing price */
    mean_price: number | null;
    quantity: number;
}

/**
 * Fetches all CS2 prices from Skinport in a single request and saves the
 * snapshot to Cloudflare R2. Triggered by a Cloudflare Pages Cron Trigger.
 */
export async function GET(request: NextRequest) {
    const refreshStart = Date.now();
    console.log("[refresh] GET /api/prices/refresh — request received");

    const authHeader = request.headers.get("Authorization");
    const cronSecret = process.env.CRON_SECRET;

    if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
        console.warn("[refresh] Unauthorized request blocked — invalid CRON_SECRET");
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { env: rawEnv } = await getCloudflareContext();
    const env = rawEnv as unknown as CloudflareEnv;

    const { skins } = await loadCatalog(env);

    // Build a reverse-lookup: "AK-47 | Redline (Field-Tested)" → { skinId, wear }
    console.log("[refresh] Building reverse-lookup map from catalog...");
    const hashToEntry = new Map<string, { skinId: string; wear: Wear }>();
    for (const skin of skins) {
        for (const wear of WEARS) {
            const key = `${skin.name} (${WEAR_LABELS[wear]})`;
            const existing = hashToEntry.get(key);
            if (existing && existing.skinId !== skin.id) {
                // Two different catalog entries share the same market hash name.
                // The last one wins, so the first skin's ID will never get a price.
                console.warn(
                    `[refresh] Duplicate market hash name: "${key}" maps to both ` +
                    `"${existing.skinId}" and "${skin.id}" — only the latter will receive prices`,
                );
            }
            hashToEntry.set(key, { skinId: skin.id, wear });
        }
    }
    console.log(`[refresh] Map built with ${hashToEntry.size} entries.`);

    console.log(`[refresh] Fetching prices from Skinport: ${SKINPORT_API}...`);

    let items: SkinportItem[];
    try {
        const fetchStart = Date.now();
        const response = await fetch(SKINPORT_API, {
            headers: { "Accept-Encoding": "br" },
            signal: AbortSignal.timeout(30_000),
        });
        if (!response.ok) {
            throw new Error(`Skinport API returned HTTP ${response.status}`);
        }
        items = (await response.json()) as SkinportItem[];
        console.log(`[refresh] Skinport API responded in ${Date.now() - fetchStart}ms — received ${items.length} items.`);
    } catch (err) {
        console.error(`[refresh] Failed to fetch from Skinport: ${err instanceof Error ? err.message : String(err)}`);
        return NextResponse.json({ error: "Failed to fetch prices from Skinport" }, { status: 502 });
    }

    console.log("[refresh] Processing items and matching against catalog...");

    const snapshot: PriceSnapshot = {};
    let matched = 0;
    let ignoredNoPrice = 0;
    let ignoredNoMatch = 0;

    const processStart = Date.now();
    for (const item of items) {
        const entry = hashToEntry.get(item.market_hash_name);
        if (!entry) {
            ignoredNoMatch++;
            continue;
        }

        const hasAnyPrice = [
            item.min_price,
            item.max_price,
            item.mean_price,
            item.suggested_price,
        ].some((p) => p !== null && p > 0);

        if (!hasAnyPrice) {
            ignoredNoPrice++;
            continue;
        }

        if (!snapshot[entry.skinId]) snapshot[entry.skinId] = {};
        snapshot[entry.skinId]![entry.wear] = {
            minPrice: item.min_price,
            maxPrice: item.max_price,
            meanPrice: item.mean_price,
            suggestedPrice: item.suggested_price,
        };
        matched++;
    }

    console.log(
        `[refresh] Processing done in ${Date.now() - processStart}ms — ` +
        `${matched} prices matched, ${ignoredNoMatch} items ignored (no catalog match), ${ignoredNoPrice} items ignored (missing prices).`
    );

    try {
        console.log("[refresh] Updating price snapshot in R2 storage...");
        const storageStart = Date.now();
        await updatePriceSnapshot(env, snapshot);
        console.log(`[refresh] R2 storage updated in ${Date.now() - storageStart}ms.`);

        const totalDuration = Date.now() - refreshStart;
        console.log(`[refresh] Successfully completed in ${totalDuration}ms total.`);

        return NextResponse.json({
            success: true,
            matchedCount: matched,
            totalItems: items.length,
            durationMs: totalDuration
        });
    } catch (err) {
        console.error(`[refresh] Failed to update R2 snapshot: ${err instanceof Error ? err.message : String(err)}`);
        return NextResponse.json({ error: "Storage failure" }, { status: 500 });
    }
}
