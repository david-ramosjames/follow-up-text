import { normalizePhone } from "../../shared/messaging.js";
import {
  callrailCallIdFromText,
  languageFromCallrailPayload,
  languageFromCallrailTracker,
  languageFromLandingUrl,
  languageFromPageViews,
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
  return languageFromCallrailPayload(row);
}

function extraFields() {
  return "fields=source,source_name,landing_page_url,last_requested_url,milestones,campaign,utm_campaign";
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

/** Newest page view first. The last page of results holds the landing page. */
export async function fetchCallrailPageViews(callId) {
  const id = String(callId ?? "").trim();
  if (!id || !callrailConfigured()) return [];
  const first = await callrailGet(`/calls/${encodeURIComponent(id)}/page_views.json?per_page=100&page=1`);
  const newest = Array.isArray(first?.page_views) ? first.page_views : [];
  const pages = Number(first?.total_pages ?? 1);
  if (!Number.isFinite(pages) || pages <= 1) return newest;
  const last = await callrailGet(`/calls/${encodeURIComponent(id)}/page_views.json?per_page=100&page=${pages}`);
  const oldest = Array.isArray(last?.page_views) ? last.page_views : [];
  return [...newest, ...oldest];
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

async function languageFromIntakeManager(callId) {
  const base = String(process.env.INTAKE_MANAGER_URL || "https://rjl-intake-manger.vercel.app").replace(/\/$/, "");
  const token = process.env.INTAKE_ENROLL_TOKEN || "";
  if (!callId || !token || !base) return null;
  try {
    const response = await fetch(`${base}/api/callrail/language`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ call_id: callId }),
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return null;
    const data = await response.json();
    return data?.language === "es" || data?.language === "en" ? data.language : null;
  } catch {
    return null;
  }
}

async function languageFromCallRecord(callId, row) {
  const fromRow = languageFromCallrailRow(row);
  if (fromRow) return fromRow;
  const id = callId || row?.id;
  if (!id) return null;
  return languageFromPageViews(await fetchCallrailPageViews(id));
}

/** Spanish when the CallRail landing page, campaign, or page-view history is Spanish. */
export async function languageFromCallrail({ text, phone } = {}) {
  const fromText = languageFromLandingUrl(text) || languageFromCallrailTracker(text);
  if (fromText) return fromText;

  const callId = callrailCallIdFromText(text);
  if (!callrailConfigured()) return languageFromIntakeManager(callId);

  const row = callId
    ? await fetchCallrailCall(callId)
    : phone
      ? await fetchCallrailCallForPhone(phone)
      : null;
  return languageFromCallRecord(callId, row);
}
