import { NextRequest, NextResponse } from "next/server";
import type { TradeupInput, Wear } from "@/lib/types";
import { evaluateTradeup } from "@/lib/tradeup/ev";
import { getBestPrice } from "@/lib/pricing";
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

  console.log(`[evaluate] Received ${inputs.length} input(s); loading catalog…`);

  const priceGetter = (skinId: string, wear: Wear) =>
    getBestPrice(skinId, wear, env);

  const { skins, collections } = await loadCatalog(env);
  console.log(`[evaluate] Catalog loaded — ${skins.length} skins, ${collections.length} collections. Evaluating trade-up…`);

  const result = await evaluateTradeup(inputs, priceGetter, undefined, skins, collections);

  console.log(
    `[evaluate] Evaluation completed in ${Date.now() - evalStart}ms — ` +
    `ev: ${result.ev ?? "null"}, roi: ${result.roi ?? "null"}`,
  );

  return NextResponse.json(result);
}
