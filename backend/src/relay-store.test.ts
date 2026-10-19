import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { encodeAbiParameters, parseAbiParameters, keccak256, parseTransaction, type PublicClient, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { mainnet } from "viem/chains";
import { RelayStore } from "./relay-store.js";
import { Relayer } from "./relayer.js";
import type { Config } from "./config.js";
import type { Chains } from "./chain.js";

const payer = "0x0000000000000000000000000000000000000001";
const raw = "0x1234" as Hex;
const hash = keccak256(raw);
function notFound(): never { const e = new Error("not mined"); e.name = "TransactionReceiptNotFoundError"; throw e; }
async function fixture(fn: (pool: Pool, scope: string, store: RelayStore, client: PublicClient) => Promise<void>, clientOverrides = {}) {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
  const scope = `fixture:${randomUUID()}`;
  const client = { getTransactionReceipt: async () => notFound(), getTransaction: async () => ({ hash }), sendRawTransaction: async () => hash, ...clientOverrides } as unknown as PublicClient;
  const store = new RelayStore(pool, scope, client);
  try { await fn(pool, scope, store, client); }
  finally { await pool.query("DELETE FROM hushfund_relay_submissions WHERE scope=$1", [scope]); await pool.end(); }
}
const options = { skip: !process.env.DATABASE_URL };
test("viem locally signs the prepared EIP-1559 request shape without sending anything", async () => {
  // Disposable, unfunded test identity. Never use a runtime secret or broadcast this payload.
  const account = privateKeyToAccount(generatePrivateKey());
  const serialized = await account.signTransaction({
    account, chain: mainnet, chainId: 1, type: "eip1559", nonce: 0, gas: 21_000n,
    maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n, to: payer, value: 0n,
  });
  const parsed = parseTransaction(serialized);
  assert.equal(parsed.chainId, 1); assert.equal(parsed.nonce, 0); assert.equal(parsed.to, payer);
});
test("Postgres serializes concurrent workers using the same signer scope", options, async () => {
  await fixture(async (pool, scope, first, client) => {
    const second = new RelayStore(pool, scope, client);
    let active = 0, max = 0;
    const work = async () => { active++; max = Math.max(max, active); await new Promise(r => setTimeout(r, 80)); active--; };
    await Promise.all([first.run(work), second.run(work)]);
    assert.equal(max, 1);
  });
});
test("signed reservations and nonce allocation survive store recreation", options, async () => {
  await fixture(async (pool, scope, first, client) => {
    await first.run(async () => {
      const id = await first.reserve(payer, 100n, 150n, 3, true);
      await first.signed(id, 8, hash, raw); await first.submitted(id);
    });
    const restarted = new RelayStore(pool, scope, client);
    await restarted.run(async () => {
      assert.equal(await restarted.nextNonce(0), 9);
      await assert.rejects(restarted.reserve(payer, 100n, 150n, 3, true), { status: 503 });
    });
  });
});
test("an uncertain signed broadcast is recovered with the identical payload", options, async () => {
  let sends = 0;
  await fixture(async (pool, scope, store) => {
    await store.run(async () => { const id = await store.reserve(payer, 100n, 1000n, 3, true); await store.signed(id, 0, hash, raw); });
    await store.run(async () => {});
    const result = await pool.query("SELECT status,reserved_cost FROM hushfund_relay_submissions WHERE scope=$1", [scope]);
    assert.equal(result.rows[0].status, "submitted"); assert.equal(result.rows[0].reserved_cost, "100"); assert.equal(sends, 1);
  }, { sendRawTransaction: async ({ serializedTransaction }: { serializedTransaction: Hex }) => { assert.equal(serializedTransaction, raw); sends++; return hash; } });
});
test("settlement uses actual cost on the original UTC day and removes signed payload", options, async () => {
  let mined = false;
  await fixture(async (pool, scope, store) => {
    await store.run(async () => { const id = await store.reserve(payer, 100n, 150n, 3, true); await store.signed(id, 0, hash, raw); await store.submitted(id); });
    await pool.query("UPDATE hushfund_relay_submissions SET day='2000-01-01' WHERE scope=$1", [scope]);
    mined = true;
    await store.run(async () => {
      await store.reserve(payer, 120n, 150n, 3, true);
    });
    const settled = await pool.query("SELECT actual_cost,signed_tx,status FROM hushfund_relay_submissions WHERE scope=$1 AND day='2000-01-01'", [scope]);
    assert.equal(settled.rows[0].actual_cost, "20");
    assert.equal(settled.rows[0].signed_tx, null);
  }, { getTransactionReceipt: async () => mined ? { gasUsed: 10n, effectiveGasPrice: 2n, status: "success" } : notFound() });
});
test("unsigned crash reservations can be cancelled without consuming a nonce", options, async () => {
  await fixture(async (_pool, _scope, store) => {
    await store.run(async () => { await store.reserve(payer, 100n, 100n, 1, true); });
    await store.run(async () => { assert.equal(await store.nextNonce(7), 7); await store.reserve(payer, 100n, 100n, 1, true); });
  });
});
test("valid exits do not consume or fail the admission quota, but new deposits and loans do", options, async () => {
  await fixture(async (_pool, _scope, store) => {
    await store.run(async () => {
      await store.reserve(payer, 10n, 100n, 1, true);
      await store.reserve(payer, 10n, 100n, 1, true, undefined, undefined, false);
      await assert.rejects(store.reserve(payer, 10n, 100n, 1, true), { status: 429 });
    });
  });
});
test("exit transactions still respect the global sponsored-gas budget", options, async () => {
  await fixture(async (_pool, _scope, store) => {
    await store.run(async () => {
      await store.reserve(payer, 10n, 15n, 1, true);
      await assert.rejects(store.reserve(payer, 10n, 15n, 1, true, undefined, undefined, false), { status: 503 });
    });
  });
});
test("deposit commits its signed outbox BEFORE broadcast and sends no duplicate on receipt recovery", options, async () => {
  await fixture(async (pool, scope, store, client) => {
    let sends = 0;
    Object.assign(client, {
      getBalance: async () => 10n ** 18n, getTransactionCount: async () => 0,
      simulateContract: async () => ({}),
      estimateContractGas: async () => 10n,
      sendRawTransaction: async () => {
        const r = await pool.query("SELECT status,tx_hash FROM hushfund_relay_submissions WHERE scope=$1", [scope]);
        assert.equal(r.rows[0].status, "signed"); assert.equal(r.rows[0].tx_hash, hash); sends++; return hash;
      },
    });
    const cfg = { relayer: { sponsorDeposits: true, sponsorFees: true, minBalanceWei: 0n, gasDeposit: 10n, dailyBudgetWei: 1000n, perAddressDaily: 3 } } as Config;
    const chains = { chain: { id: 1 }, publicClient: client, relayer: {
      account: { address: payer, signTransaction: async () => raw },
      wallet: { prepareTransactionRequest: async (p: object) => ({ ...p, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n }) },
    } } as unknown as Chains;
    const relay = new Relayer(cfg, chains, store);
    const auth = encodeAbiParameters(parseAbiParameters("address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32"),
      [payer, payer, 10n, 0n, 99999999n, `0x${"0".repeat(64)}`, 27, `0x${"1".repeat(64)}`, `0x${"2".repeat(64)}`]);
    assert.equal(await relay.deposit(payer, { innerCommitment: `0x${"3".repeat(64)}`, auth }), hash);
    assert.equal(await relay.deposit(payer, { innerCommitment: `0x${"3".repeat(64)}`, auth }), hash);
    const changedAuth = encodeAbiParameters(parseAbiParameters("address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32"),
      [payer, payer, 11n, 0n, 99999999n, `0x${"0".repeat(64)}`, 27, `0x${"1".repeat(64)}`, `0x${"2".repeat(64)}`]);
    await assert.rejects(relay.deposit(payer, { innerCommitment: `0x${"3".repeat(64)}`, auth: changedAuth }), { status: 409 });
    assert.equal(sends, 1);
  });
});
