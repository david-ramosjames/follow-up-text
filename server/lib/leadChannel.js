import { describeSlackHistoryError, historyMessageToEvent } from "../../shared/leads.js";
import { query, rows } from "../db.js";
import { loadSettings } from "./settings.js";
import { botLookupRateLimited, lookupBotName, slackApi, slackConfigured } from "./slack.js";
import { currentFirm, listFirms, runWithFirm } from "./firms.js";

// Slack's Events API is how new posts normally arrive, but it fails silently:
// the live app may not have message.channels (or message.groups, if the channel
// is private), the bot may not be in the channel, Socket Mode may be on, or a
// 401 may have made Slack stop delivering. Watch-and-record is useless if the
// only path in is a webhook nobody can see failing, so this reads the channel
// the same way a person would — conversations.history — and feeds each post
// through handleLeadPost. The unique index on (channel, ts) makes a re-read
// harmless.

export const CATCH_UP_LOOKBACK_HOURS = 48;
export const CATCH_UP_BATCH = 12;

const lastCatchUpByFirm = new Map();

export function lastLeadCatchUp(firmId = currentFirm()?.id) {
  return lastCatchUpByFirm.get(firmId ?? "none") ?? null;
}

function remember(result) {
  const entry = { ...result, at: new Date().toISOString() };
  lastCatchUpByFirm.set(currentFirm()?.id ?? "none", entry);
  return entry;
}

async function fetchChannelMessages(channel, oldest) {
  const messages = [];
  let cursor;
  for (let page = 0; page < 8; page += 1) {
    const payload = { channel, oldest: String(oldest), limit: 200 };
    if (cursor) payload.cursor = cursor;
    const response = await slackApi("conversations.history", payload);
    if (!response.ok) return { ok: false, error: response.error || "slack_error" };
    messages.push(...(response.messages ?? []));
    if (!response.has_more) break;
    cursor = response.response_metadata?.next_cursor;
    if (!cursor) break;
  }
  return { ok: true, messages };
}

function looksLikeBotId(name) {
  return !name || /^B[A-Z0-9]+$/i.test(String(name));
}

async function prefetchBotNames(messages) {
  const botIds = [...new Set(messages.map((message) => message.bot_id).filter(Boolean))];
  for (const botId of botIds) {
    await lookupBotName(botId);
    if (botLookupRateLimited()) break;
  }
}

// Posts skipped because Slack only gave a B0… id are retried once the display
// name is known. CallRail and other named skips stay skipped so this cannot
// loop every two seconds.
async function retryUnresolvedBots(channel, messages, handleLeadPost) {
  if (botLookupRateLimited()) return 0;
  const skipped = await rows(
    `select slack_ts, sender_name
     from lead_observations
     where slack_channel_id = $1
       and outcome = 'ignored_sender'
       and slack_ts is not null
       and (sender_name is null or sender_name ~* '^b[a-z0-9]+$')
     order by created_at desc
     limit 8`,
    [channel],
  );
  if (!skipped.length) return 0;

  const want = new Set(skipped.map((row) => row.slack_ts));
  const retry = messages.filter((message) => want.has(message.ts)).slice(0, 5);
  if (!retry.length) return 0;

  await prefetchBotNames(retry);

  let processed = 0;
  for (const message of retry) {
    const name = message.bot_profile?.name || message.username || await lookupBotName(message.bot_id);
    if (looksLikeBotId(name)) continue;
    await query(
      `delete from lead_observations
       where slack_channel_id = $1 and slack_ts = $2 and outcome = 'ignored_sender'`,
      [channel, message.ts],
    );
    await handleLeadPost(historyMessageToEvent(channel, message)).catch((error) => {
      console.error("lead catch-up retry skipped a post", message.ts, error);
    });
    processed += 1;
  }
  return processed;
}

export async function catchUpLeadChannel({
  lookbackHours = CATCH_UP_LOOKBACK_HOURS,
  limit = CATCH_UP_BATCH,
  retrySkipped = true,
} = {}) {
  const started = Date.now();
  const settings = await loadSettings();
  const channel = String(settings.lead_channel_id ?? "").trim();
  const mode = String(settings.lead_mode ?? "off");

  if (mode === "off") return remember({ skipped: "mode_off", ms: Date.now() - started });
  if (!channel) {
    return remember({
      skipped: "no_channel",
      error: "No lead channel is set under Settings.",
      ms: Date.now() - started,
    });
  }
  if (!slackConfigured()) {
    return remember({
      skipped: "no_token",
      error: "No Slack bot token is set for this firm, so the channel cannot be read.",
      channel,
      ms: Date.now() - started,
    });
  }

  const oldest = Date.now() / 1000 - lookbackHours * 3600;
  const fetched = await fetchChannelMessages(channel, oldest);
  if (!fetched.ok) {
    return remember({
      ok: false,
      channel,
      error: describeSlackHistoryError(fetched.error, channel),
      slackError: fetched.error,
      ms: Date.now() - started,
    });
  }

  const timestamps = fetched.messages.map((message) => message.ts).filter(Boolean);
  const already = timestamps.length
    ? await rows(
      `select slack_ts from lead_observations
       where slack_channel_id = $1 and slack_ts = any($2::text[])`,
      [channel, timestamps],
    )
    : [];
  const seen = new Set(already.map((row) => row.slack_ts));

  const fresh = fetched.messages
    .filter((message) => message.ts && !seen.has(message.ts))
    .sort((a, b) => Number(a.ts) - Number(b.ts));

  const batch = fresh.slice(0, limit);

  // Imported here so this module can load without pulling the Slack router in
  // at parse time — handleLeadPost lives next to the event handler it shares
  // behaviour with.
  const { handleLeadPost } = await import("../routes/slack.js");
  await prefetchBotNames(batch);
  for (const message of batch) {
    await handleLeadPost(historyMessageToEvent(channel, message)).catch((error) => {
      console.error("lead catch-up skipped a post", message.ts, error);
    });
  }

  const retried = retrySkipped
    ? await retryUnresolvedBots(channel, fetched.messages, handleLeadPost)
    : 0;

  return remember({
    ok: true,
    channel,
    posted: fetched.messages.length,
    unseen: fresh.length,
    processed: batch.length,
    retried,
    remaining: Math.max(0, fresh.length - batch.length),
    ms: Date.now() - started,
  });
}

export function startLeadCatchUp() {
  let timer = null;
  let stopped = false;
  let first = true;
  let lastRemaining = 0;

  const tick = async () => {
    if (stopped) return;
    // While draining unseen posts, do not retry skipped senders — that is what
    // turned a rate-limited bots.info lookup into a two-second loop.
    const draining = lastRemaining > 0;
    let remaining = 0;
    try {
      const firms = await listFirms();
      for (const firm of firms) {
        const result = await runWithFirm(firm, () => catchUpLeadChannel({ retrySkipped: !draining }));
        remaining += Number(result.remaining ?? 0);
        if (result.error) {
          console.warn(`lead catch-up (${firm.slug}): ${result.error}`);
        } else if (result.processed || result.retried) {
          const extra = result.retried ? `, ${result.retried} retried` : "";
          console.log(`lead catch-up (${firm.slug}): ${result.processed} new of ${result.unseen} unseen `
            + `(${result.posted} posts in ${result.channel})${extra}, ${result.ms}ms`);
        } else if (first && !result.skipped) {
          console.log(`lead catch-up (${firm.slug}): ${result.posted} posts in ${result.channel}, none new`);
        } else if (first && result.skipped) {
          console.log(`lead catch-up (${firm.slug}): skipped (${result.skipped})`);
        }
      }
      first = false;
    } catch (error) {
      console.error("lead catch-up failed", error);
    }

    lastRemaining = remaining;
    // Catch-up is capped per cycle so a morning of leads cannot block the
    // process; run the next batch quickly until the channel is current.
    timer = setTimeout(tick, remaining > 0 ? 2_000 : 60_000);
  };

  timer = setTimeout(tick, 8_000);

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
