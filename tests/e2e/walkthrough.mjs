// End-to-end walk through the real server: sign in, configure, start a series
// from Slack, send it via the Quo stub, then reply to it.
import crypto from "node:crypto";

const BASE = "http://127.0.0.1:3000";
const SIGNING = "slack-signing-secret-xyz";
let cookie = "";
let failures = 0;

function check(label, condition, detail = "") {
  if (condition) console.log(`  ok   ${label}`);
  else { failures += 1; console.log(`  FAIL ${label} ${detail}`); }
}

async function api(path, options = {}) {
  const response = await fetch(`${BASE}${path}`, {
    ...options,
    headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), cookie, ...(options.headers ?? {}) },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: response.status, data, response };
}

function slackHeaders(body) {
  const ts = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac("sha256", SIGNING).update(`v0:${ts}:${body}`).digest("hex");
  return {
    "content-type": "application/x-www-form-urlencoded",
    "x-slack-request-timestamp": String(ts),
    "x-slack-signature": `v0=${sig}`,
  };
}

// Everything the bot posted, in order, with the channel and thread it went to.
async function slackPosts() {
  return (await fetch("http://127.0.0.1:4999/__posts")).json();
}

async function slack(path, params) {
  const body = new URLSearchParams(params).toString();
  const response = await fetch(`${BASE}${path}`, { method: "POST", headers: slackHeaders(body), body });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : text; } catch { data = text; }
  return { status: response.status, data };
}

console.log("\n1. Authentication");
{
  const bad = await api("/api/dashboard");
  check("the API refuses an unauthenticated request", bad.status === 401);

  const wrong = await fetch(`${BASE}/auth/password`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "wrong" }),
  });
  check("a wrong password is refused", wrong.status === 401);

  const good = await fetch(`${BASE}/auth/password`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "letmein-please-1234" }),
  });
  check("the right password signs in", good.status === 200);
  cookie = (good.headers.getSetCookie?.() ?? [good.headers.get("set-cookie")])
    .map((value) => value.split(";")[0]).join("; ");

  const me = await api("/auth/me");
  check("the session is live", me.data?.signedIn === true);
  check("the password session is labelled as such", me.data?.user?.provider === "password");
  check("the sign-in page is told which methods exist",
    typeof me.data?.googleSignInAvailable === "boolean"
    && typeof me.data?.slackSignInAvailable === "boolean");

  const googleStart = await fetch(`${BASE}/auth/google/start`, { redirect: "manual" });
  check("Google sign-in is refused cleanly when unconfigured",
    googleStart.status === 302 && (googleStart.headers.get("location") ?? "").includes("google_not_configured"),
    googleStart.headers.get("location") ?? "");
}

// This walkthrough asserts exact counts, so it only means anything against a
// clean database. Running it twice in a row otherwise produces a wall of
// confusing failures that look like regressions but are just leftover rows.
{
  const existing = await api("/api/enrollments?status=all");
  if (existing.data?.length) {
    console.log(`\nThis database already has ${existing.data.length} follow-up series in it.`);
    console.log("The walkthrough checks exact counts, so it needs a clean database.");
    console.log("Use ./tests/e2e/run.sh, which resets one for you.\n");
    process.exit(1);
  }
}

console.log("\n2. Quo numbers");
{
  const synced = await api("/api/quo-numbers/sync", { method: "POST", body: {} });
  check("numbers sync from Quo", synced.status === 200 && synced.data.length === 2,
    JSON.stringify(synced.data).slice(0, 120));
  check("the sending number is stored in E.164",
    synced.data?.[0]?.phone_e164?.startsWith("+1"));

  const saved = await api("/api/settings", {
    method: "PUT",
    body: { default_quo_number_id: "PNINTAKE", firm_name: "Ramos Law", slack_alert_channel: "C0FALLBACK" },
  });
  check("settings save", saved.data?.default_quo_number_id === "PNINTAKE");
  check("the firm name saves", saved.data?.firm_name === "Ramos Law");
}

console.log("\n3. Who has access");
let paralegalId;
{
  const nobody = await api("/api/operators", { method: "POST", body: { display_name: "Nobody" } });
  check("somebody with neither a Slack ID nor an email is refused",
    nobody.status === 400 && /one of them is needed/.test(nobody.data?.error ?? ""));

  const bad = await api("/api/operators", { method: "POST", body: { slack_user_id: "not-an-id" } });
  check("a malformed Slack ID is refused with an explanation",
    bad.status === 400 && /member ID/.test(bad.data?.error ?? ""));

  const badEmail = await api("/api/operators", { method: "POST", body: { email: "not-an-email" } });
  check("a malformed email is refused", badEmail.status === 400);

  // Dashboard access is matched on email, so granting it without one would
  // create somebody who is allowed in but has no way in.
  const unusable = await api("/api/operators", {
    method: "POST", body: { slack_user_id: "U0GHOST", can_admin: true },
  });
  check("dashboard access without an email is refused",
    unusable.status === 400 && /email address/.test(unusable.data?.error ?? ""));

  const added = await api("/api/operators", {
    method: "POST",
    body: { slack_user_id: "U0PARALEGAL", email: "sam@firm.com", display_name: "Sam Ortiz", can_admin: true },
  });
  check("somebody with both a Slack ID and an email is added", added.status === 201);
  paralegalId = added.data.id;
  check("the email is stored lowercase", added.data.email === "sam@firm.com");

  const mixedCase = await api("/api/operators", {
    method: "POST", body: { email: "Rosa@Firm.com", display_name: "Rosa", can_admin: true, is_supervisor: true },
  });
  check("a mixed-case email is normalised on the way in", mixedCase.data?.email === "rosa@firm.com");

  // The office manager who never touches Slack: email only.
  const officeOnly = await api("/api/operators", {
    method: "POST", body: { email: "office@firm.com", display_name: "Office manager", can_admin: true },
  });
  check("somebody can be added with an email and no Slack ID",
    officeOnly.status === 201 && officeOnly.data.slack_user_id === null);

  // Adding the same person again by one identity fills in the other rather than
  // creating a duplicate.
  const merged = await api("/api/operators", {
    method: "POST",
    body: { email: "office@firm.com", slack_user_id: "U0OFFICE", display_name: "Office manager", can_admin: true },
  });
  check("adding them again by email attaches the Slack ID to the same person",
    merged.data?.id === officeOnly.data.id && merged.data?.slack_user_id === "U0OFFICE");

  await api("/api/operators", {
    method: "POST",
    body: { slack_user_id: "U0SUPERVISOR", email: "rosa@firm.com", display_name: "Rosa", is_supervisor: true, can_admin: true },
  });

  const list = await api("/api/operators");
  check("nobody was duplicated", list.data.length === 3, JSON.stringify(list.data.map((p) => p.email)));
}

console.log("\n4. Sequence set-up");
let sequenceId;
{
  const sequences = await api("/api/sequences");
  const seeded = sequences.data.find((row) => row.slug === "new-lead");
  sequenceId = seeded.id;
  check("the starter sequence shipped with the migrations", Boolean(seeded));
  check("it has six texts", (seeded.steps ?? []).length === 6);
  check("it is switched off until reviewed", seeded.is_active === false);
  check("every text has both languages",
    seeded.steps.every((step) => step.body_en?.trim() && step.body_es?.trim()));

  const turnedOn = await api(`/api/sequences/${sequenceId}`, {
    method: "PATCH",
    body: { is_active: true, quo_number_id: "PNINTAKE", quiet_hours_start: 0, quiet_hours_end: 24 },
  });
  check("the sequence can be switched on", turnedOn.data?.is_active === true);
}

console.log("\n5. Starting a series from the Slack slash command");
{
  const blocked = await slack("/slack/commands", {
    user_id: "U0NOBODY", user_name: "nobody", channel_id: "C0INTAKE",
    text: "start 512-555-0123", response_url: "http://127.0.0.1:4999/__noop",
  });
  check("a non-operator is refused", /not set up/.test(blocked.data?.text ?? ""));

  const unsigned = await fetch(`${BASE}/slack/commands`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "user_id=U0PARALEGAL&text=start+5125550123",
  });
  check("an unsigned Slack request is rejected", unsigned.status === 401);

  const started = await slack("/slack/commands", {
    user_id: "U0PARALEGAL", user_name: "sam", channel_id: "C0INTAKE",
    text: "start (512) 555-0123 es Maria", response_url: "http://127.0.0.1:4999/__noop",
  });
  check("the command is accepted", started.status === 200);

  const list = await api("/api/enrollments?status=active");
  check("a series is running", list.data.length === 1, JSON.stringify(list.data).slice(0, 200));
  check("the phone number was parsed out of the shorthand",
    list.data[0]?.phone_e164 === "+15125550123");
  check("the language was parsed out of the shorthand", list.data[0]?.language === "es");
  check("the name was parsed out of the shorthand", list.data[0]?.first_name === "Maria");
  check("it is assigned to whoever ran the command",
    list.data[0]?.assigned_slack_user_id === "U0PARALEGAL");

  const duplicate = await slack("/slack/commands", {
    user_id: "U0SUPERVISOR", user_name: "rosa", channel_id: "C0INTAKE",
    text: "start 512-555-0123", response_url: "http://127.0.0.1:4999/__noop",
  });
  check("a second start for the same number is refused",
    /already has a series/.test(duplicate.data?.text ?? ""), JSON.stringify(duplicate.data));
}

console.log("\n5b. Slack's escaped text (should_escape: true in the manifest)");
{
  // With should_escape on, Slack rewrites phone numbers as <tel:...> and user
  // mentions as <@U123|name> before the command text reaches us. The manifest
  // turns it on because it is what makes "assign to somebody else" possible, so
  // the parser has to cope with both forms.
  const started = await slack("/slack/commands", {
    user_id: "U0PARALEGAL", user_name: "sam", channel_id: "C0INTAKE",
    text: "start <tel:+15125550140|(512) 555-0140> es Ana <@U0SUPERVISOR|rosa>",
    response_url: "http://127.0.0.1:4999/__noop",
  });
  check("an escaped command is accepted", started.status === 200);

  const list = await api("/api/enrollments?status=active");
  const ana = list.data.find((row) => row.phone_e164 === "+15125550140");
  check("the number survives Slack's tel: markup", Boolean(ana),
    JSON.stringify(list.data.map((r) => r.phone_e164)));
  check("the language is still read", ana?.language === "es");
  check("the name is still read", ana?.first_name === "Ana");
  check("an escaped @mention assigns to that person",
    ana?.assigned_slack_user_id === "U0SUPERVISOR", ana?.assigned_slack_user_id);

  await api(`/api/enrollments/${ana.id}/stop`, { method: "POST", body: {} });
}

console.log("\n6. Starting from a Slack message shortcut");
{
  const payload = {
    type: "message_action",
    callback_id: "start_followups",
    trigger_id: "trigger-1",
    user: { id: "U0PARALEGAL", name: "sam" },
    channel: { id: "C0INTAKE" },
    message: {
      ts: "1730000000.000200",
      text: "New MVA lead from the site: Carlos Nunez, (512) 555-0124, rear-ended on I-35.",
    },
  };
  const shortcut = await slack("/slack/interactivity", { payload: JSON.stringify(payload) });
  check("the message shortcut is accepted", shortcut.status === 200);

  // views.open needs a bot token, which this run does not have, so drive the
  // submission directly — that is the step that actually creates the series.
  const submission = {
    type: "view_submission",
    user: { id: "U0PARALEGAL", name: "sam" },
    view: {
      callback_id: "followup_start",
      private_metadata: JSON.stringify({ channel_id: "C0INTAKE", thread_ts: "1730000000.000200" }),
      state: {
        values: {
          phone: { value: { value: "(512) 555-0124" } },
          first_name: { value: { value: "Carlos" } },
          language: { value: { selected_option: { value: "en" } } },
          sequence: { value: { selected_option: { value: "new-lead" } } },
          assignee: { value: { selected_user: "U0PARALEGAL" } },
          case_reference: { value: { value: "MVA-2026-118" } },
        },
      },
    },
  };
  const submitted = await slack("/slack/interactivity", { payload: JSON.stringify(submission) });
  check("the form submission is accepted", submitted.status === 200);

  const list = await api("/api/enrollments?status=active");
  const carlos = list.data.find((row) => row.phone_e164 === "+15125550124");
  check("a second series started from the message", Boolean(carlos));
  check("it remembers the thread it came from", carlos?.slack_thread_ts === "1730000000.000200");
  check("it is recorded as coming from a message", carlos?.source === "message_action");
  check("the reference was captured", carlos?.case_reference === "MVA-2026-118");

  const posts = await slackPosts();
  const confirmation = posts[posts.length - 1];
  check("the confirmation posts into that message's thread",
    confirmation?.channel === "C0INTAKE" && confirmation?.thread_ts === "1730000000.000200",
    JSON.stringify(confirmation));
}

console.log("\n6b. Where later updates go");
{
  // A series started with the slash command has no thread to hang off, so its
  // own confirmation becomes one. Everything afterwards has to land there rather
  // than loose in the channel.
  const before = (await slackPosts()).length;
  await slack("/slack/commands", {
    user_id: "U0PARALEGAL", user_name: "sam", channel_id: "C0INTAKE",
    text: "start 512-555-0177 Dana", response_url: "http://127.0.0.1:4999/__noop",
  });

  const posts = await slackPosts();
  const confirmation = posts[before];
  check("a slash-command series confirms in the channel, not in a thread",
    confirmation?.channel === "C0INTAKE" && confirmation?.thread_ts === null,
    JSON.stringify(confirmation));

  const list = await api("/api/enrollments?status=active");
  const dana = list.data.find((row) => row.phone_e164 === "+15125550177");
  check("that confirmation becomes the thread for everything later",
    dana?.slack_thread_ts === confirmation?.ts,
    `${dana?.slack_thread_ts} vs ${confirmation?.ts}`);

  // Now end it and check the notice threads off the confirmation.
  await fetch(`${BASE}/webhooks/quo?token=quo-token-abc`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "message.received",
      data: { object: { id: "IN-DANA", from: "+15125550177", to: "+15125557777", body: "yes please call me" } },
    }),
  });

  const after = await slackPosts();
  const notice = after[after.length - 1];
  check("the reply notice lands in that same thread",
    notice?.channel === "C0INTAKE" && notice?.thread_ts === confirmation?.ts,
    JSON.stringify(notice));
  check("and it says the follow-ups stopped", /follow-ups stopped/i.test(notice?.text ?? ""),
    notice?.text);
}

console.log("\n7. Sending the due texts");
{
  const run = await api("/api/dispatch/run", { method: "POST", body: {} });
  check("the dispatcher claimed both series", run.data?.claimed === 2, JSON.stringify(run.data));
  check("both texts were sent", run.data?.sent === 2, JSON.stringify(run.data));

  const sent = await (await fetch("http://127.0.0.1:4999/__sent")).json();
  check("Quo received two messages", sent.length === 2);
  check("they were sent from the sequence's number", sent.every((m) => m.from === "+15125557777"));

  const spanish = sent.find((m) => m.to[0] === "+15125550123");
  check("the Spanish client got the Spanish copy", /^Hola Maria/.test(spanish.content), spanish.content);
  check("the firm name was merged in", /Ramos Law/.test(spanish.content), spanish.content);
  check("the first text carries the Spanish opt-out line",
    /Responda ALTO/.test(spanish.content), spanish.content);

  const english = sent.find((m) => m.to[0] === "+15125550124");
  check("the English client got the English copy", /^Hi Carlos/.test(english.content), english.content);
  check("the first text carries the English opt-out line",
    /Reply STOP to opt out\.$/.test(english.content), english.content);

  const again = await api("/api/dispatch/run", { method: "POST", body: {} });
  check("a second run sends nothing, because nothing is due yet", again.data?.claimed === 0);

  // What the Activity page reads to say "Next text tomorrow · text 2 of 6".
  const running = await api("/api/enrollments?status=active");
  const maria = running.data.find((row) => row.phone_e164 === "+15125550123");
  check("the card knows how long the sequence is", Number(maria?.step_count) === 6,
    JSON.stringify({ step_count: maria?.step_count }));
  check("and which text comes next, having sent one",
    Number(maria?.next_step_number) === 2,
    JSON.stringify({ next_step_number: maria?.next_step_number, sent: maria?.sent_count }));
  check("with a time to show for it", Boolean(maria?.next_run_at));
}

console.log("\n8. The client replies");
{
  const unsigned = await fetch(`${BASE}/webhooks/quo`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "message.received" }),
  });
  check("an unverified Quo webhook is rejected", unsigned.status === 401);

  const reply = await fetch(`${BASE}/webhooks/quo?token=quo-token-abc`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "message.received",
      data: { object: { id: "IN-1", from: "+15125550123", to: "+15125557777", body: "Si, llamenme por favor" } },
    }),
  });
  const replyBody = await reply.json();
  check("the reply is accepted", reply.status === 200);
  check("it reads as re-engagement", replyBody.action === "reply");
  check("it stopped the series", replyBody.stopped === true);
  check("stopping a series is announced in Slack", replyBody.announced === true);

  // Everything the client says after that belongs to whoever is working the Quo
  // inbox. Echoing it into the intake channel would make Slack a second, worse
  // inbox, so a reply that ends nothing is recorded silently.
  const chatter = await fetch(`${BASE}/webhooks/quo?token=quo-token-abc`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "message.received",
      data: { object: { id: "IN-1b", from: "+15125550123", to: "+15125557777", body: "Do yall handle ER neglect" } },
    }),
  });
  const chatterBody = await chatter.json();
  check("a later reply with no series running is not announced",
    chatterBody.action === "reply" && chatterBody.stopped === false && chatterBody.announced === false,
    JSON.stringify(chatterBody));

  // Silent in Slack, but not lost: it is counted with the other inbound
  // messages, which the dashboard check further down asserts.
  const contact = await api("/api/contacts?search=5125550123");
  check("but it is still recorded against the client",
    Boolean(contact.data?.[0]?.last_inbound_at), JSON.stringify(contact.data?.[0] ?? null));

  const active = await api("/api/enrollments?status=active");
  check("only the other series is still running", active.data.length === 1);

  const ended = await api("/api/enrollments?status=ended");
  check("the stopped series is recorded as a reply",
    ended.data.some((row) => row.status === "stopped_reply"));
}

console.log("\n9. The other client opts out");
{
  const stop = await fetch(`${BASE}/webhooks/quo?token=quo-token-abc`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "message.received",
      data: { object: { id: "IN-2", from: "+15125550124", to: "+15125557777", body: "STOP" } },
    }),
  });
  const stopBody = await stop.json();
  check("STOP is recognised", stopBody.action === "opt_out");
  // This one had a series running, so it announces — as an ending, not as a
  // STOP alert of its own.
  check("it stopped their series and said so",
    stopBody.stopped === true && stopBody.announced === true, JSON.stringify(stopBody));

  const sent = await (await fetch("http://127.0.0.1:4999/__sent")).json();
  const confirmation = sent[sent.length - 1];
  check("a confirmation text went back", /unsubscribed/.test(confirmation.content), confirmation.content);

  const contacts = await api("/api/contacts?optedOut=true");
  check("the number is on the opted-out list", contacts.data.length === 1);

  // A second STOP, now that nothing is running. The opt-out is already in force,
  // so there is no ending to report and Slack hears nothing.
  const again = await fetch(`${BASE}/webhooks/quo?token=quo-token-abc`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "message.received",
      data: { object: { id: "IN-2b", from: "+15125550124", to: "+15125557777", body: "STOP" } },
    }),
  });
  const againBody = await again.json();
  check("a STOP that ends nothing is not announced", againBody.announced === false,
    JSON.stringify(againBody));

  const restart = await slack("/slack/commands", {
    user_id: "U0PARALEGAL", user_name: "sam", channel_id: "C0INTAKE",
    text: "start 512-555-0124", response_url: "http://127.0.0.1:4999/__noop",
  });
  check("an opted-out number cannot be restarted", /opted out/.test(restart.data?.text ?? ""));

  const active = await api("/api/enrollments?status=active");
  check("nothing is running now", active.data.length === 0);
}

console.log("\n10. The client calls the office instead");
{
  // The call path has its own webhook in Quo, its own signing secret and its own
  // handler, so proving it at the database level is not enough — this is the
  // whole route, from a signed call.completed to a stopped series.
  await slack("/slack/commands", {
    user_id: "U0PARALEGAL", user_name: "sam", channel_id: "C0INTAKE",
    text: "start 512-555-0166 Ana", response_url: "http://127.0.0.1:4999/__noop",
  });
  const running = await api("/api/enrollments?status=active");
  check("a series is running for the caller", running.data.length === 1);

  // Our own outbound call is the reason the series exists; it must not end it.
  const outgoing = await fetch(`${BASE}/webhooks/quo?token=quo-token-abc`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "call.completed",
      data: { object: { id: "CALL-OUT", direction: "outgoing", from: "+15125557777", to: "+15125550166" } },
    }),
  });
  check("our own outbound call is ignored", (await outgoing.json()).ignored === "outgoing_call");
  check("the series is still running",
    (await api("/api/enrollments?status=active")).data.length === 1);

  const incoming = await fetch(`${BASE}/webhooks/quo?token=quo-token-abc`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "call.completed",
      data: { object: { id: "CALL-IN", direction: "incoming", from: "+15125550166", to: "+15125557777" } },
    }),
  });
  const called = await incoming.json();
  check("a call back from the client is accepted", incoming.status === 200);
  check("it stops the series", called.action === "call" && called.stopped === true,
    JSON.stringify(called));

  check("nothing is left running",
    (await api("/api/enrollments?status=active")).data.length === 0);
  const ended = await api("/api/enrollments?status=ended");
  check("it is recorded as a call back, not a reply",
    ended.data.some((row) => row.status === "stopped_call"),
    JSON.stringify(ended.data.map((row) => row.status)));
}

console.log("\n11. Permissions on stopping");
{
  await slack("/slack/commands", {
    user_id: "U0PARALEGAL", user_name: "sam", channel_id: "C0INTAKE",
    text: "start 512-555-0155 Jo", response_url: "http://127.0.0.1:4999/__noop",
  });
  await api("/api/operators", {
    method: "POST", body: { slack_user_id: "U0OTHER", display_name: "Other" },
  });

  const denied = await slack("/slack/commands", {
    user_id: "U0OTHER", user_name: "other", channel_id: "C0INTAKE",
    text: "stop 512-555-0155", response_url: "http://127.0.0.1:4999/__noop",
  });
  check("somebody else cannot stop it", /only they or a supervisor/.test(denied.data?.text ?? ""),
    JSON.stringify(denied.data));

  const supervisor = await slack("/slack/commands", {
    user_id: "U0SUPERVISOR", user_name: "rosa", channel_id: "C0INTAKE",
    text: "stop 512-555-0155", response_url: "http://127.0.0.1:4999/__noop",
  });
  check("a supervisor can stop it", /Stopped/.test(supervisor.data?.text ?? ""),
    JSON.stringify(supervisor.data));
}

console.log("\n12. Status and list commands");
{
  const status = await slack("/slack/commands", {
    user_id: "U0PARALEGAL", user_name: "sam", channel_id: "C0INTAKE", text: "status 512-555-0123",
  });
  check("status finds the client", /Maria/.test(status.data?.text ?? ""), JSON.stringify(status.data));

  const list = await slack("/slack/commands", {
    user_id: "U0SUPERVISOR", user_name: "rosa", channel_id: "C0INTAKE", text: "list",
  });
  check("list reports an empty board", /No follow-up series/.test(list.data?.text ?? ""),
    JSON.stringify(list.data));

  const help = await slack("/slack/commands", {
    user_id: "U0PARALEGAL", user_name: "sam", channel_id: "C0INTAKE", text: "help",
  });
  check("help mentions the message shortcut", /⋯/.test(help.data?.text ?? ""));
}

console.log("\n13. Dashboard");
{
  const dashboard = await api("/api/dashboard?days=30");
  check("the dashboard loads", dashboard.status === 200);
  // Four: two sequence texts and two STOP confirmations. Confirmations are
  // logged with everything else because they cost the same money and belong in
  // the client's history.
  check("it counts the texts that went out", Number(dashboard.data.totals.sent) === 4,
    JSON.stringify(dashboard.data.totals));
  // Five inbound, only three of which Slack was told about — the other two ended
  // nothing. Recording and announcing are deliberately not the same thing.
  check("it counts every reply, announced in Slack or not",
    Number(dashboard.data.totals.replies) === 5, JSON.stringify(dashboard.data.totals));
  // Three: two texted back and one rang the office. Re-engagement counts both
  // kinds, which is the point — a client who calls has re-engaged just as surely.
  check("it counts who came back, by text and by phone",
    Number(dashboard.data.totals.reengaged) === 3, JSON.stringify(dashboard.data.totals));
  check("it counts opt-outs", Number(dashboard.data.totals.opted_out) === 1);
  check("it has one row per day", dashboard.data.daily.length === 30);
  check("it reports per-sequence performance", dashboard.data.bySequence.length >= 1);
  check("health knows Quo is configured", dashboard.data.health.quoConfigured === true);
  check("health counts the synced numbers", dashboard.data.health.numbers === 2);
}

console.log("\n14. Revoking access");
{
  // Removing somebody's access must end their session on the next request, not
  // whenever their two-week cookie happens to expire.
  const target = await api("/api/operators", {
    method: "POST", body: { email: "temp@firm.com", display_name: "Temp", can_admin: true },
  });

  const savedCookie = cookie;
  const signedIn = await fetch(`${BASE}/auth/password`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "letmein-please-1234" }),
  });
  check("a second session can be opened", signedIn.status === 200);
  cookie = savedCookie;

  const before = await api(`/api/operators`);
  check("the temporary person is on the list",
    before.data.some((person) => person.email === "temp@firm.com"));

  // Somebody added by email alone — which is everybody who arrives through
  // BOOTSTRAP_ADMIN_EMAIL — starts with no Slack ID and so cannot use the bot.
  // Giving them one has to work in place, without disturbing what they already
  // have, because re-adding them through the form resets their access flags.
  check("added by email, they cannot use the bot yet", target.data.slack_user_id === null);

  const given = await api(`/api/operators/${target.data.id}`, {
    method: "PATCH", body: { slack_user_id: "u09tempid" },
  });
  check("a Slack ID can be added to an existing person",
    given.status === 200 && given.data.slack_user_id === "U09TEMPID");
  check("adding it leaves their other access alone",
    given.data.can_admin === true && given.data.email === "temp@firm.com");

  const rejected = await api(`/api/operators/${target.data.id}`, {
    method: "PATCH", body: { slack_user_id: "not-an-id" },
  });
  check("a malformed Slack ID is refused", rejected.status === 400, `got ${rejected.status}`);

  const revoked = await api(`/api/operators/${target.data.id}`, {
    method: "PATCH", body: { can_admin: false },
  });
  check("access can be revoked", revoked.status === 200 && revoked.data.can_admin === false);

  const removed = await api(`/api/operators/${target.data.id}`, { method: "DELETE" });
  check("the person can be removed", removed.status === 200);

  // The last account that can sign in is protected: locking everybody out of a
  // system that is actively texting clients is not recoverable.
  const list = await api("/api/operators");
  for (const person of list.data.filter((p) => p.can_admin)) {
    await api(`/api/operators/${person.id}`, { method: "PATCH", body: { can_admin: false } });
  }
  const survivors = (await api("/api/operators")).data.filter((p) => p.can_admin && p.is_active);
  check("the last account with access cannot be stripped", survivors.length === 1,
    JSON.stringify(survivors.map((p) => p.email)));
}

console.log("\n15. Sign out");
{
  await fetch(`${BASE}/auth/logout`, { method: "POST", headers: { cookie } });
  const after = await api("/api/dashboard");
  check("the session is dead after signing out", after.status === 401);
}

console.log(failures ? `\n${failures} CHECK(S) FAILED\n` : "\nALL END-TO-END CHECKS PASSED\n");
process.exit(failures ? 1 : 0);
