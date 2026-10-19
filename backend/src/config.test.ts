import assert from "node:assert/strict";
import test from "node:test";
import { normalizeRelayerKey } from "./config.js";

test("relayer accepts wallet exports with or without a hexadecimal prefix", () => {
  const key = "1".repeat(64);
  assert.equal(normalizeRelayerKey(key), `0x${key}`);
  assert.equal(normalizeRelayerKey(` \n0x${key} `), `0x${key}`);
  assert.equal(normalizeRelayerKey(`0X${key}`), `0x${key}`);
  assert.equal(normalizeRelayerKey(undefined), "");
});

test("relayer rejects malformed exports without echoing their value", () => {
  for (const value of ["bad-export", `0x${"1".repeat(40)}`, "z".repeat(64)]) {
    assert.throws(() => normalizeRelayerKey(value), {
      message: "RELAYER_PRIVATE_KEY must be a 32-byte hexadecimal private key",
    });
  }
});
