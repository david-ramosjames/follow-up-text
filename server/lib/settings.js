import { rows, query } from "../db.js";

// Everything the firm can change lives in the database so it is editable in the
// dashboard. The environment holds only secrets, which nobody should be able to
// read back out of a web page.
export const SETTING_DEFINITIONS = [
  {
    key: "firm_name",
    label: "Firm name",
    type: "text",
    default: "",
    help: "Fills {{firm_name}} in message copy.",
  },
  {
    key: "default_timezone",
    label: "Default timezone",
    type: "timezone",
    default: "America/Chicago",
    help: "Used for new sequences and for times shown in Slack.",
  },
  {
    key: "default_quo_number_id",
    label: "Default Quo number",
    type: "quo_number",
    default: null,
    help: "Used by any sequence that has not picked its own number.",
  },
  {
    key: "slack_alert_channel",
    label: "Fallback Slack channel",
    type: "text",
    default: "",
    help: "Channel ID used when a series has no thread of its own to post into.",
  },
  {
    key: "show_full_phone_in_slack",
    label: "Show full phone numbers in Slack",
    type: "boolean",
    default: false,
    help: "Off shows only the last four digits, which suits a wide intake channel.",
  },
  {
    key: "send_stop_confirmation",
    label: "Send our own STOP confirmation",
    type: "boolean",
    default: true,
    help: "Turn off if your carrier already auto-replies to STOP, to avoid two confirmations.",
  },
  {
    key: "dispatch_batch_size",
    label: "Texts per dispatch run",
    type: "number",
    default: 25,
    min: 1,
    max: 200,
    help: "How many due texts are sent per cycle.",
  },
  {
    key: "dispatch_interval_seconds",
    label: "Seconds between dispatch runs",
    type: "number",
    default: 60,
    min: 15,
    max: 900,
    help: "How late a text can be, at worst. Takes effect within one cycle.",
  },
  {
    key: "max_send_attempts",
    label: "Attempts before giving up",
    type: "number",
    default: 3,
    min: 1,
    max: 10,
    help: "After this many failures the series stops and the assigned person is told.",
  },
  {
    key: "retry_delay_minutes",
    label: "Minutes between retries",
    type: "number",
    default: 15,
    min: 1,
    max: 240,
  },
];

const DEFAULTS = Object.fromEntries(SETTING_DEFINITIONS.map((item) => [item.key, item.default]));

let cache = null;
let cachedAt = 0;
const CACHE_MS = 5_000;

export async function loadSettings({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cachedAt < CACHE_MS) return cache;
  const stored = await rows("select key, value from app_settings");
  const merged = { ...DEFAULTS };
  for (const row of stored) {
    if (row.key in merged) merged[row.key] = row.value;
  }
  cache = merged;
  cachedAt = Date.now();
  return merged;
}

export function invalidateSettings() {
  cache = null;
}

function coerce(definition, raw) {
  switch (definition.type) {
    case "boolean":
      return Boolean(raw);
    case "number": {
      const value = Number(raw);
      if (!Number.isFinite(value)) throw new Error(`${definition.label} must be a number.`);
      if (definition.min !== undefined && value < definition.min) {
        throw new Error(`${definition.label} cannot be below ${definition.min}.`);
      }
      if (definition.max !== undefined && value > definition.max) {
        throw new Error(`${definition.label} cannot be above ${definition.max}.`);
      }
      return Math.round(value);
    }
    case "quo_number":
      return raw ? String(raw) : null;
    default:
      return raw === null || raw === undefined ? "" : String(raw);
  }
}

export async function saveSettings(values, actor) {
  const updates = [];
  for (const definition of SETTING_DEFINITIONS) {
    if (!(definition.key in values)) continue;
    updates.push([definition.key, coerce(definition, values[definition.key])]);
  }

  for (const [key, value] of updates) {
    await query(
      `insert into app_settings (key, value, updated_by, updated_at)
       values ($1, $2::jsonb, $3, now())
       on conflict (key) do update
         set value = excluded.value, updated_by = excluded.updated_by, updated_at = now()`,
      [key, JSON.stringify(value), actor ?? null],
    );
  }

  invalidateSettings();
  return loadSettings({ fresh: true });
}
