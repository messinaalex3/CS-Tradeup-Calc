import { NextRequest, NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import type { CloudflareEnv } from "@/lib/storage";

export async function getAuthorizedCloudflareEnv(request: NextRequest): Promise<CloudflareEnv | NextResponse> {
    const authHeader = request.headers.get("Authorization");
    const cronSecret = process.env.CRON_SECRET;

    if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
        console.warn("[api] Unauthorized request blocked — invalid CRON_SECRET");
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { env: rawEnv } = await getCloudflareContext();
    return rawEnv as unknown as CloudflareEnv;
}
