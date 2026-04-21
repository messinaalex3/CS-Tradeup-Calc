import { NextRequest, NextResponse } from "next/server";
import type { TradeupInput, Wear } from "@/lib/types";
import { evaluateTradeup } from "@/lib/tradeup/ev";
import { getBestPrice } from "@/lib/pricing";
import { type CloudflareEnv } from "@/lib/storage";
import { getCloudflareContext } from "@opennextjs/cloudflare";

export async function POST(request: NextRequest) {
  const { env: rawEnv } = await getCloudflareContext();
  const env = rawEnv as unknown as CloudflareEnv;

  let body: { inputs?: TradeupInput[] };
  try {
    body = await request.json() as { inputs?: TradeupInput[] };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { inputs } = body;
  if (!Array.isArray(inputs)) {
    return NextResponse.json(
      { error: "inputs must be an array of { skinId, float } objects" },
      { status: 400 },
    );
  }

  const priceGetter = (skinId: string, wear: Wear) =>
    getBestPrice(skinId, wear, env);

  const result = await evaluateTradeup(inputs, priceGetter);
  return NextResponse.json(result);
}
