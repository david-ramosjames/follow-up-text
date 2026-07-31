import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  appendOptOutNotice,
  classifyInbound,
  countSegments,
  describeDelay,
  normalizeInbound,
  previewStep,
  renderBody,
  START_KEYWORDS,
  STOP_KEYWORDS,
} from "../src/lib/render.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("merge fields are filled from the contact", () => {
  assert.equal(
    renderBody("Hi {{first_name}}, this is {{firm_name}}.", { first_name: "Maria", firm_name: "Ramos Law" }),
    "Hi Maria, this is Ramos Law.",
  );
});

test("a missing English name falls back to something sayable", () => {
  assert.equal(renderBody("Hi {{first_name}}, checking in.", {}), "Hi there, checking in.");
});

test("a missing Spanish name collapses instead of leaving a gap", () => {
  // Spanish has no neutral equivalent of "there", so the greeting has to close up.
  assert.equal(renderBody("Hola {{first_name}}, le escribimos.", {}, "es"), "Hola, le escribimos.");
});

test("spacing around punctuation survives an empty merge field", () => {
  assert.equal(renderBody("Hola {{first_name}} .", {}, "es"), "Hola.");
  assert.equal(renderBody("A {{first_name}} B", {}, "es"), "A B");
});

test("unknown tokens are left alone rather than blanked", () => {
  // Better to send a visible {{oops}} that someone notices than to silently drop
  // half a sentence.
  assert.equal(renderBody("Hi {{oops}}", { first_name: "X" }), "Hi {{oops}}");
});

test("token matching tolerates spacing and case", () => {
  assert.equal(renderBody("Hi {{ First_Name }}", { first_name: "Ana" }), "Hi Ana");
});

test("the opt-out notice is added once, not twice", () => {
  const once = appendOptOutNotice("Hi there.", "en");
  assert.equal(once, "Hi there. Reply STOP to opt out.");
  assert.equal(appendOptOutNotice(once, "en"), once);
});

test("copy that already mentions STOP does not get a second notice", () => {
  const body = "Call us back. Reply STOP to opt out of these texts.";
  assert.equal(appendOptOutNotice(body, "en"), body);
});

// ---------------------------------------------------------------- keywords

test("STOP keywords are recognised in both languages", () => {
  for (const word of ["STOP", "stop", "Stop.", "unsubscribe", "ALTO", "¡Alto!", "no mas", "no más"]) {
    assert.equal(classifyInbound(word).isStop, true, `${word} should opt out`);
  }
});

test("keywords are only matched as the whole message", () => {
  // These are the false positives that would unsubscribe a client who was
  // actually re-engaging, which is the worst possible outcome.
  const replies = [
    "please stop by the office tomorrow",
    "gracias, es para mi caso",
    "can you call me at the end of the day",
    "I want to cancel my appointment but still need the case handled",
    "yes please",
  ];
  for (const reply of replies) {
    assert.equal(classifyInbound(reply).isStop, false, `"${reply}" must not opt out`);
  }
});

test("accents and punctuation are normalized away", () => {
  assert.equal(normalizeInbound("  ¿SÍ?  "), "si");
  assert.equal(normalizeInbound("No más!"), "no mas");
});

test("bare yes is a START keyword, handled as a reply by the database", () => {
  // The word alone cannot distinguish "yes, subscribe me" from "yes, call me",
  // so the database only treats it as an opt-in when the contact is opted out.
  assert.equal(classifyInbound("yes").isStart, true);
  assert.equal(classifyInbound("yes please call me").isStart, false);
});

test("the keyword lists do not overlap", () => {
  const overlap = STOP_KEYWORDS.filter((word) => START_KEYWORDS.includes(word));
  assert.deepEqual(overlap, []);
});

// --------------------------------------------------------------- segments

test("plain English copy counts as one GSM-7 segment", () => {
  const result = countSegments("Hi Maria, this is the firm. Do you have a minute to talk?");
  assert.equal(result.encoding, "GSM-7");
  assert.equal(result.segments, 1);
});

test("161 GSM-7 characters spill into a second segment", () => {
  assert.equal(countSegments("a".repeat(160)).segments, 1);
  assert.equal(countSegments("a".repeat(161)).segments, 2);
});

test("only some Spanish accents survive GSM-7", () => {
  // The GSM-7 basic set covers é, è, ñ, ü, ¿ and ¡ but not á, í, ó or ú. So
  // "¿Tiene un minuto?" is a cheap single segment while "¿Está bien?" silently
  // drops to UCS-2 and halves the per-segment budget. That surprise is the whole
  // reason the editor shows a live segment count.
  assert.equal(countSegments("Le llamamos del bufete").encoding, "GSM-7");
  assert.equal(countSegments("¿Tiene un minuto para hablar? Señor").encoding, "GSM-7");
  assert.equal(countSegments("¿Está bien?").encoding, "UCS-2");
  assert.equal(countSegments("Último mensaje").encoding, "UCS-2");
  assert.equal(countSegments("It’s us").encoding, "UCS-2");
});

test("UCS-2 copy splits at 70 characters", () => {
  assert.equal(countSegments("á".repeat(70)).segments, 1);
  assert.equal(countSegments("á".repeat(71)).segments, 2);
});

test("an empty body is zero segments", () => {
  assert.equal(countSegments("").segments, 0);
});

// ---------------------------------------------------------------- preview

test("the preview shows the opt-out line on the first step only", () => {
  const step = { body_en: "Hi {{first_name}}, checking in.", body_es: "Hola {{first_name}}." };
  const first = previewStep(step, { language: "en", isFirst: true, vars: { first_name: "Dana" } });
  const later = previewStep(step, { language: "en", isFirst: false, vars: { first_name: "Dana" } });

  assert.equal(first.body, "Hi Dana, checking in. Reply STOP to opt out.");
  assert.equal(later.body, "Hi Dana, checking in.");
});

test("the preview honours the sequence's opt-out setting", () => {
  const step = { body_en: "Hi.", body_es: "Hola." };
  assert.equal(previewStep(step, { isFirst: true, appendNotice: false }).body, "Hi.");
});

test("the preview picks the Spanish body for Spanish enrollments", () => {
  const step = { body_en: "Hello", body_es: "Hola" };
  assert.equal(previewStep(step, { language: "es" }).body, "Hola");
});

// ----------------------------------------------------------------- delays

test("delays read the way a person would say them", () => {
  assert.equal(describeDelay(0), "immediately");
  assert.equal(describeDelay(45), "after 45 minutes");
  assert.equal(describeDelay(60), "after 1 hour");
  assert.equal(describeDelay(1440), "after 1 day");
  assert.equal(describeDelay(4320), "after 3 days");
});

// -------------------------------------------------------- drift guard

// The sender runs on Deno and cannot import this module, so the logic is
// duplicated. These checks fail the build if only one copy gets edited.
test("the Deno sender and the browser preview agree", () => {
  const deno = readFileSync(join(root, "supabase/functions/_shared/copy.ts"), "utf8");
  const browser = readFileSync(join(root, "src/lib/render.js"), "utf8");

  const listFrom = (source, name) => {
    const match = source.match(new RegExp(`${name}\\s*=\\s*(?:new Set\\()?\\[([\\s\\S]*?)\\]`));
    assert.ok(match, `${name} not found`);
    return match[1].split(",").map((entry) => entry.trim()).filter(Boolean).sort();
  };

  assert.deepEqual(listFrom(deno, "STOP_KEYWORDS"), listFrom(browser, "STOP_KEYWORDS"),
    "STOP keywords differ between the sender and the preview");
  assert.deepEqual(listFrom(deno, "START_KEYWORDS"), listFrom(browser, "START_KEYWORDS"),
    "START keywords differ between the sender and the preview");

  const noticeFrom = (source) => {
    const match = source.match(/OPT_OUT_NOTICE[^=]*=\s*\{([\s\S]*?)\}/);
    assert.ok(match, "OPT_OUT_NOTICE not found");
    return match[1].replace(/\s+/g, " ").trim();
  };
  assert.equal(noticeFrom(deno), noticeFrom(browser),
    "The opt-out wording differs, so the preview would lie about the segment count");

  const gsmFrom = (source) => {
    const match = source.match(/const GSM7 = ([\s\S]*?);\nconst GSM7_EXTENDED = (.*?);/);
    assert.ok(match, "GSM-7 tables not found");
    return `${match[1].replace(/\s+/g, "")}|${match[2]}`;
  };
  assert.equal(gsmFrom(deno), gsmFrom(browser), "The GSM-7 tables differ, so segment counts would differ");
});
