// Thin wrapper over the JSON API. Every response either resolves with data or
// rejects with the message the server actually gave, so pages can show that
// message rather than inventing their own.

function withFirmId(path, firmId) {
  if (!firmId) return `/api${path}`;
  const separator = path.includes("?") ? "&" : "?";
  return `/api${path}${separator}firmId=${encodeURIComponent(firmId)}`;
}

async function request(path, options = {}) {
  const firmId = typeof localStorage !== "undefined" ? localStorage.getItem("followup_firm_id") : null;
  const { headers: extraHeaders, body, ...rest } = options;
  const response = await fetch(withFirmId(path, firmId), {
    credentials: "same-origin",
    ...rest,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(firmId ? { "X-Firm-Id": firmId } : {}),
      ...extraHeaders,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (response.status === 401) {
    const error = new Error("Your session has expired. Sign in again.");
    error.unauthorized = true;
    throw error;
  }

  const text = await response.text();
  const data = text ? JSON.parse(text) : null;

  if (!response.ok) {
    const error = new Error(data?.error || `Request failed (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return data;
}

export const api = {
  get: (path) => request(path),
  post: (path, body) => request(path, { method: "POST", body: body ?? {} }),
  put: (path, body) => request(path, { method: "PUT", body }),
  patch: (path, body) => request(path, { method: "PATCH", body }),
  delete: (path) => request(path, { method: "DELETE" }),
};

export async function fetchSession() {
  const response = await fetch("/auth/me", { credentials: "same-origin" });
  return response.json();
}

export async function signInWithPassword(password) {
  const response = await fetch("/auth/password", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error || "Sign-in failed.");
  return data;
}

export async function signOut() {
  await fetch("/auth/logout", { method: "POST", credentials: "same-origin" });
}

/* ------------------------------------------------------------------ labels */

export const STATUS_LABELS = {
  active: "Running",
  completed: "Finished, no reply",
  stopped_reply: "They replied",
  stopped_call: "They called back",
  stopped_manual: "Stopped by staff",
  stopped_opt_out: "Opted out",
  failed: "Texts kept failing",
};

export const SOURCE_LABELS = {
  command: "Slash command",
  message_action: "From a Slack message",
  mention: "Mentioned in a thread",
  dashboard: "Dashboard",
};

export const DAY_NAMES = [
  { iso: 1, short: "Mon" },
  { iso: 2, short: "Tue" },
  { iso: 3, short: "Wed" },
  { iso: 4, short: "Thu" },
  { iso: 5, short: "Fri" },
  { iso: 6, short: "Sat" },
  { iso: 7, short: "Sun" },
];

export const TIMEZONES = [
  "America/Chicago",
  "America/New_York",
  "America/Denver",
  "America/Los_Angeles",
  "America/Phoenix",
  "America/Anchorage",
  "Pacific/Honolulu",
];

export { slugify } from "../../shared/sequences.js";

export function formatWhen(iso, timezone) {
  if (!iso) return "—";
  try {
    return new Intl.DateTimeFormat("en-US", {
      ...(timezone ? { timeZone: timezone } : {}),
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(iso));
  } catch {
    return String(iso);
  }
}

export function formatDay(iso) {
  try {
    return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(new Date(iso));
  } catch {
    return String(iso);
  }
}

// Long form, with the weekday and the zone abbreviation, for the one date on a
// card that somebody actually plans around. The zone is worth the space: the
// sending window is measured in the client's local time, not the reader's.
export function formatWhenLong(iso, timezone) {
  if (!iso) return "—";
  try {
    return new Intl.DateTimeFormat("en-US", {
      ...(timezone ? { timeZone: timezone } : {}),
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    }).format(new Date(iso));
  } catch {
    return String(iso);
  }
}

// "in 3 hours", "tomorrow", "2 days ago" — the part people read first. Under a
// minute is treated as now, because the dispatcher runs on a cycle and the
// exact second is neither knowable nor interesting.
export function formatRelative(iso) {
  if (!iso) return "";
  const target = new Date(iso).getTime();
  if (!Number.isFinite(target)) return "";

  const minutes = Math.round((target - Date.now()) / 60_000);
  if (Math.abs(minutes) < 1) return "any moment now";

  const relative = new Intl.RelativeTimeFormat("en-US", { numeric: "auto" });
  // Each step is how many of this unit make up the next one.
  const steps = [["minute", 60], ["hour", 24], ["day", 7], ["week", 4.35], ["month", 12]];

  let value = minutes;
  for (const [unit, perNext] of steps) {
    if (Math.abs(value) < perNext) return relative.format(value, unit);
    value = Math.round(value / perNext);
  }
  return relative.format(value, "year");
}
