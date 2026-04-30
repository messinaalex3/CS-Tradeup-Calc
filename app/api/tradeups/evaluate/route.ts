import { NextRequest, NextResponse } from "next/server";
import type { TradeupInput, Wear } from "@/lib/types";
import { evaluateTradeup } from "@/lib/tradeup/ev";
import { getBuyPrice, getSellPrice } from "@/lib/pricing";
import { type CloudflareEnv } from "@/lib/storage";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { loadCatalog } from "@/lib/catalog/dynamic";

export async function POST(request: NextRequest) {
  const evalStart = Date.now();
  console.log("[evaluate] POST /api/tradeups/evaluate — request received");

  const { env: rawEnv } = await getCloudflareContext();
  const env = rawEnv as unknown as CloudflareEnv;

  let body: { inputs?: TradeupInput[] };
  try {
    body = await request.json() as { inputs?: TradeupInput[] };
  } catch {
    console.warn("[evaluate] Bad request — invalid JSON body");
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { inputs } = body;
  if (!Array.isArray(inputs)) {
    console.warn("[evaluate] Bad request — inputs must be an array");
    return NextResponse.json(
      { error: "inputs must be an array of { skinId, float } objects" },
      { status: 400 },
    );
  }

  // Input cost: mean price (conservative — avoids outlier cheap listings).
  // Output value: min price (floor — what you'd have to undercut to sell).
  const inputPriceGetter = (skinId: string, wear: Wear) =>
    getBuyPrice(skinId, wear, env);
  const outputPriceGetter = (skinId: string, wear: Wear) =>
    getSellPrice(skinId, wear, env);

  const { skins, collections } = await loadCatalog(env);
  const result = await evaluateTradeup(inputs, inputPriceGetter, outputPriceGetter, skins, collections);
  return NextResponse.json(result);
}
