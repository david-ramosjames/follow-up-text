#!/usr/bin/env node
// Sets up the Quo webhook that tells this app a client replied.
//
// The Quo app has a webhook screen (Settings -> Webhooks), and clicking through
// it is fine. This covers what that screen cannot: checking what is registered
// from the command line, and proving the signing secret actually matches what
// the deployment has.
//
//   node scripts/quo-webhook.mjs list        what is registered today
//   node scripts/quo-webhook.mjs setup       create (or replace) ours, print the secret
//   node scripts/quo-webhook.mjs test        prove QUO_WEBHOOK_SECRET is right
//   node scripts/quo-webhook.mjs delete <id> remove one
//
// Needs QUO_API_KEY and PUBLIC_URL. `test` also needs QUO_WEBHOOK_SECRET.
import crypto from "node:crypto";
import "dotenv/config";

const BASE = (process.env.QUO_API_BASE || "https://api.quo.com/v1").replace(/\/$/, "");
const API_KEY = process.env.QUO_API_KEY;
const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/$/, "");
const LABEL = "Client follow-up texts";

// Only the events this app actually handles. Quo also emits
// call.recording.completed, call.transcript.completed and call.summary.completed;
// subscribing to those would just deliver traffic the webhook ignores.
//
// message.received is the only one the system genuinely needs. The rest sharpen
// it: delivered gives delivery receipts, and the call events are what let a
// client ringing the office stop their series.
const MESSAGE_EVENTS = ["message.received", "message.delivered"];
const CALL_EVENTS = ["call.completed", "call.ringing"];

const bold = (text) => `[1m${text}[0m`;
const green = (text) => `[32m${text}[0m`;
const red = (text) => `[31m${text}[0m`;
const dim = (text) => `[2m${text}[0m`;

function die(message) {
  console.error(`\n${red("✗")} ${message}\n`);
  process.exit(1);
}

async function quo(path, options = {}) {
  const response = await fetch(`${BASE}${path}`, {
    ...options,
    headers: { Authorization: API_KEY, "Content-Type": "application/json", ...(options.headers ?? {}) },
  });
  const raw = await response.text();
  let body = null;
  try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
  return { ok: response.ok, status: response.status, body, raw };
}

function webhookUrl() {
  if (!PUBLIC_URL) die("PUBLIC_URL is not set. It must be your deployed URL, e.g. https://followups.up.railway.app");
  const local = /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(PUBLIC_URL);
  if (!PUBLIC_URL.startsWith("https://") && !local) {
    die(`PUBLIC_URL is "${PUBLIC_URL}". Quo only delivers to https, so this has to be your deployed URL.`);
  }
  return `${PUBLIC_URL}/webhooks/quo`;
}

/* -------------------------------------------------------------------- list */

async function list({ quiet = false } = {}) {
  const result = await quo("/webhooks");
  if (!result.ok) {
    die(`Quo returned ${result.status} listing webhooks: ${String(result.raw).slice(0, 300)}`);
  }
  const hooks = Array.isArray(result.body?.data) ? result.body.data : (result.body ?? []);

  if (!quiet) {
    if (!hooks.length) console.log("\nNo webhooks registered.\n");
    else {
      console.log(`\n${bold(`${hooks.length} webhook(s) registered`)}\n`);
      for (const hook of hooks) {
        const mine = String(hook.url ?? "").includes("/webhooks/quo");
        console.log(`  ${mine ? green("●") : "○"} ${hook.label || "(no label)"}  ${dim(hook.id)}`);
        console.log(`     ${hook.url}`);
        console.log(`     events: ${(hook.events ?? []).join(", ") || "none"}   status: ${hook.status ?? "?"}\n`);
      }
    }
  }
  return hooks;
}

/* ------------------------------------------------------------------- setup */

// Creating with an event Quo does not recognise fails the whole call, so on a
// 4xx the list is narrowed and retried. That way an unknown event name costs a
// feature rather than the entire webhook.
async function createWithFallback(path, events, url) {
  let attempt = [...events];

  while (attempt.length) {
    const result = await quo(path, {
      method: "POST",
      body: JSON.stringify({ url, events: attempt, label: LABEL, resourceIds: ["*"], status: "enabled" }),
    });

    if (result.ok) {
      const dropped = events.filter((event) => !attempt.includes(event));
      return { created: result.body?.data ?? result.body, events: attempt, dropped };
    }

    if (result.status >= 500) {
      die(`Quo returned ${result.status} creating the webhook: ${String(result.raw).slice(0, 300)}`);
    }

    if (attempt.length === 1) {
      return { failed: true, status: result.status, detail: String(result.raw).slice(0, 300) };
    }

    console.log(dim(`     ${attempt.join(", ")} was rejected (${result.status}); retrying without ${attempt.at(-1)}`));
    attempt = attempt.slice(0, -1);
  }

  return { failed: true };
}

async function setup() {
  const url = webhookUrl();
  console.log(`\n${bold("Setting up the Quo webhook")}`);
  console.log(`  target: ${url}\n`);

  // Replace any earlier attempt so repeated runs do not stack up duplicates,
  // which would deliver every reply twice.
  const existing = await list({ quiet: true });
  const ours = existing.filter((hook) => String(hook.url ?? "").includes("/webhooks/quo"));
  for (const hook of ours) {
    console.log(`  removing an existing webhook ${dim(hook.id)}`);
    await quo(`/webhooks/${hook.id}`, { method: "DELETE" });
  }

  const secrets = [];

  console.log("\n  messages...");
  const messages = await createWithFallback("/webhooks/messages", MESSAGE_EVENTS, url);
  if (messages.failed) {
    console.log(`  ${red("✗")} could not create the message webhook (${messages.status}): ${messages.detail}`);
    console.log("     Without this, replies never reach the app and nothing can stop a series.");
  } else {
    console.log(`  ${green("✓")} messages: ${messages.events.join(", ")}`);
    if (messages.dropped.length) console.log(`     ${dim(`not supported: ${messages.dropped.join(", ")}`)}`);
    if (messages.created?.key) secrets.push(["messages", messages.created.key]);
  }

  console.log("\n  calls...");
  const calls = await createWithFallback("/webhooks/calls", CALL_EVENTS, url);
  if (calls.failed) {
    console.log(`  ${dim("○")} no call webhook (${calls.status}). Replies still work; a client`);
    console.log(`     ${dim("calling the office will not stop their series.")}`);
  } else {
    console.log(`  ${green("✓")} calls: ${calls.events.join(", ")}`);
    if (calls.dropped.length) console.log(`     ${dim(`not supported: ${calls.dropped.join(", ")}`)}`);
    if (calls.created?.key) secrets.push(["calls", calls.created.key]);
  }

  if (!secrets.length) {
    console.log(`\n${bold("No signing secret came back.")}`);
    console.log("Reveal it in the Quo app under the webhook, then set QUO_WEBHOOK_SECRET.\n");
    return;
  }

  const unique = [...new Set(secrets.map(([, key]) => key))];
  console.log(`\n${bold("Set this in Railway, then redeploy:")}\n`);
  console.log(`  QUO_WEBHOOK_SECRET=${unique[0]}\n`);

  if (unique.length > 1) {
    // Two secrets means one of the two webhooks would fail verification.
    console.log(`${red("!")} Quo issued a different secret per webhook:`);
    for (const [kind, key] of secrets) console.log(`    ${kind}: ${key}`);
    console.log("  This app verifies with one secret, so set QUO_WEBHOOK_SECRET to the");
    console.log("  messages one and use QUO_WEBHOOK_TOKEN instead if calls start failing.\n");
  }

  console.log(`${dim("Then: node scripts/quo-webhook.mjs test")}\n`);
}

/* -------------------------------------------------------------------- test */

// Signs a request exactly the way Quo does and sends it to your deployment. The
// event type is one the app ignores, so this proves the secret without creating
// a contact, stopping a series, or posting anything to Slack.
async function test() {
  const secret = process.env.QUO_WEBHOOK_SECRET;
  const token = process.env.QUO_WEBHOOK_TOKEN;
  if (!secret && !token) die("Set QUO_WEBHOOK_SECRET (or QUO_WEBHOOK_TOKEN) to the value from `setup`.");

  const url = webhookUrl();
  const body = JSON.stringify({ type: "webhook.test", data: { object: {} } });
  const headers = { "Content-Type": "application/json" };
  let target = url;

  if (secret) {
    const timestamp = String(Date.now());
    const parts = secret.split(";");
    const key = Buffer.from(parts.length >= 4 ? parts[3] : secret, "base64");
    const signature = crypto.createHmac("sha256", key).update(`${timestamp}.${body}`).digest("base64");
    headers["quo-signature"] = `hmac;1;${timestamp};${signature}`;
  } else {
    target = `${url}?token=${encodeURIComponent(token)}`;
  }

  console.log(`\n${bold("Testing the webhook endpoint")}\n  ${url}\n`);

  let response;
  try {
    response = await fetch(target, { method: "POST", headers, body });
  } catch (error) {
    die(`Could not reach it: ${error.message}\nIs the deployment up, and is PUBLIC_URL right?`);
  }

  const text = await response.text();

  if (response.status === 401) {
    console.log(`${red("✗")} Rejected (401). The secret does not match what the app has.`);
    console.log("  Check QUO_WEBHOOK_SECRET in Railway matches the one `setup` printed,");
    console.log("  and that the deployment restarted after you set it.\n");
    process.exit(1);
  }
  if (!response.ok) {
    console.log(`${red("✗")} ${response.status}: ${text.slice(0, 300)}\n`);
    process.exit(1);
  }

  console.log(`${green("✓")} Accepted and verified. ${dim(text.slice(0, 120))}`);
  console.log("\n  Real replies will now be accepted. Text the Quo number from a phone");
  console.log("  and watch it appear under Activity.\n");
}

/* ------------------------------------------------------------------ delete */

async function remove(id) {
  if (!id) die("Which one? `node scripts/quo-webhook.mjs list` shows the ids.");
  const result = await quo(`/webhooks/${id}`, { method: "DELETE" });
  if (!result.ok) die(`Quo returned ${result.status}: ${String(result.raw).slice(0, 200)}`);
  console.log(`\n${green("✓")} Deleted ${id}.\n`);
}

/* -------------------------------------------------------------------- main */

const [command, argument] = process.argv.slice(2);

if (!API_KEY && command !== "test") {
  die("QUO_API_KEY is not set. Quo workspace settings -> API; needs Owner or Admin.");
}

switch (command) {
  case "list": await list(); break;
  case "setup": await setup(); break;
  case "test": await test(); break;
  case "delete": await remove(argument); break;
  default:
    console.log(`
${bold("Quo webhook setup")}

  node scripts/quo-webhook.mjs list          what is registered today
  node scripts/quo-webhook.mjs setup         create ours, print the signing secret
  node scripts/quo-webhook.mjs test          prove QUO_WEBHOOK_SECRET is right
  node scripts/quo-webhook.mjs delete <id>   remove one

Reads QUO_API_KEY and PUBLIC_URL from the environment or a .env file.
`);
}
