import { parseAbi, parseAbiItem, type Address, type PublicClient } from "viem";
import { vaultAbi } from "./abi.js";
import type { Config } from "./config.js";

const erc20BalanceAbi = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const morphoAbi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function convertToAssets(uint256) view returns (uint256)",
]);

const commitmentEvent = parseAbiItem(
  "event Commitment(bytes32 indexed commitment, uint32 leafIndex, uint256 timestamp, uint256 yieldIndex)",
);
const depositEvent = parseAbiItem("event Deposit(bytes32 indexed commitment, address indexed depositor)");

export interface Leaf {
  commitment: `0x${string}`;
  leafIndex: number;
  timestamp: number;
  yieldIndex: string;
  kind: "deposit" | "renewal";
}

/**
 * Incremental indexer for the Merkle tree leaves of each vault. Logs are fetched once, in chunks, and only new
 * blocks are scanned afterwards, which keeps the load on an Ethereum RPC provider low.
 */
export class LeafIndexer {
  private leaves = new Map<string, Leaf[]>();
  private scannedTo = new Map<string, bigint>();
  private depositBlocks = new Map<string, bigint[]>();
  private scannedHashes = new Map<string, `0x${string}`>();
  private inflight = new Map<string, Promise<Leaf[]>>();
  private readonly chunk = 9_000n; // most providers cap eth_getLogs at 10k blocks

  constructor(private client: PublicClient, private cfg: Config) {}

  isKnownVault(address: string): boolean {
    return this.cfg.deployment.vaults.some((v) => v.address.toLowerCase() === address.toLowerCase());
  }

  getDepositCount(vault: Address, block?: bigint): number {
    const blocks = this.depositBlocks.get(vault.toLowerCase()) ?? [];
    let count = blocks.length;
    while (block !== undefined && count > 0 && blocks[count - 1] > block) count--;
    return count;
  }

  async getLeaves(vault: Address, block?: bigint): Promise<Leaf[]> {
    const key = vault.toLowerCase();
    const running = this.inflight.get(key);
    if (running) {
      const leaves = await running;
      if (block !== undefined && (this.scannedTo.get(key) ?? -1n) < block) return this.getLeaves(vault, block);
      return leaves;
    }
    const p = this.sync(vault, block).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  private async sync(vault: Address, block?: bigint): Promise<Leaf[]> {
    const key = vault.toLowerCase();
    let list = [...(this.leaves.get(key) ?? [])];
    let depositBlocks = [...(this.depositBlocks.get(key) ?? [])];
    const head = block ?? await this.client.getBlockNumber();
    const previous = this.scannedTo.get(key);
    if (previous !== undefined && head < previous) throw new Error("RPC head is behind the indexed block");
    const header = await withRetry(() => this.client.getBlock({ blockNumber: head }));
    if (!header.hash) throw new Error("Chain header is not confirmed");
    let from = (this.scannedTo.get(key) ?? BigInt(this.cfg.deployment.deployBlock) - 1n) + 1n;
    if (previous !== undefined) {
      const previousHeader = previous === head ? header : await withRetry(() => this.client.getBlock({ blockNumber: previous }));
      if (previousHeader.hash !== this.scannedHashes.get(key)) {
        // Only discard the public RPC cache; private notes are never stored here.
        list = [];
        depositBlocks = [];
        from = BigInt(this.cfg.deployment.deployBlock);
      }
    }

    while (from <= head) {
      const to = from + this.chunk - 1n > head ? head : from + this.chunk - 1n;
      const [logs, deposits] = await Promise.all([
        withRetry(() => this.client.getLogs({ address: vault, event: commitmentEvent, fromBlock: from, toBlock: to })),
        withRetry(() => this.client.getLogs({ address: vault, event: depositEvent, fromBlock: from, toBlock: to })),
      ]);
      for (const log of deposits) {
        if (typeof log.blockNumber !== "bigint") throw new Error("Deposit event has no confirmed block");
        depositBlocks.push(log.blockNumber);
      }
      const deposited = new Set(deposits.map(log => log.args.commitment?.toLowerCase()));
      for (const log of logs) {
        const a = log.args as { commitment: `0x${string}`; leafIndex: number; timestamp: bigint; yieldIndex: bigint };
        list.push({
          commitment: a.commitment,
          leafIndex: Number(a.leafIndex),
          timestamp: Number(a.timestamp),
          yieldIndex: a.yieldIndex.toString(),
          kind: deposited.has(a.commitment.toLowerCase()) ? "deposit" : "renewal",
        });
      }
      from = to + 1n;
    }

    list.sort((x, y) => x.leafIndex - y.leafIndex);
    // the tree is append-only, so leaf indices must be 0..n-1 without gaps
    list.forEach((l, i) => {
      if (l.leafIndex !== i) throw new Error(`leaf ${i} missing for ${vault}; re-sync required`);
    });
    const confirmedHeader = await withRetry(() => this.client.getBlock({ blockNumber: head }));
    if (confirmedHeader.hash !== header.hash) throw new Error("Chain changed during indexing; retry required");
    this.leaves.set(key, list);
    this.depositBlocks.set(key, depositBlocks);
    this.scannedHashes.set(key, header.hash);
    if (head > (this.scannedTo.get(key) ?? -1n)) this.scannedTo.set(key, head);
    return list;
  }
}

async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 500 * (i + 1)));
    }
  }
  throw last;
}

export async function readVault(client: PublicClient, vault: Address, atBlock?: bigint) {
  const blockNumber = atBlock ?? await client.getBlockNumber({ cacheTime: 0 });
  // Pin every component to the same block so a borrow cannot be counted both
  // as strategy assets before it executes and as loan principal after it.
  const read: typeof client.readContract = (p: any) => client.readContract({ ...p, blockNumber }) as any;
  const [denomination, feeBps, yieldIndex, bucketed, nextLeaf, totalBorrowed, paused] = await Promise.all([
    read({ address: vault, abi: vaultAbi, functionName: "DENOMINATION" }),
    read({ address: vault, abi: vaultAbi, functionName: "s_withdrawalFeeBps" }),
    read({ address: vault, abi: vaultAbi, functionName: "getCurrentYieldIndex" }),
    read({ address: vault, abi: vaultAbi, functionName: "getCurrentBucketedYieldIndex" }),
    read({ address: vault, abi: vaultAbi, functionName: "s_nextLeafIndex" }),
    read({ address: vault, abi: vaultAbi, functionName: "totalBorrowed" }),
    read({ address: vault, abi: vaultAbi, functionName: "paused" }),
  ]);
  // Assets actually held in the strategies (what backs the notes), for the dashboard
  const [aToken, morpho, token] = await Promise.all([
    read({ address: vault, abi: vaultAbi, functionName: "aToken" }) as Promise<Address>,
    read({ address: vault, abi: vaultAbi, functionName: "morphoVault" }) as Promise<Address>,
    read({ address: vault, abi: vaultAbi, functionName: "token" }) as Promise<Address>,
  ]);
  const [aaveAssets, shares, idleAssets] = await Promise.all([
    read({ address: aToken, abi: erc20BalanceAbi, functionName: "balanceOf", args: [vault] }),
    read({ address: morpho, abi: morphoAbi, functionName: "balanceOf", args: [vault] }),
    read({ address: token, abi: erc20BalanceAbi, functionName: "balanceOf", args: [vault] }),
  ]);
  const morphoAssets = await read({ address: morpho, abi: morphoAbi, functionName: "convertToAssets", args: [shares] });
  const totalAssets = aaveAssets + morphoAssets + idleAssets + totalBorrowed;
  return {
    aaveAssets: String(aaveAssets),
    morphoAssets: String(morphoAssets),
    idleAssets: String(idleAssets),
    totalAssets: String(totalAssets),
    asOfBlock: blockNumber.toString(),
    updatedAt: new Date().toISOString(),
    denomination: String(denomination),
    feeBps: String(feeBps),
    yieldIndex: String(yieldIndex),
    bucketedYieldIndex: String(bucketed),
    commitmentCount: Number(nextLeaf),
    totalBorrowed: String(totalBorrowed),
    paused: Boolean(paused),
  };
}

export async function readLoan(client: PublicClient, vault: Address, collateralNullifierHash: `0x${string}`) {
  const [loan, debt, spent] = await Promise.all([
    client.readContract({ address: vault, abi: vaultAbi, functionName: "s_loans", args: [collateralNullifierHash] }),
    client.readContract({ address: vault, abi: vaultAbi, functionName: "getDebt", args: [collateralNullifierHash] }),
    client.readContract({ address: vault, abi: vaultAbi, functionName: "s_collateralSpent", args: [collateralNullifierHash] }),
  ]);
  const [principalAmount, borrowYieldIndex, depositYieldIndex, active] = loan as readonly [bigint, bigint, bigint, boolean];
  return {
    active,
    collateralSpent: Boolean(spent),
    principalAmount: principalAmount.toString(),
    borrowYieldIndex: borrowYieldIndex.toString(),
    depositYieldIndex: depositYieldIndex.toString(),
    debt: String(debt),
  };
}

export { readApy } from "./apy.js";
