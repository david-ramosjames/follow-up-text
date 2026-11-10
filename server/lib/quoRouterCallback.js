// Ask quo-router to run the webform callback-tag ladder in a Slack thread.
// follow-up-text sees form/chat posts; quo-router owns phone-staff presence,
// the daily channel topic, and the escalation timer.

function routerBaseUrl() {
  return String(process.env.QUO_ROUTER_URL || "").replace(/\/+$/, "");
}

function routerFirmId() {
  return String(process.env.QUO_ROUTER_FIRM_ID || "ramosjames").trim() || "ramosjames";
}

function routerToken() {
  return String(
    process.env.QUO_ROUTER_REPORT_TOKEN
      || process.env.REPORT_API_TOKEN
      || "",
  ).trim();
}

export function webformCallbackConfigured() {
  return Boolean(routerBaseUrl() && routerToken());
}

/**
 * Start outbound → inbound → LA → managers callback tags (one at a time, 2 min).
 * No-ops when QUO_ROUTER_* env is missing. Never throws to the lead router.
 */
export async function startWebformCallbackEscalation({
  channelId,
  parentTs,
  phone = null,
  intervalSeconds = 120,
} = {}) {
  const base = routerBaseUrl();
  const token = routerToken();
  if (!base || !token) {
    console.log("webform callback tags skipped — set QUO_ROUTER_URL and QUO_ROUTER_REPORT_TOKEN");
    return { ok: false, reason: "not_configured" };
  }
  if (!channelId || !parentTs) {
    return { ok: false, reason: "missing_thread" };
  }

  const firmId = encodeURIComponent(routerFirmId());
  const url = `${base}/api/firms/${firmId}/callback-escalation/start`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        lane: "webform",
        channelId,
        parentTs,
        phone: phone || null,
        intervalSeconds,
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.warn(
        `webform callback tags failed (${res.status}): ${body.error || body.detail || body.reason || res.statusText}`,
      );
      return { ok: false, reason: body.reason || "http_error", status: res.status, body };
    }
    console.log(
      `webform callback tags started in ${channelId}/${parentTs}`
      + (body.intervalSeconds ? ` every ${body.intervalSeconds}s` : ""),
    );
    return { ok: true, ...body };
  } catch (err) {
    console.warn("webform callback tags error:", err.message);
    return { ok: false, reason: "network_error", detail: err.message };
  }
}
