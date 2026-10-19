import { Openfort } from "@openfort/openfort-node";

export function createOpenfortClient(secretKey: string, publishableKey: string): Openfort | null {
  if (!secretKey.startsWith("sk_live_") || !publishableKey.startsWith("pk_live_")) {
    console.warn(JSON.stringify({ level: "warn", event: "live_wallet_auth_not_configured" }));
    return null;
  }
  return new Openfort(secretKey, { publishableKey, debugging: false });
}

export class ShieldSessionError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ShieldSessionError";
  }
}

export interface ShieldClient {
  iam: {
    getSession(params: { accessToken: string; disableCookieCache: boolean }): Promise<{
      user: { id: string };
      session: { userId?: string; expiresAt: string };
    } | null>;
  };
  createEncryptionSession(publicKey: string, secretKey: string, share: string): Promise<string>;
}

/** Verify ownership before releasing a short-lived wallet encryption session. */
export async function createWalletSession(
  client: ShieldClient | null,
  shield: { publishableKey: string; secretKey: string; encryptionShare: string },
  authorization: string | undefined,
  userId: unknown,
): Promise<string> {
  const match = authorization?.match(/^Bearer ([^\s]{1,8192})$/);
  if (!match) throw new ShieldSessionError("Sign in to access your wallet.", 401);
  if (typeof userId !== "string" || !userId || userId.length > 256) {
    throw new ShieldSessionError("A valid wallet user is required.", 400);
  }
  if (!client || !shield.publishableKey || !shield.secretKey || !shield.encryptionShare) {
    throw new ShieldSessionError("Wallet service is not configured. Please try again later.", 503);
  }
  let verified: Awaited<ReturnType<ShieldClient["iam"]["getSession"]>>;
  try {
    // React SDK uses IAM v2 SIWE sessions. The legacy v1 player-token endpoint
    // rejects a genuine v2 sign-in; do not fall back to decoding tokens locally.
    verified = await client.iam.getSession({ accessToken: match[1], disableCookieCache: true });
  } catch (error) {
    const failure = error as { status?: number; statusCode?: number };
    const status = failure?.statusCode ?? failure?.status;
    if (status === 401 || status === 403) {
      throw new ShieldSessionError("Your sign-in has expired. Please sign in again.", 401);
    }
    throw new ShieldSessionError("Wallet sign-in could not be verified. Please try again later.", 503);
  }
  if (!verified?.user?.id || !verified.session ||
      !Number.isFinite(Date.parse(verified.session.expiresAt)) ||
      Date.parse(verified.session.expiresAt) <= Date.now()) {
    throw new ShieldSessionError("Your sign-in has expired. Please sign in again.", 401);
  }
  // Some IAM v2 responses omit the redundant session.userId. The user identity
  // returned by the provider for this token is mandatory and authoritative.
  if (verified.user.id !== userId ||
      (verified.session.userId !== undefined && verified.session.userId !== userId)) {
    console.warn(JSON.stringify({
      level: "warn", event: "wallet_identity_mismatch",
      requestedMatchesVerifiedUser: verified.user.id === userId,
      sessionOwnerPresent: verified.session.userId !== undefined,
      sessionOwnerMatchesVerifiedUser: verified.session.userId === verified.user.id,
    }));
    throw new ShieldSessionError("This sign-in cannot access the requested wallet.", 403);
  }
  try {
    const result = await client.createEncryptionSession(shield.publishableKey, shield.secretKey, shield.encryptionShare);
    if (!result || typeof result !== "string") throw new Error("Invalid session response");
    return result;
  } catch {
    throw new ShieldSessionError("Wallet service is unavailable. Please try again later.", 503);
  }
}
