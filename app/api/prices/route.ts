import { NextRequest, NextResponse } from "next/server";
import { fetchSteamPrice } from "@/lib/pricing/steam";
import type { Wear } from "@/lib/types";
import { type CloudflareEnv } from "@/lib/storage";
import { getCloudflareContext } from "@opennextjs/cloudflare";

export async function GET(request: NextRequest) {
  const { env: rawEnv } = await getCloudflareContext();
  const env = rawEnv as unknown as CloudflareEnv;

  const { searchParams } = request.nextUrl;
  const skinId = searchParams.get("skinId");
  const wear = searchParams.get("wear") as Wear | null;

  if (!skinId) {
    return NextResponse.json({ error: "skinId is required" }, { status: 400 });
  }
  if (!wear || !["FN", "MW", "FT", "WW", "BS"].includes(wear)) {
    return NextResponse.json(
      { error: "wear is required and must be one of FN, MW, FT, WW, BS" },
      { status: 400 },
    );
  }

  const priceData = await fetchSteamPrice(skinId, wear, env);
  return NextResponse.json(priceData);
}
