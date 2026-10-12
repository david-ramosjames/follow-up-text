import { one, rows } from "../db.js";
import { leadsDb, toLeadE164 } from "./leadDecision.js";

let mirroredActive = false;

const ACTIVE_SQL = `
  select c.phone_e164, s.slug, e.status, e.next_run_at,
         c.first_name, c.last_name, coalesce(e.case_type, c.case_type) as case_type
  from followup_enrollments e
  join followup_contacts c on c.id = e.contact_id
  join followup_sequences s on s.id = e.sequence_id
  join firms f on f.id = e.firm_id
  where f.slug = 'ramos-james'
    and c.phone_e164 = $1
  order by case when e.status = 'active' then 0 else 1 end, e.started_at desc
  limit 1`;

function clientName(row) {
  const name = [row.first_name, row.last_name].map((part) => String(part || "").trim()).filter(Boolean).join(" ");
  return name || null;
}

function accidentType(row) {
  const value = String(row.case_type || "").trim();
  if (!value || /^other$/i.test(value)) return null;
  return value;
}

async function writeOntoLead(db, row) {
  const name = clientName(row);
  const accident = accidentType(row);
  const saved = await db.query(
    `update public.leads
     set text_sequence_slug = $2,
         text_sequence_status = $3,
         text_next_at = $4,
         lead_name = coalesce(nullif(btrim(lead_name), ''), $5),
         case_type = coalesce(nullif(btrim(case_type), ''), $6)
     where id = (
       select id from public.leads
       where phone_e164 = $1
       order by created_at desc
       limit 1
     )
     returning id, intake_call_id, phone, email, lead_name, case_type`,
    [
      row.phone_e164,
      row.slug,
      row.status,
      row.status === "active" ? row.next_run_at : null,
      name,
      accident,
    ],
  );
  const lead = saved.rows[0];
  if (!lead || (!name && !accident)) return;
  const callId = lead.intake_call_id || `form:${lead.id}`;
  if (!lead.intake_call_id) {
    await db.query(
      `update public.leads set intake_call_id = $2 where id = $1 and intake_call_id is null`,
      [lead.id, callId],
    );
  }
  await db.query(
    `insert into public.intakes (call_id, name, phone, email, accident_description)
     values ($1, $2, $3, $4, $5)
     on conflict (call_id) do update set
       name = coalesce(public.intakes.name, excluded.name),
       phone = coalesce(public.intakes.phone, excluded.phone),
       email = coalesce(public.intakes.email, excluded.email),
       accident_description = coalesce(public.intakes.accident_description, excluded.accident_description)`,
    [callId, lead.lead_name, lead.phone, lead.email, lead.case_type],
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

// Copies every live Ramos James series once per process, so the lead shows
// who is already on a sequence before the next text goes out.
export async function mirrorActiveSequences() {
  if (mirroredActive) return;
  const db = leadsDb();
  if (!db) return;
  const list = await rows(
    `select c.phone_e164, s.slug, e.status, e.next_run_at,
            c.first_name, c.last_name, coalesce(e.case_type, c.case_type) as case_type
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
  mirroredActive = true;
  if (list.length) console.log(`Mirrored ${list.length} active text sequences onto leads`);
}
