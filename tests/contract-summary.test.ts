import test from "node:test";
import assert from "node:assert/strict";
import { summarizeContractInputs } from "../lib/tradeup/input-summary";

test("summarizeContractInputs renders mixed contracts compactly", () => {
    const summary = summarizeContractInputs([
        { skinId: "a", skinName: "AK-47 | Redline" },
        { skinId: "a", skinName: "AK-47 | Redline" },
        { skinId: "a", skinName: "AK-47 | Redline" },
        { skinId: "b", skinName: "AWP | Asiimov" },
        { skinId: "b", skinName: "AWP | Asiimov" },
    ]);

    assert.equal(summary, "3× AK-47 | Redline + 2× AWP | Asiimov");
});
