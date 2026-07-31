import express from "express";
import { one, query, rows } from "../db.js";
import { googleConfigured, requireSession, slackSignInConfigured } from "../auth.js";
import { listQuoNumbers, quoConfigured, syncQuoNumbers } from "../lib/quo.js";
import { loadSettings, SETTING_DEFINITIONS, saveSettings } from "../lib/settings.js";
import { announceStop, stopSeries } from "../lib/followups.js";
import { runDispatch } from "../lib/dispatch.js";
import { slackConfigured } from "../lib/slack.js";

export const apiRouter = express.Router();

apiRouter.use(express.json({ limit: "1mb" }));

const ok = (handler) => requireSession(async (req, res) => {
  try {
    await handler(req, res);
  } catch (error) {
    console.error(`${req.method} ${req.originalUrl} failed`, error);
    // Postgres constraint violations carry the most useful message the user can
    // act on, so pass them through rather than flattening to "server error".
    const status = error.code?.startsWith("23") ? 400 : 500;
    res.status(status).json({ error: error.detail || error.message || "Something went wrong." });
  }
});

const actor = (req) => req.session.display_name || req.session.email || req.session.slack_user_id || "admin";

/* -------------------------------------------------------------- dashboard */

apiRouter.get("/dashboard", ok(async (req, res) => {
  const days = Math.min(90, Math.max(7, Number(req.query.days) || 30));

  const totals = await one(`
    select
      (select count(*) from followup_enrollments where status = 'active') as active,
      (select count(*) from followup_contacts where opted_out_at is not null) as opted_out,
      (select count(*) from followup_enrollments where started_at >= now() - ($1 || ' days')::interval) as started,
      (select count(*) from followup_messages
         where direction = 'outbound' and status <> 'failed'
           and created_at >= now() - ($1 || ' days')::interval) as sent,
      (select coalesce(sum(segments), 0) from followup_messages
         where direction = 'outbound' and status <> 'failed'
           and created_at >= now() - ($1 || ' days')::interval) as segments,
      (select count(*) from followup_messages
         where direction = 'inbound' and created_at >= now() - ($1 || ' days')::interval) as replies,
      (select count(*) from followup_enrollments
         where status in ('stopped_reply', 'stopped_call')
           and ended_at >= now() - ($1 || ' days')::interval) as reengaged,
      (select count(*) from followup_enrollments
         where status = 'completed' and ended_at >= now() - ($1 || ' days')::interval) as completed,
      (select count(*) from followup_enrollments
         where status = 'failed' and ended_at >= now() - ($1 || ' days')::interval) as failed,
      (select count(*) from followup_messages
         where direction = 'outbound' and status in ('undelivered', 'failed')
           and created_at >= now() - ($1 || ' days')::interval) as undelivered
  `, [String(days)]);

  // Daily counts for the activity chart. generate_series keeps zero-days in the
  // result so the chart shows a real gap rather than compressing it away.
  const daily = await rows(`
    select d::date as day,
      (select count(*) from followup_messages m
        where m.direction = 'outbound' and m.status <> 'failed' and m.created_at::date = d::date) as sent,
      (select count(*) from followup_messages m
        where m.direction = 'inbound' and m.created_at::date = d::date) as replies
    from generate_series(now() - ($1 || ' days')::interval, now(), interval '1 day') d
    order by day
  `, [String(days - 1)]);

  // Which step actually earns the replies: for each sequence, how many series
  // ended in re-engagement, and at which step they were up to when it happened.
  const bySequence = await rows(`
    select q.id, q.name, q.slug, q.is_active,
      count(e.id) as started,
      count(e.id) filter (where e.status in ('stopped_reply', 'stopped_call')) as reengaged,
      count(e.id) filter (where e.status = 'stopped_opt_out') as opted_out,
      count(e.id) filter (where e.status = 'completed') as completed,
      count(e.id) filter (where e.status = 'active') as active
    from followup_sequences q
    left join followup_enrollments e
      on e.sequence_id = q.id and e.started_at >= now() - ($1 || ' days')::interval
    group by q.id, q.name, q.slug, q.is_active
    order by started desc, q.name
  `, [String(days)]);

  const byStep = await rows(`
    select q.slug as sequence_slug, s.position, s.label,
      count(m.id) filter (where m.direction = 'outbound' and m.status <> 'failed') as sent,
      count(distinct e.id) filter (where e.status in ('stopped_reply', 'stopped_call')
        and e.next_position = s.position) as reengaged_after
    from followup_sequences q
    join followup_steps s on s.sequence_id = q.id and s.is_active
    left join followup_messages m on m.step_id = s.id
      and m.created_at >= now() - ($1 || ' days')::interval
    left join followup_enrollments e on e.sequence_id = q.id
      and e.ended_at >= now() - ($1 || ' days')::interval
    group by q.slug, s.position, s.label
    order by q.slug, s.position
  `, [String(days)]);

  const upcoming = await rows(`
    select e.id, e.next_run_at, e.next_position, e.assigned_slack_user_id, e.assigned_slack_user_name,
           c.phone_e164, c.first_name, q.name as sequence_name, q.timezone
    from followup_enrollments e
    join followup_contacts c on c.id = e.contact_id
    join followup_sequences q on q.id = e.sequence_id
    where e.status = 'active' and e.next_run_at is not null
    order by e.next_run_at limit 8
  `);

  const health = {
    quoConfigured: quoConfigured(),
    slackConfigured: slackConfigured(),
    sequencesReady: Number((await one(
      `select count(*)::int as count from followup_sequences q
       where q.is_active and exists (select 1 from followup_steps s where s.sequence_id = q.id and s.is_active)`,
    ))?.count ?? 0),
    operators: Number((await one("select count(*)::int as count from followup_operators where is_active"))?.count ?? 0),
    numbers: Number((await one("select count(*)::int as count from quo_numbers where is_active"))?.count ?? 0),
    lastSendAt: (await one(
      "select max(sent_at) as at from followup_messages where direction = 'outbound'",
    ))?.at ?? null,
  };

  res.json({ days, totals, daily, bySequence, byStep, upcoming, health });
}));

/* -------------------------------------------------------------- sequences */

const SEQUENCE_SELECT = `
  select q.*, (
    select coalesce(json_agg(s order by s.position), '[]'::json)
    from followup_steps s where s.sequence_id = q.id
  ) as steps
  from followup_sequences q
`;

apiRouter.get("/sequences", ok(async (req, res) => {
  res.json(await rows(`${SEQUENCE_SELECT} order by q.is_default desc, q.name`));
}));

apiRouter.get("/sequences/:slug", ok(async (req, res) => {
  const sequence = await one(`${SEQUENCE_SELECT} where q.slug = $1`, [req.params.slug]);
  if (!sequence) return res.status(404).json({ error: "No such sequence." });
  res.json(sequence);
}));

apiRouter.post("/sequences", ok(async (req, res) => {
  const { name, slug } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: "A name is required." });

  const settings = await loadSettings();
  const isFirst = !(await one("select 1 as found from followup_sequences limit 1"));

  const created = await one(
    `insert into followup_sequences (slug, name, is_active, is_default, timezone)
     values ($1, $2, false, $3, $4) returning *`,
    [slug, name.trim(), isFirst, settings.default_timezone],
  );
  res.status(201).json(created);
}));

const SEQUENCE_FIELDS = [
  "name", "description", "is_active", "quo_number_id", "timezone",
  "quiet_hours_start", "quiet_hours_end", "send_days", "append_opt_out_notice",
];

apiRouter.patch("/sequences/:id", ok(async (req, res) => {
  const updates = [];
  const values = [req.params.id];
  for (const field of SEQUENCE_FIELDS) {
    if (!(field in req.body)) continue;
    values.push(req.body[field]);
    updates.push(`${field} = $${values.length}`);
  }
  if (!updates.length) return res.status(400).json({ error: "Nothing to update." });

  const updated = await one(
    `update followup_sequences set ${updates.join(", ")} where id = $1 returning *`,
    values,
  );
  if (!updated) return res.status(404).json({ error: "No such sequence." });
  res.json(updated);
}));

apiRouter.post("/sequences/:id/default", ok(async (req, res) => {
  await query("update followup_sequences set is_default = false where is_default and id <> $1", [req.params.id]);
  const updated = await one("update followup_sequences set is_default = true where id = $1 returning *", [req.params.id]);
  res.json(updated);
}));

apiRouter.delete("/sequences/:id", ok(async (req, res) => {
  await query("delete from followup_sequences where id = $1", [req.params.id]);
  res.json({ ok: true });
}));

/* ------------------------------------------------------------------ steps */

apiRouter.post("/sequences/:id/steps", ok(async (req, res) => {
  const last = await one(
    "select position, delay_minutes from followup_steps where sequence_id = $1 order by position desc limit 1",
    [req.params.id],
  );
  const created = await one(
    `insert into followup_steps (sequence_id, position, delay_minutes, body_en, body_es, is_active)
     values ($1, $2, $3, $4, $5, false) returning *`,
    [
      req.params.id,
      (last?.position ?? 0) + 1,
      (last?.delay_minutes ?? -1440) + 1440,
      // A new step starts empty and switched off; the length constraint would
      // reject a truly blank body, so seed a placeholder the editor overwrites.
      "New message",
      "Mensaje nuevo",
    ],
  );
  res.status(201).json(created);
}));

// Saving the whole set at once keeps the deferred position constraint happy: a
// reorder that swaps two steps is only valid once every row has moved.
apiRouter.put("/sequences/:id/steps", ok(async (req, res) => {
  const steps = Array.isArray(req.body.steps) ? req.body.steps : [];

  for (const [index, step] of steps.entries()) {
    if (!step.is_active) continue;
    if (!String(step.body_en ?? "").trim() || !String(step.body_es ?? "").trim()) {
      return res.status(400).json({
        error: `Text ${index + 1} is switched on but is missing its `
          + `${!String(step.body_en ?? "").trim() ? "English" : "Spanish"} copy. Every text needs both, `
          + "because the language is chosen per client when the series starts.",
      });
    }
  }

  const client = await (await import("../db.js")).pool.connect();
  try {
    await client.query("begin");
    await client.query("set constraints all deferred");
    for (const [index, step] of steps.entries()) {
      await client.query(
        `update followup_steps
         set position = $2, label = $3, delay_minutes = $4, body_en = $5, body_es = $6, is_active = $7
         where id = $1 and sequence_id = $8`,
        [
          step.id, index + 1, step.label || null, Math.max(0, Number(step.delay_minutes) || 0),
          step.body_en, step.body_es, Boolean(step.is_active), req.params.id,
        ],
      );
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  res.json(await one(`${SEQUENCE_SELECT} where q.id = $1`, [req.params.id]));
}));

apiRouter.delete("/steps/:id", ok(async (req, res) => {
  await query("delete from followup_steps where id = $1", [req.params.id]);
  res.json({ ok: true });
}));

/* ------------------------------------------------------------- enrollments */

apiRouter.get("/enrollments", ok(async (req, res) => {
  const status = req.query.status ?? "active";
  const conditions = [];
  const values = [];

  if (status === "active") conditions.push("e.status = 'active'");
  else if (status === "ended") conditions.push("e.status <> 'active'");

  if (req.query.search) {
    values.push(`%${String(req.query.search).replace(/[^0-9a-zA-Z]/g, "")}%`);
    conditions.push(`(c.phone_e164 ilike $${values.length} or c.first_name ilike $${values.length})`);
  }

  const list = await rows(`
    select e.*, c.phone_e164, c.first_name, c.last_name, c.opted_out_at, c.last_inbound_at,
           q.name as sequence_name, q.slug as sequence_slug, q.timezone,
           (select count(*) from followup_messages m
             where m.enrollment_id = e.id and m.direction = 'outbound' and m.status <> 'failed') as sent_count
    from followup_enrollments e
    join followup_contacts c on c.id = e.contact_id
    join followup_sequences q on q.id = e.sequence_id
    ${conditions.length ? `where ${conditions.join(" and ")}` : ""}
    order by e.started_at desc limit 100
  `, values);
  res.json(list);
}));

apiRouter.get("/enrollments/:id/messages", ok(async (req, res) => {
  res.json(await rows(
    "select * from followup_messages where enrollment_id = $1 order by created_at",
    [req.params.id],
  ));
}));

apiRouter.post("/enrollments/:id/stop", ok(async (req, res) => {
  // The dashboard is the administrator's override, so it does not enforce the
  // assignment rule the way Slack does.
  const result = await stopSeries({ enrollmentId: req.params.id, actor: actor(req), reason: "manual" });
  if (!result?.ok) return res.status(400).json({ error: result?.reason ?? "Could not stop that series." });
  await announceStop(result, actor(req)).catch((error) => console.error("announce failed", error));
  res.json(result);
}));

/* ---------------------------------------------------------------- contacts */

apiRouter.get("/contacts", ok(async (req, res) => {
  const conditions = [];
  const values = [];

  if (req.query.optedOut === "true") conditions.push("opted_out_at is not null");
  if (req.query.search) {
    const digits = String(req.query.search).replace(/[^0-9]/g, "");
    values.push(digits ? `%${digits}%` : `%${req.query.search}%`);
    conditions.push(digits ? `phone_e164 ilike $${values.length}` : `first_name ilike $${values.length}`);
  }

  res.json(await rows(`
    select * from followup_contacts
    ${conditions.length ? `where ${conditions.join(" and ")}` : ""}
    order by updated_at desc limit 200
  `, values));
}));

// One-directional on purpose: staff can honour an opt-out, but opting somebody
// back in has to come from the client, by text.
apiRouter.post("/contacts/:id/opt-out", ok(async (req, res) => {
  const contact = await one(
    `update followup_contacts
     set opted_out_at = coalesce(opted_out_at, now()), opted_out_reason = 'staff'
     where id = $1 returning *`,
    [req.params.id],
  );
  if (!contact) return res.status(404).json({ error: "No such contact." });

  const active = await one(
    "select id from followup_enrollments where contact_id = $1 and status = 'active'",
    [req.params.id],
  );
  if (active) await stopSeries({ enrollmentId: active.id, actor: actor(req), reason: "opt_out" });

  await query(
    "insert into followup_events (contact_id, kind, detail, actor) values ($1, 'opt_out', $2::jsonb, $3)",
    [req.params.id, JSON.stringify({ source: "dashboard" }), actor(req)],
  );
  res.json(contact);
}));

apiRouter.patch("/contacts/:id", ok(async (req, res) => {
  const fields = ["first_name", "last_name", "language", "notes"];
  const updates = [];
  const values = [req.params.id];
  for (const field of fields) {
    if (!(field in req.body)) continue;
    values.push(req.body[field]);
    updates.push(`${field} = $${values.length}`);
  }
  if (!updates.length) return res.status(400).json({ error: "Nothing to update." });
  res.json(await one(`update followup_contacts set ${updates.join(", ")} where id = $1 returning *`, values));
}));

/* --------------------------------------------------------------- operators */

apiRouter.get("/operators", ok(async (req, res) => {
  res.json(await rows(
    "select * from followup_operators order by display_name nulls last, email nulls last, slack_user_id",
  ));
}));

// A person is identified by a Slack ID, an email address, or both. The Slack ID
// is what lets them start follow-ups; the email is what lets them sign in with
// Google. Requiring both would lock out the office manager who never uses Slack.
function readIdentity(body) {
  const slackUserId = String(body.slack_user_id ?? "").trim().toUpperCase() || null;
  const email = String(body.email ?? "").trim().toLowerCase() || null;

  if (!slackUserId && !email) {
    return { error: "Add a Slack member ID, an email address, or both — one of them is needed." };
  }
  if (slackUserId && !/^[A-Z0-9]{6,}$/.test(slackUserId)) {
    return {
      error: "That is not a Slack member ID. It looks like U01ABC2DEFG — find it under the person's "
        + "Slack profile, View full profile, then the ⋯ menu, Copy member ID.",
    };
  }
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return { error: "That does not look like an email address." };
  }
  return { slackUserId, email };
}

// Dashboard access without an email cannot work: Google sign-in is keyed on the
// address, so this would create somebody who is allowed in but has no way in.
function accessIsUsable({ email, can_admin: canAdmin }) {
  if (!canAdmin || email) return null;
  return "Dashboard access needs an email address — that is what Google sign-in matches on.";
}

apiRouter.post("/operators", ok(async (req, res) => {
  const identity = readIdentity(req.body);
  if (identity.error) return res.status(400).json({ error: identity.error });

  const canAdmin = Boolean(req.body.can_admin);
  const unusable = accessIsUsable({ email: identity.email, can_admin: canAdmin });
  if (unusable) return res.status(400).json({ error: unusable });

  const existing = identity.slackUserId
    ? await one("select id from followup_operators where slack_user_id = $1", [identity.slackUserId])
    : null;
  const byEmail = identity.email
    ? await one("select id from followup_operators where email = $1", [identity.email])
    : null;

  if (existing && byEmail && existing.id !== byEmail.id) {
    return res.status(400).json({
      error: "That Slack ID and that email already belong to two different people. "
        + "Edit one of them instead of adding a third.",
    });
  }

  const target = existing ?? byEmail;
  const fields = [
    identity.slackUserId,
    identity.email,
    req.body.display_name?.trim() || null,
    Boolean(req.body.is_supervisor),
    canAdmin,
  ];

  if (target) {
    const updated = await one(
      `update followup_operators
       set slack_user_id = coalesce($2, slack_user_id),
           email = coalesce($3, email),
           display_name = coalesce($4, display_name),
           is_supervisor = $5, can_admin = $6, is_active = true
       where id = $1 returning *`,
      [target.id, ...fields],
    );
    return res.json(updated);
  }

  const created = await one(
    `insert into followup_operators (slack_user_id, email, display_name, is_supervisor, can_admin)
     values ($1, $2, $3, $4, $5) returning *`,
    fields,
  );
  return res.status(201).json(created);
}));

// Refuses to remove the last way into the dashboard. Locking everybody out of a
// system that is actively texting clients is not a recoverable mistake.
async function wouldLockEveryoneOut(personId, body) {
  const losing = body.can_admin === false || body.is_active === false;
  if (!losing) return false;
  const remaining = await one(
    `select count(*)::int as count from followup_operators
     where can_admin and is_active and id <> $1`,
    [personId],
  );
  return (remaining?.count ?? 0) === 0;
}

apiRouter.patch("/operators/:id", ok(async (req, res) => {
  const person = await one("select * from followup_operators where id = $1", [req.params.id]);
  if (!person) return res.status(404).json({ error: "No such person." });

  if (await wouldLockEveryoneOut(person.id, req.body)) {
    return res.status(400).json({
      error: "This is the last account that can sign in. Give somebody else dashboard access first.",
    });
  }

  const next = { ...person, ...req.body };
  const unusable = accessIsUsable({
    email: String(next.email ?? "").trim().toLowerCase() || null,
    can_admin: next.can_admin,
  });
  if (unusable) return res.status(400).json({ error: unusable });

  const updates = [];
  const values = [person.id];
  for (const field of ["display_name", "email", "slack_user_id", "is_supervisor", "can_admin", "is_active"]) {
    if (!(field in req.body)) continue;
    let value = req.body[field];
    if (field === "email") value = String(value ?? "").trim().toLowerCase() || null;
    if (field === "slack_user_id") value = String(value ?? "").trim().toUpperCase() || null;
    values.push(value);
    updates.push(`${field} = $${values.length}`);
  }
  if (!updates.length) return res.status(400).json({ error: "Nothing to update." });

  res.json(await one(
    `update followup_operators set ${updates.join(", ")} where id = $1 returning *`,
    values,
  ));
}));

apiRouter.delete("/operators/:id", ok(async (req, res) => {
  if (await wouldLockEveryoneOut(req.params.id, { can_admin: false })) {
    return res.status(400).json({
      error: "This is the last account that can sign in. Give somebody else dashboard access first.",
    });
  }
  await query("delete from followup_operators where id = $1", [req.params.id]);
  res.json({ ok: true });
}));

/* ---------------------------------------------------------------- settings */

apiRouter.get("/settings", ok(async (req, res) => {
  res.json({
    definitions: SETTING_DEFINITIONS,
    values: await loadSettings({ fresh: true }),
    numbers: await listQuoNumbers(),
    environment: {
      quoConfigured: quoConfigured(),
      slackBotConfigured: slackConfigured(),
      slackSigningConfigured: Boolean(process.env.SLACK_SIGNING_SECRET),
      quoWebhookConfigured: Boolean(process.env.QUO_WEBHOOK_SECRET || process.env.QUO_WEBHOOK_TOKEN),
      slackSignInConfigured: slackSignInConfigured(),
      googleSignInConfigured: googleConfigured(),
      publicUrl: process.env.PUBLIC_URL || null,
    },
  });
}));

apiRouter.put("/settings", ok(async (req, res) => {
  res.json(await saveSettings(req.body ?? {}, actor(req)));
}));

apiRouter.post("/quo-numbers/sync", ok(async (req, res) => {
  if (!quoConfigured()) return res.status(400).json({ error: "QUO_API_KEY is not set." });
  try {
    res.json(await syncQuoNumbers());
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
}));

apiRouter.get("/quo-numbers", ok(async (req, res) => {
  res.json(await listQuoNumbers());
}));

/* ------------------------------------------------------------------ events */

apiRouter.get("/events", ok(async (req, res) => {
  res.json(await rows(`
    select e.*, c.phone_e164, c.first_name
    from followup_events e
    left join followup_contacts c on c.id = e.contact_id
    order by e.created_at desc limit 100
  `));
}));

// Lets an administrator prove the pipeline works without waiting for the timer.
apiRouter.post("/dispatch/run", ok(async (req, res) => {
  res.json(await runDispatch());
}));
