// Reading a lead out of a Slack post, without needing a database or a model.
//
// Kept apart from the classifier on purpose. Everything here is deterministic
// and testable on its own, and the phone number in particular is never left to
// a model: being wrong about it means texting a stranger.
import { extractPhones } from "./messaging.js";

// Slack apps put their content in wildly different places — some in `text`,
// some only inside block elements, some in legacy attachments. The four sources
// posting into the lead channel each pick a different one, so flatten all of it
// and let the reader see what a person sees.
export function flattenSlackMessage(event) {
  const parts = [];
  const seen = new Set();

  const walk = (node) => {
    if (node === null || node === undefined) return;
    if (typeof node === "string") { parts.push(node); return; }
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (typeof node !== "object") return;
    // Guards against a payload that refers back to itself.
    if (seen.has(node)) return;
    seen.add(node);

    for (const key of ["text", "value", "title", "pretext", "fallback", "alt_text"]) {
      const child = node[key];
      if (typeof child === "string") parts.push(child);
      else if (child && typeof child === "object") walk(child);
    }
    for (const key of ["blocks", "elements", "fields", "attachments"]) walk(node[key]);
  };

  walk(event?.text);
  walk(event?.blocks);
  walk(event?.attachments);

  // Slack markup carries no meaning for a reader and a lot of noise. Unwrap the
  // links rather than dropping them: a UTM or a form URL is often the only clue
  // to which source a post came from.
  return [...new Set(parts)]
    .join("\n")
    .replace(/<(https?:[^|>]+)\|([^>]+)>/g, "$2 ($1)")
    .replace(/<tel:[^|>]*\|([^>]+)>/g, "$1")
    .replace(/<mailto:([^|>]+)(\|[^>]*)?>/g, "$1")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// conversations.history omits `channel` on each message. The event handler keys
// off event.channel, so a history row has to be given one before it is treated
// as a post.
export function historyMessageToEvent(channel, message) {
  return { ...message, channel, type: message?.type || "message" };
}

const SLACK_HISTORY_ERRORS = {
  not_in_channel:
    "The bot is not in this channel. Open it in Slack and /invite the follow-up bot.",
  channel_not_found:
    "Slack does not recognise that channel ID. Check it under Settings. If the channel is private, re-apply the app manifest and reinstall so the bot has groups:history.",
  missing_scope:
    "The Slack bot is missing permission to read this channel. Re-apply the app manifest, then reinstall the app to the workspace.",
  invalid_auth: "SLACK_BOT_TOKEN was rejected by Slack.",
  token_revoked: "SLACK_BOT_TOKEN was revoked. Install the Slack app again and put the new token in Railway.",
  account_inactive: "The Slack workspace this token belongs to is no longer active.",
};

export function describeSlackHistoryError(code, channel) {
  const known = SLACK_HISTORY_ERRORS[code];
  if (known) return `${known} (${channel})`;
  if (!code) return `Could not read ${channel} from Slack.`;
  return `Slack refused to read ${channel}: ${code}.`;
}

const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/;

// Everything readable without a model. No usable number means this is not a
// lead anything can act on, whatever else the post says.
export function readLead(text) {
  const body = String(text ?? "");
  const phones = extractPhones(body);
  return {
    phone: phones[0] ?? null,
    email: body.match(EMAIL)?.[0] ?? null,
    text: body,
    referral: isOutboundReferral(body),
  };
}

// Forms that this firm will send to another lawyer are marked Referral on the
// Slack post (the forms also misspell it Referal). That is a field to parse,
// not a judgement for the model: "referred by a friend" is not the same thing.
export function isOutboundReferral(text) {
  return /\breferr?als?\b/i.test(String(text ?? ""));
}

// When the model returns no slug, or a slug that is not a live track, pick
// something the router is actually allowed to start. New lead follow-up is the
// default sequence for hand starts — it is not a track — so an injury form
// with no slug lands on qualified-lead rather than a sequence that still says
// "accident".
export function pickTrackSlug({ preferred, referral = false, tracks = [] } = {}) {
  const has = (slug) => tracks.some((track) => track.slug === slug);
  if (referral && has("referral")) return "referral";
  if (preferred && has(preferred)) return preferred;
  if (has("qualified-lead")) return "qualified-lead";
  return tracks[0]?.slug ?? null;
}
