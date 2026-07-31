// Browser mirror of supabase/functions/_shared/copy.ts.
//
// The admin preview has to show byte-for-byte what Quo will send, including the
// appended opt-out line and the segment count, so this logic exists twice: once
// in Deno for the sender and once here for the editor. `npm test` fails if the
// two copies drift apart.

export const FALLBACKS = {
  en: { first_name: "there", last_name: "", full_name: "there", case_reference: "your case", assigned_user: "our team", firm_name: "our office" },
  es: { first_name: "", last_name: "", full_name: "", case_reference: "su caso", assigned_user: "nuestro equipo", firm_name: "nuestra oficina" },
};

export const MERGE_FIELDS = [
  { token: "{{first_name}}", label: "First name" },
  { token: "{{last_name}}", label: "Last name" },
  { token: "{{full_name}}", label: "Full name" },
  { token: "{{case_reference}}", label: "Case reference" },
  { token: "{{assigned_user}}", label: "Assigned staff member" },
  { token: "{{firm_name}}", label: "Firm name" },
];

export function renderBody(template, vars = {}, language = "en") {
  const values = {
    first_name: (vars.first_name ?? "").trim(),
    last_name: (vars.last_name ?? "").trim(),
    full_name: (vars.full_name ?? [vars.first_name, vars.last_name].filter(Boolean).join(" ")).trim(),
    case_reference: (vars.case_reference ?? "").trim(),
    assigned_user: (vars.assigned_user ?? "").trim(),
    firm_name: (vars.firm_name ?? "").trim(),
  };

  const rendered = String(template ?? "").replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (whole, rawKey) => {
    const key = rawKey.toLowerCase();
    if (!(key in values)) return whole;
    return values[key] || FALLBACKS[language][key] || "";
  });

  return rendered.replace(/[ \t]{2,}/g, " ").replace(/\s+([,.!?])/g, "$1").trim();
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
  const notice = OPT_OUT_NOTICE[language];
  if (body.toLowerCase().includes(notice.toLowerCase().slice(0, 12))) return body;
  return `${body} ${notice}`.trim();
}

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

// What one step will look like on the client's phone.
export function previewStep(step, { language = "en", isFirst = false, appendNotice = true, vars = {} } = {}) {
  const template = language === "es" ? step.body_es : step.body_en;
  const rendered = renderBody(template || "", vars, language);
  const body = isFirst && appendNotice ? appendOptOutNotice(rendered, language) : rendered;
  return { body, ...countSegments(body) };
}

// "in 2 days", "after 3 hours" — how the schedule reads to whoever is editing it.
export function describeDelay(minutes) {
  const value = Number(minutes) || 0;
  if (value === 0) return "immediately";
  if (value < 60) return `after ${value} minute${value === 1 ? "" : "s"}`;
  if (value < 60 * 24) {
    const hours = value / 60;
    const rounded = Number.isInteger(hours) ? hours : hours.toFixed(1);
    return `after ${rounded} hour${rounded === 1 ? "" : "s"}`;
  }
  const days = value / (60 * 24);
  const rounded = Number.isInteger(days) ? days : days.toFixed(1);
  return `after ${rounded} day${rounded === 1 ? "" : "s"}`;
}

export const DELAY_PRESETS = [
  { label: "Immediately", minutes: 0 },
  { label: "1 hour", minutes: 60 },
  { label: "4 hours", minutes: 240 },
  { label: "1 day", minutes: 1440 },
  { label: "2 days", minutes: 2880 },
  { label: "3 days", minutes: 4320 },
  { label: "1 week", minutes: 10080 },
  { label: "2 weeks", minutes: 20160 },
];
