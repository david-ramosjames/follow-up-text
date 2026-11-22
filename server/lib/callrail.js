import { normalizePhone } from "../../shared/messaging.js";
import {
  callrailCallIdFromText,
  languageFromCallrailTracker,
  languageFromLandingUrl,
} from "../../shared/leads.js";

export function callrailConfigured() {
  return Boolean(process.env.CALLRAIL_API_KEY && process.env.CALLRAIL_ACCOUNT_ID);
}

async function callrailGet(path) {
  const account = process.env.CALLRAIL_ACCOUNT_ID;
  const key = process.env.CALLRAIL_API_KEY;
  if (!account || !key) return null;
  const response = await fetch(`https://api.callrail.com/v3/a/${account}${path}`, {
    headers: { Authorization: `Token token=${key}`, Accept: "application/json" },
  });
  const raw = await response.text();
  if (!response.ok) {
    console.warn(`CallRail returned ${response.status}: ${raw.slice(0, 200)}`);
    return null;
  }
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return null;
  }
}

function languageFromCallrailRow(row) {
  if (!row || typeof row !== "object") return null;
  return languageFromLandingUrl(row.landing_page_url)
    || languageFromCallrailTracker(row.tracking_number_name || row.name)
    || null;
}

function extraFields() {
  return "fields[]=landing_page_url&fields[]=tracking_number_name&fields[]=source";
}

function isoDate(offsetDays = 0) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

export async function fetchCallrailCall(callId) {
  const id = String(callId ?? "").trim();
  if (!id || !callrailConfigured()) return null;
  const payload = await callrailGet(`/calls/${encodeURIComponent(id)}.json?${extraFields()}`);
  return payload && typeof payload === "object" ? payload : null;
}

export async function fetchCallrailCallForPhone(phone) {
  const e164 = normalizePhone(phone);
  if (!e164 || !callrailConfigured()) return null;
  const digits = e164.replace(/\D/g, "").slice(-10);
  if (digits.length < 10) return null;
  const params = new URLSearchParams({
    search: digits,
    start_date: isoDate(-1),
    end_date: isoDate(1),
    per_page: "5",
  });
  const payload = await callrailGet(`/calls.json?${params.toString()}&${extraFields()}`);
  const calls = Array.isArray(payload?.calls) ? payload.calls : [];
  return calls.find((row) => languageFromCallrailRow(row)) || calls[0] || null;
}

/** Spanish if CallRail's landing page is lang=es, or the Call Ad tracker says ES. */
export async function languageFromCallrail({ text, phone } = {}) {
  const fromText = languageFromLandingUrl(text) || languageFromCallrailTracker(text);
  if (fromText) return fromText;

  if (!callrailConfigured()) return null;

  const callId = callrailCallIdFromText(text);
  const row = callId
    ? await fetchCallrailCall(callId)
    : phone
      ? await fetchCallrailCallForPhone(phone)
      : null;
  return languageFromCallrailRow(row);
}
