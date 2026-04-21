import { NextRequest, NextResponse } from "next/server";
import { fetchSteamPrice } from "@/lib/pricing/steam";
import { SKINS } from "@/lib/catalog";
import { type Wear } from "@/lib/types";
import { updatePriceSnapshot, type PriceSnapshot, type CloudflareEnv } from "@/lib/storage";
import { getCloudflareContext } from "@opennextjs/cloudflare";

/**
 * Background worker to refresh all prices in the catalog and save to R2.
 * This can be triggered by a Cloudflare Pages Cron Trigger.
 */
export async function GET(request: NextRequest) {
    // Simple auth check to prevent abuse if called via URL
    const authHeader = request.headers.get("Authorization");
    const cronSecret = process.env.CRON_SECRET;

    // If CRON_SECRET is set, require it. Otherwise, allow (for local testing)
    if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { env: rawEnv } = await getCloudflareContext();
    const env = rawEnv as unknown as CloudflareEnv;
    const snapshot: PriceSnapshot = {};
    const wears: Wear[] = ["FN", "MW", "FT", "WW", "BS"];

    console.log("Starting price refresh for all catalog items...");

    for (const skin of SKINS) {
        snapshot[skin.id] = {};
        for (const wear of wears) {
            try {
                // Fetch fresh from Steam (fetchSteamPrice handles its own internal request-level cache, 
                // but since this is a new execution it hits Steam)
                const priceData = await fetchSteamPrice(skin.id, wear);
                if (priceData.lowestPrice) {
                    snapshot[skin.id]![wear] = priceData.lowestPrice;
                }

                // Respect Steam rate limits - pause briefly between requests
                // Note: In a real Cloudflare Worker, you'd use a more robust queueing system
                console.log(`Fetched price for ${skin.id} (${wear}): ${priceData.lowestPrice}`);
                await new Promise(resolve => setTimeout(resolve, 2000));
            } catch (err) {
                console.error(`Failed to fetch price for ${skin.id} (${wear}):`, err);
            }
        }
    }

    // Persist to R2
    try {
        await updatePriceSnapshot(env, snapshot);
        console.log("Successfully updated R2 price snapshot.");
        return NextResponse.json({ success: true, updatedCount: SKINS.length });
    } catch (err) {
        console.error("Failed to update R2 snapshot:", err);
        return NextResponse.json({ error: "Storage failure" }, { status: 500 });
    }
}
