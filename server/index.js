import "dotenv/config";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { authRouter, cookieParser, purgeExpiredSessions } from "./auth.js";
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

async function main() {
  console.log("Running migrations...");
  await migrate();

  await purgeExpiredSessions().catch(() => {});
  setInterval(() => purgeExpiredSessions().catch(() => {}), 60 * 60 * 1000).unref();

  const stopScheduler = startScheduler();

  const server = app.listen(port, () => {
    console.log(`Follow-up texts listening on ${port}`);
    if (!process.env.SLACK_SIGNING_SECRET) console.warn("  SLACK_SIGNING_SECRET is not set: Slack requests will be rejected.");
    if (!process.env.QUO_API_KEY) console.warn("  QUO_API_KEY is not set: no texts can be sent.");
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
