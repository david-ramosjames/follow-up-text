import { rows, query } from "../db.js";
import { currentFirm, defaultFirm } from "./firms.js";

// Everything the firm can change lives in the database so it is editable in the
// dashboard. The environment holds only secrets, which nobody should be able to
// read back out of a web page.
export const SETTING_DEFINITIONS = [
  {
    key: "firm_name",
    label: "Firm name",
    type: "text",
    default: "",
    help: "This practice's name in the Firm menu and in {{firm_name}} in texts. "
      + "Saving this page renames the firm you have selected, not the others.",
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
    key: "secondary_quo_number_id",
    label: "Secondary Quo number",
    type: "quo_number",
    default: null,
    emptyLabel: "None — pick a number on the start form when you need one",
    help: "The other line for a rare manual start. On Slack, type from and this line's "
      + "Quo name — from Intake if that is how it is labelled. from secondary also works. "
      + "Leave this blank if you do not have a second line.",
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
  {
    key: "lead_mode",
    label: "Reading the lead channel",
    type: "select",
    default: "off",
    options: [
      { value: "off", label: "Off — do not read the channel at all" },
      { value: "preview", label: "Watch and record — decide, but never text" },
      { value: "live", label: "Live — start follow-ups automatically" },
    ],
    help: "Watch and record is how to try this safely: every post is read and its decision "
      + "written to the Leads page, including the exact text that would have gone out, but "
      + "nothing is sent and nothing is posted to Slack. Move to Live when the decisions look right.",
  },
  {
    key: "lead_channel_id",
    label: "Lead channel ID",
    type: "text",
    default: "",
    help: "The channel your form fills post into, e.g. C09ABCDEFG — in Slack, right-click the "
      + "channel, Copy link, and take the last part. No other channel is read.",
  },
  {
    key: "lead_senders",
    label: "Which apps count as form fills",
    type: "text",
    default: "",
    help: "Comma-separated names of the apps that post form fills — for example "
      + "Web Leads, RJL, rj-tiktok-leads. The name Slack shows on the post. Only "
      + "posts from these are considered. Leave empty to accept any app, but never "
      + "a person: a colleague pasting a client's number into the channel is not a "
      + "form fill and is always ignored.",
  },
  {
    key: "lead_default_owner_slack_id",
    label: "Who owns an automatic lead",
    type: "text",
    default: "",
    help: "The Slack member ID an automatically started series is assigned to. They can stop "
      + "it, and anybody can hand it over afterwards.",
  },
  {
    key: "night_starts_hour",
    label: "Night starts at",
    type: "number",
    default: 21,
    min: 12,
    max: 23,
    help: "Copied onto a sequence when you create it. After that, edit night hours on the "
      + "sequence itself — that is what the first text actually uses. This is not the "
      + "sending window; Earliest and Latest on each sequence still decide when later texts "
      + "may go out.",
  },
  {
    key: "night_ends_hour",
    label: "Night ends at",
    type: "number",
    default: 8,
    min: 1,
    max: 11,
    help: "Default closing hour copied onto new sequences. A first text before this hour "
      + "uses night copy; a first text after it uses the usual copy.",
  },
  {
    key: "min_gap_minutes",
    label: "Minimum minutes between two texts to one client",
    type: "number",
    default: 60,
    min: 5,
    max: 1440,
    help: "A backstop against catch-up bursts. A series started at 11pm has several texts "
      + "overdue by the time the window opens; this spaces them out rather than sending "
      + "them together. It only ever delays a text, never brings one forward.",
  },
];

const DEFAULTS = Object.fromEntries(SETTING_DEFINITIONS.map((item) => [item.key, item.default]));

let cache = null;
let cachedAt = 0;
const CACHE_MS = 5_000;

async function settingsFirmId() {
  return currentFirm()?.id ?? (await defaultFirm())?.id ?? null;
}

export async function loadSettings({ fresh = false } = {}) {
  const id = await settingsFirmId();
  const cacheKey = id ?? "none";
  if (!fresh && cache && cache._firmId === cacheKey && Date.now() - cachedAt < CACHE_MS) {
    const { _firmId, ...rest } = cache;
    return rest;
  }
  const stored = id
    ? await rows("select key, value from app_settings where firm_id = $1", [id])
    : [];
  const merged = { ...DEFAULTS };
  for (const row of stored) {
    if (row.key in merged) merged[row.key] = row.value;
  }
  cache = { ...merged, _firmId: cacheKey };
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
    case "select": {
      // A value outside the list would silently disable whatever it controls,
      // and for lead_mode that means either texting nobody or texting everybody.
      const value = String(raw ?? "");
      const allowed = (definition.options ?? []).map((option) => option.value);
      if (!allowed.includes(value)) {
        throw new Error(`${definition.label} must be one of: ${allowed.join(", ")}.`);
      }
      return value;
    }
    case "quo_number":
      return raw ? String(raw) : null;
    default:
      return raw === null || raw === undefined ? "" : String(raw);
  }
}

export async function saveSettings(values, actor) {
  const id = await settingsFirmId();
  if (!id) throw new Error("No firm is set up yet.");
  const updates = [];
  for (const definition of SETTING_DEFINITIONS) {
    if (!(definition.key in values)) continue;
    updates.push([definition.key, coerce(definition, values[definition.key])]);
  }

  for (const [key, value] of updates) {
    await query(
      `insert into app_settings (firm_id, key, value, updated_by, updated_at)
       values ($1, $2, $3::jsonb, $4, now())
       on conflict (firm_id, key) do update
         set value = excluded.value, updated_by = excluded.updated_by, updated_at = now()`,
      [id, key, JSON.stringify(value), actor ?? null],
    );
  }

  invalidateSettings();
  return loadSettings({ fresh: true });
}
