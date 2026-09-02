import test from "node:test";
import assert from "node:assert/strict";

import {
  callDurationSeconds,
  describeCallDuration,
  isIncomingCall,
  isOutgoingCall,
  outboundCallOutcome,
  unwrapQuoContext,
  unwrapQuoObject,
} from "../shared/calls.js";

test("an inbound call is incoming even without a direction", () => {
  assert.equal(isIncomingCall({ direction: "incoming" }), true);
  assert.equal(isIncomingCall({ direction: "inbound" }), true);
  assert.equal(isIncomingCall({}), true);
  assert.equal(isOutgoingCall({ direction: "outgoing" }), true);
  assert.equal(isOutgoingCall({ direction: "inbound" }), false);
});

test("outbound length splits miss / short review / long stop", () => {
  assert.equal(outboundCallOutcome({ direction: "outgoing", status: "unanswered" }), "unanswered");
  assert.equal(outboundCallOutcome({
    direction: "outgoing", answeredAt: "2026-09-01T23:02:00.000Z", duration: 45,
  }), "short");
  assert.equal(outboundCallOutcome({
    direction: "outgoing", answeredAt: "2026-09-01T23:02:00.000Z",
  }), "short");
  assert.equal(outboundCallOutcome({
    direction: "outgoing", status: "answered", duration: 119,
  }), "short");
  assert.equal(outboundCallOutcome({
    direction: "outgoing", status: "answered", duration: 120,
  }), "long");
  assert.equal(outboundCallOutcome({
    direction: "outgoing",
    answeredAt: "2026-09-01T23:00:00.000Z",
    completedAt: "2026-09-01T23:03:05.000Z",
  }), "long");
  assert.equal(callDurationSeconds({ duration: 45 }), 45);
  assert.equal(describeCallDuration(45), "45 seconds");
  assert.equal(describeCallDuration(120), "2 minutes");
  assert.equal(describeCallDuration(135), "2 min 15 sec");
});

test("Quo nests the call under data.object or data.resource", () => {
  assert.equal(unwrapQuoObject({
    type: "call.completed",
    data: { object: { direction: "outgoing", answeredAt: "2026-09-01T23:02:00.000Z" } },
  }).direction, "outgoing");
  assert.equal(unwrapQuoObject({
    type: "call.completed",
    data: { resource: { direction: "outgoing", status: "answered" } },
  }).status, "answered");
  assert.equal(unwrapQuoContext({
    data: { resource: {}, context: { phoneNumberId: "PN1" } },
  }).phoneNumberId, "PN1");
});
