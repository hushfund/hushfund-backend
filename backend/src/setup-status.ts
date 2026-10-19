import fs from "node:fs";
import path from "node:path";
import { isAddress, zeroAddress } from "viem";

/** Non-secret field names only: safe to return on the setup-status endpoint. */
export function backendSetupIssues(
  env: NodeJS.ProcessEnv = process.env,
  root = path.resolve(process.cwd(), ".."),
): string[] {
  const issues: string[] = [];
  if ((env.NETWORK ?? "mainnet") !== "mainnet") issues.push("NETWORK must be mainnet");
  if (!env.RPC_URL) issues.push("RPC_URL");
  let denominations: number[] = [];
  for (const file of ["config/mainnet.json", "deployments/mainnet.json"]) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
      if (data.network !== "mainnet" || data.chainId !== 1) issues.push(`${file}: mainnet chain ID 1 required`);
      if (file.startsWith("config/")) {
        for (const field of ["owner", "feeRecipient"]) {
          if (typeof data[field] !== "string" || !isAddress(data[field], { strict: false }) || data[field].toLowerCase() === zeroAddress) {
            issues.push(`${file}: ${field}`);
          }
        }
        if (data.useMockStrategies !== false) issues.push(`${file}: real strategies required`);
        denominations = data.denominationsUsdc;
        if (!Array.isArray(denominations) || !denominations.length || denominations.some(n => !Number.isSafeInteger(n) || n <= 0)) {
          issues.push(`${file}: denominationsUsdc`);
          denominations = [];
        }
      } else {
        if (!Number.isSafeInteger(data.deployBlock) || data.deployBlock <= 0) issues.push(`${file}: deployBlock`);
        const vaults: Array<{ address: string; denominationUsdc: number }> = data.vaults;
        if (!Array.isArray(vaults) || !vaults.length ||
            vaults.some(v => !v || typeof v.address !== "string" || !isAddress(v.address, { strict: false }) ||
              v.address.toLowerCase() === zeroAddress || !denominations.includes(v.denominationUsdc)) ||
            new Set(vaults.map(v => v.denominationUsdc)).size !== denominations.length ||
            new Set(vaults.map(v => v.address.toLowerCase())).size !== vaults.length) {
          issues.push(`${file}: verified vault addresses and denominations`);
        }
      }
    } catch {
      issues.push(file);
    }
  }
  return issues;
}
