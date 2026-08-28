import {
  appendOptOutNotice,
  countSegments,
  isNightHour,
  pickStepTemplate,
  renderBody,
} from "../../shared/messaging.js";
import { one } from "../db.js";
import { loadSettings } from "./settings.js";
import { currentFirm } from "./firms.js";

// What a lead would actually receive as text 1, merge fields filled in.
// Used by watch-and-record and by the Leads page when someone switches tracks.
export async function previewFirstText(slug, { firstName, lastName, caseType, language } = {}) {
  const step = await one(
    `select s.body_en, s.body_es, s.body_en_night, s.body_es_night,
            s.body_en_alt, s.body_es_alt, s.body_en_alt_night, s.body_es_alt_night,
            s.alt_case_types, q.append_opt_out_notice,
            q.slug, q.name, q.timezone, q.quiet_hours_start, q.quiet_hours_end, q.send_days,
            q.night_starts_hour, q.night_ends_hour
     from followup_sequences q
     join followup_steps s on s.sequence_id = q.id and s.is_active
     where ($2::uuid is null or q.firm_id = $2)
       and q.slug = coalesce($1, (
         select slug from followup_sequences
         where is_default and ($2::uuid is null or firm_id = $2) limit 1
       ))
     order by s.position limit 1`,
    [slug, currentFirm()?.id ?? null],
  );
  if (!step) return null;

  const settings = await loadSettings();
  const tz = step.timezone || "America/Chicago";
  const hourRow = await one(
    `select extract(hour from (now() at time zone $1))::int
            + extract(minute from (now() at time zone $1))::int / 60.0 as hour`,
    [tz],
  );
  const hour = Number(hourRow?.hour ?? 0);
  const nightStart = Number(step.night_starts_hour ?? settings.night_starts_hour ?? 21);
  const nightEnd = Number(step.night_ends_hour ?? settings.night_ends_hour ?? 8);
  const isNight = isNightHour(hour, nightStart, nightEnd);

  const lang = language === "es" ? "es" : "en";
  const picked = pickStepTemplate(step, { language: lang, isNight, caseType });
  const body = renderBody(picked.template, {
    first_name: firstName,
    last_name: lastName,
    case_type: caseType,
    firm_name: settings.firm_name,
  }, lang);

  const withNotice = step.append_opt_out_notice ? appendOptOutNotice(body, lang) : body;

  const next = await one(
    `select followup_shift_into_window(
       now() + make_interval(mins => s.delay_minutes),
       q.timezone, q.quiet_hours_start, q.quiet_hours_end, q.send_days
     ) as at
     from followup_sequences q
     join followup_steps s on s.sequence_id = q.id and s.is_active
     where q.slug = $1
     order by s.position offset 1 limit 1`,
    [step.slug],
  );

  return {
    body: withNotice,
    segments: countSegments(withNotice).segments,
    isNight,
    nextAt: next?.at ?? null,
    slug: step.slug,
    name: step.name,
  };
}
