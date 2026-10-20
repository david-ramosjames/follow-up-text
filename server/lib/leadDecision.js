import pg from "pg";

// Intake Manager owns the decision. This service still sends the texts, and it
// skips a lead the cockpit has marked need-more-info, signed, referred, or
// follow-up off. With no LEADS_DATABASE_URL, sending stays as it is today.
let pool = null;

export function leadsDb() {
  const connectionString = process.env.LEADS_DATABASE_URL;
  if (!connectionString) return null;
  if (!pool) {
    const local = /localhost|127\.0\.0\.1/.test(connectionString);
    pool = new pg.Pool({
      connectionString,
      ssl: local || process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false },
      max: 2,
      idleTimeoutMillis: 30_000,
    });
    pool.on("error", (error) => console.error("Lead decision database error", error));
  }
  return pool;
}

export function toLeadE164(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

const CLOSED_STATUSES = ["Lost", "Referred", "Promoted", "Signed"];

function needsInfo(lead) {
  return lead?.sequence === "needs_info" || lead?.kind === "needs_info";
}

function manualFallback(reason, sequenceSlug) {
  return { allow: true, reason, sequenceSlug: sequenceSlug || "new-lead" };
}

// Automatic intake still honours the cockpit. A person starting texts by
// hand — @sms-follow-up, the ⋯ menu, /followup, the dashboard — is telling
// us to text anyway. Lost, referred, or needs-more-info still start, on
// New lead follow-up unless they named a track. Signed / a case on file,
// and an explicit stop, stay blocked.
export function decideLeadTexts(lead, { manual = false, sequenceSlug = null } = {}) {
  if (!lead) return { allow: true, reason: "no_lead" };
  if (lead.signed_case || lead.case_id) return { allow: false, reason: "closed" };
  if (lead.sequence === "stop") return { allow: false, reason: "stop" };
  if (CLOSED_STATUSES.includes(lead.lead_status)) {
    if (manual) return manualFallback(`${String(lead.lead_status).toLowerCase()}_manual`, sequenceSlug);
    return { allow: false, reason: lead.lead_status };
  }
  if (needsInfo(lead)) {
    if (manual) return manualFallback("needs_info_manual", sequenceSlug);
    return { allow: false, reason: "needs_info" };
  }
  if (lead.follow_up === false) {
    if (manual) return manualFallback("follow_up_off_manual", sequenceSlug);
    return { allow: false, reason: "follow_up_off" };
  }
  if (lead.sequence === "referral") return { allow: true, reason: "referral", sequenceSlug: "referral" };
  if (lead.sequence === "want_to_sign") {
    return { allow: true, reason: "want_to_sign", sequenceSlug: "qualified-lead" };
  }
  return { allow: true, reason: "pursue" };
}

const PRACTICE_TEST_PHONE = "+17654183805";

export const INITIAL_CONTACT_GRACE_MS = 15 * 60 * 1000;

// A lead that has been on file for more than a few minutes is already in the
// cockpit. The grace window covers the same Sona or missed call that just
// created the row, so first contact still starts.
export function isExistingLeadContact(lead, now = Date.now()) {
  if (!lead) return false;
  const created = lead.created_at ? new Date(lead.created_at).getTime() : NaN;
  if (!Number.isFinite(created)) return true;
  return now - created > INITIAL_CONTACT_GRACE_MS;
}

export async function lookupLead(phone) {
  const db = leadsDb();
  const phoneE164 = toLeadE164(phone);
  if (!db || !phoneE164) return null;
  const { rows } = await db.query(
    `select kind, follow_up, signed_case, case_id, lead_status, sequence, created_at
     from public.leads
     where phone_e164 = $1
     order by created_at desc
     limit 1`,
    [phoneE164],
  );
  return rows[0] ?? null;
}

export async function leadAllowsTexts(phone, { manual = false, sequenceSlug = null } = {}) {
  if (toLeadE164(phone) === PRACTICE_TEST_PHONE) {
    return { allow: true, reason: "practice_test", sequenceSlug: sequenceSlug ?? null };
  }
  const db = leadsDb();
  const phoneE164 = toLeadE164(phone);
  if (!db || !phoneE164) return { allow: true, reason: "no_lead_decision" };
  try {
    const lead = await lookupLead(phone);
    return decideLeadTexts(lead, { manual, sequenceSlug });
  } catch (error) {
    console.error("Could not read the lead decision", error);
    return { allow: true, reason: "lead_lookup_failed" };
  }
}
