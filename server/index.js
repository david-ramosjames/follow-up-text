import "dotenv/config";
import http from "node:http";
import express from "express";

// Open a port before importing the rest of the app. Railway's healthcheck is a
// TCP probe of /healthz; if loading Postgres, Slack or the LLM SDKs hangs or
// throws, the probe never connects and the deploy is rolled back with
// "service unavailable" — which is what the last three deploys did.

const app = express();
app.disable("x-powered-by");
app.get("/healthz", (req, res) => res.json({ ok: true, uptime: process.uptime() }));
app.head("/healthz", (req, res) => res.status(200).end());

const port = Number(process.env.PORT ?? 3000);
const server = http.createServer(app);

function bind(host, extra = {}) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ port, host, ...extra });
  });
}

console.log(`Binding port ${port} (PORT=${process.env.PORT ?? "unset"})`);
try {
  // Dual-stack: Railway Metal probes v6, classic probes v4.
  await bind("::", { ipv6Only: false });
  console.log(`Follow-up texts listening on [::]:${port}`);
} catch (error) {
  console.warn(`:: bind failed (${error.code || error.message}), trying 0.0.0.0`);
  await bind("0.0.0.0");
  console.log(`Follow-up texts listening on 0.0.0.0:${port}`);
}

try {
  const { boot } = await import("./boot.js");
  await boot(app, server);
} catch (error) {
  console.error("Failed to start:", error);
}
