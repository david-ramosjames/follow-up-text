import test from "node:test";
import assert from "node:assert/strict";

import { decideLeadTexts, isExistingLeadContact, INITIAL_CONTACT_GRACE_MS } from "../server/lib/leadDecision.js";

test("automatic intake still skips a needs-more-info lead", () => {
  assert.deepEqual(
    decideLeadTexts({ kind: "needs_info", sequence: "needs_info" }),
    { allow: false, reason: "needs_info" },
  );
});

test("a manual start with no case data goes on new-lead", () => {
  assert.deepEqual(
    decideLeadTexts({ kind: "needs_info", sequence: "needs_info" }, { manual: true }),
    { allow: true, reason: "needs_info_manual", sequenceSlug: "new-lead" },
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

test("a manual start still goes when Intake Manager marked the lead Lost", () => {
  assert.deepEqual(
    decideLeadTexts({ lead_status: "Lost" }, { manual: true }),
    { allow: true, reason: "lost_manual", sequenceSlug: "new-lead" },
  );
});

test("signed cases and an explicit stop stay blocked even from Slack", () => {
  assert.equal(decideLeadTexts({ signed_case: true }, { manual: true }).allow, false);
  assert.equal(decideLeadTexts({ case_id: "C-1" }, { manual: true }).allow, false);
  assert.equal(decideLeadTexts({ sequence: "stop" }, { manual: true }).allow, false);
});

test("automatic intake still skips a Lost lead", () => {
  assert.deepEqual(
    decideLeadTexts({ lead_status: "Lost" }),
    { allow: false, reason: "Lost" },
  );
});

test("a lead just created by this call is still first contact", () => {
  const now = Date.parse("2026-10-20T18:00:00Z");
  assert.equal(isExistingLeadContact(null), false);
  assert.equal(isExistingLeadContact({ created_at: "2026-10-20T17:50:00Z" }, now), false);
  assert.equal(
    isExistingLeadContact({ created_at: new Date(now - INITIAL_CONTACT_GRACE_MS - 1000).toISOString() }, now),
    true,
  );
});
