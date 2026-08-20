import {
  appendOptOutNotice,
  countSegments,
  renderBody,
} from "../../shared/messaging.js";
import { rpc, rpcSet } from "../db.js";
import { resolveSendingNumber, sendText } from "./quo.js";
import { retireStartCard } from "./followups.js";
import { displayPhone, postToThread } from "./slack.js";
import { loadSettings } from "./settings.js";

// Quo throttles the messages endpoint at roughly ten calls a second. Pacing at
// eight keeps a large batch comfortably under the limit.
const SEND_INTERVAL_MS = 125;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function buildBody(row, settings) {
  // A step may carry separate copy for the middle of the night, because "we
  // just received your message" reads wrong at 3am. Falls back to the ordinary
  // body, so night copy is something you add where it matters rather than
  // something every step has to have. Whether it is night was decided in the
  // database, on the client's clock, at the moment the text was claimed.
  const night = row.language === "es" ? row.body_es_night : row.body_en_night;
  const day = row.language === "es" ? row.body_es : row.body_en;
  const template = row.is_night && night?.trim() ? night : day;
  const rendered = renderBody(template, {
    first_name: row.first_name,
    last_name: row.last_name,
    case_reference: row.case_reference,
    assigned_user: row.assigned_slack_user_name,
    firm_name: settings.firm_name,
  }, row.language);

  // The opt-out line goes on the first text of a series only. Repeating it on
  // every message wastes a third of a segment and reads as automated.
  return row.is_first_step && row.append_opt_out_notice
    ? appendOptOutNotice(rendered, row.language)
    : rendered;
}

async function sendOne(row, settings) {
  const body = buildBody(row, settings);
  const segments = countSegments(body).segments;

  const numberId = row.quo_number_id || settings.default_quo_number_id;
  const number = await resolveSendingNumber(numberId);
  const from = number?.phone_e164 ?? null;

  const result = from
    ? await sendText({ to: row.to_number, from, content: body })
    : { ok: false, retryable: false, error: "No Quo number is selected for this sequence, and no default is set." };

  const recorded = await rpc("followup_record_send", {
    enrollment_id: row.enrollment_id,
    step_id: row.step_id,
    ok: result.ok,
    body,
    segments,
    quo_message_id: result.id ?? null,
    quo_number_id: numberId ?? null,
    from_number: from,
    to_number: row.to_number,
    error: result.error ?? null,
  });

  const shown = await displayPhone(row.to_number);
  const who = row.first_name ? `${row.first_name} (${shown})` : shown;

  if (!result.ok && recorded?.final) {
    await postToThread({
      channel: row.slack_channel_id,
      threadTs: row.slack_thread_ts,
      text: `:warning: Follow-up texts to ${who} keep failing, so the series has been stopped. `
        + `<@${row.assigned_slack_user_id}> may want to try calling. Last error: ${result.error}`,
    });
  } else if (result.ok && recorded?.completed) {
    await postToThread({
      channel: row.slack_channel_id,
      threadTs: row.slack_thread_ts,
      text: `:checkered_flag: The follow-up series for ${who} has finished with no reply. `
        + `<@${row.assigned_slack_user_id}>`,
    });
  }

  // Both of those end the series, so the start card's Stop button goes too.
  if (recorded?.final || recorded?.completed) await retireStartCard(row.enrollment_id);

  return { sent: result.ok, error: result.error, segments };
}

let running = false;

export async function runDispatch() {
  // The database lock already prevents double-sends across processes; this just
  // stops one slow cycle from stacking up behind itself inside one process.
  if (running) return { skipped: "already_running" };
  running = true;
  const started = Date.now();

  try {
    const settings = await loadSettings();
    const rows = await rpcSet("followup_claim_due", settings.dispatch_batch_size ?? 25);
    if (!rows.length) return { claimed: 0, sent: 0, failed: 0, ms: Date.now() - started };

    let sent = 0;
    let failed = 0;
    let segments = 0;
    const failures = [];

    for (const [index, row] of rows.entries()) {
      if (index > 0) await sleep(SEND_INTERVAL_MS);
      try {
        const result = await sendOne(row, settings);
        segments += result.segments ?? 0;
        if (result.sent) sent += 1;
        else { failed += 1; failures.push({ enrollment: row.enrollment_id, error: result.error }); }
      } catch (error) {
        // One bad row must not strand the rest of the batch under its lock.
        failed += 1;
        failures.push({ enrollment: row.enrollment_id, error: error.message });
        console.error("send threw for", row.enrollment_id, error);
      }
    }

    return { claimed: rows.length, sent, failed, segments, failures, ms: Date.now() - started };
  } finally {
    running = false;
  }
}

// The scheduler re-reads its own interval from settings each tick, so changing
// it in the dashboard takes effect within one cycle without a redeploy.
export function startScheduler() {
  let timer = null;
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    try {
      const result = await runDispatch();
      if (result.claimed) {
        console.log(`dispatch: ${result.sent} sent, ${result.failed} failed, ${result.ms}ms`);
      }
    } catch (error) {
      console.error("dispatch cycle failed", error);
    }

    let seconds = 60;
    try {
      seconds = (await loadSettings()).dispatch_interval_seconds ?? 60;
    } catch { /* keep the default if settings cannot be read */ }

    timer = setTimeout(tick, Math.max(15, Math.min(900, seconds)) * 1000);
  };

  timer = setTimeout(tick, 5_000);

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
