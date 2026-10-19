import { BaseError, ContractFunctionRevertedError, decodeAbiParameters, encodeAbiParameters, encodeFunctionData, keccak256, type Address, type Hex, parseAbi } from "viem";
import { vaultAbi } from "./abi.js";
import type { Config } from "./config.js";
import type { Chains } from "./chain.js";
import { createRelayStore, type RelayStore } from "./relay-store.js";
import { RelayError } from "./relay-error.js";
export { RelayError } from "./relay-error.js";

/**
 * The relayer submits withdraw and borrow transactions on behalf of users, so the transaction sender is this hot
 * wallet instead of the user's own address. That is what keeps a withdrawal unlinkable from the deposit.
 *
 * The proof binds recipient, relayer address and relayer fee (ext_data_hash), so the relayer can neither redirect
 * funds nor raise its fee. It is paid in USDC by the vault out of the withdrawal or loan.
 *
 * Developer-paid gas: deposits and repayments are authorised with a USDC signature (EIP-3009) whose nonce the vault
 * binds to the note, so anyone may submit them. With SPONSOR_DEPOSITS the relayer submits them and the developer's
 * ETH pays the gas; with SPONSOR_FEES the withdraw/borrow fee is 0 as well. A daily ETH budget and a per-address
 * limit stop spam from draining the wallet, and every transaction is simulated first, so failing ones cost nothing.
 */

const chainlinkAbi = parseAbi([
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
]);

export type RelayAction = "withdraw" | "borrow";

const authAbi = [
  { type: "address" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" },
  { type: "bytes32" }, { type: "uint8" }, { type: "bytes32" }, { type: "bytes32" },
] as const;

export interface Quote {
  relayer: Address;
  fee: string; // USDC base units
  gasLimit: string;
  ethUsd: number;
  maxFeePerGas: string;
  validUntil: number;
}

export class Relayer {
  private store?: RelayStore;

  constructor(private cfg: Config, private chains: Chains, store?: RelayStore) { this.store = store; }

  get enabled(): boolean {
    return this.chains.relayer !== null;
  }

  get address(): Address | null {
    return this.chains.relayer?.account.address ?? null;
  }

  async ethUsd(): Promise<number> {
    const feed = this.cfg.net.chainlinkEthUsd;
    if (!feed || /^0x0{40}$/i.test(feed)) return this.cfg.relayer.ethUsdFallback;
    const [, answer, , updatedAt] = await this.chains.publicClient.readContract({
      address: feed,
      abi: chainlinkAbi,
      functionName: "latestRoundData",
    });
    if (answer <= 0n) throw new Error("Chainlink returned a non-positive ETH price");
    if (Date.now() / 1000 - Number(updatedAt) > 3 * 3600) throw new Error("Chainlink ETH/USD price is stale");
    return Number(answer) / 1e8;
  }

  /** Fee in USDC for an action at the current gas price, with the configured margin and minimum. */
  async quote(action: RelayAction): Promise<Quote> {
    if (!this.address) throw new Error("Relayer is not configured on this server");
    const gasLimit = action === "withdraw" ? this.cfg.relayer.gasWithdraw : this.cfg.relayer.gasBorrow;
    const fees = await this.chains.publicClient.estimateFeesPerGas();
    const maxFeePerGas = fees.maxFeePerGas ?? (await this.chains.publicClient.getGasPrice());
    const ethUsd = await this.ethUsd();

    const costWei = gasLimit * maxFeePerGas;
    // USDC (6 decimals) = wei * price / 1e18 * 1e6 ; price scaled by 1e6 to stay in integers
    const priceE6 = BigInt(Math.round(ethUsd * 1e6));
    let fee = (costWei * priceE6) / 10n ** 18n;
    fee = (fee * (10_000n + this.cfg.relayer.marginBps)) / 10_000n;
    if (fee < this.cfg.relayer.minFee) fee = this.cfg.relayer.minFee;
    if (this.cfg.relayer.sponsorFees) fee = 0n;

    return {
      relayer: this.address,
      fee: fee.toString(),
      gasLimit: gasLimit.toString(),
      ethUsd,
      maxFeePerGas: maxFeePerGas.toString(),
      validUntil: Math.floor(Date.now() / 1000) + 120,
    };
  }

  /** Accepts a fee that is at least 80% of the current quote (gas can move between quote and submission). */
  private async checkFee(action: RelayAction, fee: bigint) {
    const q = await this.quote(action);
    const floor = (BigInt(q.fee) * 8n) / 10n;
    if (fee < floor) throw new RelayError(`Relayer fee too low: offered ${fee}, need at least ${floor}`, 400);
  }

  private async checkBalance() {
    const r = this.chains.relayer!;
    const bal = await this.chains.publicClient.getBalance({ address: r.account.address });
    if (bal < this.cfg.relayer.minBalanceWei) {
      console.error(`[relayer] balance low: ${bal} wei`);
      throw new RelayError("Relayer is temporarily out of gas funds. Try again later or submit from a fresh wallet.", 503);
    }
  }

  get sponsorsDeposits(): boolean {
    return this.enabled && this.cfg.relayer.sponsorDeposits;
  }

  private get storage() {
    if (!this.chains.relayer) throw new RelayError("Relayer is not configured.", 503);
    this.store ??= createRelayStore(this.chains.relayer.account.address, this.chains.publicClient);
    return this.store;
  }

  async ready() { if (this.enabled) await this.storage.ready(); }

  /** Persist the signed payload and its hash BEFORE any broadcast, so crash recovery cannot lose it. */
  private async broadcast(vault: Address, data: Hex, gas: bigint, payer: Address, sponsored: boolean, identity: Hex, addressLimited = true): Promise<Hex> {
    const r = this.chains.relayer!;
    const requestKey = keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes4" }, { type: "bytes32" }], [vault, data.slice(0, 10) as Hex, identity]));
    const callHash = keccak256(data);
    const existing = await this.storage.existing(requestKey, callHash);
    if (existing) return existing;
    const request = await r.wallet.prepareTransactionRequest({ account: r.account, chain: this.chains.chain, to: vault, data, gas, type: "eip1559",
      nonce: await this.storage.nextNonce(await this.chains.publicClient.getTransactionCount({ address: r.account.address, blockTag: "pending" })),
    });
    const cost = gas * request.maxFeePerGas;
    const balance = await this.chains.publicClient.getBalance({ address: r.account.address });
    if (balance < cost) throw new RelayError("Relayer cannot cover this transaction's current gas cost. Try again later.", 503);
    const id = await this.storage.reserve(payer, cost, this.cfg.relayer.dailyBudgetWei, this.cfg.relayer.perAddressDaily, sponsored, requestKey, callHash, addressLimited);
    let recorded = false;
    try {
      const raw = await r.account.signTransaction(request);
      const hash = keccak256(raw);
      await this.storage.signed(id, request.nonce, hash, raw);
      recorded = true;
      await this.chains.publicClient.sendRawTransaction({ serializedTransaction: raw });
      await this.storage.submitted(id);
      return hash;
    } catch (e) {
      // Once signed data is recorded, a broadcast failure may be ambiguous. Keep its reservation.
      if (!recorded) await this.storage.cancel(id);
      throw e;
    }
  }

  private payerOf(auth: Hex): Address {
    try {
      return decodeAbiParameters(authAbi, auth)[0] as Address;
    } catch {
      throw new RelayError("Malformed USDC authorization", 400);
    }
  }

  /** Submits a deposit signed by the user. The developer's ETH pays the gas. */
  async deposit(vault: Address, p: DepositRequest): Promise<Hex> {
    if (!this.sponsorsDeposits) throw new RelayError("Sponsored deposits are turned off on this server", 503);
    const payer = this.payerOf(p.auth);
    const r = this.chains.relayer!;
    await simulate(() =>
      this.chains.publicClient.simulateContract({
        address: vault,
        abi: vaultAbi,
        functionName: "depositWithAuthorization",
        args: [p.innerCommitment, p.auth],
        account: r.account,
        gas: this.cfg.relayer.gasDeposit,
      }),
      () => this.chains.publicClient.estimateContractGas({ address: vault, abi: vaultAbi,
        functionName: "depositWithAuthorization", args: [p.innerCommitment, p.auth], account: r.account }),
      this.cfg.relayer.gasDeposit,
    );
    return this.sponsored(payer, this.cfg.relayer.gasDeposit, vault, encodeFunctionData({ abi: vaultAbi, functionName: "depositWithAuthorization", args: [p.innerCommitment, p.auth] }), p.innerCommitment);
  }

  /** Submits a loan repayment (proof + USDC signature) for the user. The developer's ETH pays the gas. */
  async repay(vault: Address, p: RepayRequest): Promise<Hex> {
    if (!this.sponsorsDeposits) throw new RelayError("Sponsored repayments are turned off on this server", 503);
    const payer = this.payerOf(p.auth);
    const r = this.chains.relayer!;
    await simulate(() =>
      this.chains.publicClient.simulateContract({
        address: vault,
        abi: vaultAbi,
        functionName: "repayWithAuthorization",
        args: [p.proof, p.root, p.nullifierHash, p.collateralNullifierHash, BigInt(p.yieldIndex), p.newInnerCommitment, p.auth],
        account: r.account,
        gas: this.cfg.relayer.gasRepay,
      }),
      () => this.chains.publicClient.estimateContractGas({ address: vault, abi: vaultAbi,
        functionName: "repayWithAuthorization",
        args: [p.proof, p.root, p.nullifierHash, p.collateralNullifierHash, BigInt(p.yieldIndex), p.newInnerCommitment, p.auth], account: r.account }),
      this.cfg.relayer.gasRepay,
    );
    return this.sponsored(payer, this.cfg.relayer.gasRepay, vault, encodeFunctionData({ abi: vaultAbi, functionName: "repayWithAuthorization", args: [p.proof, p.root, p.nullifierHash, p.collateralNullifierHash, BigInt(p.yieldIndex), p.newInnerCommitment, p.auth] }), p.newInnerCommitment, false);
  }

  private sponsored(payer: Address, gas: bigint, vault: Address, data: Hex, identity: Hex, addressLimited = true): Promise<Hex> {
    return this.serial(async () => {
      await this.checkBalance();
      return this.broadcast(vault, data, gas, payer, true, identity, addressLimited);
    });
  }

  /** Transactions are sent one at a time so nonces never collide. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    return this.storage.run(fn);
  }

  async withdraw(vault: Address, p: WithdrawRequest): Promise<Hex> {
    if (!this.enabled) throw new RelayError("Relayer is not configured on this server", 503);
    await this.checkFee("withdraw", BigInt(p.relayerFee));
    return this.serial(async () => {
      await this.checkBalance();
      const r = this.chains.relayer!;
      const args = [
        p.proof,
        p.root,
        p.nullifierHash,
        p.collateralNullifierHash,
        BigInt(p.yieldIndex),
        p.recipient,
        r.account.address,
        BigInt(p.relayerFee),
      ] as const;
      await simulate(() =>
        this.chains.publicClient.simulateContract({
          address: vault,
          abi: vaultAbi,
          functionName: "withdraw",
          args,
          account: r.account,
          gas: this.cfg.relayer.gasWithdraw,
        }),
        () => this.chains.publicClient.estimateContractGas({ address: vault, abi: vaultAbi,
          functionName: "withdraw", args, account: r.account }),
        this.cfg.relayer.gasWithdraw,
      );
      return this.broadcast(vault, encodeFunctionData({ abi: vaultAbi, functionName: "withdraw", args }), this.cfg.relayer.gasWithdraw, p.recipient, this.cfg.relayer.sponsorFees, p.nullifierHash, false);
    });
  }

  async borrow(vault: Address, p: BorrowRequest): Promise<Hex> {
    if (!this.enabled) throw new RelayError("Relayer is not configured on this server", 503);
    await this.checkFee("borrow", BigInt(p.relayerFee));
    return this.serial(async () => {
      await this.checkBalance();
      const r = this.chains.relayer!;
      const args = [
        p.proof,
        p.root,
        p.collateralNullifierHash,
        BigInt(p.yieldIndex),
        p.recipient,
        BigInt(p.amount),
        r.account.address,
        BigInt(p.relayerFee),
      ] as const;
      await simulate(() =>
        this.chains.publicClient.simulateContract({
          address: vault,
          abi: vaultAbi,
          functionName: "borrow",
          args,
          account: r.account,
          gas: this.cfg.relayer.gasBorrow,
        }),
        () => this.chains.publicClient.estimateContractGas({ address: vault, abi: vaultAbi,
          functionName: "borrow", args, account: r.account }),
        this.cfg.relayer.gasBorrow,
      );
      return this.broadcast(vault, encodeFunctionData({ abi: vaultAbi, functionName: "borrow", args }), this.cfg.relayer.gasBorrow, p.recipient, this.cfg.relayer.sponsorFees, p.collateralNullifierHash);
    });
  }
}

export interface WithdrawRequest {
  proof: Hex;
  root: Hex;
  nullifierHash: Hex;
  collateralNullifierHash: Hex;
  yieldIndex: string;
  recipient: Address;
  relayerFee: string;
}

export interface DepositRequest {
  innerCommitment: Hex;
  auth: Hex;
}

export interface RepayRequest {
  proof: Hex;
  root: Hex;
  nullifierHash: Hex;
  collateralNullifierHash: Hex;
  yieldIndex: string;
  newInnerCommitment: Hex;
  auth: Hex;
}

export interface BorrowRequest {
  proof: Hex;
  root: Hex;
  collateralNullifierHash: Hex;
  yieldIndex: string;
  recipient: Address;
  amount: string;
  relayerFee: string;
}

/** Runs a simulation and turns a contract revert into a readable 400 error (e.g. Hushfund__NoteAlreadySpent). */
export async function simulate<T>(fn: () => Promise<T>, estimate: () => Promise<bigint>, gasLimit: bigint): Promise<T> {
  try {
    const needed = await estimate();
    if (needed > gasLimit) {
      console.warn(JSON.stringify({ level: "warn", event: "relay_gas_limit_too_low",
        estimatedGas: needed.toString(), configuredGas: gasLimit.toString() }));
      throw new RelayError("Current transaction needs more gas than the configured limit. No transaction was sent.", 503);
    }
    return await fn();
  } catch (e) {
    if (e instanceof BaseError) {
      const revert = e.walk((err) => err instanceof ContractFunctionRevertedError);
      if (revert instanceof ContractFunctionRevertedError) {
        const name = revert.data?.errorName ?? "reverted";
        throw new RelayError(`Transaction would fail: ${name}`, 400);
      }
    }
    throw e;
  }
}
