// Slack only turns `<@U0123ABC>` into a name when the id is alone inside the
// brackets. A settings field with several member IDs stuffed into one mention
// — `<@U026P9FUKHC, U0AFCCVC7S5>` — prints as raw ids. Split them first.

const USER_ID = /\b([UW][A-Z0-9]{8,})\b/g;

export function parseSlackUserIds(value) {
  const text = String(value ?? "");
  const ids = [];
  const seen = new Set();
  for (const match of text.matchAll(USER_ID)) {
    const id = match[1];
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

export function formatSlackMentions(value, fallback = "") {
  const ids = parseSlackUserIds(value);
  if (ids.length) return ids.map((id) => `<@${id}>`).join(" ");
  return String(fallback || value || "").trim();
}
