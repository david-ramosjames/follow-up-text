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
  };
}
