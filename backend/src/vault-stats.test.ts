import assert from "node:assert/strict";
import test from "node:test";
import { LeafIndexer, readVault } from "./vault.js";

const vault = "0x1111111111111111111111111111111111111111" as const;
const aToken = "0x2222222222222222222222222222222222222222";
const morpho = "0x3333333333333333333333333333333333333333";
const usdc = "0x4444444444444444444444444444444444444444";
const cfg = { deployment: { deployBlock: 1, vaults: [{ address: vault }] } } as any;
const leaf = (i: number) => ({
  args: { leafIndex: i, commitment: `0x${i.toString(16).padStart(64, "0")}`, timestamp: 1n, yieldIndex: 10n ** 27n },
});

test("TVL includes strategy values, idle USDC and principal at exactly one block", async () => {
  const client = {
    getBlockNumber: async () => 777n,
    readContract: async ({ functionName: fn, address, args, blockNumber }: any) => {
      assert.equal(blockNumber, 777n);
      if (fn === "balanceOf") return address === aToken ? 3_000_000n : address === morpho ? 2_000_000n : 500_000n;
      if (fn === "convertToAssets") {
        assert.equal(args[0], 2_000_000n);
        return 2_500_000n; // Value of shares, even if current withdrawal liquidity is zero.
      }
      const values: Record<string, unknown> = {
        DENOMINATION: 10_000_000n, s_withdrawalFeeBps: 5n,
        getCurrentYieldIndex: 10n ** 27n, getCurrentBucketedYieldIndex: 10n ** 27n,
        s_nextLeafIndex: 3n, totalBorrowed: 1_000_000n, paused: false,
        aToken, morphoVault: morpho, token: usdc,
      };
      assert.ok(fn in values, `Unexpected read: ${fn}`);
      return values[fn];
    },
  } as any;
  const stats = await readVault(client, vault);
  assert.equal(stats.totalAssets, "7000000");
  assert.equal(stats.morphoAssets, "2500000");
  assert.equal(stats.idleAssets, "500000");
  assert.equal(stats.asOfBlock, "777");
  assert.equal(stats.commitmentCount, 3);
});

test("failed chain reads reject instead of reporting zero TVL", async () => {
  await assert.rejects(readVault({
    getBlockNumber: async () => { throw new Error("RPC unavailable"); },
  } as any, vault), /RPC unavailable/);
});

test("replacement notes do not inflate the cumulative deposit count", async () => {
  const indexer = new LeafIndexer({
    getBlockNumber: async () => 2n,
    getBlock: async () => ({ hash: "0x01" }),
    getLogs: async ({ event }: any) => event.name === "Commitment"
      ? [leaf(0), leaf(1), leaf(2)]
      : [{ blockNumber: 1n, args: { commitment: leaf(0).args.commitment } }, { blockNumber: 2n, args: { commitment: leaf(1).args.commitment } }],
  } as any, cfg);
  const leaves = await indexer.getLeaves(vault);
  assert.equal(leaves.length, 3);
  assert.deepEqual(leaves.map(leaf => leaf.kind), ["deposit", "deposit", "renewal"]);
  assert.equal(indexer.getDepositCount(vault), 2);
  assert.equal(indexer.getDepositCount(vault, 1n), 1);
  await indexer.getLeaves(vault);
  assert.equal(indexer.getDepositCount(vault), 2);
});

test("a failed multi-chunk sync resumes without losing or duplicating deposits", async () => {
  let fail = true;
  const indexer = new LeafIndexer({
    getBlockNumber: async () => 9001n,
    getBlock: async () => ({ hash: "0x01" }),
    getLogs: async ({ event, fromBlock }: any) => {
      if (fail && fromBlock === 9001n && event.name === "Deposit") throw new Error("Temporary RPC error");
      return event.name === "Commitment"
        ? [leaf(fromBlock === 1n ? 0 : 1)]
        : [{ blockNumber: fromBlock === 1n ? 9000n : 9001n, args: { commitment: leaf(fromBlock === 1n ? 0 : 1).args.commitment } }];
    },
  } as any, cfg);
  await assert.rejects(indexer.getLeaves(vault), /Temporary RPC error/);
  assert.equal(indexer.getDepositCount(vault), 0);
  fail = false;
  assert.equal((await indexer.getLeaves(vault)).length, 2);
  assert.equal(indexer.getDepositCount(vault), 2);
});

test("a same-height chain reorganization rebuilds leaves and deposit counts", async () => {
  let reorganized = false;
  const indexer = new LeafIndexer({
    getBlockNumber: async () => 2n,
    getBlock: async () => ({ hash: reorganized ? "0x02" : "0x01" }),
    getLogs: async ({ event }: any) => {
      const ids = reorganized ? [0] : [0, 1];
      return event.name === "Commitment" ? ids.map(leaf) : ids.map(i => ({ blockNumber: 2n, args: { commitment: leaf(i).args.commitment } }));
    },
  } as any, cfg);
  assert.equal((await indexer.getLeaves(vault)).length, 2);
  reorganized = true;
  assert.equal((await indexer.getLeaves(vault)).length, 1);
  assert.equal(indexer.getDepositCount(vault), 1);
});

test("a chain change during indexing does not commit a partial cache", async () => {
  let reads = 0;
  const indexer = new LeafIndexer({
    getBlockNumber: async () => 2n,
    getBlock: async () => ({ hash: ++reads === 1 ? "0x01" : "0x02" }),
    getLogs: async ({ event }: any) => event.name === "Commitment" ? [leaf(0)] : [{ blockNumber: 2n, args: { commitment: leaf(0).args.commitment } }],
  } as any, cfg);
  await assert.rejects(indexer.getLeaves(vault), /Chain changed/);
  assert.equal(indexer.getDepositCount(vault), 0);
  assert.equal((await indexer.getLeaves(vault)).length, 1);
});
