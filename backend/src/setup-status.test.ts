import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { backendSetupIssues } from "./setup-status.js";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hushfund-setup-"));
  fs.mkdirSync(path.join(root, "config"));
  fs.mkdirSync(path.join(root, "deployments"));
  const config = {
    network: "mainnet", chainId: 1, owner: `0x${"1".repeat(40)}`,
    feeRecipient: `0x${"2".repeat(40)}`, useMockStrategies: false, denominationsUsdc: [100],
  };
  const deployment = {
    network: "mainnet", chainId: 1, deployBlock: 123,
    vaults: [{ denominationUsdc: 100, address: `0x${"3".repeat(40)}` }],
  };
  const save = () => {
    fs.writeFileSync(path.join(root, "config/mainnet.json"), JSON.stringify(config));
    fs.writeFileSync(path.join(root, "deployments/mainnet.json"), JSON.stringify(deployment));
  };
  save();
  return { root, config, deployment, save, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("a complete mainnet fixture passes local startup checks without sending transactions", () => {
  const f = fixture();
  try {
    assert.deepEqual(backendSetupIssues({ NETWORK: "mainnet", RPC_URL: "RPC_SENTINEL" }, f.root), []);
  } finally { f.cleanup(); }
});

test("missing RPC and deployment are reported as field names without secret values", () => {
  const f = fixture();
  try {
    fs.unlinkSync(path.join(f.root, "deployments/mainnet.json"));
    const issues = backendSetupIssues({}, f.root);
    assert(issues.includes("RPC_URL"));
    assert(issues.includes("deployments/mainnet.json"));
  } finally { f.cleanup(); }
});

test("wrong chain, mock strategies, zero owners, and placeholder vaults prevent readiness", () => {
  const f = fixture();
  try {
    f.config.chainId = 2;
    f.config.useMockStrategies = true;
    f.config.owner = `0x${"0".repeat(40)}`;
    f.deployment.vaults[0].address = "PLACEHOLDER";
    f.save();
    const issues = backendSetupIssues({ RPC_URL: "RPC_SENTINEL" }, f.root);
    assert(issues.some(s => s.includes("chain ID 1")));
    assert(issues.some(s => s.includes("owner")));
    assert(issues.some(s => s.includes("real strategies")));
    assert(issues.some(s => s.includes("verified vault")));
  } finally { f.cleanup(); }
});

test("duplicate vault addresses or denominations are not treated as a valid deployment", () => {
  const f = fixture();
  try {
    f.deployment.vaults.push({ ...f.deployment.vaults[0] });
    f.save();
    assert(backendSetupIssues({ RPC_URL: "RPC_SENTINEL" }, f.root).some(s => s.includes("verified vault")));
  } finally { f.cleanup(); }
});
