import assert from "node:assert/strict";
import test from "node:test";

import { SKINS } from "../lib/catalog";
import { generateCandidates, getAvailabilityAdjustedInputPrice } from "../lib/tradeup/scanner";

test("generateCandidates creates a much broader contract search space", () => {
    const candidates = generateCandidates("restricted", SKINS);

    assert.ok(candidates.length > 12000, `expected > 12000 candidates, got ${candidates.length}`);
    assert.ok(
        candidates.some((inputs) => new Set(inputs.map((input) => input.skinId)).size > 1),
        "expected mixed-skin contracts to be generated",
    );
    assert.ok(
        candidates.some((inputs) => new Set(inputs.map((input) => input.skinId)).size >= 4),
        "expected high-diversity contracts with at least four distinct skins",
    );
});

test("availability-adjusted input pricing penalizes thin-market buys", () => {
    assert.equal(getAvailabilityAdjustedInputPrice(20, 3), 27);
    assert.equal(getAvailabilityAdjustedInputPrice(20, 8), 20);
});
