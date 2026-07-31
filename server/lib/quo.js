import crypto from "node:crypto";
import { query, rows } from "../db.js";

// Quo (formerly OpenPhone). The rebrand kept the API shape, so an account that
// has not been migrated can point QUO_API_BASE at api.openphone.com instead.
const DEFAULT_BASE = "https://api.quo.com/v1";

export function quoBase() {
  return (process.env.QUO_API_BASE || DEFAULT_BASE).replace(/\/$/, "");
}

export function quoConfigured() {
  return Boolean(process.env.QUO_API_KEY);
}

async function quoFetch(path, options = {}) {
  const apiKey = process.env.QUO_API_KEY;
  if (!apiKey) throw new Error("QUO_API_KEY is not set.");

  const response = await fetch(`${quoBase()}${path}`, {
    ...options,
    headers: { Authorization: apiKey, "Content-Type": "application/json", ...(options.headers ?? {}) },
  });

  const raw = await response.text();
  let parsed = {};
  try {
    parsed = raw ? JSON.parse(raw) : {};
  } catch {
    parsed = {};
  }
  return { response, parsed, raw };
}

/* -------------------------------------------------------------- numbers */

// A firm with several Quo numbers picks which one each sequence sends from, so
// this pulls the list and caches it locally for the dropdown.
export async function fetchQuoNumbers() {
  const { response, parsed, raw } = await quoFetch("/phone-numbers");
  if (!response.ok) {
    throw new Error(`Quo returned ${response.status} listing phone numbers: ${raw.slice(0, 200)}`);
  }

  const list = Array.isArray(parsed?.data) ? parsed.data : Array.isArray(parsed) ? parsed : [];
  return list.map((item) => ({
    id: String(item.id ?? item.phoneNumberId ?? ""),
    phone_e164: String(item.number ?? item.phoneNumber ?? item.e164 ?? ""),
    label: item.name ?? item.label ?? item.formattedNumber ?? null,
  })).filter((item) => item.id && item.phone_e164);
}

export async function syncQuoNumbers() {
  const fetched = await fetchQuoNumbers();

  for (const number of fetched) {
    await query(
      `insert into quo_numbers (id, phone_e164, label, is_active, last_synced_at)
       values ($1, $2, $3, true, now())
       on conflict (id) do update
         set phone_e164 = excluded.phone_e164,
             label = excluded.label,
             is_active = true,
             last_synced_at = now()`,
      [number.id, number.phone_e164, number.label],
    );
  }

  // A number removed from the Quo workspace is deactivated rather than deleted,
  // so history that references it still resolves.
  if (fetched.length) {
    await query(
      `update quo_numbers set is_active = false
       where id <> all($1::text[]) and is_active`,
      [fetched.map((number) => number.id)],
    );
  }

  return listQuoNumbers();
}

export async function listQuoNumbers() {
  return rows("select id, phone_e164, label, is_active, last_synced_at from quo_numbers order by is_active desc, label, phone_e164");
}

export async function resolveSendingNumber(quoNumberId) {
  if (!quoNumberId) return null;
  const found = await rows("select id, phone_e164 from quo_numbers where id = $1", [quoNumberId]);
  return found[0] ?? null;
}

/* ---------------------------------------------------------------- sending */

export async function sendText({ to, from, content }) {
  if (!process.env.QUO_API_KEY) {
    return { ok: false, error: "QUO_API_KEY is not set.", retryable: false };
  }
  if (!from) {
    return {
      ok: false,
      retryable: false,
      error: "No sending number. Pick one on the sequence, or set a default under Settings.",
    };
  }

  let result;
  try {
    result = await quoFetch("/messages", {
      method: "POST",
      body: JSON.stringify({ content, from, to: [to] }),
    });
  } catch (error) {
    // Network-level failure: worth another attempt on the next cycle.
    return { ok: false, error: `Could not reach Quo: ${error.message}`, retryable: true };
  }

  const { response, parsed, raw } = result;

  if (!response.ok) {
    const detail = parsed?.message
      ?? parsed?.errors?.[0]?.message
      ?? raw.slice(0, 300);
    return {
      ok: false,
      status: response.status,
      error: `Quo returned ${response.status}: ${detail}`,
      // 429 and 5xx are transient. A 4xx is a bad number or a bad payload and
      // will fail identically forever, so it should burn the retry budget fast.
      retryable: response.status === 429 || response.status >= 500,
    };
  }

  const data = parsed?.data ?? parsed;
  return { ok: true, status: response.status, id: data?.id ? String(data.id) : undefined };
}

/* --------------------------------------------------------------- webhooks */

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Quo signs webhooks the way OpenPhone did: the header carries
// `hmac;1;<timestamp>;<base64 signature>` over `<timestamp>.<raw body>`. The
// signing secret is handed out in that same four-part form, so accept either the
// whole string or just the key.
export function verifyWebhook(req, rawBody) {
  const token = process.env.QUO_WEBHOOK_TOKEN;
  if (token) {
    const provided = new URL(req.originalUrl, "http://localhost").searchParams.get("token");
    if (provided && timingSafeEqual(Buffer.from(provided), Buffer.from(token))) return { ok: true };
    if (!process.env.QUO_WEBHOOK_SECRET) return { ok: false, reason: "Bad or missing ?token=." };
  }

  const secret = process.env.QUO_WEBHOOK_SECRET;
  if (!secret) {
    return { ok: false, reason: "Set QUO_WEBHOOK_SECRET or QUO_WEBHOOK_TOKEN before exposing this endpoint." };
  }

  const header = req.get("quo-signature") || req.get("openphone-signature") || req.get("x-quo-signature");
  if (!header) return { ok: false, reason: "Missing signature header." };

  const parts = header.split(";");
  if (parts.length < 4) return { ok: false, reason: "Malformed signature header." };
  const timestamp = parts[2];
  const provided = parts[3];

  // Reject anything older than five minutes so a captured webhook cannot be
  // replayed later.
  const sentAt = Number(timestamp);
  if (!Number.isFinite(sentAt) || Math.abs(Date.now() - sentAt) > 5 * 60 * 1000) {
    return { ok: false, reason: "Signature timestamp is outside the accepted window." };
  }

  const secretParts = secret.split(";");
  const keyMaterial = secretParts.length >= 4 ? secretParts[3] : secret;

  let computed;
  try {
    computed = crypto.createHmac("sha256", Buffer.from(keyMaterial, "base64"))
      .update(`${timestamp}.${rawBody}`)
      .digest();
  } catch {
    return { ok: false, reason: "QUO_WEBHOOK_SECRET is not valid base64." };
  }

  let expected;
  try {
    expected = Buffer.from(provided, "base64");
  } catch {
    return { ok: false, reason: "Signature is not valid base64." };
  }

  return timingSafeEqual(computed, expected)
    ? { ok: true }
    : { ok: false, reason: "Signature did not match." };
}

// Quo nests the interesting part under data.object, but has shipped payloads
// with the object at data or at the root, so unwrap defensively.
export function readEvent(body) {
  const type = String(body?.type ?? body?.event ?? "");
  const data = body?.data ?? {};
  const object = data?.object ?? (Object.keys(data).length ? data : body);
  return { type, object: object ?? {} };
}

export function readPhone(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  if (value && typeof value === "object") {
    const inner = value.phoneNumber ?? value.number;
    if (typeof inner === "string") return inner;
  }
  return null;
}
