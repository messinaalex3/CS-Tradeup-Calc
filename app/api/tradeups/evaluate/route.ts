import { NextRequest, NextResponse } from "next/server";
import type { TradeupInput, Wear } from "@/lib/types";
import { evaluateTradeup } from "@/lib/tradeup/ev";
import { getBestPrice } from "@/lib/pricing/steam";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
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
    getBestPrice(skinId, wear);

  const result = await evaluateTradeup(inputs, priceGetter);
  return NextResponse.json(result);
}
