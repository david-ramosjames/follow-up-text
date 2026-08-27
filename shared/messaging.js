// Message copy: merge fields, opt-out wording, the keyword lists that decide
// whether an inbound text is an opt-out or an ordinary reply, and SMS segment
// counting.
//
// Imported by both the server (which sends the texts) and the browser (which
// previews them), so the preview is guaranteed to match what actually goes out.

export const FALLBACKS = {
  // A text opening "Hi ," because intake had no name reads worse than "Hi there,".
  en: { first_name: "there", last_name: "", full_name: "there", case_reference: "your case", case_type: "case", assigned_user: "our team", firm_name: "our office" },
  // Spanish has no neutral equivalent of "there", so the greeting closes up instead.
  es: { first_name: "", last_name: "", full_name: "", case_reference: "su caso", case_type: "caso", assigned_user: "nuestro equipo", firm_name: "nuestra oficina" },
};

export const MERGE_FIELDS = [
  { token: "{{first_name}}", label: "First name" },
  { token: "{{last_name}}", label: "Last name" },
  { token: "{{full_name}}", label: "Full name" },
  { token: "{{case_reference}}", label: "Case number — the firm's own reference" },
  { token: "{{case_type}}", label: "Case type — short spoken words after “your”, like car accident" },
  { token: "{{assigned_user}}", label: "Assigned staff member" },
  { token: "{{firm_name}}", label: "Firm name" },
];

export function renderBody(template, vars = {}, language = "en") {
  const values = {
    first_name: (vars.first_name ?? "").trim(),
    last_name: (vars.last_name ?? "").trim(),
    full_name: (vars.full_name ?? [vars.first_name, vars.last_name].filter(Boolean).join(" ")).trim(),
    case_reference: (vars.case_reference ?? "").trim(),
    case_type: (vars.case_type ?? "").trim(),
    assigned_user: (vars.assigned_user ?? "").trim(),
    firm_name: (vars.firm_name ?? "").trim(),
  };

  const rendered = String(template ?? "").replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (whole, rawKey) => {
    const key = rawKey.toLowerCase();
    // An unknown token is left visible rather than blanked: somebody will notice
    // "{{frist_name}}" in the preview, but they will not notice a missing clause.
    if (!(key in values)) return whole;
    return values[key] || FALLBACKS[language]?.[key] || "";
  });

  return rendered.replace(/[ \t]{2,}/g, " ").replace(/[ \t]+([,.!?])/g, "$1").trim();
}

export const OPT_OUT_NOTICE = {
  en: "Reply STOP to opt out.",
  es: "Responda ALTO para no recibir mas mensajes.",
};

export const STOP_CONFIRMATION = {
  en: "You are unsubscribed and will not get more texts from us. Reply START if you change your mind.",
  es: "Se ha dado de baja y no recibira mas mensajes. Responda INICIAR si cambia de opinion.",
};

export const START_CONFIRMATION = {
  en: "You are subscribed again. Reply STOP at any time to opt out.",
  es: "Se ha suscrito de nuevo. Responda ALTO en cualquier momento para darse de baja.",
};

export function appendOptOutNotice(body, language) {
  const notice = OPT_OUT_NOTICE[language] ?? OPT_OUT_NOTICE.en;
  // Do not stack a second notice onto copy that already carries one.
  if (body.toLowerCase().includes(notice.toLowerCase().slice(0, 12))) return body;
  return `${body} ${notice}`.trim();
}

// Matched against the whole normalized message, never as a substring. "Para" is
// an everyday Spanish preposition and "end" appears mid-sentence constantly, so
// substring matching would silently unsubscribe clients who were re-engaging.
export const STOP_KEYWORDS = [
  "stop", "stopall", "stop all", "unsubscribe", "cancel", "end", "quit",
  "revoke", "optout", "opt out", "remove", "remove me", "no more",
  "stop texting", "stop texting me", "do not text", "dont text me", "leave me alone",
  "alto", "pare", "parar", "para", "cancelar", "cancele", "basta", "no mas",
  "borrar", "eliminar", "salir", "detener", "quitar", "no me escriban",
  "dejen de escribirme", "no quiero mas mensajes",
];

export const START_KEYWORDS = [
  "start", "unstop", "resume", "subscribe", "yes",
  "iniciar", "comenzar", "empezar", "reanudar", "suscribir", "si",
];

// Lowercase, strip accents and punctuation, collapse whitespace, so "¡ALTO!",
// "Alto." and "alto" all land on the same token.
export function normalizeInbound(body) {
  return String(body ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function classifyInbound(body) {
  const normalized = normalizeInbound(body);
  return {
    isStop: STOP_KEYWORDS.includes(normalized),
    isStart: START_KEYWORDS.includes(normalized),
    normalized,
  };
}

const GSM7 = "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?"
  + "¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const GSM7_EXTENDED = "^{}\\[~]|€";

// Spanish copy is the reason this exists: é and ñ are in the GSM-7 table but á,
// í, ó and ú are not, so one accented vowel drops a whole message to UCS-2 and
// cuts the per-segment budget from 160 characters to 70.
export function countSegments(body) {
  const text = body ?? "";
  let isGsm = true;
  let units = 0;

  for (const char of text) {
    if (GSM7.includes(char)) units += 1;
    else if (GSM7_EXTENDED.includes(char)) units += 2;
    else { isGsm = false; break; }
  }

  if (!isGsm) {
    units = text.length;
    return {
      encoding: "UCS-2",
      characters: units,
      segments: units === 0 ? 0 : units <= 70 ? 1 : Math.ceil(units / 67),
    };
  }

  return {
    encoding: "GSM-7",
    characters: units,
    segments: units === 0 ? 0 : units <= 160 ? 1 : Math.ceil(units / 153),
  };
}

// Emoji are welcome in the copy — they just cost more than people expect, so
// the editor calls this to explain the encoding rather than only naming it.
// Note the arithmetic above is already right for them: an emoji outside the BMP
// is a surrogate pair, two UTF-16 code units, and UCS-2 counts it as two
// characters. `text.length` is the correct measure, not the code-point count.
const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;

export function hasEmoji(body) {
  return PICTOGRAPHIC.test(body ?? "");
}

// Cutting a string with slice() can land between the two halves of a surrogate
// pair and leave a lone half, which renders as a replacement character. Used
// wherever a client's own message is shortened for display.
export function truncateChars(body, limit) {
  const text = String(body ?? "");
  if (text.length <= limit) return text;
  const kept = [...text].slice(0, limit).join("");
  // Taking whole code points can still exceed the limit by one unit, since one
  // code point may be two of them; drop the last one when it does.
  return kept.length > limit ? [...kept].slice(0, -1).join("") : kept;
}

// What one step will look like on the client's phone.
export function previewStep(step, { language = "en", isFirst = false, appendNotice = true, isNight = false, vars = {} } = {}) {
  const night = language === "es" ? step.body_es_night : step.body_en_night;
  const day = language === "es" ? step.body_es : step.body_en;
  const template = isNight && night?.trim() ? night : day;
  const rendered = renderBody(template || "", vars, language);
  const body = isFirst && appendNotice ? appendOptOutNotice(rendered, language) : rendered;
  return { body, usedNight: Boolean(isNight && night?.trim()), ...countSegments(body) };
}

// Night wording wraps midnight: from 9pm to 8am is hour >= 21 or hour < 8.
export function isNightHour(hour, start = 21, end = 8) {
  const value = Number(hour);
  return value >= Number(start) || value < Number(end);
}

export function describeDelay(minutes) {
  const value = Number(minutes) || 0;
  if (value === 0) return "immediately";
  if (value < 60) return `after ${value} minute${value === 1 ? "" : "s"}`;
  if (value < 60 * 24) {
    const hours = value / 60;
    const rounded = Number.isInteger(hours) ? hours : Number(hours.toFixed(1));
    return `after ${rounded} hour${rounded === 1 ? "" : "s"}`;
  }
  const days = value / (60 * 24);
  const rounded = Number.isInteger(days) ? days : Number(days.toFixed(1));
  return `after ${rounded} day${rounded === 1 ? "" : "s"}`;
}

export const DELAY_PRESETS = [
  { label: "Immediately", minutes: 0 },
  { label: "1 hour", minutes: 60 },
  { label: "4 hours", minutes: 240 },
  { label: "1 day", minutes: 1440 },
  { label: "2 days", minutes: 2880 },
  { label: "3 days", minutes: 4320 },
  { label: "4 days", minutes: 5760 },
  { label: "6 days", minutes: 8640 },
  { label: "1 week", minutes: 10080 },
  { label: "8 days", minutes: 11520 },
  { label: "12 days", minutes: 17280 },
  { label: "2 weeks", minutes: 20160 },
];

// Tokens the translator must keep byte-for-byte, compared case-insensitively so
// "{{First_Name}}" in English still matches "{{first_name}}" in Spanish.
export function mergeTokens(text) {
  return [...String(text ?? "").matchAll(/\{\{\s*([a-z_]+)\s*\}\}/gi)]
    .map((match) => `{{${match[1].toLowerCase()}}}`);
}

export function missingMergeTokens(english, spanish) {
  const have = new Set(mergeTokens(spanish));
  return [...new Set(mergeTokens(english))].filter((token) => !have.has(token));
}

/* ------------------------------------------------------------ phone numbers */

// The same shape the contacts table enforces. Keeping the two in step matters:
// when they drifted, this returned "+04961199404" for a Quo handle and the
// insert raised, which answered 500 and got the whole webhook disabled.
const E164 = /^\+[1-9][0-9]{7,14}$/;

export function normalizePhone(raw) {
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim();
  const digits = text.replace(/[^0-9]/g, "");

  let candidate = null;
  if (text.startsWith("+")) candidate = `+${digits}`;
  else if (digits.length === 10) candidate = `+1${digits}`;
  else if (digits.length >= 11 && digits.length <= 15) candidate = `+${digits}`;

  return candidate && E164.test(candidate) ? candidate : null;
}

export function formatPhone(e164) {
  if (!e164) return "";
  const match = String(e164).match(/^\+1(\d{3})(\d{3})(\d{4})$/);
  return match ? `(${match[1]}) ${match[2]}-${match[3]}` : String(e164);
}

export function maskPhone(phone) {
  if (!phone || phone.length < 4) return phone ?? "";
  return `(•••) •••-${String(phone).slice(-4)}`;
}

// Pulls candidate phone numbers out of free Slack text so a paralegal can start
// follow-ups straight from the message where the client's number appears.
// Slack wraps tel: links as <tel:+15125550123|(512) 555-0123>, so unwrap first.
export function extractPhones(text) {
  const unwrapped = String(text ?? "")
    .replace(/<tel:([^|>]+)(\|[^>]*)?>/gi, " $1 ")
    .replace(/<mailto:[^>]*>/gi, " ")
    .replace(/<https?:[^>]*>/gi, " ");

  const found = [];
  const pattern = /\+?\d[\d\s().-]{8,20}\d/g;
  for (const match of unwrapped.matchAll(pattern)) {
    const normalized = normalizePhone(match[0]);
    // A 4-digit year inside a longer run, or a case number, will not normalize
    // to a plausible mobile, so this filters most false positives on its own.
    if (normalized && !found.includes(normalized)) found.push(normalized);
  }
  return found;
}

// Match a token from `/followup … from spare` to one of the firm's Quo lines.
// Unique last four digits, a full number, the Quo id, or the label all work.
// Ambiguous last-fours return nothing so a start does not pick the wrong line.
export function matchSendingNumber(token, numbers = [], { aliases = {} } = {}) {
  const raw = String(token ?? "").trim();
  if (!raw) return null;

  const lower = raw.toLowerCase();
  const digits = raw.replace(/\D/g, "");

  const aliasId = aliases[lower];
  if (aliasId) {
    return numbers.find((number) => number.id === aliasId) ?? { id: aliasId };
  }

  if (!numbers.length) return null;

  const only = (matches) => (matches.length === 1 ? matches[0] : null);

  const byId = numbers.filter((number) => number.id === raw);
  if (byId.length) return only(byId);

  const byLabel = numbers.filter((number) => {
    const label = String(number.label ?? "").toLowerCase();
    return label === lower || label.split(/\s+/)[0] === lower;
  });
  if (byLabel.length) return only(byLabel);

  if (digits.length >= 10) {
    const byFull = numbers.filter((number) => String(number.phone_e164 ?? "").replace(/\D/g, "").endsWith(digits)
      || digits.endsWith(String(number.phone_e164 ?? "").replace(/\D/g, "")));
    if (byFull.length) return only(byFull);
  }

  if (digits.length === 4) {
    const byLastFour = numbers.filter((number) => String(number.phone_e164 ?? "").replace(/\D/g, "").endsWith(digits));
    return only(byLastFour);
  }

  return null;
}
