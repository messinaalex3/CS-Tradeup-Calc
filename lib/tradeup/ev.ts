import type {
  TradeupInput,
  OutputWithValue,
  EvaluationResult,
  Wear,
  Skin,
  Collection,
} from "../types";
import { DEFAULT_SELL_FEE } from "../types";
import { SKINS as STATIC_SKINS, COLLECTIONS as STATIC_COLLECTIONS } from "../catalog";
import { calculateOutputPool, validateInputs } from "./pool";
import {
  averageNormalizedFloats,
  computeOutputFloat,
  floatToWear,
} from "./float";

/**
 * Evaluate a trade-up contract given input items and a price lookup function.
 */
export async function evaluateTradeup(
  inputs: TradeupInput[],
  getInputPrice: (skinId: string, wear: Wear) => Promise<number | null>,
  getOutputPrice?: (skinId: string, wear: Wear) => Promise<number | null>,
  skins: Skin[] = STATIC_SKINS,
  collections: Collection[] = STATIC_COLLECTIONS,
  /**
   * Optional float-aware output price getter. When provided, the exact computed
   * output float is passed so the price can be interpolated toward adjacent
   * wear-tier prices for better accuracy. Falls back to getOutputPrice if omitted.
   */
  getOutputPriceByFloat?: (skinId: string, float: number) => Promise<number | null>,
): Promise<EvaluationResult> {
  const outputPriceGetter = getOutputPrice ?? getInputPrice;

  // Validate inputs
  const validation = validateInputs(inputs, skins);
  if (!validation.valid) {
    return {
      valid: false,
      error: validation.error,
      totalCost: 0,
      ev: 0,
      roi: 0,
      netRoi: 0,
      sellFee: DEFAULT_SELL_FEE,
      guaranteedProfit: false,
      chanceToProfit: 0,
      minOutput: 0,
      maxOutput: 0,
      outputs: [],
    };
  }

  // Look up input prices and calculate total cost
  let totalCost = 0;
  for (const input of inputs) {
    const skin = skins.find((s) => s.id === input.skinId);
    if (!skin) continue;
    const wear = floatToWear(input.float);
    const price = await getInputPrice(input.skinId, wear);

    // If we can't get a price for any input item, the trade-up cost is unknown
    if (price === null || price <= 0) {
      return {
        valid: false,
        error: `Price not available for input: ${skin.name} (${wear})`,
        totalCost: 0,
        ev: 0,
        roi: 0,
        netRoi: 0,
        sellFee: DEFAULT_SELL_FEE,
        guaranteedProfit: false,
        chanceToProfit: 0,
        minOutput: 0,
        maxOutput: 0,
        outputs: [],
      };
    }

    totalCost += price;
  }

  // Calculate output pool
  const outputPool = calculateOutputPool(inputs, skins);
  if (outputPool.length === 0) {
    return {
      valid: false,
      error: "No eligible output items found for this trade-up.",
      totalCost,
      ev: 0,
      roi: 0,
      netRoi: 0,
      sellFee: DEFAULT_SELL_FEE,
      guaranteedProfit: false,
      chanceToProfit: 0,
      minOutput: 0,
      maxOutput: 0,
      outputs: [],
    };
  }

  // Calculate the normalized float average for output float computation
  const inputSkins = inputs.map((i) => skins.find((s) => s.id === i.skinId)!);
  const normalizedAvg = averageNormalizedFloats(
    inputs.map((i) => i.float),
    inputSkins.map((s) => s.minFloat),
    inputSkins.map((s) => s.maxFloat),
  );

  // Evaluate each output item
  const outputs: OutputWithValue[] = [];
  for (const poolItem of outputPool) {
    const skin = skins.find((s) => s.id === poolItem.skinId);
    if (!skin) continue;
    const collection = collections.find((c) => c.id === skin.collectionId);

    const outputFloat = computeOutputFloat(
      normalizedAvg,
      skin.minFloat,
      skin.maxFloat,
    );
    const wear = floatToWear(outputFloat);
    // Prefer the float-aware getter (interpolates between tier prices at boundaries)
    // so a FT at 0.16 prices closer to MW and a FT at 0.37 prices closer to WW.
    const price = getOutputPriceByFloat
      ? await getOutputPriceByFloat(skin.id, outputFloat)
      : await outputPriceGetter(skin.id, wear);

    outputs.push({
      skinId: skin.id,
      skinName: skin.name,
      collectionName: collection?.name ?? skin.collectionId,
      probability: poolItem.probability,
      outputFloat: Math.round(outputFloat * 10000) / 10000,
      wear,
      estimatedPrice: price,
    });
  }

  // Sort outputs by probability descending
  outputs.sort((a, b) => b.probability - a.probability);

  // Calculate EV
  const ev = outputs.reduce((sum, o) => {
    return sum + o.probability * (o.estimatedPrice ?? 0);
  }, 0);

  // Calculate ROI (as a multiplier, e.g. 1.15 = 15% profit)
  const roi = totalCost > 0 ? ev / totalCost : 0;

  // Net ROI after the marketplace sell fee (Skinport charges sellers ~12%).
  // A contract needs netRoi > 1.0 to actually be profitable after fees.
  const netEv = ev * (1 - DEFAULT_SELL_FEE);
  const netRoi = totalCost > 0 ? netEv / totalCost : 0;

  // Min/max output value
  const validPrices = outputs
    .map((o) => o.estimatedPrice)
    .filter((p): p is number => p !== null);

  // If we're missing any output prices, we can't reliably say it's guaranteed or calculate full EV
  const hasMissingPrices = validPrices.length < outputs.length;

  const minOutput = validPrices.length > 0 ? Math.min(...validPrices) : 0;
  const maxOutput = validPrices.length > 0 ? Math.max(...validPrices) : 0;

  // Guaranteed profit: cheapest possible output > total cost
  // Must NOT have missing prices to be "guaranteed"
  const guaranteedProfit = !hasMissingPrices && minOutput > totalCost;

  // Chance to profit: sum of probabilities for outputs priced above total cost
  const chanceToProfit = outputs.reduce((sum, o) => {
    if (o.estimatedPrice !== null && o.estimatedPrice > totalCost) {
      return sum + o.probability;
    }
    return sum;
  }, 0);

  return {
    valid: !hasMissingPrices, // Consider invalid if we can't price all outputs
    totalCost: Math.round(totalCost * 100) / 100,
    ev: Math.round(ev * 100) / 100,
    roi: Math.round(roi * 1000) / 1000,
    netRoi: Math.round(netRoi * 1000) / 1000,
    sellFee: DEFAULT_SELL_FEE,
    guaranteedProfit,
    chanceToProfit: Math.round(chanceToProfit * 100) / 100, // Round to percentage (0-100)
    minOutput: Math.round(minOutput * 100) / 100,
    maxOutput: Math.round(maxOutput * 100) / 100,
    outputs,
  };
}
