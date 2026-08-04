import express from "express";
import { classifyInbound, countSegments, START_CONFIRMATION, STOP_CONFIRMATION } from "../../shared/messaging.js";
import { query, rpc } from "../db.js";
import { readEvent, readPhone, resolveSendingNumber, sendText } from "../lib/quo.js";
import { displayPhone, postToThread } from "../lib/slack.js";
import { loadSettings } from "../lib/settings.js";
import { verifyWebhook } from "../lib/quo.js";

export const webhookRouter = express.Router();

// Confirmations are logged alongside sequence texts. They cost the same money
// and, more importantly, somebody looking at a client's history needs to see
// everything the firm sent them — not just the parts a sequence produced.
async function confirmTo(phone, contactId, fromNumber) {
  return async (text) => {
    let from = fromNumber;
    if (!from) {
      const settings = await loadSettings();
      const fallback = await resolveSendingNumber(settings.default_quo_number_id);
      from = fallback?.phone_e164 ?? null;
    }
    if (!from) {
      console.warn("No sending number available for the confirmation text.");
      return;
    }

    const result = await sendText({ to: phone, from, content: text });
    if (!result.ok) console.error("Confirmation text failed:", result.error);

    if (contactId) {
      await query(
        `insert into followup_messages
           (contact_id, direction, body, status, quo_message_id, from_number, to_number, segments, error, sent_at)
         values ($1, 'outbound', $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          contactId, text, result.ok ? "sent" : "failed", result.id ?? null,
          from, phone, countSegments(text).segments, result.error ?? null,
          result.ok ? new Date().toISOString() : null,
        ],
      ).catch((error) => console.error("Could not log the confirmation text", error));
    }
  };
}

async function handleInboundMessage(object) {
  const from = readPhone(object.from);
  const to = readPhone(object.to);
  const body = String(object.body ?? object.text ?? "");
  const messageId = object.id ? String(object.id) : null;

  if (!from) return { ignored: "no_sender" };

  const { isStop, isStart } = classifyInbound(body);

  const result = await rpc("followup_record_inbound", {
    phone: from,
    body,
    kind: "message",
    quo_message_id: messageId,
    quo_number_id: object.phoneNumberId ? String(object.phoneNumberId) : null,
    from_number: from,
    to_number: to,
    is_stop: isStop,
    is_start: isStart,
  });

  if (result?.duplicate) return { duplicate: true };
  if (!result?.ok) return { ignored: result?.reason };

  const settings = await loadSettings();
  const language = result.language === "es" ? "es" : "en";
  const shown = await displayPhone(from);
  const who = result.first_name ? `${result.first_name} (${shown})` : shown;
  const assigned = result.assigned_slack_user_id ? ` <@${result.assigned_slack_user_id}>` : "";
  const confirm = await confirmTo(from, result.contact_id, to);

  if (result.action === "opt_out") {
    // Carriers registered for A2P 10DLC usually auto-reply to STOP themselves. A
    // duplicate confirmation is noise; a missing one is a compliance problem, so
    // this defaults on and is switchable in Settings.
    if (settings.send_stop_confirmation) await confirm(STOP_CONFIRMATION[language]);
    await postToThread({
      channel: result.slack_channel_id,
      threadTs: result.slack_thread_ts,
      text: `:no_entry: ${who} texted *STOP*. They are unsubscribed and any running series has been stopped.${assigned}`,
    });
    return { action: "opt_out" };
  }

  if (result.action === "opt_in") {
    await confirm(START_CONFIRMATION[language]);
    await postToThread({
      channel: result.slack_channel_id,
      threadTs: result.slack_thread_ts,
      text: `:white_check_mark: ${who} texted *START* and can receive texts again.`,
    });
    return { action: "opt_in" };
  }

  // An ordinary reply. This is the outcome the whole system exists to produce,
  // so it goes back into the client's thread with the message quoted in full.
  const wasRunning = Boolean(result.stopped?.ok);
  await postToThread({
    channel: result.slack_channel_id,
    threadTs: result.slack_thread_ts,
    text: `:tada: ${who} replied${wasRunning ? " — follow-ups stopped" : ""}.${assigned}`,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: `:tada: *${who} replied*${assigned}` } },
      { type: "section", text: { type: "mrkdwn", text: `>${body.slice(0, 2500).replace(/\n/g, "\n>")}` } },
      {
        type: "context",
        elements: [{
          type: "mrkdwn",
          text: wasRunning
            ? `Follow-ups stopped after ${result.stopped?.sent_count ?? 0} text(s). Somebody should reply in Quo.`
            : "No series was running for this number.",
        }],
      },
    ],
  });
  return { action: "reply", stopped: wasRunning };
}

async function handleInboundCall(object) {
  const direction = String(object.direction ?? "");
  // Only a call *from* the client counts as re-engagement. Our own outbound
  // attempts, which are the reason the series exists, must not stop it.
  if (direction && direction !== "incoming" && direction !== "inbound") {
    return { ignored: "outgoing_call" };
  }

  const from = readPhone(object.from);
  if (!from) return { ignored: "no_caller" };

  const result = await rpc("followup_record_inbound", {
    phone: from,
    kind: "call",
    is_stop: false,
    is_start: false,
  });
  if (!result?.ok) return { ignored: result?.reason };
  if (!result.stopped?.ok) return { action: "call", stopped: false };

  const shown = await displayPhone(from);
  const who = result.first_name ? `${result.first_name} (${shown})` : shown;
  await postToThread({
    channel: result.slack_channel_id,
    threadTs: result.slack_thread_ts,
    text: `:telephone_receiver: ${who} called back — follow-ups stopped after `
      + `${result.stopped.sent_count ?? 0} text(s).`
      + (result.assigned_slack_user_id ? ` <@${result.assigned_slack_user_id}>` : ""),
  });
  return { action: "call", stopped: true };
}

async function handleDelivery(object, status) {
  const messageId = object.id ? String(object.id) : null;
  if (!messageId) return { ignored: "no_message_id" };
  return rpc("followup_record_delivery", {
    quo_message_id: messageId,
    status,
    error: object.error ? String(object.error) : null,
  });
}

webhookRouter.post("/quo", async (req, res) => {
  const verified = verifyWebhook(req, req.rawBody);
  if (!verified.ok) {
    console.warn("Rejected a Quo webhook:", verified.reason);
    // The reason goes in the body, not just the log. Quo's own Events log shows
    // the response to each delivery, so a wall of 401s there should say what is
    // wrong with the secret rather than making somebody go and read Railway's
    // logs to find out. None of these reasons discloses anything secret.
    return res.status(401).json({ error: "Unauthorized", reason: verified.reason });
  }

  let body;
  try {
    body = JSON.parse(req.rawBody);
  } catch {
    return res.status(400).json({ error: "Body was not JSON." });
  }

  const { type, object } = readEvent(body);

  try {
    if (type === "message.received" || (!type && object.direction === "incoming")) {
      return res.json(await handleInboundMessage(object));
    }
    if (type === "message.delivered") return res.json(await handleDelivery(object, "delivered"));
    if (type === "message.failed" || type === "message.undelivered") {
      return res.json(await handleDelivery(object, "undelivered"));
    }
    // Only the two events that mean "a call happened". The recording, transcript
    // and summary events are also call.* but carry a recording as their object,
    // not a call, so running them through the caller check would be reading
    // fields that are not there.
    if (type === "call.completed" || type === "call.ringing") {
      return res.json(await handleInboundCall(object));
    }

    // Unknown events are acknowledged rather than rejected, so Quo does not keep
    // retrying something we will never handle.
    return res.json({ ignored: type || "unknown_event" });
  } catch (error) {
    console.error("quo webhook failed", error);
    return res.status(500).json({ error: error.message });
  }
});
