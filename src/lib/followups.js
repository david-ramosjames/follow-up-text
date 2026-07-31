import { requireSupabase, supabase } from "./supabase";

export const LANGUAGES = [
  { value: "en", label: "English" },
  { value: "es", label: "Spanish" },
];

export const DAY_NAMES = [
  { iso: 1, short: "Mon" },
  { iso: 2, short: "Tue" },
  { iso: 3, short: "Wed" },
  { iso: 4, short: "Thu" },
  { iso: 5, short: "Fri" },
  { iso: 6, short: "Sat" },
  { iso: 7, short: "Sun" },
];

export const TIMEZONES = [
  "America/Chicago",
  "America/New_York",
  "America/Denver",
  "America/Los_Angeles",
  "America/Phoenix",
];

// How an ended series reads in the UI. The database distinguishes these because
// "they called back" and "they told us to stop" mean very different things to
// whoever picks the file up next.
export const STATUS_LABELS = {
  active: "Running",
  completed: "Finished, no reply",
  stopped_reply: "Stopped — they replied",
  stopped_call: "Stopped — they called back",
  stopped_manual: "Stopped by staff",
  stopped_opt_out: "Stopped — opted out",
  failed: "Stopped — texts kept failing",
};

export function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

export function formatPhone(e164) {
  if (!e164) return "";
  const match = String(e164).match(/^\+1(\d{3})(\d{3})(\d{4})$/);
  return match ? `(${match[1]}) ${match[2]}-${match[3]}` : e164;
}

export function formatWhen(iso, timezone = "America/Chicago") {
  if (!iso) return "—";
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

/* --------------------------------------------------------------- sequences */

const SEQUENCE_SELECT = "*, followup_steps(*)";

function normalizeSequence(row) {
  const steps = [...(row.followup_steps || [])].sort((a, b) => a.position - b.position);
  const { followup_steps: _steps, ...rest } = row;
  return { ...rest, steps };
}

export async function loadSequences() {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from("followup_sequences")
    .select(SEQUENCE_SELECT)
    .order("is_default", { ascending: false })
    .order("name");
  if (error) throw error;
  return (data || []).map(normalizeSequence);
}

export async function loadSequence(slug) {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from("followup_sequences")
    .select(SEQUENCE_SELECT)
    .eq("slug", slug)
    .maybeSingle();
  if (error) throw error;
  return data ? normalizeSequence(data) : null;
}

export async function createSequence(values) {
  const client = requireSupabase();
  const { data, error } = await client
    .from("followup_sequences")
    .insert(values)
    .select(SEQUENCE_SELECT)
    .single();
  if (error) throw error;
  return normalizeSequence(data);
}

export async function saveSequence(id, values) {
  const client = requireSupabase();
  const { data, error } = await client
    .from("followup_sequences")
    .update(values)
    .eq("id", id)
    .select(SEQUENCE_SELECT)
    .single();
  if (error) throw error;
  return normalizeSequence(data);
}

export async function deleteSequence(id) {
  const client = requireSupabase();
  const { error } = await client.from("followup_sequences").delete().eq("id", id);
  if (error) throw error;
  return true;
}

// Only one sequence can be the default, so clear the old one first. A unique
// index enforces this too; doing it in order avoids tripping it.
export async function setDefaultSequence(id) {
  const client = requireSupabase();
  const { error: clearError } = await client
    .from("followup_sequences")
    .update({ is_default: false })
    .eq("is_default", true)
    .neq("id", id);
  if (clearError) throw clearError;
  const { data, error } = await client
    .from("followup_sequences")
    .update({ is_default: true })
    .eq("id", id)
    .select(SEQUENCE_SELECT)
    .single();
  if (error) throw error;
  return normalizeSequence(data);
}

/* ------------------------------------------------------------------- steps */

export async function createStep(sequenceId, position, values) {
  const client = requireSupabase();
  const { data, error } = await client
    .from("followup_steps")
    .insert({ sequence_id: sequenceId, position, ...values })
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

export async function saveStep(id, values) {
  const client = requireSupabase();
  const { data, error } = await client
    .from("followup_steps")
    .update(values)
    .eq("id", id)
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

export async function deleteStep(id) {
  const client = requireSupabase();
  const { error } = await client.from("followup_steps").delete().eq("id", id);
  if (error) throw error;
  return true;
}

// Reordering renumbers every step. The unique constraint on (sequence_id,
// position) is deferred, so the intermediate collisions are fine as long as the
// final state is unique.
export async function reorderSteps(steps) {
  const client = requireSupabase();
  for (const [index, step] of steps.entries()) {
    const nextPosition = index + 1;
    if (step.position === nextPosition) continue;
    const { error } = await client
      .from("followup_steps")
      .update({ position: nextPosition })
      .eq("id", step.id);
    if (error) throw error;
  }
  return true;
}

/* ------------------------------------------------------------- enrollments */

const ENROLLMENT_SELECT = "*, followup_contacts(id, phone_e164, first_name, last_name, "
  + "language, opted_out_at, last_inbound_at), followup_sequences(name, slug, timezone)";

export async function loadEnrollments({ status = "active", limit = 100 } = {}) {
  if (!supabase) return [];
  let query = supabase
    .from("followup_enrollments")
    .select(ENROLLMENT_SELECT)
    .order("started_at", { ascending: false })
    .limit(limit);
  if (status === "active") query = query.eq("status", "active");
  else if (status === "ended") query = query.neq("status", "active");
  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

// Stopping from the browser goes through RLS on the table rather than the
// service-role function the Slack app uses, so an administrator can always
// intervene regardless of who the series is assigned to.
export async function stopEnrollment(id, actorEmail) {
  const client = requireSupabase();
  const { data, error } = await client
    .from("followup_enrollments")
    .update({ status: "stopped_manual", end_reason: "manual", ended_by: actorEmail || "admin" })
    .eq("id", id)
    .eq("status", "active")
    .select(ENROLLMENT_SELECT)
    .single();
  if (error) throw error;
  return data;
}

export async function loadEnrollmentMessages(enrollmentId) {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from("followup_messages")
    .select("*")
    .eq("enrollment_id", enrollmentId)
    .order("created_at");
  if (error) throw error;
  return data || [];
}

/* ---------------------------------------------------------------- contacts */

export async function loadContacts({ optedOutOnly = false, search = "", limit = 100 } = {}) {
  if (!supabase) return [];
  let query = supabase
    .from("followup_contacts")
    .select("*")
    .order("updated_at", { ascending: false })
    .limit(limit);
  if (optedOutOnly) query = query.not("opted_out_at", "is", null);
  if (search.trim()) {
    const digits = search.replace(/[^0-9]/g, "");
    query = digits
      ? query.ilike("phone_e164", `%${digits}%`)
      : query.ilike("first_name", `%${search.trim()}%`);
  }
  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

// Deliberately one-directional: staff can honour an opt-out from here, but
// cannot opt somebody back in. Consent has to come from the client, by text.
export async function optOutContact(id, reason = "staff") {
  const client = requireSupabase();
  const { data, error } = await client
    .from("followup_contacts")
    .update({ opted_out_at: new Date().toISOString(), opted_out_reason: reason })
    .eq("id", id)
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

export async function saveContact(id, values) {
  const client = requireSupabase();
  const { data, error } = await client
    .from("followup_contacts")
    .update(values)
    .eq("id", id)
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

/* --------------------------------------------------------------- operators */

export async function loadOperators() {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from("followup_operators")
    .select("*")
    .order("display_name");
  if (error) throw error;
  return data || [];
}

export async function addOperator(values) {
  const client = requireSupabase();
  const slackUserId = String(values.slack_user_id || "").trim().toUpperCase();
  if (!/^[A-Z0-9]{6,}$/.test(slackUserId)) {
    throw new Error("That is not a Slack member ID. It looks like U01ABC2DEFG — find it under the "
      + "person's Slack profile, View full profile, More, Copy member ID.");
  }
  const { data, error } = await client
    .from("followup_operators")
    .insert({ ...values, slack_user_id: slackUserId })
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

export async function saveOperator(slackUserId, values) {
  const client = requireSupabase();
  const { data, error } = await client
    .from("followup_operators")
    .update(values)
    .eq("slack_user_id", slackUserId)
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

export async function removeOperator(slackUserId) {
  const client = requireSupabase();
  const { error } = await client.from("followup_operators").delete().eq("slack_user_id", slackUserId);
  if (error) throw error;
  return true;
}

/* ------------------------------------------------------------------ events */

export async function loadEvents({ limit = 60 } = {}) {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from("followup_events")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data || [];
}

/* ---------------------------------------------------------------- overview */

export async function loadOverview() {
  if (!supabase) return { active: 0, optedOut: 0, sentToday: 0, repliedToday: 0 };
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const since = midnight.toISOString();

  const [active, optedOut, sent, replied] = await Promise.all([
    supabase.from("followup_enrollments").select("id", { count: "exact", head: true }).eq("status", "active"),
    supabase.from("followup_contacts").select("id", { count: "exact", head: true }).not("opted_out_at", "is", null),
    supabase.from("followup_messages").select("id", { count: "exact", head: true })
      .eq("direction", "outbound").neq("status", "failed").gte("created_at", since),
    supabase.from("followup_messages").select("id", { count: "exact", head: true })
      .eq("direction", "inbound").gte("created_at", since),
  ]);

  return {
    active: active.count ?? 0,
    optedOut: optedOut.count ?? 0,
    sentToday: sent.count ?? 0,
    repliedToday: replied.count ?? 0,
  };
}
