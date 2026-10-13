import test from "node:test";
import assert from "node:assert/strict";

import { decideLeadTexts } from "../server/lib/leadDecision.js";

test("automatic intake still skips a needs-more-info lead", () => {
  assert.deepEqual(
    decideLeadTexts({ kind: "needs_info", sequence: "needs_info" }),
    { allow: false, reason: "needs_info" },
  );
});

test("a manual start with no case data goes on qualified-lead", () => {
  assert.deepEqual(
    decideLeadTexts({ kind: "needs_info", sequence: "needs_info" }, { manual: true }),
    { allow: true, reason: "needs_info_manual", sequenceSlug: "qualified-lead" },
  );
});

test("a manual start keeps the sequence the person named", () => {
  assert.equal(
    decideLeadTexts(
      { kind: "needs_info", sequence: "needs_info" },
      { manual: true, sequenceSlug: "new-lead" },
    ).sequenceSlug,
    "new-lead",
  );
});

test("signed and stopped leads stay blocked even from Slack", () => {
  assert.equal(decideLeadTexts({ signed_case: true }, { manual: true }).allow, false);
  assert.equal(decideLeadTexts({ sequence: "stop" }, { manual: true }).allow, false);
  assert.equal(decideLeadTexts({ lead_status: "Lost" }, { manual: true }).allow, false);
});
