import type { Request, Response } from "express";
import type { Openfort } from "@openfort/openfort-node";
import type { Address, Hex } from "viem";
import type { Config } from "./config.js";
import type { Chains } from "./chain.js";
import { LeafIndexer, readApy, readLoan, readVault } from "./vault.js";
import { Relayer, RelayError, type RelayAction } from "./relayer.js";
import { createWalletSession, ShieldSessionError } from "./openfort.js";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const HEX = /^0x[0-9a-fA-F]*$/;
const UINT = /^[0-9]{1,78}$/;

const isAddress = (v: unknown): v is Address => typeof v === "string" && ADDRESS.test(v);
const isBytes32 = (v: unknown): v is Hex => typeof v === "string" && BYTES32.test(v);
const isHex = (v: unknown): v is Hex => typeof v === "string" && HEX.test(v) && v.length % 2 === 0;
const isUint = (v: unknown): v is string => typeof v === "string" && UINT.test(v);

function fail(res: Response, status: number, error: string) {
  res.status(status).json({ error });
}

export function createRoutes(cfg: Config, chains: Chains, openfort: Openfort | null) {
  const indexer = new LeafIndexer(chains.publicClient, cfg);
  const relayer = new Relayer(cfg, chains);
  const loadSnapshot = async (block: bigint, hash: Hex) => {
    const vaults = await Promise.all(cfg.deployment.vaults.map(async ({ address }) => {
      const [leaves, info] = await Promise.all([
        indexer.getLeaves(address, block),
        readVault(chains.publicClient, address, block),
      ]);
      return {
        address, ...info,
        deposits: indexer.getDepositCount(address, block),
        leaves: leaves.filter(leaf => leaf.leafIndex < info.commitmentCount),
      };
    }));
    if ((await chains.publicClient.getBlock({ blockNumber: block })).hash !== hash) throw new Error("Chain changed during snapshot; retry required");
    return {
      asOfBlock: block.toString(),
      asOfBlockHash: hash,
      updatedAt: new Date().toISOString(),
      totalAssets: vaults.reduce((sum, vault) => sum + BigInt(vault.totalAssets), 0n).toString(),
      vaults,
    };
  };
  // All viewers share one read per block; rejected reads are never cached.
  let snapshot: { block: bigint; hash: Hex; result: ReturnType<typeof loadSnapshot> } | undefined;

  const vaultParam = (req: Request, res: Response): Address | null => {
    const v = req.query.vault ?? req.body?.vault;
    if (!isAddress(v) || !indexer.isKnownVault(v)) {
      fail(res, 400, "Unknown vault address");
      return null;
    }
    return v;
  };

  const wrap =
    (fn: (req: Request, res: Response) => Promise<void>) =>
    async (req: Request, res: Response) => {
      try {
        await fn(req, res);
      } catch (e) {
        if (e instanceof RelayError || e instanceof ShieldSessionError) return fail(res, e.status, e.message);
        console.error(JSON.stringify({ level: "error", event: "api_request_failed", errorType: e instanceof Error ? e.name : "Error" }));
        fail(res, 500, "Internal server error");
      }
    };

  return {
    readiness: () => relayer.ready(),
    health: wrap(async (_req, res) => {
      try { await relayer.ready(); }
      catch { return fail(res, 503, "Persistent relayer storage is unavailable. Check deployment database setup."); }
      res.json({ status: "ok", network: cfg.net.network, chainId: cfg.net.chainId, relayer: relayer.address });
    }),

    /** Network settings and vault list, so the frontend never needs hard-coded addresses. */
    config: wrap(async (_req, res) => {
      res.json({
        network: cfg.net.network,
        chainId: cfg.net.chainId,
        explorer: cfg.net.explorer,
        usdc: cfg.net.usdc,
        deployBlock: cfg.deployment.deployBlock,
        vaults: cfg.deployment.vaults,
        relayer: relayer.address,
        sponsoredGas: relayer.sponsorsDeposits,
        sponsoredFees: relayer.enabled && cfg.relayer.sponsorFees,
      });
    }),

    shieldSession: wrap(async (req, res) => {
      const session = await createWalletSession(
        openfort, cfg.openfort.shield, req.headers.authorization, req.body?.user_id,
      );
      res.setHeader("Cache-Control", "no-store");
      res.json({ session });
    }),

    commitments: wrap(async (req, res) => {
      const vault = vaultParam(req, res);
      if (!vault) return;
      const leaves = await indexer.getLeaves(vault);
      res.json({ commitments: leaves.map((l) => l.commitment) });
    }),

    stats: wrap(async (req, res) => {
      const vault = vaultParam(req, res);
      if (!vault) return;
      const header = await chains.publicClient.getBlock({ blockTag: "latest" });
      if (header.number === null || !header.hash) throw new Error("Chain header is not confirmed");
      const block = header.number;
      const [leaves, info] = await Promise.all([indexer.getLeaves(vault, block), readVault(chains.publicClient, vault, block)]);
      if ((await chains.publicClient.getBlock({ blockNumber: block })).hash !== header.hash) throw new Error("Chain changed during snapshot; retry required");
      res.setHeader("Cache-Control", "no-store");
      res.json({ ...info, asOfBlockHash: header.hash, deposits: indexer.getDepositCount(vault, block), leaves: leaves.filter(leaf => leaf.leafIndex < info.commitmentCount) });
    }),

    allStats: wrap(async (_req, res) => {
      const header = await chains.publicClient.getBlock({ blockTag: "latest" });
      if (header.number === null || !header.hash) throw new Error("Chain header is not confirmed");
      const block = header.number;
      if (!snapshot || snapshot.block !== block || snapshot.hash !== header.hash) {
        const entry = { block, hash: header.hash, result: loadSnapshot(block, header.hash) };
        snapshot = entry;
        void entry.result.catch(() => { if (snapshot === entry) snapshot = undefined; });
      }
      const data = await snapshot.result;
      res.setHeader("Cache-Control", "no-store");
      res.json(data);
    }),

    apy: wrap(async (req, res) => {
      const vault = vaultParam(req, res);
      if (!vault) return;
      res.json(await readApy(chains.publicClient, vault, cfg.deployment.deployBlock));
    }),

    loan: wrap(async (req, res) => {
      const vault = vaultParam(req, res);
      if (!vault) return;
      const h = req.query.collateralNullifierHash;
      if (!isBytes32(h)) return fail(res, 400, "collateralNullifierHash must be a 32-byte hex string");
      res.json(await readLoan(chains.publicClient, vault, h));
    }),

    quote: wrap(async (req, res) => {
      const action = req.query.action as RelayAction;
      if (action !== "withdraw" && action !== "borrow") return fail(res, 400, "action must be withdraw or borrow");
      if (!relayer.enabled) return fail(res, 503, "Relayer is not configured on this server");
      res.json(await relayer.quote(action));
    }),

    relayWithdraw: wrap(async (req, res) => {
      const vault = vaultParam(req, res);
      if (!vault) return;
      const b = req.body ?? {};
      if (!isHex(b.proof) || !isBytes32(b.root) || !isBytes32(b.nullifierHash) || !isBytes32(b.collateralNullifierHash)) {
        return fail(res, 400, "proof, root, nullifierHash and collateralNullifierHash are required");
      }
      if (!isUint(b.yieldIndex) || !isAddress(b.recipient) || !isUint(b.relayerFee)) {
        return fail(res, 400, "yieldIndex, recipient and relayerFee are required");
      }
      const txHash = await relayer.withdraw(vault, b);
      res.json({ txHash });
    }),

    relayBorrow: wrap(async (req, res) => {
      const vault = vaultParam(req, res);
      if (!vault) return;
      const b = req.body ?? {};
      if (!isHex(b.proof) || !isBytes32(b.root) || !isBytes32(b.collateralNullifierHash)) {
        return fail(res, 400, "proof, root and collateralNullifierHash are required");
      }
      if (!isUint(b.yieldIndex) || !isAddress(b.recipient) || !isUint(b.amount) || !isUint(b.relayerFee)) {
        return fail(res, 400, "yieldIndex, recipient, amount and relayerFee are required");
      }
      const txHash = await relayer.borrow(vault, b);
      res.json({ txHash });
    }),

    relayDeposit: wrap(async (req, res) => {
      const vault = vaultParam(req, res);
      if (!vault) return;
      const b = req.body ?? {};
      if (!isBytes32(b.innerCommitment) || !isHex(b.auth)) return fail(res, 400, "innerCommitment and auth are required");
      res.json({ txHash: await relayer.deposit(vault, b) });
    }),

    relayRepay: wrap(async (req, res) => {
      const vault = vaultParam(req, res);
      if (!vault) return;
      const b = req.body ?? {};
      if (!isHex(b.proof) || !isBytes32(b.root) || !isBytes32(b.nullifierHash) || !isBytes32(b.collateralNullifierHash)) {
        return fail(res, 400, "proof, root, nullifierHash and collateralNullifierHash are required");
      }
      if (!isUint(b.yieldIndex) || !isBytes32(b.newInnerCommitment) || !isHex(b.auth)) {
        return fail(res, 400, "yieldIndex, newInnerCommitment and auth are required");
      }
      res.json({ txHash: await relayer.repay(vault, b) });
    }),

  };
}
