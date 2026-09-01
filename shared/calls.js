// Whether a Quo call event should stop a running series.
//
// A client ringing in is always re-engagement, even if they hang up. Our own
// outbound dial is the reason the series exists, so a miss or a ring must not
// stop it — but once somebody at the firm actually reaches them, the drip is
// over. "We tried reaching you and missed you" after a completed intake call
// is the failure this is here to prevent.

export function isIncomingCall(object) {
  const direction = String(object?.direction ?? "").toLowerCase();
  return direction === "incoming" || direction === "inbound" || direction === "";
}

export function isOutgoingCall(object) {
  const direction = String(object?.direction ?? "").toLowerCase();
  return direction === "outgoing" || direction === "outbound";
}

export function isAnsweredCall(object) {
  if (object?.answeredAt) return true;
  const status = String(object?.status ?? "").toLowerCase();
  if (status === "answered" || status === "ai-handled") return true;
  const duration = Number(object?.duration);
  return Number.isFinite(duration) && duration > 0;
}

export function unwrapQuoObject(body) {
  const data = body?.data ?? {};
  return data?.object ?? data?.resource ?? (Object.keys(data).length ? data : body) ?? {};
}

export function unwrapQuoContext(body) {
  const data = body?.data ?? {};
  return data?.context ?? {};
}
