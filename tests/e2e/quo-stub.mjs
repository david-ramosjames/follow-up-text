// Stand-in for the Quo API so the whole pipeline can be exercised without
// sending real texts or touching a real Quo workspace.
//
// Implements the endpoints this app uses: phone numbers, sending a message, and
// webhook management. It deliberately rejects one call event so the setup
// script's "narrow the event list and retry" path gets exercised too.
import http from "node:http";

const PORT = Number(process.env.E2E_STUB_PORT ?? 4999);

const sent = [];
const webhooks = [];
let nextId = 1;

const numbers = [
  { id: "PNINTAKE", number: "+15125557777", name: "Intake line" },
  { id: "PNSPARE", number: "+15125558888", name: "Spanish line" },
];

// Quo rejects the whole create call if it does not recognise an event. This stub
// pretends not to know about call.ringing, so the retry path stays covered.
const UNSUPPORTED_EVENTS = new Set(["call.ringing"]);

// Same four-part shape Quo hands back, so the signing round-trip is real.
const SIGNING_KEY = "hmac;1;0;c3R1Yi1zaWduaW5nLWtleS1mb3ItdGVzdHM=";

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

http.createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => { raw += chunk; });
  req.on("end", () => {
    const path = new URL(req.url, "http://localhost").pathname;
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }

    if (path === "/v1/phone-numbers") return json(res, 200, { data: numbers });

    if (path === "/v1/messages" && req.method === "POST") {
      const id = `MSG${sent.length + 1}`;
      sent.push({ id, ...body });
      return json(res, 202, { data: { id, status: "queued" } });
    }

    if (path === "/v1/webhooks" && req.method === "GET") {
      return json(res, 200, { data: webhooks });
    }

    if ((path === "/v1/webhooks/messages" || path === "/v1/webhooks/calls") && req.method === "POST") {
      const rejected = (body.events ?? []).filter((event) => UNSUPPORTED_EVENTS.has(event));
      if (rejected.length) {
        return json(res, 400, { message: `Unknown event(s): ${rejected.join(", ")}` });
      }
      const hook = {
        id: `WH${nextId++}`,
        label: body.label,
        url: body.url,
        events: body.events,
        status: body.status ?? "enabled",
        resourceIds: body.resourceIds ?? ["*"],
        key: SIGNING_KEY,
      };
      webhooks.push(hook);
      return json(res, 201, { data: hook });
    }

    if (path.startsWith("/v1/webhooks/") && req.method === "DELETE") {
      const id = path.split("/").pop();
      const index = webhooks.findIndex((hook) => hook.id === id);
      if (index === -1) return json(res, 404, { message: "Not found" });
      webhooks.splice(index, 1);
      return json(res, 204, {});
    }

    // Test-only helpers.
    if (path === "/__sent") return json(res, 200, sent);
    if (path === "/__webhooks") return json(res, 200, webhooks);
    if (path === "/__signing-key") return json(res, 200, { key: SIGNING_KEY });
    if (path === "/__reset") { sent.length = 0; webhooks.length = 0; return json(res, 200, { ok: true }); }

    return json(res, 404, {});
  });
}).listen(PORT, () => console.log(`quo stub on ${PORT}`));
