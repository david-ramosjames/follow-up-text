// Whether a Quo call event should stop a running series.
//
// Incoming: always re-engagement, even if they hang up.
// Outbound: a miss keeps the drip going. A conversation of two minutes or more
// is a real reach and stops it. A short connect is ambiguous (voicemail, "wrong
// number", they asked to be called back) so the series continues and Slack asks.

export const LONG_OUTBOUND_SECONDS = 120;

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

export function callDurationSeconds(object) {
  const duration = Number(object?.duration);
  if (Number.isFinite(duration) && duration >= 0) return Math.round(duration);
  if (object?.answeredAt && object?.completedAt) {
    const start = Date.parse(object.answeredAt);
    const end = Date.parse(object.completedAt);
    if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
      return Math.round((end - start) / 1000);
    }
  }
  return null;
}

export function describeCallDuration(seconds) {
  if (seconds == null) return "an unknown length";
  if (seconds < 60) return `${seconds} second${seconds === 1 ? "" : "s"}`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (!rest) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  return `${minutes} min ${rest} sec`;
}

// unanswered | short | long
export function outboundCallOutcome(object) {
  if (!isAnsweredCall(object)) return "unanswered";
  const seconds = callDurationSeconds(object);
  if (seconds == null) return "short";
  return seconds >= LONG_OUTBOUND_SECONDS ? "long" : "short";
}

export function unwrapQuoObject(body) {
  const data = body?.data ?? {};
  return data?.object ?? data?.resource ?? (Object.keys(data).length ? data : body) ?? {};
}

export function unwrapQuoContext(body) {
  const data = body?.data ?? {};
  return data?.context ?? {};
}
