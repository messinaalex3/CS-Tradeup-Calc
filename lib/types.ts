export type Rarity =
  | "consumer_grade"
  | "industrial_grade"
  | "mil_spec"
  | "restricted"
  | "classified"
  | "covert";

export type Wear = "FN" | "MW" | "FT" | "WW" | "BS";

export const RARITY_ORDER: Rarity[] = [
  "consumer_grade",
  "industrial_grade",
  "mil_spec",
  "restricted",
  "classified",
  "covert",
];

export const RARITY_LABELS: Record<Rarity, string> = {
  consumer_grade: "Consumer Grade",
  industrial_grade: "Industrial Grade",
  mil_spec: "Mil-Spec",
  restricted: "Restricted",
  classified: "Classified",
  covert: "Covert",
};

export const RARITY_COLORS: Record<Rarity, string> = {
  consumer_grade: "text-gray-400",
  industrial_grade: "text-blue-400",
  mil_spec: "text-blue-500",
  restricted: "text-purple-500",
  classified: "text-pink-500",
  covert: "text-red-500",
};

export const WEAR_FLOAT_RANGES: Record<Wear, [number, number]> = {
  FN: [0.0, 0.07],
  MW: [0.07, 0.15],
  FT: [0.15, 0.38],
  WW: [0.38, 0.45],
  BS: [0.45, 1.0],
};

export const WEAR_LABELS: Record<Wear, string> = {
  FN: "Factory New",
  MW: "Minimal Wear",
  FT: "Field-Tested",
  WW: "Well-Worn",
  BS: "Battle-Scarred",
};

export interface Skin {
  id: string;
  name: string; // e.g. "AK-47 | Redline"
  weaponName: string; // e.g. "AK-47"
  skinName: string; // e.g. "Redline"
  collectionId: string;
  rarity: Rarity;
  minFloat: number;
  maxFloat: number;
  stattrak: boolean;
}

export interface Collection {
  id: string;
  name: string;
}

export interface TradeupInput {
  skinId: string;
  float: number;
}

export interface OutputItem {
  skinId: string;
  probability: number;
}

export interface OutputWithValue {
  skinId: string;
  skinName: string;
  collectionName: string;
  probability: number;
  outputFloat: number;
  wear: Wear;
  estimatedPrice: number | null;
}

export interface EvaluationResult {
  valid: boolean;
  error?: string;
  totalCost: number;
  ev: number;
  roi: number;
  guaranteedProfit: boolean;
  chanceToProfit: number;
  minOutput: number;
  maxOutput: number;
  outputs: OutputWithValue[];
}

export interface PriceData {
  skinId: string;
  wear: Wear;
  lowestPrice: number | null;
  medianPrice: number | null;
  volume: number | null;
  currency: string;
  fetchedAt: string;
  source: "steam" | "cache";
}
