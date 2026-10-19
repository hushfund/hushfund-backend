import test from "node:test";
import assert from "node:assert/strict";
import type { PublicClient, Address } from "viem";
import { creationBlock, readApy } from "./apy.js";

function fixture(born: bigint) {
  const reads: bigint[] = [];
  const client = {
    getCode: async ({ blockNumber }: { blockNumber: bigint }) => blockNumber >= born ? "0x01" : undefined,
    getBlock: async (p?: { blockNumber: bigint }) => ({ number: p?.blockNumber ?? 10_000n, timestamp: (p?.blockNumber ?? 10_000n) * 12n }),
    readContract: async ({ blockNumber }: { blockNumber: bigint }) => {
      reads.push(blockNumber);
      assert.ok(blockNumber >= born, "must never read a strategy index before creation");
      return blockNumber === 10_000n ? 1_000_100n : 1_000_000n;
    },
  } as unknown as PublicClient;
  return { client, reads };
}
test("finds each vault creation block rather than trusting the batch's earlier block", async () => {
  const { client } = fixture(8_123n);
  assert.equal(await creationBlock(client, "0x0000000000000000000000000000000000000011", 7_000n, 10_000n), 8_123n);
});
test("new vaults return an explicit insufficient-history status without index reads", async () => {
  const f = fixture(8_000n);
  const result = await readApy(f.client, "0x0000000000000000000000000000000000000012", 7_000);
  assert.equal(result.status, "insufficient_history");
  assert.equal(result.blended, null);
  assert.equal(f.reads.length, 0);
});
test("available APY uses 24 hours of timestamp-based historical data", async () => {
  const f = fixture(2n);
  const result = await readApy(f.client, "0x0000000000000000000000000000000000000013", 0);
  assert.equal(result.status, "available");
  assert.ok(result.blended !== null && result.blended > 3 && result.blended < 4);
  assert.ok(f.reads.includes(2_800n));
});
test("RPC failures yield a safe unavailable status, not provider exception text", async () => {
  const client = { getBlock: async () => { throw new Error("provider-token-sensitive-fixture"); } } as unknown as PublicClient;
  const result = await readApy(client, "0x0000000000000000000000000000000000000014" as Address, 0);
  assert.equal(result.status, "historical_unavailable");
  assert.ok(!JSON.stringify(result).includes("provider-token"));
});
