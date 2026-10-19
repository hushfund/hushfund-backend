import test from "node:test";
import assert from "node:assert/strict";
import { simulate } from "./relayer.js";

test("real first-deposit estimate fits corrected gas limit", async () => {
  let calls = 0;
  assert.equal(await simulate(async () => { calls++; return "passed"; }, async () => 2_450_449n, 3_000_000n), "passed");
  assert.equal(calls, 1);
});
for (const [action, needed, limit] of [
  ["borrow", 4_933_949n, 6_000_000n],
  ["repay", 5_458_614n, 7_000_000n],
  ["withdraw", 4_899_035n, 6_000_000n],
] as const) {
  test(`measured Mainnet ${action} fits its corrected ceiling`, async () => {
    assert.equal(await simulate(async () => true, async () => needed, limit), true);
  });
}
test("insufficient gas is rejected before limited simulation or signing", async () => {
  let calls = 0;
  await assert.rejects(simulate(async () => { calls++; }, async () => 2_450_449n, 1_600_000n),
    { status: 503, message: "Current transaction needs more gas than the configured limit. No transaction was sent." });
  assert.equal(calls, 0);
});
test("estimation failure never proceeds to the transaction simulation", async () => {
  let calls = 0;
  await assert.rejects(simulate(async () => { calls++; }, async () => { throw new Error("estimate unavailable"); }, 3_000_000n),
    { message: "estimate unavailable" });
  assert.equal(calls, 0);
});
