// Short names (slugs) are the URL and the Slack shorthand. A duplicate has to
// mint a free one without colliding with qualified-lead / referral / anything
// already on the Sequences page.

export function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

// "Qualified lead (copy)" and "Qualified lead (copy 2)" both stem back to
// "Qualified lead", so duplicating a copy does not become "(copy) (copy)".
function stemName(name) {
  return String(name || "").trim().replace(/\s+\(copy(?:\s+\d+)?\)$/i, "") || "Sequence";
}

export function uniqueCopyIdentity(baseName, takenSlugs = []) {
  const taken = new Set(takenSlugs);
  const trimmed = stemName(baseName);
  const root = slugify(trimmed) || "copy";

  for (let n = 1; n < 1000; n++) {
    const name = n === 1 ? `${trimmed} (copy)` : `${trimmed} (copy ${n})`;
    const suffix = n === 1 ? "-copy" : `-copy-${n}`;
    const slug = `${root.slice(0, Math.max(1, 60 - suffix.length))}${suffix}`;
    if (!taken.has(slug)) return { name, slug };
  }

  throw new Error("Could not find a free short name.");
}
