import pg from "pg";

// Intake Manager owns the decision. This service still sends the texts, and it
// skips a lead the cockpit has marked need-more-info, signed, referred, or
// follow-up off. With no LEADS_DATABASE_URL, sending stays as it is today.
let pool = null;

function leadsDb() {
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

export async function leadAllowsTexts(phone) {
  const db = leadsDb();
  const phoneE164 = toLeadE164(phone);
  if (!db || !phoneE164) return { allow: true, reason: "no_lead_decision" };
  try {
    const { rows } = await db.query(
      `select kind, follow_up, signed_case, case_id, lead_status
       from public.leads
       where phone_e164 = $1
       order by created_at desc
       limit 1`,
      [phoneE164],
    );
    const lead = rows[0];
    if (!lead) return { allow: true, reason: "no_lead" };
    if (lead.signed_case || lead.case_id) return { allow: false, reason: "closed" };
    if (["Lost", "Referred", "Promoted", "Signed"].includes(lead.lead_status)) {
      return { allow: false, reason: lead.lead_status };
    }
    if (lead.kind === "needs_info") return { allow: false, reason: "needs_info" };
    if (lead.follow_up === false) return { allow: false, reason: "follow_up_off" };
    return { allow: true, reason: "pursue" };
  } catch (error) {
    console.error("Could not read the lead decision", error);
    return { allow: true, reason: "lead_lookup_failed" };
  }
}
