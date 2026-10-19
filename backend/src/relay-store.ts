import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import type { Address, Hex, PublicClient } from "viem";
import { RelayError } from "./relay-error.js";

export function sponsorshipPayerKey(scope: string, payer: Address, addressLimited = true) {
  return createHash("sha256").update(`${scope}:${addressLimited ? "" : "exit:"}${payer.toLowerCase()}`).digest("hex");
}
/** Session-scoped Postgres locks serialize ALL replicas sharing the same Mainnet signer.
 * Reservations commit before signing. Signed outbox entries commit before broadcasting.
 * Uncertain broadcasts retain their full reservation, never silently resetting the budget.
 */
export class RelayStore {
  private connection = new AsyncLocalStorage<PoolClient>();
  constructor(private pool: Pool, private scope: string, private client: PublicClient) {}
  async ready() {
    await this.pool.query("SELECT id, nonce, signed_tx, request_key, call_hash FROM hushfund_relay_submissions LIMIT 0");
  }
  private get db() {
    const c = this.connection.getStore();
    if (!c) throw new RelayError("Relayer storage lock is unavailable.", 503);
    return c;
  }
  async run<T>(fn: () => Promise<T>): Promise<T> {
    let c: PoolClient;
    try { c = await this.pool.connect(); }
    catch { throw new RelayError("Relayer storage is temporarily unavailable.", 503); }
    let locked = false;
    let healthy = true;
    try {
      const deadline = Date.now() + 20_000;
      do {
        const result = await c.query("SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked", [this.scope]);
        locked = result.rows[0].locked;
        if (!locked) await new Promise(resolve => setTimeout(resolve, 100));
      } while (!locked && Date.now() < deadline);
      if (!locked) throw new RelayError("Relayer is busy. Try again shortly.", 503);
      return await this.connection.run(c, async () => {
        await this.reconcile();
        return fn();
      });
    } catch (e) {
      if (e instanceof RelayError) throw e;
      console.error(JSON.stringify({ level: "error", event: "relay_operation_failed", errorType: e instanceof Error ? e.name : "Error" }));
      throw new RelayError("Relayer request could not be completed. Check transaction status before retrying.", 503);
    } finally {
      if (locked) {
        try { await c.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [this.scope]); }
        catch { healthy = false; }
      }
      c.release(!healthy);
    }
  }
  async existing(requestKey: string, callHash: string): Promise<Hex | undefined> {
    const r = await this.db.query("SELECT tx_hash,call_hash FROM hushfund_relay_submissions WHERE scope=$1 AND request_key=$2", [this.scope, requestKey]);
    if (r.rows[0] && r.rows[0].call_hash !== callHash) throw new RelayError("A transaction for this note already exists with different parameters. Check its status before making a new request.", 409);
    return r.rows[0]?.tx_hash as Hex | undefined;
  }
  async reserve(payer: Address, cost: bigint, cap: bigint, perAddress: number, sponsored: boolean, requestKey?: string, callHash?: string, addressLimited = true) {
    const day = new Date().toISOString().slice(0, 10);
    const payerKey = sponsorshipPayerKey(this.scope, payer, addressLimited);
    if (sponsored) {
      const { rows } = await this.db.query(
        `SELECT COALESCE(SUM(COALESCE(actual_cost,reserved_cost)),0) AS spent,
        COUNT(*) FILTER (WHERE payer_key=$3) AS used
         FROM hushfund_relay_submissions WHERE scope=$1 AND day=$2 AND sponsored AND status <> 'cancelled'`,
        [this.scope, day, payerKey],
      );
      // Admission limits must not prevent closing an already-admitted position.
      // Exits still require proof/authorization and consume the global gas budget.
      if (addressLimited && Number(rows[0].used) >= perAddress) throw new RelayError("Daily limit of sponsored deposits and loans reached for this wallet. Try again tomorrow.", 429);
      if (cap > 0n && BigInt(rows[0].spent) + cost > cap) throw new RelayError("Sponsored gas for today is used up. Try again tomorrow.", 503);
    }
    const id = randomUUID();
    await this.db.query(
      `INSERT INTO hushfund_relay_submissions(id,scope,payer_key,day,reserved_cost,sponsored,request_key,call_hash,status)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,'reserved')`, [id, this.scope, payerKey, day, cost.toString(), sponsored, requestKey ?? null, callHash ?? null],
    );
    return id;
  }
  async nextNonce(pending: number) {
    const result = await this.db.query("SELECT MAX(nonce) AS nonce FROM hushfund_relay_submissions WHERE scope=$1", [this.scope]);
    return Math.max(pending, result.rows[0].nonce === null ? 0 : Number(result.rows[0].nonce) + 1);
  }
  async signed(id: string, nonce: number, hash: Hex, raw: Hex) {
    const result = await this.db.query("UPDATE hushfund_relay_submissions SET nonce=$2,tx_hash=$3,signed_tx=$4,status='signed' WHERE id=$1 AND scope=$5 AND status='reserved'", [id, nonce, hash, raw, this.scope]);
    if (result.rowCount !== 1) throw new RelayError("Relayer reservation was not saved. No new transaction was sent.", 503);
  }
  async submitted(id: string) {
    await this.db.query("UPDATE hushfund_relay_submissions SET status='submitted' WHERE id=$1 AND scope=$2", [id, this.scope]);
  }
  async cancel(id: string) {
    await this.db.query("UPDATE hushfund_relay_submissions SET status='cancelled',request_key=NULL WHERE id=$1 AND scope=$2 AND status='reserved'", [id, this.scope]);
  }
  private async reconcile() {
    // A process may die before it signs. No nonce/payload existed, so that reservation is safe to cancel.
    await this.db.query("UPDATE hushfund_relay_submissions SET status='cancelled',request_key=NULL WHERE scope=$1 AND status='reserved'", [this.scope]);
    const result = await this.db.query(
      "SELECT id,tx_hash,signed_tx,status FROM hushfund_relay_submissions WHERE scope=$1 AND status IN ('signed','submitted') ORDER BY nonce", [this.scope],
    );
    for (const row of result.rows) {
      let receipt;
      try { receipt = await this.client.getTransactionReceipt({ hash: row.tx_hash as Hex }); }
      catch (e) {
        if (!(e instanceof Error) || e.name !== "TransactionReceiptNotFoundError") throw e;
      }
      if (receipt) {
        await this.db.query(
          "UPDATE hushfund_relay_submissions SET actual_cost=$2,status=$3,signed_tx=NULL,request_key=CASE WHEN $3='reverted' THEN NULL ELSE request_key END WHERE id=$1",
          [row.id, (receipt.gasUsed * receipt.effectiveGasPrice).toString(), receipt.status === "success" ? "confirmed" : "reverted"],
        );
      } else if (row.status === "signed" || !await this.client.getTransaction({ hash: row.tx_hash as Hex }).catch(() => null)) {
        // Re-broadcast only an already signed, previously requested payload, never create a new transaction.
        try { await this.client.sendRawTransaction({ serializedTransaction: row.signed_tx as Hex }); }
        catch {
          const known = await this.client.getTransaction({ hash: row.tx_hash as Hex }).catch(() => null);
          if (!known) throw new RelayError("An earlier relay request is awaiting recovery. Try again shortly; do not make a second deposit.", 503);
        }
        await this.submitted(row.id);
      }
    }
  }
}

let sharedPool: Pool | undefined;
export function createRelayStore(address: Address, client: PublicClient) {
  if (!process.env.DATABASE_URL) throw new RelayError("Persistent relayer storage is not configured.", 503);
  if (!sharedPool) {
    sharedPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5, connectionTimeoutMillis: 10_000, query_timeout: 15_000, keepAlive: true });
    sharedPool.on("error", () => console.error(JSON.stringify({ level: "error", event: "relay_database_connection_failed" })));
  }
  return new RelayStore(sharedPool, `1:${address.toLowerCase()}`, client);
}
