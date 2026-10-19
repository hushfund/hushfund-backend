import assert from "node:assert/strict";
import test from "node:test";
import { publicEnvironment, publicEnvironmentScript } from "./public-env.js";

test("public configuration excludes all server-only credentials and unknown VITE keys", () => {
  const values = publicEnvironment({
    NETWORK: "mainnet",
    RPC_URL: "SERVER_RPC_SENTINEL",
    RELAYER_PRIVATE_KEY: "RELAYER_SENTINEL",
    DEPLOYER_PRIVATE_KEY: "DEPLOYER_SENTINEL",
    OPENFORT_SECRET_KEY: "SERVER_SECRET_SENTINEL",
    OPENFORT_SHIELD_SECRET_KEY: "SHIELD_SECRET_SENTINEL",
    OPENFORT_SHIELD_ENCRYPTION_SHARE: "SHARE_SENTINEL",
    VITE_UNKNOWN_SECRET: "UNKNOWN_SENTINEL",
    VITE_RPC_URL: "https://browser.example.invalid",
  });
  assert.equal(values.VITE_NETWORK, "mainnet");
  assert.equal(values.VITE_RPC_URL, "https://browser.example.invalid");
  assert(!JSON.stringify(values).includes("SENTINEL"));
  assert(!("RPC_URL" in values));
  assert(!("VITE_UNKNOWN_SECRET" in values));
});

test("same-origin routing and Shield public-key fallback are automatic", () => {
  const values = publicEnvironment({ OPENFORT_SHIELD_PUBLISHABLE_KEY: "PUBLIC_SHIELD" });
  assert.equal(values.VITE_API_URL, "");
  assert.equal(values.VITE_CREATE_ENCRYPTED_SESSION_ENDPOINT, "/api/protected-create-encryption-session");
  assert.equal(values.VITE_OPENFORT_SHIELD_PUBLISHABLE_KEY, "PUBLIC_SHIELD");
});

test("runtime settings are read afresh instead of cached at build time", () => {
  const env = { VITE_DOCS_URL: "https://first.example.invalid" };
  assert.equal(publicEnvironment(env).VITE_DOCS_URL, env.VITE_DOCS_URL);
  env.VITE_DOCS_URL = "https://second.example.invalid";
  assert.equal(publicEnvironment(env).VITE_DOCS_URL, env.VITE_DOCS_URL);
});

test("non-mainnet settings and mismatched Shield keys are rejected", () => {
  assert.throws(() => publicEnvironment({ NETWORK: "unsupported" }));
  assert.throws(() => publicEnvironment({ VITE_NETWORK: "unsupported" }));
  assert.throws(() => publicEnvironment({
    OPENFORT_SHIELD_PUBLISHABLE_KEY: "ONE", VITE_OPENFORT_SHIELD_PUBLISHABLE_KEY: "TWO",
  }));
});

test("private credentials and non-live publishable keys cannot be served to browsers", () => {
  assert.throws(() => publicEnvironment({ VITE_OPENFORT_PUBLISHABLE_KEY: ["sk", "live", "fixture"].join("_") }));
  assert.throws(() => publicEnvironment({ VITE_DOCS_URL: `0x${"1".repeat(64)}` }));
  assert.throws(() => publicEnvironment({ VITE_OPENFORT_PUBLISHABLE_KEY: "pk_not_live" }));
});

test("script serialization cannot terminate a script element", () => {
  const script = publicEnvironmentScript({ VITE_DOCS_URL: "https://example.invalid/</script>" });
  assert(!script.includes("</script>"));
  assert(script.includes("\\u003c/script>"));
  assert(script.startsWith("window.__HUSHFUND_ENV__"));
});
