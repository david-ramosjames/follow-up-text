// The grammar of `/followup start …` and `@sms-follow-up start …`.
// Kept out of the Slack route so it can be tested without a workspace.
import { extractPhones, matchSendingNumber } from "./messaging.js";

const LANGUAGE_WORDS = {
  en: "en", eng: "en", english: "en", ingles: "en",
  es: "es", spa: "es", spanish: "es", espanol: "es", "español": "es",
};

function takePhone(tokens) {
  const text = tokens.join(" ");
  const phones = extractPhones(text);
  if (!phones.length) return { phone: null, extraPhones: [], rest: tokens };

  const rest = text
    .replace(/<tel:[^>]*>/gi, " ")
    .split(/\s+/)
    .filter(Boolean)
    .filter((token) => !(/\d/.test(token) && /^[+()\-.\d]+$/.test(token)));

  return { phone: phones[0], extraPhones: phones.slice(1), rest };
}

function takeFrom(tokens, sendingNumbers, aliases) {
  const working = [...tokens];
  const parsed = {};
  const index = working.findIndex((token) => token.toLowerCase() === "from");
  if (index < 0) return { tokens: working, parsed };

  parsed.fromAsked = true;
  const next = working[index + 1];
  working.splice(index, next ? 2 : 1);
  if (next) {
    const match = matchSendingNumber(next, sendingNumbers, { aliases });
    if (match) parsed.quoNumberId = match.id;
    else parsed.fromUnmatched = next;
  }
  return { tokens: working, parsed };
}

export function parseStartArgs(tokens, { sequenceSlugs = [], sendingNumbers = [], aliases = {} } = {}) {
  const parsed = {};
  const leftovers = [];

  // Pull `from spare` / `from 8888` / `from secondary` out first. Last four
  // digits would otherwise be stripped as phone punctuation before they can
  // match a Quo line.
  const takenFrom = takeFrom(tokens, sendingNumbers, aliases);
  Object.assign(parsed, takenFrom.parsed);

  const taken = takePhone(takenFrom.tokens);
  if (taken.phone) parsed.phone = taken.phone;

  for (const extra of taken.extraPhones) {
    const match = sendingNumbers.find((number) => number.phone_e164 === extra);
    if (match && !parsed.quoNumberId) parsed.quoNumberId = match.id;
  }

  for (const token of taken.rest) {
    const mention = token.match(/^<@([A-Z0-9]+)(\|[^>]*)?>$/);
    if (mention) { parsed.assignee = mention[1]; continue; }

    const lower = token.toLowerCase();
    if (!parsed.language && lower in LANGUAGE_WORDS) { parsed.language = LANGUAGE_WORDS[lower]; continue; }
    if (!parsed.sequenceSlug && sequenceSlugs.includes(lower)) { parsed.sequenceSlug = lower; continue; }
    leftovers.push(token);
  }

  const nameParts = leftovers.filter((token) => !/^[0-9+()\-.]+$/.test(token));
  if (nameParts.length) parsed.firstName = nameParts.join(" ");
  return parsed;
}
