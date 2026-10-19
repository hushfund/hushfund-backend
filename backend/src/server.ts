import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { config as loadEnv } from "dotenv";
import { loadConfig, type Config } from "./config.js";
import { createChains, type Chains } from "./chain.js";
import { createOpenfortClient } from "./openfort.js";
import { createRoutes } from "./routes.js";
import { publicEnvironment, publicEnvironmentScript } from "./public-env.js";
import { backendSetupIssues } from "./setup-status.js";

loadEnv({ path: ".env.local" });
loadEnv();

let setupIssues = backendSetupIssues();
let cfg: Config | null = null;
let chains: Chains | null = null;
if (!setupIssues.length) {
  try {
    cfg = loadConfig();
    chains = createChains(cfg);
    if (await chains.publicClient.getChainId() !== 1) {
      setupIssues.push("RPC_URL must point to Ethereum Mainnet (chain ID 1)");
    }
  } catch {
    setupIssues.push("Unable to validate backend configuration or RPC_URL");
  }
}
if (setupIssues.length) {
  cfg = null;
  chains = null;
  console.warn(JSON.stringify({ level: "warn", event: "backend_setup_required", missing: setupIssues }));
}
const routes = cfg && chains ? createRoutes(cfg, chains, createOpenfortClient(
  cfg.openfort.secretKey, process.env.VITE_OPENFORT_PUBLISHABLE_KEY ?? "",
)) : null;
const app = express();
const port = Number(process.env.PORT ?? 3007);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be a valid service port");

// Behind a reverse proxy (Railway, Render, nginx) set TRUST_PROXY=1 so rate limits see the real client IP.
if (process.env.TRUST_PROXY) app.set("trust proxy", Number(process.env.TRUST_PROXY));

// ---------- rate limiting (in memory, per IP + route) ----------
const hits = new Map<string, { count: number; resetAt: number }>();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
}, 60_000).unref();

function limit(max: number, windowMs: number) {
  return (req: Request, res: Response, next: NextFunction) => {
    const key = `${req.ip}:${req.path}`;
    const now = Date.now();
    const e = hits.get(key);
    if (!e || e.resetAt <= now) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }
    if (e.count >= max) return void res.status(429).json({ error: "Too many requests, try again in a minute" });
    e.count++;
    next();
  };
}

// ---------- middleware ----------
app.disable("x-powered-by");
app.use((req, res, next) => {
  const requestId = randomUUID();
  const started = Date.now();
  res.setHeader("X-Request-Id", requestId);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.on("finish", () => console.log(JSON.stringify({
    level: res.statusCode >= 500 ? "error" : "info",
    event: "http_request", requestId, method: req.method,
    status: res.statusCode, durationMs: Date.now() - started,
  })));
  next();
});
app.use(express.json({ limit: "256kb" }));
app.use((req, res, next) => {
  const allowed = cfg?.allowedOrigins ?? (process.env.CORS_ORIGINS ?? "").split(",").map(o => o.trim()).filter(Boolean);
  const origin = req.headers.origin;
  // The independent ENS landing only reads public statistics, never signs or submits.
  const ensPublicRead = origin === "https://hushfund.eth.limo"
    && req.method === "GET"
    && ["/api/vault/stats/all", "/api/vault/apy", "/api/relay/quote"].includes(req.path);
  if (origin && (allowed.includes(origin) || ensPublicRead)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return void res.sendStatus(204);
  next();
});

// ---------- routes ----------
app.get(["/env.js", "/api/env.js"], (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    res.type("application/javascript").send(publicEnvironmentScript());
  } catch {
    res.status(503).type("application/javascript").send("throw new Error('Public configuration is invalid; review the mainnet setup.');");
  }
});
app.get("/api/public-env", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    res.json(publicEnvironment());
  } catch {
    res.status(503).json({ error: "Public configuration is invalid; review the mainnet setup." });
  }
});
// Liveness is distinct from blockchain readiness; it never claims vaults are ready.
app.get("/api/healthz", async (_req, res) => {
  let ready = Boolean(routes);
  if (routes) {
    try { await routes.readiness(); }
    catch { ready = false; }
  }
  res.json({ status: "running", ready, network: "mainnet", chainId: 1 });
});
if (routes) {
app.get("/api/health", routes.health);
app.get("/api/config", routes.config);
app.post("/api/protected-create-encryption-session", limit(10, 60_000), routes.shieldSession);
app.get("/api/vault/commitments", limit(30, 60_000), routes.commitments);
app.get("/api/vault/stats", limit(60, 60_000), routes.stats);
app.get("/api/vault/stats/all", limit(60, 60_000), routes.allStats);
app.get("/api/vault/loan", limit(60, 60_000), routes.loan);
app.get("/api/vault/apy", limit(60, 60_000), routes.apy);
app.get("/api/relay/quote", limit(60, 60_000), routes.quote);
app.post("/api/relay/withdraw", limit(5, 60_000), routes.relayWithdraw);
app.post("/api/relay/borrow", limit(5, 60_000), routes.relayBorrow);
app.post("/api/relay/deposit", limit(5, 60_000), routes.relayDeposit);
app.post("/api/relay/repay", limit(5, 60_000), routes.relayRepay);
} else {
  app.use("/api", (_req, res) => {
    res.status(503).json({
      status: "setup_required", error: "Backend setup is incomplete",
      network: "mainnet", chainId: 1, relayer: null, missing: setupIssues,
    });
  });
}

// ---------- web app (single-service hosting) ----------
// When ../frontend/dist exists (npm --prefix frontend run build), serve it from the same origin as the API.
const webDir = path.resolve(process.cwd(), "..", "frontend", "dist");
if (process.env.SERVE_FRONTEND !== "false" && fs.existsSync(path.join(webDir, "index.html"))) {
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    next();
  });
  app.use(
    "/assets",
    express.static(path.join(webDir, "assets"), { immutable: true, maxAge: "1y", fallthrough: false }),
  );
  app.use(
    express.static(webDir, {
      index: false,
      redirect: false,
      setHeaders: (res, file) => {
        if (/(circuits|borrow_circuits)\.json$/.test(file)) res.setHeader("Cache-Control", "no-cache");
      },
    }),
  );
  // single-page app: every non-API GET/HEAD returns index.html (wallet SDKs send HEAD / to check COOP)
  app.use((req, res, next) => {
    if ((req.method !== "GET" && req.method !== "HEAD") || req.path === "/api" || req.path.startsWith("/api/")) return next();
    res.setHeader("Cache-Control", "no-cache");
    const route = req.path.replace(/\/+$/, "") || "/";
    const publicPages = ["/", "/docs", "/app", "/app/deposit", "/app/withdraw", "/app/borrow", "/app/notes", "/app/activity"];
    if (!publicPages.includes(route)) {
      res.setHeader("X-Robots-Tag", "noindex");
      return void res.status(404).sendFile(path.join(webDir, "index.html"));
    }
    // Serve the route's crawler-readable metadata, not the homepage head on every route.
    res.sendFile(path.join(webDir, route === "/" ? "" : route.slice(1), "index.html"));
  });
  console.log(`Serving web app from ${webDir}`);
}

app.use((_req, res) => void res.status(404).json({ error: "Not found" }));
app.use((err: Error & { status?: number }, _req: Request, res: Response, _next: NextFunction) => {
  console.error(JSON.stringify({ level: "error", event: "request_failed", errorType: err.name }));
  const status = err.status === 400 || err.status === 413 ? err.status : 500;
  res.status(status).json({ error: status === 400 ? "Invalid JSON request" : status === 413 ? "Request too large" : "Internal server error" });
});

const server = app.listen(port, "0.0.0.0", () => {
  console.log(JSON.stringify({
    level: "info", event: "server_started", port, network: "mainnet",
    ready: Boolean(routes), relayer: chains?.relayer?.account.address ?? "disabled",
  }));
});
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}
