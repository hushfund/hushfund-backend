import type { Address, PublicClient } from "viem";
import { vaultAbi } from "./abi.js";

export interface ApyResult {
  aave: number | null;
  morpho: number | null;
  blended: number | null;
  status: "available" | "insufficient_history" | "historical_unavailable";
  message: string;
}
const cache = new Map<string, { at: number; result: ApyResult }>();
const creation = new Map<string, bigint>();
const empty = (status: ApyResult["status"], message: string): ApyResult => ({ aave: null, morpho: null, blended: null, status, message });

/** Deployment metadata starts at the batch's simulation block, not each vault's creation block. */
export async function creationBlock(client: PublicClient, vault: Address, lower: bigint, head: bigint) {
  const hasCode = async (blockNumber: bigint) => {
    const code = await client.getCode({ address: vault, blockNumber });
    return Boolean(code && code !== "0x");
  };
  if (!await hasCode(head)) throw new Error("Vault is not deployed");
  if (await hasCode(lower)) return lower;
  let lo = lower;
  let hi = head;
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    if (await hasCode(mid)) hi = mid;
    else lo = mid;
  }
  return hi;
}

export async function readApy(client: PublicClient, vault: Address, deployBlock: number): Promise<ApyResult> {
  const id = `${vault.toLowerCase()}:${deployBlock}`;
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.result;
  const remember = (result: ApyResult) => { cache.set(id, { at: Date.now(), result }); return result; };
  try {
    const head = await client.getBlock();
    let born = creation.get(id);
    if (born === undefined) {
      born = await creationBlock(client, vault, BigInt(deployBlock), head.number);
      creation.set(id, born);
    }
    // Find the block nearest 24h ago, but never query a vault before its creation.
    const bornBlock = await client.getBlock({ blockNumber: born });
    const target = head.timestamp - 86_400n;
    if (bornBlock.timestamp > target) return remember(empty("insufficient_history", "APY will be available after this vault has 24 hours of history."));
    let lo = born;
    let hi = head.number;
    while (hi - lo > 1n) {
      const mid = (lo + hi) / 2n;
      const b = await client.getBlock({ blockNumber: mid });
      if (b.timestamp <= target) lo = mid;
      else hi = mid;
    }
    const past = await client.getBlock({ blockNumber: lo });
    const read = (functionName: "getAaveIndex" | "getMorphoIndex", blockNumber: bigint) =>
      client.readContract({ address: vault, abi: vaultAbi, functionName, blockNumber }) as Promise<bigint>;
    const [a1, m1, a0, m0] = await Promise.all([
      read("getAaveIndex", head.number), read("getMorphoIndex", head.number),
      read("getAaveIndex", lo), read("getMorphoIndex", lo),
    ]);
    const dt = Number(head.timestamp - past.timestamp);
    const annualise = (now: bigint, then: bigint) => {
      if (then <= 0n || dt <= 0) return null;
      const value = (Math.pow(Number(now) / Number(then), 365 * 86_400 / dt) - 1) * 100;
      return Number.isFinite(value) ? value : null;
    };
    const aave = annualise(a1, a0);
    const morpho = annualise(m1, m0);
    if (aave === null || morpho === null) return remember(empty("historical_unavailable", "APY is unavailable because historical strategy data could not be read."));
    return remember({ aave, morpho, blended: (aave + morpho) / 2, status: "available", message: "Annualized from the last 24 hours of on-chain index growth; not a guaranteed return." });
  } catch {
    console.warn(JSON.stringify({ level: "warn", event: "apy_history_unavailable" }));
    return remember(empty("historical_unavailable", "APY is unavailable because the RPC could not provide the required historical data."));
  }
}
