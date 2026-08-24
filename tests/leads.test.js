import test from "node:test";
import assert from "node:assert/strict";

import { flattenSlackMessage, readLead, historyMessageToEvent, describeSlackHistoryError } from "../shared/leads.js";

// The four shapes actually posting into the lead channel. Kept verbatim rather
// than tidied, because the point of these tests is that real posts parse — a
// cleaned-up sample would prove nothing.
const WEBSITE = {
  text: "WEBSITE LEAD TO CONTACT\nThu, 20 Aug 2026 00:37:28 +0000\nNew Case is Submitted - Ramos James Law",
  blocks: [{
    type: "section",
    fields: [
      { type: "mrkdwn", text: "*Name*\nAmber" },
      { type: "mrkdwn", text: "*Email*\n<mailto:acel.hill135@gmail.com|acel.hill135@gmail.com>" },
      { type: "mrkdwn", text: "*Phone*\n8484676601" },
      { type: "mrkdwn", text: "*Comments*\nwas hit by a truck" },
    ],
  }],
};

const META_FORM = {
  text: "META FORM LEAD TO CONTACT\nName: Salvador Romero\nLanguage: Spanish\n"
    + "Phone: +12147723859\nEmail: Sromero65@icloud.com\n\n"
    + "Type of Accident: Resbalón y Caída\nInjuries: Sí\n\n"
    + "Campaign: Form Leads - ES 3 (CRM)\nAd Name: Retarget: Slip ES - SMS",
};

const WEB_CHAT = {
  text: ":fire: PRIORITY lead (qualified) — Ramos James Law\nQualified: :white_check_mark: Yes\n"
    + "Name: Caroline Sue Barnett\nPhone: 15128970458\nEmail: carolinebarnett49@gmail.com\n"
    + "Service: other\nFrom: <https://www.ramosjames.com/contact-us/?|ramosjames.com>\n"
    + "UTM: source=google / medium=cpc / campaign=1595317338",
};

const TIKTOK = {
  text: ":rotating_light: New TikTok Lead ... Name: Deborah Vargas ... "
    + "Phone: <tel:+19567133834|+1 956-713-3834> ... Email: vargasdeborah272@gmail.com ... "
    + "Injured: Yes ... When did it happen: Less than 6 months ... TikTok Lead ID: 7668484697474859294",
};

/* -------------------------------------------------------------- flattening */

test("a post that hides its content in block fields is still readable", () => {
  // The website form puts every field inside a section's `fields` array, so
  // reading event.text alone would find a header and nothing else.
  const text = flattenSlackMessage(WEBSITE);
  assert.match(text, /Amber/);
  assert.match(text, /8484676601/);
  assert.match(text, /was hit by a truck/);
});

test("Slack link markup is unwrapped rather than left as noise", () => {
  assert.match(flattenSlackMessage(WEBSITE), /acel\.hill135@gmail\.com/);
  assert.doesNotMatch(flattenSlackMessage(WEBSITE), /<mailto:/);
  assert.doesNotMatch(flattenSlackMessage(WEB_CHAT), /<https:/);
  assert.doesNotMatch(flattenSlackMessage(TIKTOK), /<tel:/);
});

test("attachment-only posts are read too", () => {
  const event = { attachments: [{ pretext: "New lead", text: "Jo Diaz, 512-555-0123, rear-ended" }] };
  assert.match(flattenSlackMessage(event), /Jo Diaz/);
  assert.match(flattenSlackMessage(event), /512-555-0123/);
});

test("an empty post flattens to nothing rather than throwing", () => {
  assert.equal(flattenSlackMessage({}), "");
  assert.equal(flattenSlackMessage(undefined), "");
  assert.equal(flattenSlackMessage({ blocks: [] }), "");
});

test("a payload that refers to itself does not hang", () => {
  const event = { text: "New lead 512-555-0123" };
  event.blocks = [{ type: "section", elements: [event] }];
  assert.match(flattenSlackMessage(event), /512-555-0123/);
});

/* ------------------------------------------------------------ the number */

test("every real source yields the right number", () => {
  // This is the field that must never be wrong — it decides who gets texted —
  // so it is read in code and never left to a model.
  const cases = [
    [WEBSITE, "+18484676601"],   // bare ten digits inside a block field
    [META_FORM, "+12147723859"], // already E.164
    [WEB_CHAT, "+15128970458"],  // eleven digits, no punctuation
    [TIKTOK, "+19567133834"],    // inside Slack's tel: markup
  ];
  for (const [event, expected] of cases) {
    assert.equal(readLead(flattenSlackMessage(event)).phone, expected);
  }
});

test("the campaign ID and lead ID are not mistaken for phone numbers", () => {
  // "campaign=1595317338" and "TikTok Lead ID: 7668484697474859294" are both
  // long digit runs sitting next to the real number.
  assert.equal(readLead(flattenSlackMessage(WEB_CHAT)).phone, "+15128970458");
  assert.equal(readLead(flattenSlackMessage(TIKTOK)).phone, "+19567133834");
});

test("a post with no number gives none rather than inventing one", () => {
  const text = flattenSlackMessage({ text: "Name: Jo\nEmail: jo@example.com\nplease email me" });
  assert.equal(readLead(text).phone, null);
});

/* ------------------------------------------------------------- the email */

test("the email comes through from each source", () => {
  assert.equal(readLead(flattenSlackMessage(WEBSITE)).email, "acel.hill135@gmail.com");
  assert.equal(readLead(flattenSlackMessage(META_FORM)).email, "Sromero65@icloud.com");
  assert.equal(readLead(flattenSlackMessage(TIKTOK)).email, "vargasdeborah272@gmail.com");
});

test("a post with no email is not a failure", () => {
  assert.equal(readLead("Name: Jo\nPhone: 512-555-0123").email, null);
});

test("a history row is turned into the same event the webhook would have sent", () => {
  // conversations.history omits `channel` on each message. Without it the
  // router would treat the post as belonging to some other channel and skip it.
  const event = historyMessageToEvent("C026G89PPSS", {
    type: "message",
    subtype: "bot_message",
    ts: "1777068000.000100",
    text: META_FORM.text,
    bot_profile: { name: "RJL" },
    app_id: "A123",
  });
  assert.equal(event.channel, "C026G89PPSS");
  assert.equal(event.subtype, "bot_message");
  assert.equal(event.bot_profile.name, "RJL");
  assert.equal(readLead(flattenSlackMessage(event)).phone, "+12147723859");
});

test("the Slack errors that actually happen are spelled out", () => {
  assert.match(describeSlackHistoryError("not_in_channel", "C026G89PPSS"), /invite/);
  assert.match(describeSlackHistoryError("missing_scope", "C026G89PPSS"), /manifest/);
  assert.match(describeSlackHistoryError("channel_not_found", "C026G89PPSS"), /private/);
  assert.match(describeSlackHistoryError("mystery", "C026G89PPSS"), /mystery/);
});
