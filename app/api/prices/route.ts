import { NextRequest, NextResponse } from "next/server";
import { fetchSteamPrice } from "@/lib/pricing/steam";
import type { Wear } from "@/lib/types";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
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

  const priceData = await fetchSteamPrice(skinId, wear);
  return NextResponse.json(priceData);
}
