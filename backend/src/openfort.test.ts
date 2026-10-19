import assert from "node:assert/strict";
import test from "node:test";
import { createOpenfortClient, createWalletSession, type ShieldClient } from "./openfort.js";

const shield = { publishableKey: "PUBLIC_FIXTURE", secretKey: "PRIVATE_FIXTURE", encryptionShare: "SHARE_FIXTURE" };
function fixture() {
  let calls = 0;
  const client: ShieldClient = {
    iam: { getSession: async () => ({
      user: { id: "owner-fixture" },
      session: { userId: "owner-fixture", expiresAt: new Date(Date.now() + 60_000).toISOString() },
    }) },
    createEncryptionSession: async () => { calls++; return "SESSION_FIXTURE"; },
  };
  return { client, calls: () => calls };
}

test("anonymous and invalid bearer requests never create Shield sessions", async () => {
  const f = fixture();
  for (const auth of [undefined, "", "Basic fixture", "Bearer x y"]) {
    await assert.rejects(createWalletSession(f.client, shield, auth, "owner-fixture"), { status: 401 });
  }
  assert.equal(f.calls(), 0);
});

test("a provider-verified v2 user can access only their own wallet session", async () => {
  const f = fixture();
  await assert.rejects(createWalletSession(f.client, shield, "Bearer fixture", "another-user"), { status: 403 });
  assert.equal(f.calls(), 0);
  assert.equal(await createWalletSession(f.client, shield, "Bearer fixture", "owner-fixture"), "SESSION_FIXTURE");
  assert.equal(f.calls(), 1);
});

test("expired, absent, and malformed v2 sessions cannot access Shield", async () => {
  const f = fixture();
  for (const session of [null, { user: { id: "owner-fixture" }, session: { userId: "owner-fixture", expiresAt: "invalid" } },
    { user: { id: "owner-fixture" }, session: { userId: "owner-fixture", expiresAt: "2000-01-01T00:00:00Z" } }]) {
    f.client.iam.getSession = async () => session;
    await assert.rejects(createWalletSession(f.client, shield, "Bearer fixture", "owner-fixture"), { status: 401 });
  }
  for (const failure of [{ status: 401 }, { statusCode: 401 }, { statusCode: 403 }]) {
    f.client.iam.getSession = async () => { throw failure; };
    await assert.rejects(createWalletSession(f.client, shield, "Bearer fixture", "owner-fixture"), { status: 401 });
  }
  assert.equal(f.calls(), 0);
});

test("v2 identity and session owner must agree, and cookie cache is disabled", async () => {
  const f = fixture();
  f.client.iam.getSession = async (params) => {
    assert.deepEqual(params, { accessToken: "fixture", disableCookieCache: true });
    return { user: { id: "owner-fixture" }, session: {
      userId: "another-user", expiresAt: new Date(Date.now() + 60_000).toISOString(),
    } };
  };
  await assert.rejects(createWalletSession(f.client, shield, "Bearer fixture", "owner-fixture"), { status: 403 });
  assert.equal(f.calls(), 0);
});

test("provider-verified user identity is authoritative when the redundant session owner is omitted", async () => {
  const f = fixture();
  f.client.iam.getSession = async () => ({
    user: { id: "owner-fixture" },
    session: { expiresAt: new Date(Date.now() + 60_000).toISOString() },
  });
  assert.equal(await createWalletSession(f.client, shield, "Bearer fixture", "owner-fixture"), "SESSION_FIXTURE");
  await assert.rejects(createWalletSession(f.client, shield, "Bearer fixture", "another-user"), { status: 403 });
  assert.equal(f.calls(), 1);
});

test("missing or non-live project credentials never initialize a Shield auth client", () => {
  assert.equal(createOpenfortClient("", ""), null);
  assert.equal(createOpenfortClient("sk_fixture", "pk_fixture"), null);
  assert.equal(createOpenfortClient(["sk", "live", "fixture"].join("_"), ""), null);
});

test("provider failures are safe 503 errors without credential details", async () => {
  const f = fixture();
  f.client.createEncryptionSession = async () => { throw new Error(shield.secretKey); };
  await assert.rejects(createWalletSession(f.client, shield, "Bearer fixture", "owner-fixture"), {
    status: 503, message: "Wallet service is unavailable. Please try again later.",
  });
});
