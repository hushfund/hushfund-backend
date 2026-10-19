import fs from "node:fs";
import path from "node:path";

export type NetworkName = "mainnet";

export interface NetworkConfig {
  network: NetworkName;
  chainId: number;
  explorer: string;
  usdc: `0x${string}`;
  chainlinkEthUsd: `0x${string}`;
  denominationsUsdc: number[];
}

export interface Deployment {
  network: NetworkName;
  chainId: number;
  deployBlock: number;
  vaults: { denominationUsdc: number; address: `0x${string}` }[];
}

export interface RelayerConfig {
  /** Private key of the hot wallet that submits withdraw/borrow transactions. Empty = relayer disabled. */
  privateKey: `0x${string}` | "";
  /** Gas the relayer budgets for each action (verifier + Aave/Morpho). Validate estimates before enabling. */
  gasWithdraw: bigint;
  gasBorrow: bigint;
  /** Margin over cost, in basis points (2000 = +20%). */
  marginBps: bigint;
  /** Minimum fee in USDC base units (6 decimals). */
  minFee: bigint;
  /** Used only when no Chainlink feed is configured. USD per ETH. */
  ethUsdFallback: number;
  /** Refuse to relay when the hot wallet holds less than this (wei). */
  minBalanceWei: bigint;
  /** Developer-paid gas: the relayer also submits deposits and repayments, so users never need ETH. */
  sponsorDeposits: boolean;
  /** Developer-paid gas: withdraw/borrow relayer fee is 0 USDC (the developer covers that gas too). */
  sponsorFees: boolean;
  /** Gas budgeted for a deposit and a repayment. */
  gasDeposit: bigint;
  gasRepay: bigint;
  /** Most ETH (wei) the relayer may spend on sponsored transactions per UTC day; 0 = no cap. */
  dailyBudgetWei: bigint;
  /** Sponsored deposits + repayments allowed per depositing address per UTC day. */
  perAddressDaily: number;
}

export interface Config {
  port: number;
  allowedOrigins: string[];
  rpcUrl: string;
  net: NetworkConfig;
  deployment: Deployment;
  relayer: RelayerConfig;
  openfort: {
    secretKey: string;
    shield: { publishableKey: string; secretKey: string; encryptionShare: string };
  };
}

function readJson<T>(file: string): T {
  const full = path.resolve(process.cwd(), "..", file);
  if (!fs.existsSync(full)) {
    throw new Error(`Missing ${full}. ${file.startsWith("deployments") ? "Deploy the contracts first (see README)." : ""}`);
  }
  return JSON.parse(fs.readFileSync(full, "utf8")) as T;
}

function num(value: string | undefined, fallback: number): number {
  const n = value ? Number(value) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

export function normalizeRelayerKey(value: string | undefined): RelayerConfig["privateKey"] {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return "";
  const key = trimmed.replace(/^0x/i, "");
  if (!/^[0-9a-f]{64}$/i.test(key)) {
    throw new Error("RELAYER_PRIVATE_KEY must be a 32-byte hexadecimal private key");
  }
  return `0x${key}`;
}

export function loadConfig(): Config {
  const network = process.env.NETWORK ?? "mainnet";
  if (network !== "mainnet") throw new Error("NETWORK must be mainnet");

  const rpcUrl = process.env.RPC_URL ?? "";
  if (!rpcUrl) throw new Error("RPC_URL is required (an Ethereum RPC endpoint for the selected NETWORK)");

  const net = readJson<NetworkConfig>(`config/${network}.json`);
  const deployment = readJson<Deployment>(`deployments/${network}.json`);
  if (net.network !== "mainnet" || net.chainId !== 1 ||
      deployment.network !== "mainnet" || deployment.chainId !== 1) {
    throw new Error("Configuration and deployment must both use Ethereum Mainnet (chain ID 1)");
  }

  const pk = normalizeRelayerKey(process.env.RELAYER_PRIVATE_KEY);

  return {
    port: num(process.env.PORT, 3007),
    allowedOrigins: (process.env.CORS_ORIGINS ?? "").split(",").map((o) => o.trim()).filter(Boolean),
    rpcUrl,
    net,
    deployment,
    relayer: {
      privateKey: pk,
      gasWithdraw: BigInt(num(process.env.RELAYER_GAS_WITHDRAW, 6_000_000)),
      gasBorrow: BigInt(num(process.env.RELAYER_GAS_BORROW, 6_000_000)),
      marginBps: BigInt(num(process.env.RELAYER_MARGIN_BPS, 2000)),
      minFee: BigInt(Math.round(num(process.env.RELAYER_MIN_FEE_USDC, 1) * 1e6)),
      ethUsdFallback: num(process.env.ETH_USD_FALLBACK, 3000),
      minBalanceWei: BigInt(Math.round(num(process.env.RELAYER_MIN_BALANCE_ETH, 0) * 1e18)),
      sponsorDeposits: (process.env.SPONSOR_DEPOSITS ?? "true") === "true",
      sponsorFees: (process.env.SPONSOR_FEES ?? "true") === "true",
      gasDeposit: BigInt(num(process.env.RELAYER_GAS_DEPOSIT, 3_000_000)),
      gasRepay: BigInt(num(process.env.RELAYER_GAS_REPAY, 7_000_000)),
      dailyBudgetWei: BigInt(Math.round(num(process.env.SPONSOR_DAILY_BUDGET_ETH, 0.5) * 1e18)),
      perAddressDaily: num(process.env.SPONSOR_PER_ADDRESS_DAILY, 3),
    },
    openfort: {
      secretKey: process.env.OPENFORT_SECRET_KEY ?? "",
      shield: {
        publishableKey: process.env.OPENFORT_SHIELD_PUBLISHABLE_KEY ?? "",
        secretKey: process.env.OPENFORT_SHIELD_SECRET_KEY ?? "",
        encryptionShare: process.env.OPENFORT_SHIELD_ENCRYPTION_SHARE ?? "",
      },
    },
  };
}
