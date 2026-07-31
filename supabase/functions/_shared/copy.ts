// Message copy: merge fields, opt-out wording, and the keyword lists that decide
// whether an inbound text is an opt-out, an opt-in, or an ordinary reply.
//
// src/lib/render.js mirrors renderBody and countSegments so the admin preview
// shows exactly what will be sent. Change one, change the other.

export type Language = "en" | "es";

export interface MergeVars {
  first_name?: string | null;
  last_name?: string | null;
  full_name?: string | null;
  case_reference?: string | null;
  assigned_user?: string | null;
  firm_name?: string | null;
}

// Deliberately generic: a text that opens "Hi ," because the intake form had no
// name reads worse than one that opens "Hi there,".
const FALLBACKS: Record<Language, Record<string, string>> = {
  en: { first_name: "there", last_name: "", full_name: "there", case_reference: "your case", assigned_user: "our team", firm_name: "our office" },
  es: { first_name: "", last_name: "", full_name: "", case_reference: "su caso", assigned_user: "nuestro equipo", firm_name: "nuestra oficina" },
};

export function renderBody(template: string, vars: MergeVars, language: Language = "en"): string {
  const values: Record<string, string> = {
    first_name: (vars.first_name ?? "").trim(),
    last_name: (vars.last_name ?? "").trim(),
    full_name: (vars.full_name ?? [vars.first_name, vars.last_name].filter(Boolean).join(" ")).trim(),
    case_reference: (vars.case_reference ?? "").trim(),
    assigned_user: (vars.assigned_user ?? "").trim(),
    firm_name: (vars.firm_name ?? "").trim(),
  };

  const rendered = template.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (whole, rawKey: string) => {
    const key = rawKey.toLowerCase();
    if (!(key in values)) return whole;
    return values[key] || FALLBACKS[language][key] || "";
  });

  // Spanish has no neutral stand-in for a missing name, so "Hola {{first_name}},"
  // collapses to "Hola," rather than leaving a dangling space before the comma.
  return rendered.replace(/[ \t]{2,}/g, " ").replace(/\s+([,.!?])/g, "$1").trim();
}

export const OPT_OUT_NOTICE: Record<Language, string> = {
  en: "Reply STOP to opt out.",
  es: "Responda ALTO para no recibir mas mensajes.",
};

export const STOP_CONFIRMATION: Record<Language, string> = {
  en: "You are unsubscribed and will not get more texts from us. Reply START if you change your mind.",
  es: "Se ha dado de baja y no recibira mas mensajes. Responda INICIAR si cambia de opinion.",
};

export const START_CONFIRMATION: Record<Language, string> = {
  en: "You are subscribed again. Reply STOP at any time to opt out.",
  es: "Se ha suscrito de nuevo. Responda ALTO en cualquier momento para darse de baja.",
};

export function appendOptOutNotice(body: string, language: Language): string {
  const notice = OPT_OUT_NOTICE[language];
  // Do not stack a second notice onto copy that already carries one.
  if (body.toLowerCase().includes(notice.toLowerCase().slice(0, 12))) return body;
  return `${body} ${notice}`.trim();
}

// Matched against the whole normalized message, never as a substring. "Para" is
// an everyday Spanish preposition and "end" appears mid-sentence constantly, so
// substring matching would silently unsubscribe clients who were just replying.
const STOP_KEYWORDS = new Set([
  "stop", "stopall", "stop all", "unsubscribe", "cancel", "end", "quit",
  "revoke", "optout", "opt out", "remove", "remove me", "no more",
  "stop texting", "stop texting me", "do not text", "dont text me", "leave me alone",
  "alto", "pare", "parar", "para", "cancelar", "cancele", "basta", "no mas",
  "borrar", "eliminar", "salir", "detener", "quitar", "no me escriban",
  "dejen de escribirme", "no quiero mas mensajes",
]);

const START_KEYWORDS = new Set([
  "start", "unstop", "resume", "subscribe", "yes",
  "iniciar", "comenzar", "empezar", "reanudar", "suscribir", "si",
]);

// Lowercase, strip accents and punctuation, collapse whitespace, so "¡ALTO!",
// "Alto." and "alto" all land on the same token.
export function normalizeInbound(body: string): string {
  return (body ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface InboundClassification {
  isStop: boolean;
  isStart: boolean;
  normalized: string;
}

export function classifyInbound(body: string): InboundClassification {
  const normalized = normalizeInbound(body);
  return {
    isStop: STOP_KEYWORDS.has(normalized),
    isStart: START_KEYWORDS.has(normalized),
    normalized,
  };
}

// GSM-7 vs UCS-2 segment counting. Spanish copy with accents falls to UCS-2 and
// halves the per-segment budget, which is exactly the surprise the admin preview
// exists to prevent.
const GSM7 = "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?"
  + "¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const GSM7_EXTENDED = "^{}\\[~]|€";

export function countSegments(body: string): { encoding: "GSM-7" | "UCS-2"; characters: number; segments: number } {
  const text = body ?? "";
  let isGsm = true;
  let units = 0;

  for (const char of text) {
    if (GSM7.includes(char)) units += 1;
    else if (GSM7_EXTENDED.includes(char)) units += 2;
    else { isGsm = false; break; }
  }

  if (!isGsm) {
    // UCS-2 counts UTF-16 code units, so an emoji costs two.
    units = text.length;
    const single = 70;
    const multi = 67;
    return {
      encoding: "UCS-2",
      characters: units,
      segments: units === 0 ? 0 : units <= single ? 1 : Math.ceil(units / multi),
    };
  }

  const single = 160;
  const multi = 153;
  return {
    encoding: "GSM-7",
    characters: units,
    segments: units === 0 ? 0 : units <= single ? 1 : Math.ceil(units / multi),
  };
}
