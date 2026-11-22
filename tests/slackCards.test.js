import test from "node:test";
import assert from "node:assert/strict";

import { languageLabel, patchEnrollmentLanguageBlocks } from "../shared/slackCards.js";

test("language labels match the Slack card wording", () => {
  assert.equal(languageLabel("es"), "Spanish");
  assert.equal(languageLabel("en"), "English");
  assert.equal(languageLabel(null), "English");
});

test("switching language rewrites the field, routing line, and button", () => {
  const blocks = [
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: "*Sequence*\nMissed Call" },
        { type: "mrkdwn", text: "*Language*\nEnglish" },
      ],
    },
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: ":white_circle: Routed to *Missed Call* · English\n_Sona call — New lead follow-up_" }],
    },
    {
      type: "actions",
      elements: [
        { type: "button", action_id: "followup_stop", value: "enroll-1" },
        {
          type: "button",
          action_id: "followup_switch_language",
          text: { type: "plain_text", text: "Switch to Spanish" },
          value: "enroll-1",
        },
      ],
    },
  ];

  const next = patchEnrollmentLanguageBlocks(blocks, "es", "enroll-1");
  assert.equal(next[0].fields[1].text, "*Language*\nSpanish");
  assert.match(next[1].elements[0].text, / · Spanish\n/);
  assert.equal(next[2].elements[1].text.text, "Switch to English");
  assert.equal(blocks[0].fields[1].text, "*Language*\nEnglish");
});

test("an older start card gets the switch button next to Stop", () => {
  const blocks = [{
    type: "actions",
    elements: [
      { type: "button", action_id: "followup_stop", value: "enroll-2" },
      { type: "static_select", action_id: "followup_reroute" },
    ],
  }];

  const next = patchEnrollmentLanguageBlocks(blocks, "en", "enroll-2");
  assert.equal(next[0].elements[1].action_id, "followup_switch_language");
  assert.equal(next[0].elements[1].text.text, "Switch to Spanish");
  assert.equal(next[0].elements[2].action_id, "followup_reroute");
});
