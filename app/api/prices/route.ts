import { NextRequest, NextResponse } from "next/server";
import { getPrice } from "@/lib/pricing";
import type { Wear } from "@/lib/types";
import { type CloudflareEnv } from "@/lib/storage";
import { getCloudflareContext } from "@opennextjs/cloudflare";

export async function GET(request: NextRequest) {
  const requestStart = Date.now();
  console.log("[prices] GET /api/prices — request received");

  const { env: rawEnv } = await getCloudflareContext();
  const env = rawEnv as unknown as CloudflareEnv;

  const { searchParams } = request.nextUrl;
  const skinId = searchParams.get("skinId");
  const wear = searchParams.get("wear") as Wear | null;

  console.log(`[prices] Params — skinId: ${skinId ?? "(missing)"}, wear: ${wear ?? "(missing)"}`);

  if (!skinId) {
    console.warn("[prices] Bad request — skinId is required");
    return NextResponse.json({ error: "skinId is required" }, { status: 400 });
  }
  if (!wear || !["FN", "MW", "FT", "WW", "BS"].includes(wear)) {
    console.warn(`[prices] Bad request — invalid wear value: ${wear ?? "(missing)"}`);
    return NextResponse.json(
      { error: "wear is required and must be one of FN, MW, FT, WW, BS" },
      { status: 400 },
    );
  }

  console.log(`[prices] Fetching price for skinId=${skinId} wear=${wear}…`);
  const priceData = await getPrice(skinId, wear, env);

  console.log(
    `[prices] Result for ${skinId}/${wear} — lowestPrice: ${priceData.lowestPrice ?? "null"}, ` +
    `medianPrice: ${priceData.medianPrice ?? "null"}, source: ${priceData.source} — ` +
    `elapsed ${Date.now() - requestStart}ms`,
  );

  return NextResponse.json(priceData);
}
