import test from "node:test";
import assert from "node:assert/strict";

import {
  appendOptOutNotice,
  classifyInbound,
  countSegments,
  DELAY_PRESETS,
  describeDelay,
  extractPhones,
  formatPhone,
  hasEmoji,
  isNightHour,
  maskPhone,
  matchSendingNumber,
  missingMergeTokens,
  mergeTokens,
  normalizeInbound,
  normalizePhone,
  previewStep,
  renderBody,
  START_KEYWORDS,
  STOP_KEYWORDS,
  truncateChars,
} from "../shared/messaging.js";

/* ------------------------------------------------------------ merge fields */

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
  assert.equal(renderBody("Hola {{first_name}}, le escribimos.", {}, "es"), "Hola, le escribimos.");
});

test("spacing around punctuation survives an empty merge field", () => {
  assert.equal(renderBody("Hola {{first_name}} .", {}, "es"), "Hola.");
  assert.equal(renderBody("A {{first_name}} B", {}, "es"), "A B");
});

test("unknown tokens are left visible rather than blanked", () => {
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

/* ---------------------------------------------------------------- keywords */

test("STOP keywords are recognised in both languages", () => {
  for (const word of ["STOP", "stop", "Stop.", "unsubscribe", "ALTO", "¡Alto!", "no mas", "no más"]) {
    assert.equal(classifyInbound(word).isStop, true, `${word} should opt out`);
  }
});

test("keywords are only matched as the whole message", () => {
  // These are the false positives that would unsubscribe a client who was
  // actually re-engaging, which is the worst outcome this system can produce.
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

test("bare yes is a START keyword, resolved as a reply by the database", () => {
  assert.equal(classifyInbound("yes").isStart, true);
  assert.equal(classifyInbound("yes please call me").isStart, false);
});

test("the keyword lists do not overlap", () => {
  assert.deepEqual(STOP_KEYWORDS.filter((word) => START_KEYWORDS.includes(word)), []);
});

/* ---------------------------------------------------------------- segments */

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
  // é, è, ñ, ü, ¿ and ¡ are in the GSM-7 table; á, í, ó and ú are not. One of
  // those halves the per-segment budget, which is why the editor shows a live
  // segment count.
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

/* ----------------------------------------------------------------- preview */

test("the preview shows the opt-out line on the first step only", () => {
  const step = { body_en: "Hi {{first_name}}, checking in.", body_es: "Hola {{first_name}}." };
  assert.equal(
    previewStep(step, { language: "en", isFirst: true, vars: { first_name: "Dana" } }).body,
    "Hi Dana, checking in. Reply STOP to opt out.",
  );
  assert.equal(
    previewStep(step, { language: "en", isFirst: false, vars: { first_name: "Dana" } }).body,
    "Hi Dana, checking in.",
  );
});

test("the preview honours the sequence's opt-out setting", () => {
  assert.equal(previewStep({ body_en: "Hi.", body_es: "Hola." }, { isFirst: true, appendNotice: false }).body, "Hi.");
});

test("the preview picks the Spanish body for Spanish clients", () => {
  assert.equal(previewStep({ body_en: "Hello", body_es: "Hola" }, { language: "es" }).body, "Hola");
});

test("the preview uses night wording when asked", () => {
  const step = {
    body_en: "Hi, we got your message.",
    body_es: "Hola.",
    body_en_night: "Hi, we got your message tonight.",
    body_es_night: "Hola, esta noche.",
  };
  assert.equal(previewStep(step).body, "Hi, we got your message.");
  assert.equal(previewStep(step, { isNight: true }).body, "Hi, we got your message tonight.");
  assert.equal(previewStep(step, { isNight: true }).usedNight, true);
  assert.equal(previewStep({ body_en: "Hi.", body_es: "Hola." }, { isNight: true }).usedNight, false);
});

test("night hours wrap midnight", () => {
  assert.equal(isNightHour(21, 21, 8), true);
  assert.equal(isNightHour(2, 21, 8), true);
  assert.equal(isNightHour(8, 21, 8), false);
  assert.equal(isNightHour(14, 21, 8), false);
});

/* ------------------------------------------------------------------ delays */

test("delays read the way a person would say them", () => {
  assert.equal(describeDelay(0), "immediately");
  assert.equal(describeDelay(45), "after 45 minutes");
  assert.equal(describeDelay(60), "after 1 hour");
  assert.equal(describeDelay(1440), "after 1 day");
  assert.equal(describeDelay(4320), "after 3 days");
  assert.equal(describeDelay(5760), "after 4 days");
  assert.equal(describeDelay(17280), "after 12 days");
});

test("delay presets include the multi-day cadence", () => {
  const minutes = DELAY_PRESETS.map((preset) => preset.minutes);
  for (const value of [0, 1440, 2880, 5760, 8640, 11520, 17280]) {
    assert.equal(minutes.includes(value), true, `missing preset ${value}`);
  }
});

test("merge tokens are compared without caring about case or spacing", () => {
  assert.deepEqual(mergeTokens("Hi {{first_name}} from {{ firm_name }}."), ["{{first_name}}", "{{firm_name}}"]);
  assert.deepEqual(
    missingMergeTokens("Hi {{First_Name}}, {{case_type}}.", "Hola {{first_name}}, {{case_type}}."),
    [],
  );
  assert.deepEqual(
    missingMergeTokens("Hi {{first_name}} about {{case_type}}.", "Hola {{first_name}}."),
    ["{{case_type}}"],
  );
});

/* ------------------------------------------------------------ phone numbers */

test("phone numbers normalize the way people type them", () => {
  assert.equal(normalizePhone("5125550123"), "+15125550123");
  assert.equal(normalizePhone("(512) 555-0123"), "+15125550123");
  assert.equal(normalizePhone("1-512-555-0123"), "+15125550123");
  assert.equal(normalizePhone("+1 512 555 0123"), "+15125550123");
  assert.equal(normalizePhone("call me"), null);
  assert.equal(normalizePhone("5550123"), null);
});

test("formatting and masking", () => {
  assert.equal(formatPhone("+15125550123"), "(512) 555-0123");
  assert.equal(maskPhone("+15125550123"), "(•••) •••-0123");
});

/* -------------------------------------------- pulling numbers out of Slack */

test("a number is found in an ordinary Slack message", () => {
  const text = "New MVA lead from the website. Ana Ruiz, 512-555-0123, rear-ended on I-35 yesterday.";
  assert.deepEqual(extractPhones(text), ["+15125550123"]);
});

test("Slack's tel: link markup is unwrapped", () => {
  // Slack rewrites anything phone-shaped into <tel:+15125550123|(512) 555-0123>,
  // so the raw message text is not what was typed.
  assert.deepEqual(extractPhones("Call <tel:+15125550123|(512) 555-0123> back"), ["+15125550123"]);
});

test("several numbers come back in the order they appear", () => {
  const text = "Client 512-555-0123, her husband on (512) 555-0199.";
  assert.deepEqual(extractPhones(text), ["+15125550123", "+15125550199"]);
});

test("the same number written twice is only returned once", () => {
  assert.deepEqual(extractPhones("512-555-0123 and +1 512 555 0123"), ["+15125550123"]);
});

test("links and emails do not produce phantom numbers", () => {
  const text = "Form at <https://firm.com/intake?id=2026001234> from <mailto:a@b.com|a@b.com>";
  assert.deepEqual(extractPhones(text), []);
});

test("short digit runs are not mistaken for numbers", () => {
  assert.deepEqual(extractPhones("Case 2026-118, filed 08/03/2026, $4,500 in bills"), []);
});

test("a message with no number gives nothing rather than guessing", () => {
  assert.deepEqual(extractPhones("Following up with the client from yesterday"), []);
});

/* -------------------------------------------------------------------- emoji */

test("one emoji drops the whole message to UCS-2", () => {
  const plain = countSegments("Hi Maria, checking in about your case.");
  const withEmoji = countSegments("Hi Maria \u{1F44B}, checking in about your case.");
  assert.equal(plain.encoding, "GSM-7");
  assert.equal(withEmoji.encoding, "UCS-2");
});

test("an emoji costs two characters, because it is two UTF-16 units", () => {
  // This is not a quirk of the implementation — UCS-2 SMS counts code units,
  // so a surrogate pair really does take two of the seventy.
  assert.equal(countSegments("\u{1F44B}").characters, 2);
  assert.equal(countSegments("ab").characters, 2);
});

test("emoji made of several code points cost all of them", () => {
  // 👨‍👩‍👧 is three people joined by two zero-width joiners: 8 units, not 1.
  assert.equal(countSegments("\u{1F468}‍\u{1F469}‍\u{1F467}").characters, 8);
});

test("a 36-emoji message is already two segments", () => {
  // 70 units per single segment, two units each, so 35 is the whole budget.
  assert.equal(countSegments("\u{1F44B}".repeat(35)).segments, 1);
  assert.equal(countSegments("\u{1F44B}".repeat(36)).segments, 2);
});

test("hasEmoji tells emoji apart from accents", () => {
  assert.equal(hasEmoji("Gracias \u{1F64F}"), true);
  assert.equal(hasEmoji("❤️"), true);
  // Accented Spanish is also UCS-2, but for a different reason and with
  // different advice, so it must not read as an emoji.
  assert.equal(hasEmoji("Su caso está listo"), false);
  assert.equal(hasEmoji(""), false);
  assert.equal(hasEmoji(null), false);
});

test("truncating never leaves half an emoji behind", () => {
  // Cutting at 5 lands mid-surrogate-pair; slice() would emit a lone half.
  const text = `abcd\u{1F44B}efg`;
  const cut = truncateChars(text, 5);
  assert.equal(cut, "abcd");
  assert.ok(!/[\uD800-\uDFFF]/.test(cut), "no unpaired surrogate survives");
});

test("truncating leaves short text alone", () => {
  assert.equal(truncateChars("Hi \u{1F44B}", 50), "Hi \u{1F44B}");
});

/* ---------------------------------------------- numbers that are not numbers */

test("a Quo handle is refused rather than turned into a fake number", () => {
  // The payload that disabled the webhook: `from` was "@04961199404". Stripping
  // the "@" left eleven digits, which used to become "+04961199404" — a value
  // the contacts table rejects, so the insert raised and the webhook 500ed.
  assert.equal(normalizePhone("@04961199404"), null);
  assert.equal(normalizePhone("@06813922298"), null);
});

test("a leading zero is never a valid country code", () => {
  assert.equal(normalizePhone("+04961199404"), null);
  assert.equal(normalizePhone("0123456789012"), null);
});

test("anything returned is a number the contacts table will accept", () => {
  // Same expression as the check constraint on followup_contacts.phone_e164.
  const constraint = /^\+[1-9][0-9]{7,14}$/;
  const inputs = [
    "5125550123", "(512) 555-0123", "+1 512 555 0123", "1-512-555-0123",
    "@04961199404", "+04961199404", "not a phone", "", "12345", "+",
    "+999999999999999999", "0000000000",
  ];
  for (const input of inputs) {
    const result = normalizePhone(input);
    if (result !== null) {
      assert.match(result, constraint, `${input} produced ${result}, which the table would refuse`);
    }
  }
});

test("real numbers still normalize", () => {
  assert.equal(normalizePhone("+15125550123"), "+15125550123");
  assert.equal(normalizePhone("5125550123"), "+15125550123");
  assert.equal(normalizePhone("+44 20 7946 0958"), "+442079460958");
});

const QUO_LINES = [
  { id: "PNINTAKE", phone_e164: "+15125557777", label: "Intake line" },
  { id: "PNSPARE", phone_e164: "+15125558888", label: "Spare line" },
];

test("a sending number matches by label, last four, or full number", () => {
  assert.equal(matchSendingNumber("spare", QUO_LINES)?.id, "PNSPARE");
  assert.equal(matchSendingNumber("8888", QUO_LINES)?.id, "PNSPARE");
  assert.equal(matchSendingNumber("512-555-8888", QUO_LINES)?.id, "PNSPARE");
  assert.equal(matchSendingNumber("PNINTAKE", QUO_LINES)?.id, "PNINTAKE");
  assert.equal(matchSendingNumber("nope", QUO_LINES), null);
  assert.equal(matchSendingNumber("secondary", QUO_LINES, { aliases: { secondary: "PNSPARE" } })?.id, "PNSPARE");
});

test("an ambiguous last four does not pick a sending number", () => {
  const clash = [
    { id: "A", phone_e164: "+15125550123", label: "One" },
    { id: "B", phone_e164: "+12125550123", label: "Two" },
  ];
  assert.equal(matchSendingNumber("0123", clash), null);
});
