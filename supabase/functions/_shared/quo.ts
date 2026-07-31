// Quo (formerly OpenPhone) client.
//
// Secrets:
//   QUO_API_KEY           required, sent as a bare Authorization header
//   QUO_API_BASE          defaults to https://api.quo.com/v1
//   QUO_FROM_NUMBER       fallback sending number when a sequence sets none
//   QUO_PHONE_NUMBER_ID   fallback sending number id
//   QUO_WEBHOOK_SECRET    signing secret for inbound webhooks
//   QUO_WEBHOOK_TOKEN     alternative shared secret, checked as ?token= on the URL
//
// Quo rebranded from OpenPhone and kept the API shape, so the older
// api.openphone.com base still works if the account has not been migrated.

const DEFAULT_BASE = "https://api.quo.com/v1";

export function quoBase(): string {
  return (Deno.env.get("QUO_API_BASE") ?? DEFAULT_BASE).replace(/\/$/, "");
}

export interface SendTextInput {
  to: string;
  from: string;
  content: string;
}

export interface SendTextResult {
  ok: boolean;
  id?: string;
  status?: number;
  error?: string;
  retryable?: boolean;
}

export async function sendText(input: SendTextInput): Promise<SendTextResult> {
  const apiKey = Deno.env.get("QUO_API_KEY");
  if (!apiKey) return { ok: false, error: "QUO_API_KEY is not configured.", retryable: false };
  if (!input.from) {
    return { ok: false, error: "No sending number. Set one on the sequence or in QUO_FROM_NUMBER.", retryable: false };
  }

  let response: Response;
  try {
    response = await fetch(`${quoBase()}/messages`, {
      method: "POST",
      headers: { Authorization: apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ content: input.content, from: input.from, to: [input.to] }),
    });
  } catch (error) {
    // Network-level failure: worth another attempt on the next cron tick.
    return { ok: false, error: `Could not reach Quo: ${(error as Error).message}`, retryable: true };
  }

  const raw = await response.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = raw ? JSON.parse(raw) : {};
  } catch {
    parsed = {};
  }

  if (!response.ok) {
    const detail = (parsed?.message as string)
      ?? ((parsed?.errors as Array<{ message?: string }>)?.[0]?.message)
      ?? raw.slice(0, 300);
    return {
      ok: false,
      status: response.status,
      error: `Quo returned ${response.status}: ${detail}`,
      // 429 and 5xx are transient. A 4xx is a bad number or bad payload and will
      // fail identically forever, so it should burn the retry budget fast.
      retryable: response.status === 429 || response.status >= 500,
    };
  }

  const data = (parsed?.data ?? parsed) as Record<string, unknown>;
  return { ok: true, status: response.status, id: (data?.id as string) ?? undefined };
}

// --------------------------------------------------------------- webhooks

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

function decodeBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

// Quo signs webhooks the way OpenPhone did: the header carries
// `hmac;1;<timestamp>;<base64 signature>` and the signature covers
// `<timestamp>.<raw body>`. The signing secret itself is handed out in that same
// four-part form, so accept either the whole string or just the key.
export async function verifyWebhook(request: Request, rawBody: string): Promise<{ ok: boolean; reason?: string }> {
  const token = Deno.env.get("QUO_WEBHOOK_TOKEN");
  if (token) {
    const provided = new URL(request.url).searchParams.get("token");
    if (provided && provided === token) return { ok: true };
    if (!Deno.env.get("QUO_WEBHOOK_SECRET")) return { ok: false, reason: "Bad or missing ?token=." };
  }

  const secret = Deno.env.get("QUO_WEBHOOK_SECRET");
  if (!secret) {
    return { ok: false, reason: "Set QUO_WEBHOOK_SECRET or QUO_WEBHOOK_TOKEN before exposing this endpoint." };
  }

  const header = request.headers.get("quo-signature")
    ?? request.headers.get("openphone-signature")
    ?? request.headers.get("x-quo-signature");
  if (!header) return { ok: false, reason: "Missing signature header." };

  const parts = header.split(";");
  if (parts.length < 4) return { ok: false, reason: "Malformed signature header." };
  const timestamp = parts[2];
  const provided = parts[3];

  // Reject anything more than five minutes old so a captured webhook cannot be
  // replayed later.
  const sentAt = Number(timestamp);
  if (!Number.isFinite(sentAt) || Math.abs(Date.now() - sentAt) > 5 * 60 * 1000) {
    return { ok: false, reason: "Signature timestamp is outside the accepted window." };
  }

  const secretParts = secret.split(";");
  const keyMaterial = secretParts.length >= 4 ? secretParts[3] : secret;

  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      "raw",
      decodeBase64(keyMaterial),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
  } catch {
    return { ok: false, reason: "QUO_WEBHOOK_SECRET is not valid base64." };
  }

  const computed = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${rawBody}`)),
  );

  let expected: Uint8Array;
  try {
    expected = decodeBase64(provided);
  } catch {
    return { ok: false, reason: "Signature is not valid base64." };
  }

  return timingSafeEqual(computed, expected)
    ? { ok: true }
    : { ok: false, reason: "Signature did not match." };
}

// ------------------------------------------------------- payload reading

export interface QuoEvent {
  type: string;
  object: Record<string, unknown>;
}

// Quo nests the interesting part under data.object, but has shipped payloads
// with the object at data or at the root, so unwrap defensively.
export function readEvent(body: Record<string, unknown>): QuoEvent {
  const type = String(body?.type ?? body?.event ?? "");
  const data = (body?.data ?? {}) as Record<string, unknown>;
  const object = (data?.object ?? (Object.keys(data).length ? data : body)) as Record<string, unknown>;
  return { type, object };
}

export function readPhone(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  if (value && typeof value === "object") {
    const inner = (value as Record<string, unknown>).phoneNumber ?? (value as Record<string, unknown>).number;
    if (typeof inner === "string") return inner;
  }
  return null;
}
