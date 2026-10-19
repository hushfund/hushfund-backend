/** Explicit allowlist. Never serialize process.env or server credentials. */
export function publicEnvironment(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  if ((env.NETWORK ?? "mainnet") !== "mainnet" || (env.VITE_NETWORK ?? "mainnet") !== "mainnet") {
    throw new Error("Public configuration requires Ethereum Mainnet");
  }
  const values: Record<string, string> = {
    VITE_NETWORK: "mainnet",
    VITE_API_URL: env.VITE_API_URL ?? "",
    VITE_CREATE_ENCRYPTED_SESSION_ENDPOINT:
      env.VITE_CREATE_ENCRYPTED_SESSION_ENDPOINT || "/api/protected-create-encryption-session",
    VITE_RPC_URL: env.VITE_RPC_URL ?? "",
    VITE_MAINNET_RPC_URL: env.VITE_MAINNET_RPC_URL ?? "",
    VITE_OPENFORT_PUBLISHABLE_KEY: env.VITE_OPENFORT_PUBLISHABLE_KEY ?? "",
    VITE_OPENFORT_SHIELD_PUBLISHABLE_KEY:
      env.VITE_OPENFORT_SHIELD_PUBLISHABLE_KEY ?? env.OPENFORT_SHIELD_PUBLISHABLE_KEY ?? "",
    VITE_WALLET_CONNECT_PROJECT_ID: env.VITE_WALLET_CONNECT_PROJECT_ID ?? "",
    VITE_DOCS_URL: env.VITE_DOCS_URL ?? "",
    VITE_GUIDE_URL: env.VITE_GUIDE_URL ?? "",
    VITE_X_URL: env.VITE_X_URL ?? "",
  };
  for (const value of Object.values(values)) {
    if (/(?:^|[^a-z])(?:sk_|ssk_)/i.test(value) || /^0x[0-9a-f]{64}$/i.test(value)) {
      throw new Error("A server credential was placed in public configuration");
    }
  }
  if (values.VITE_OPENFORT_PUBLISHABLE_KEY && !values.VITE_OPENFORT_PUBLISHABLE_KEY.startsWith("pk_live_")) {
    throw new Error("Openfort requires a live publishable key");
  }
  if (env.OPENFORT_SHIELD_PUBLISHABLE_KEY && values.VITE_OPENFORT_SHIELD_PUBLISHABLE_KEY !== env.OPENFORT_SHIELD_PUBLISHABLE_KEY) {
    throw new Error("Shield publishable keys must match");
  }
  return values;
}

export function publicEnvironmentScript(env: NodeJS.ProcessEnv = process.env): string {
  const json = JSON.stringify(publicEnvironment(env))
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  return `window.__HUSHFUND_ENV__ = Object.freeze(${json});\n`;
}
