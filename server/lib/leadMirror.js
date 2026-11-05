import { one, rows } from "../db.js";
import { leadsDb, toLeadE164 } from "./leadDecision.js";

let mirroredActiveAt = 0;

const ACTIVE_SQL = `
  select c.phone_e164, s.slug, e.status, e.next_run_at
  from followup_enrollments e
  join followup_contacts c on c.id = e.contact_id
  join followup_sequences s on s.id = e.sequence_id
  join firms f on f.id = e.firm_id
  where f.slug = 'ramos-james'
    and c.phone_e164 = $1
  order by case when e.status = 'active' then 0 else 1 end, e.started_at desc
  limit 1`;

async function writeOntoLead(db, row) {
  // Sequence status only. Do not refill lead_name / case_type — staff edits on
  // open leads must stick, and Follow-Up contacts often still hold the original
  // form junk (N/A, "it's my brother…") that Intake Manager already cleared.
  // Every lead on this number, not just the newest. A second case (or a row
  // whose phone_e164 was still empty) used to keep showing Start SMS while
  // the series was already sending.
  const tail = String(row.phone_e164 || "").replace(/\D/g, "").slice(-10);
  if (tail.length < 10) return;
  await db.query(
    `update public.leads
     set text_sequence_slug = $2,
         text_sequence_status = $3,
         text_next_at = $4
     where right(regexp_replace(coalesce(phone_e164, ''), '\\D', '', 'g'), 10) = $1
        or right(regexp_replace(coalesce(phone, ''), '\\D', '', 'g'), 10) = $1`,
    [
      tail,
      row.slug,
      row.status,
      row.status === "active" ? row.next_run_at : null,
    ],
  );
}

// SMS Follow-Up already knows which numbers are on a sequence. This copies
// that status onto the shared lead so Intake Manager can show it. With no
// LEADS_DATABASE_URL, the texts still send and nothing is written.
export async function mirrorTextSequence(phone) {
  const db = leadsDb();
  const phoneE164 = toLeadE164(phone);
  if (!db || !phoneE164) return;

  const row = await one(ACTIVE_SQL, [phoneE164]);
  if (!row) return;

  try {
    await writeOntoLead(db, row);
  } catch (error) {
    console.error("Could not mirror the text sequence onto the lead", error.message);
  }
}

// Copies every live Ramos James series onto its leads. Repeats with each
// dispatch (at most every 20s) so a missed write does not stay wrong until restart.
export async function mirrorActiveSequences() {
  const now = Date.now();
  if (now - mirroredActiveAt < 20_000) return;
  mirroredActiveAt = now;
  const db = leadsDb();
  if (!db) return;
  const list = await rows(
    `select c.phone_e164, s.slug, e.status, e.next_run_at
     from followup_enrollments e
     join followup_contacts c on c.id = e.contact_id
     join followup_sequences s on s.id = e.sequence_id
     join firms f on f.id = e.firm_id
     where f.slug = 'ramos-james' and e.status = 'active'
     limit 500`,
  );
  for (const row of list) {
    try {
      await writeOntoLead(db, row);
    } catch (error) {
      console.error("Could not mirror an active text sequence", error.message);
    }
  }
  if (list.length) console.log(`Mirrored ${list.length} active text sequences onto leads`);
}
