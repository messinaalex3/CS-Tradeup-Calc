import type {
  TradeupInput,
  OutputWithValue,
  EvaluationResult,
  Wear,
} from "../types";
import { SKINS, getCollectionById } from "../catalog";
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
  getPrice: (skinId: string, wear: Wear) => Promise<number | null>,
): Promise<EvaluationResult> {
  // Validate inputs
  const validation = validateInputs(inputs);
  if (!validation.valid) {
    return {
      valid: false,
      error: validation.error,
      totalCost: 0,
      ev: 0,
      roi: 0,
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
    const skin = SKINS.find((s) => s.id === input.skinId);
    if (!skin) continue;
    const wear = floatToWear(input.float);
    const price = await getPrice(input.skinId, wear);
    totalCost += price ?? 0;
  }

  // Calculate output pool
  const outputPool = calculateOutputPool(inputs);
  if (outputPool.length === 0) {
    return {
      valid: false,
      error: "No eligible output items found for this trade-up.",
      totalCost,
      ev: 0,
      roi: 0,
      guaranteedProfit: false,
      chanceToProfit: 0,
      minOutput: 0,
      maxOutput: 0,
      outputs: [],
    };
  }

  // Calculate the normalized float average for output float computation
  const inputSkins = inputs.map((i) => SKINS.find((s) => s.id === i.skinId)!);
  const normalizedAvg = averageNormalizedFloats(
    inputs.map((i) => i.float),
    inputSkins.map((s) => s.minFloat),
    inputSkins.map((s) => s.maxFloat),
  );

  // Evaluate each output item
  const outputs: OutputWithValue[] = [];
  for (const poolItem of outputPool) {
    const skin = SKINS.find((s) => s.id === poolItem.skinId);
    if (!skin) continue;
    const collection = getCollectionById(skin.collectionId);

    const outputFloat = computeOutputFloat(
      normalizedAvg,
      skin.minFloat,
      skin.maxFloat,
    );
    const wear = floatToWear(outputFloat);
    const price = await getPrice(skin.id, wear);

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

  // Min/max output value
  const validPrices = outputs
    .map((o) => o.estimatedPrice)
    .filter((p): p is number => p !== null);
  const minOutput = validPrices.length > 0 ? Math.min(...validPrices) : 0;
  const maxOutput = validPrices.length > 0 ? Math.max(...validPrices) : 0;

  // Guaranteed profit: cheapest possible output > total cost
  const guaranteedProfit = minOutput > totalCost;

  // Chance to profit: sum of probabilities for outputs priced above total cost
  const chanceToProfit = outputs.reduce((sum, o) => {
    if (o.estimatedPrice !== null && o.estimatedPrice > totalCost) {
      return sum + o.probability;
    }
    return sum;
  }, 0);

  return {
    valid: true,
    totalCost: Math.round(totalCost * 100) / 100,
    ev: Math.round(ev * 100) / 100,
    roi: Math.round(roi * 1000) / 1000,
    guaranteedProfit,
    chanceToProfit: Math.round(chanceToProfit * 1000) / 1000,
    minOutput: Math.round(minOutput * 100) / 100,
    maxOutput: Math.round(maxOutput * 100) / 100,
    outputs,
  };
}
