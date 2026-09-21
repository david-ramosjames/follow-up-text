import {
  CONTRACT_PATH_MATCH_SECONDS,
  CONTRACT_PATH_WAIT_SECONDS,
  flattenSlackMessage,
  isContractPath,
  isContractSent,
  pickWaitingParent,
  readLead,
} from "../../shared/leads.js";
import { one, rows } from "../db.js";
import { currentFirm, listFirms, runWithFirm } from "./firms.js";
import { loadSettings } from "./settings.js";

export {
  CONTRACT_PATH_MATCH_SECONDS,
  CONTRACT_PATH_WAIT_SECONDS,
  isContractPath,
  isContractSent,
  pickWaitingParent,
};

function parentTs(event) {
  if (event?.thread_ts && event.thread_ts !== event.ts) return event.thread_ts;
  return null;
}

async function slackTools() {
  return import("./slack.js");
}

async function followupTools() {
  return import("./followups.js");
}

export async function threadHasContractSent(channel, threadTs) {
  if (!channel || !threadTs) return false;
  const { slackApi } = await slackTools();
  const response = await slackApi("conversations.replies", {
    channel,
    ts: threadTs,
    limit: 80,
  }, { quiet: true });
  if (!response?.ok) return false;
  return (response.messages ?? []).some((message) => isContractSent(flattenSlackMessage(message)));
}

async function recentContractCandidates(channel) {
  const firm = currentFirm()?.id;
  if (!firm || !channel) return [];
  return rows(
    `select id, slack_ts, phone_e164, post_text, outcome, enrollment_id, created_at,
            first_name, last_name, language, case_type, case_detail, lead_source,
            sequence_slug, classifier_slug, confidence, reasoning, classifier_error, email
     from lead_observations
     where firm_id = $1
       and slack_channel_id = $2
       and outcome in ('waiting_contract', 'started')
       and created_at >= now() - ($3 || ' seconds')::interval
     order by created_at desc
     limit 40`,
    [firm, channel, String(CONTRACT_PATH_MATCH_SECONDS)],
  );
}

export async function findContractParent(event, phone = null) {
  const channel = event?.channel;
  const candidates = (await recentContractCandidates(channel))
    .filter((row) => isContractPath(row.post_text));
  return pickWaitingParent({
    waiting: candidates,
    threadTs: parentTs(event),
    phone,
  });
}

export async function contractAlreadyArrived(event, phone) {
  if (await threadHasContractSent(event.channel, event.ts)) return true;
  if (!phone) return false;
  const notice = await one(
    `select id from lead_observations
     where firm_id = $1
       and slack_channel_id = $2
       and outcome = 'contract_notice'
       and phone_e164 = $3
       and created_at >= now() - ($4 || ' seconds')::interval
     limit 1`,
    [currentFirm()?.id, event.channel, phone, String(CONTRACT_PATH_MATCH_SECONDS)],
  );
  return Boolean(notice);
}

async function noteInThread(observation, text) {
  const { postToThread } = await slackTools();
  await postToThread({
    channel: observation.slack_channel_id,
    threadTs: observation.slack_ts,
    text,
  });
}

export async function cancelContractWait(observation, { detail, stopIfStarted = true } = {}) {
  if (!observation?.id) return observation;
  if (observation.outcome === "waiting_contract") {
    const updated = await one(
      `update lead_observations
       set outcome = 'contract_sent',
           outcome_detail = $2
       where id = $1 and outcome = 'waiting_contract'
       returning *`,
      [observation.id, detail ?? "A contract was sent to be signed, so abandoned texts were not started."],
    );
    if (updated) {
      await noteInThread(updated, ":pencil: No follow-up texts — a signing link was sent.");
    }
    return updated ?? observation;
  }

  if (stopIfStarted && observation.outcome === "started" && observation.enrollment_id) {
    const { stopSeries, retireStartCard } = await followupTools();
    await stopSeries({
      enrollmentId: observation.enrollment_id,
      actor: "contract-path",
      reason: "manual",
    });
    await retireStartCard(observation.enrollment_id);
    await one(
      `update lead_observations
       set outcome_detail = $2
       where id = $1`,
      [observation.id, detail ?? "A contract was sent after texts had already started, so the series was stopped."],
    );
    await noteInThread(observation, ":pencil: Follow-up texts stopped — a signing link was sent.");
  }
  return observation;
}

export async function applyContractSent(event) {
  const text = flattenSlackMessage(event);
  const phone = readLead(text).phone;
  const parent = await findContractParent(event, phone);
  if (parent) {
    await cancelContractWait(parent, {
      detail: parent.outcome === "waiting_contract"
        ? "A contract was sent to be signed, so abandoned texts were not started."
        : "A contract was sent after texts had already started, so the series was stopped.",
    });
  }
  return { parent, phone, text };
}

export async function startWaitedLead(observation) {
  const settings = await loadSettings();
  const mode = String(settings.lead_mode ?? "off");
  if (mode !== "live") {
    await one(
      `update lead_observations
       set outcome = 'preview_only',
           outcome_detail = 'The contract-path wait ended while intake was not live, so nobody was texted.'
       where id = $1 and outcome = 'waiting_contract'
       returning id`,
      [observation.id],
    );
    return { ignored: "mode_not_live" };
  }

  const claimed = await one(
    `update lead_observations
     set outcome_detail = 'Starting after no signing link arrived.'
     where id = $1 and outcome = 'waiting_contract'
     returning *`,
    [observation.id],
  );
  if (!claimed) return { ignored: "already_settled" };

  const owner = String(settings.lead_default_owner_slack_id ?? "").trim();
  if (!owner) {
    await one(
      `update lead_observations
       set outcome = 'no_owner',
           outcome_detail = 'No default owner is set under Settings, so nothing was started.'
       where id = $1`,
      [claimed.id],
    );
    return { ignored: "no_owner" };
  }

  const {
    startSeries,
    announceEnrollment,
    lookupSlackName,
    enrollFailureText,
  } = await followupTools();
  const { slackApi } = await slackTools();

  const threadTs = claimed.slack_ts;
  const result = await startSeries({
    phone: claimed.phone_e164,
    language: claimed.language,
    first_name: claimed.first_name,
    last_name: claimed.last_name,
    case_type: claimed.case_type,
    sequence_slug: claimed.sequence_slug,
    assigned_slack_user_id: owner,
    assigned_slack_user_name: await lookupSlackName(owner),
    started_by_slack_user_id: owner,
    slack_channel_id: claimed.slack_channel_id,
    slack_thread_ts: threadTs,
    source: "lead",
    lead_source: claimed.lead_source,
    lead_detail: {
      confidence: claimed.confidence,
      reasoning: claimed.reasoning,
      case_type: claimed.case_type ?? null,
      case_detail: claimed.case_detail ?? null,
      email: claimed.email ?? null,
      classifier_failed: claimed.classifier_error ?? null,
      contract_path: true,
    },
  });

  if (!result?.ok) {
    await one(
      `update lead_observations
       set outcome = 'enroll_failed',
           outcome_detail = $2
       where id = $1`,
      [claimed.id, result?.reason ?? "unknown"],
    );
    await slackApi("chat.postMessage", {
      channel: claimed.slack_channel_id,
      thread_ts: threadTs,
      text: `:warning: No follow-ups started for this lead — ${enrollFailureText(result, claimed.phone_e164)}`,
    });
    return { ignored: result?.reason ?? "enroll_failed" };
  }

  await one(
    `update lead_observations
     set outcome = 'started',
         enrollment_id = $2,
         outcome_detail = 'Started after the contract-path wait: no signing link arrived.'
     where id = $1`,
    [claimed.id, result.enrollment_id],
  );
  await announceEnrollment(result, {
    channel: claimed.slack_channel_id,
    threadTs,
    routing: {
      confidence: claimed.confidence,
      reasoning: claimed.reasoning,
      caseType: claimed.case_type,
    },
  });
  return { started: true, enrollment_id: result.enrollment_id };
}

async function settleCurrentFirm() {
  const waiting = await rows(
    `select * from lead_observations
     where firm_id = $1 and outcome = 'waiting_contract'
     order by created_at
     limit 40`,
    [currentFirm()?.id],
  );
  let cancelled = 0;
  let started = 0;
  for (const row of waiting) {
    if (await threadHasContractSent(row.slack_channel_id, row.slack_ts)) {
      await cancelContractWait(row);
      cancelled += 1;
      continue;
    }
    const ageSeconds = (Date.now() - new Date(row.created_at).getTime()) / 1000;
    if (ageSeconds < CONTRACT_PATH_WAIT_SECONDS) continue;
    const result = await startWaitedLead(row);
    if (result?.started) started += 1;
  }
  return { waiting: waiting.length, cancelled, started };
}

export async function settleContractPathWaits() {
  const firms = await listFirms();
  let cancelled = 0;
  let started = 0;
  let waiting = 0;
  for (const firm of firms) {
    const result = await runWithFirm(firm, settleCurrentFirm);
    waiting += result.waiting;
    cancelled += result.cancelled;
    started += result.started;
  }
  if (cancelled || started) {
    console.log(`contract path: ${started} started after wait, ${cancelled} cancelled (signing link arrived), ${waiting} open`);
  }
  return { waiting, cancelled, started };
}
