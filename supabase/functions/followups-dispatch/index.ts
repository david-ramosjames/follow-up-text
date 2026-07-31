// Sends whatever texts are due. Run it on a schedule; every five minutes is
// plenty, because the database decides what is due and holds a lock while a
// batch is in flight.
//
//   supabase functions deploy followups-dispatch --no-verify-jwt
//
// Authenticate with the FOLLOWUP_CRON_SECRET header. See supabase/cron/dispatch.sql
// for the pg_cron job, or point any external scheduler at the same URL.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { appendOptOutNotice, countSegments, type Language, renderBody } from "../_shared/copy.ts";
import { sendText } from "../_shared/quo.ts";
import { json, maskPhone, notifyChannel } from "../_shared/slack.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
);

const BATCH_SIZE = Number(Deno.env.get("FOLLOWUP_BATCH_SIZE") ?? "25");
const SHOW_FULL_PHONE = (Deno.env.get("SLACK_SHOW_FULL_PHONE") ?? "false") === "true";
const FIRM_NAME = Deno.env.get("FIRM_NAME") ?? "";

// Quo throttles the messages endpoint at roughly ten calls a second. Pacing at
// eight keeps a large batch under the limit without needing retry handling for
// something this predictable.
const SEND_INTERVAL_MS = 125;

interface DueRow {
  enrollment_id: string;
  step_id: string;
  step_position: number;
  is_first_step: boolean;
  language: Language;
  body_en: string;
  body_es: string;
  append_opt_out_notice: boolean;
  from_number: string | null;
  quo_phone_number_id: string | null;
  to_number: string;
  first_name: string | null;
  last_name: string | null;
  case_reference: string | null;
  assigned_slack_user_id: string;
  assigned_slack_user_name: string | null;
  slack_channel_id: string | null;
  sequence_name: string;
  sequence_slug: string;
}

function buildBody(row: DueRow): string {
  const template = row.language === "es" ? row.body_es : row.body_en;
  const rendered = renderBody(template, {
    first_name: row.first_name,
    last_name: row.last_name,
    case_reference: row.case_reference,
    assigned_user: row.assigned_slack_user_name,
    firm_name: FIRM_NAME,
  }, row.language);

  // The opt-out line goes on the first text of a series only. Repeating it on
  // every message wastes a third of a segment and reads as automated.
  return row.is_first_step && row.append_opt_out_notice
    ? appendOptOutNotice(rendered, row.language)
    : rendered;
}

async function sendOne(row: DueRow): Promise<{ sent: boolean; error?: string }> {
  const body = buildBody(row);
  const from = row.quo_phone_number_id
    ?? row.from_number
    ?? Deno.env.get("QUO_PHONE_NUMBER_ID")
    ?? Deno.env.get("QUO_FROM_NUMBER")
    ?? "";

  const result = await sendText({ to: row.to_number, from, content: body });

  const { data: recorded, error } = await supabase.rpc("followup_record_send", {
    payload: {
      enrollment_id: row.enrollment_id,
      step_id: row.step_id,
      ok: result.ok,
      body,
      quo_message_id: result.id ?? null,
      quo_phone_number_id: row.quo_phone_number_id,
      from_number: from,
      to_number: row.to_number,
      error: result.error ?? null,
    },
  });

  if (error) {
    // The text may well have gone out; failing to record it is the dangerous
    // half, because the lock expires and the step would be re-sent. Log loudly.
    console.error("followup_record_send failed", { enrollment: row.enrollment_id, error });
    return { sent: result.ok, error: error.message };
  }

  const who = SHOW_FULL_PHONE ? row.to_number : maskPhone(row.to_number);
  const name = row.first_name ? `${row.first_name} (${who})` : who;

  if (!result.ok && recorded?.final) {
    await notifyChannel(
      row.slack_channel_id,
      `:warning: Follow-up texts to ${name} keep failing, so the series has been stopped. `
        + `<@${row.assigned_slack_user_id}> may want to try calling. Last error: ${result.error}`,
    );
  } else if (result.ok && recorded?.completed) {
    await notifyChannel(
      row.slack_channel_id,
      `:checkered_flag: The follow-up series for ${name} has finished with no reply. `
        + `<@${row.assigned_slack_user_id}>`,
    );
  }

  return { sent: result.ok, error: result.error };
}

function authorized(request: Request): boolean {
  const expected = Deno.env.get("FOLLOWUP_CRON_SECRET");
  if (!expected) return false;
  const provided = request.headers.get("x-cron-secret")
    ?? new URL(request.url).searchParams.get("secret");
  return provided === expected;
}

Deno.serve(async (request) => {
  if (request.method !== "POST" && request.method !== "GET") {
    return json({ error: "Method not allowed" }, 405);
  }
  if (!authorized(request)) {
    return json({ error: "Unauthorized. Set FOLLOWUP_CRON_SECRET and send it as x-cron-secret." }, 401);
  }

  const started = Date.now();
  const { data, error } = await supabase.rpc("followup_claim_due", { max_rows: BATCH_SIZE });
  if (error) {
    console.error("followup_claim_due failed", error);
    return json({ error: error.message }, 500);
  }

  const rows = (data ?? []) as DueRow[];
  if (!rows.length) return json({ claimed: 0, sent: 0, failed: 0, ms: Date.now() - started });

  let sent = 0;
  let failed = 0;
  const failures: Array<{ enrollment: string; error?: string }> = [];

  for (const [index, row] of rows.entries()) {
    if (index > 0) await new Promise((resolve) => setTimeout(resolve, SEND_INTERVAL_MS));
    try {
      const result = await sendOne(row);
      if (result.sent) sent += 1;
      else { failed += 1; failures.push({ enrollment: row.enrollment_id, error: result.error }); }
    } catch (sendError) {
      // One bad row must not strand the rest of the batch under its lock.
      failed += 1;
      failures.push({ enrollment: row.enrollment_id, error: (sendError as Error).message });
      console.error("send threw", row.enrollment_id, sendError);
    }
  }

  const segments = rows.reduce((total, row) => total + countSegments(buildBody(row)).segments, 0);
  return json({ claimed: rows.length, sent, failed, segments, failures, ms: Date.now() - started });
});
