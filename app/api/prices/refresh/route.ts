import { NextRequest, NextResponse } from "next/server";
import { SKINS } from "@/lib/catalog";
import { WEAR_LABELS, type Wear } from "@/lib/types";
import { updatePriceSnapshot, type PriceSnapshot, type CloudflareEnv } from "@/lib/storage";
import { getCloudflareContext } from "@opennextjs/cloudflare";

const SKINPORT_API = "https://api.skinport.com/v1/items?app_id=730&currency=USD&tradable=0";
const WEARS: Wear[] = ["FN", "MW", "FT", "WW", "BS"];

interface SkinportItem {
    market_hash_name: string;
    /** Skinport's estimate of Steam Market value in USD */
    suggested_price: number | null;
    /** Lowest current Skinport listing price in USD */
    min_price: number | null;
    quantity: number;
}

/**
 * Fetches all CS2 prices from Skinport in a single request and saves the
 * snapshot to Cloudflare R2. Triggered by a Cloudflare Pages Cron Trigger.
 */
export async function GET(request: NextRequest) {
    const authHeader = request.headers.get("Authorization");
    const cronSecret = process.env.CRON_SECRET;

    if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Build a reverse-lookup: "AK-47 | Redline (Field-Tested)" → { skinId, wear }
    const hashToEntry = new Map<string, { skinId: string; wear: Wear }>();
    for (const skin of SKINS) {
        for (const wear of WEARS) {
            hashToEntry.set(`${skin.name} (${WEAR_LABELS[wear]})`, { skinId: skin.id, wear });
        }
    }

    console.log("Fetching prices from Skinport...");

    let items: SkinportItem[];
    try {
        const response = await fetch(SKINPORT_API, {
            headers: { "Accept-Encoding": "br" },
            signal: AbortSignal.timeout(30_000),
        });
        if (!response.ok) {
            throw new Error(`Skinport API returned HTTP ${response.status}`);
        }
        items = (await response.json()) as SkinportItem[];
    } catch (err) {
        console.error("Failed to fetch from Skinport:", err);
        return NextResponse.json({ error: "Failed to fetch prices from Skinport" }, { status: 502 });
    }

    console.log(`Received ${items.length} items from Skinport.`);

    const snapshot: PriceSnapshot = {};
    let matched = 0;

    for (const item of items) {
        const entry = hashToEntry.get(item.market_hash_name);
        if (!entry) continue;

        // Prefer suggested_price (tracks Steam Market value); fall back to min_price
        const price = item.suggested_price ?? item.min_price;
        if (!price || price <= 0) continue;

        if (!snapshot[entry.skinId]) snapshot[entry.skinId] = {};
        snapshot[entry.skinId]![entry.wear] = price;
        matched++;
    }

    console.log(`Matched ${matched} prices.`);

    const { env: rawEnv } = await getCloudflareContext();
    const env = rawEnv as unknown as CloudflareEnv;

    try {
        await updatePriceSnapshot(env, snapshot);
        console.log("Successfully updated R2 price snapshot.");
        return NextResponse.json({ success: true, matchedCount: matched, totalItems: items.length });
    } catch (err) {
        console.error("Failed to update R2 snapshot:", err);
        return NextResponse.json({ error: "Storage failure" }, { status: 500 });
    }
}
