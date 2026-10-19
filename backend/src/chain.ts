import { createPublicClient, createWalletClient, http, type PublicClient, type WalletClient, type Chain } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { mainnet } from "viem/chains";
import type { Config } from "./config.js";

export interface Chains {
  chain: Chain;
  publicClient: PublicClient;
  relayer: { account: PrivateKeyAccount; wallet: WalletClient } | null;
}

export function createChains(cfg: Config): Chains {
  if (cfg.net.chainId !== 1) throw new Error("Only Ethereum Mainnet (chain ID 1) is supported");
  const chain = mainnet;
  const publicClient = createPublicClient({ chain, transport: http(cfg.rpcUrl) }) as PublicClient;
  let relayer: Chains["relayer"] = null;
  if (cfg.relayer.privateKey) {
    const account = privateKeyToAccount(cfg.relayer.privateKey);
    relayer = { account, wallet: createWalletClient({ account, chain, transport: http(cfg.rpcUrl) }) };
  }
  return { chain, publicClient, relayer };
}
