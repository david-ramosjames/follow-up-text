import test from "node:test";
import assert from "node:assert/strict";

import {
  isAnsweredCall, isIncomingCall, isOutgoingCall, unwrapQuoContext, unwrapQuoObject,
} from "../shared/calls.js";

test("an inbound call is incoming even without a direction", () => {
  assert.equal(isIncomingCall({ direction: "incoming" }), true);
  assert.equal(isIncomingCall({ direction: "inbound" }), true);
  assert.equal(isIncomingCall({}), true);
  assert.equal(isOutgoingCall({ direction: "outgoing" }), true);
  assert.equal(isOutgoingCall({ direction: "inbound" }), false);
});

test("an outbound call is answered only when Quo says it connected", () => {
  assert.equal(isAnsweredCall({ direction: "outgoing" }), false);
  assert.equal(isAnsweredCall({ direction: "outgoing", status: "unanswered" }), false);
  assert.equal(isAnsweredCall({ direction: "outgoing", status: "completed" }), false);
  assert.equal(isAnsweredCall({ direction: "outgoing", answeredAt: "2026-09-01T23:02:00.000Z" }), true);
  assert.equal(isAnsweredCall({ direction: "outgoing", status: "answered" }), true);
  assert.equal(isAnsweredCall({ direction: "outgoing", duration: 180 }), true);
  assert.equal(isAnsweredCall({ direction: "outgoing", duration: 0 }), false);
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
