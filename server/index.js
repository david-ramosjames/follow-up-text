import "dotenv/config";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { authRouter, cookieParser, ensureBootstrapAdmins, purgeExpiredSessions } from "./auth.js";
import { migrate } from "./migrate.js";
import { startScheduler } from "./lib/dispatch.js";
import { apiRouter } from "./routes/api.js";
import { slackRouter } from "./routes/slack.js";
import { webhookRouter } from "./routes/webhooks.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const app = express();

// Railway terminates TLS upstream, so secure cookies and the public URL both
// depend on trusting the forwarded headers.
app.set("trust proxy", true);
app.disable("x-powered-by");

// Slack and Quo sign the exact bytes they sent, so the raw body has to survive
// parsing untouched.
const keepRawBody = (req, res, buffer) => { req.rawBody = buffer.toString("utf8"); };

app.get("/healthz", (req, res) => res.json({ ok: true, uptime: process.uptime() }));

app.use("/slack", express.urlencoded({ extended: true, verify: keepRawBody }), express.json({ verify: keepRawBody }));
app.use("/slack", slackRouter);

app.use("/webhooks", express.json({ verify: keepRawBody, type: () => true }));
app.use("/webhooks", webhookRouter);

app.use(cookieParser);
app.use("/auth", authRouter);
app.use("/api", apiRouter);

// The built single-page app. In development Vite serves it instead, on its own
// port, proxying /api back here.
const distDir = join(root, "dist");
if (existsSync(distDir)) {
  app.use(express.static(distDir, { index: false, maxAge: "1h" }));
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api") || req.path.startsWith("/slack") || req.path.startsWith("/webhooks")) {
      return next();
    }
    return res.sendFile(join(distDir, "index.html"));
  });
} else {
  app.get("/", (req, res) => res.status(503).send(
    "The front end has not been built. Run `npm run build`, or use `npm run dev` for the Vite server.",
  ));
}

app.use((error, req, res, next) => {
  console.error("Unhandled error", error);
  if (res.headersSent) return next(error);
  return res.status(500).json({ error: "Something went wrong." });
});

const port = Number(process.env.PORT ?? 3000);

// Printed at every boot so "what do I still need to set?" is answered by the
// deploy logs rather than by reading the source. Nothing here is fatal except a
// missing DATABASE_URL, which db.js catches first — the app is meant to start
// half-configured so somebody can sign in and finish the setup.
function reportConfiguration() {
  const checks = [
    ["DATABASE_URL", Boolean(process.env.DATABASE_URL), "the database"],
    ["PUBLIC_URL", Boolean(process.env.PUBLIC_URL), "OAuth redirects and secure cookies"],
    ["QUO_API_KEY", Boolean(process.env.QUO_API_KEY), "sending any text at all"],
    ["QUO_WEBHOOK_SECRET", Boolean(process.env.QUO_WEBHOOK_SECRET || process.env.QUO_WEBHOOK_TOKEN),
      "receiving replies, so nothing can stop a series"],
    ["SLACK_SIGNING_SECRET", Boolean(process.env.SLACK_SIGNING_SECRET),
      "accepting anything from Slack"],
    ["SLACK_BOT_TOKEN", Boolean(process.env.SLACK_BOT_TOKEN),
      "the start form and thread notifications"],
    ["GOOGLE_CLIENT_ID", Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
      "signing in with Google"],
    ["ADMIN_PASSWORD", Boolean(process.env.ADMIN_PASSWORD),
      "the first sign-in, before anybody is on the access list"],
    ["BOOTSTRAP_ADMIN_EMAIL", Boolean(process.env.BOOTSTRAP_ADMIN_EMAIL),
      "granting yourself dashboard access without the password"],
  ];

  const missing = checks.filter(([, present]) => !present);
  if (!missing.length) {
    console.log("Configuration: everything is set.");
    return;
  }

  console.log(`Configuration: ${checks.length - missing.length} of ${checks.length} set. Missing:`);
  for (const [name, , why] of missing) console.log(`  ${name.padEnd(22)} needed for ${why}`);
  if (!process.env.GOOGLE_CLIENT_ID && !process.env.ADMIN_PASSWORD) {
    console.log("  -> With neither GOOGLE_CLIENT_ID nor ADMIN_PASSWORD, nobody can sign in.");
  } else if (!process.env.BOOTSTRAP_ADMIN_EMAIL && !process.env.ADMIN_PASSWORD) {
    console.log("  -> Set BOOTSTRAP_ADMIN_EMAIL to your work email to grant yourself access.");
  }
}

async function main() {
  console.log("Running migrations...");
  await migrate();

  const bootstrapped = await ensureBootstrapAdmins().catch((error) => {
    console.error("BOOTSTRAP_ADMIN_EMAIL could not be applied:", error.message);
    return [];
  });
  for (const entry of bootstrapped) console.log(`Dashboard access: ${entry}`);

  await purgeExpiredSessions().catch(() => {});
  setInterval(() => purgeExpiredSessions().catch(() => {}), 60 * 60 * 1000).unref();

  const stopScheduler = startScheduler();

  const server = app.listen(port, () => {
    console.log(`Follow-up texts listening on ${port}`);
    reportConfiguration();
  });

  const shutdown = () => {
    console.log("Shutting down...");
    stopScheduler();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 8000).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((error) => {
  console.error("Failed to start:", error.message);
  process.exit(1);
});
