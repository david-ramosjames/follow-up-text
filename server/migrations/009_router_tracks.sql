-- Two tracks the lead router can actually choose: a qualified injured person
-- this firm may represent, and a Referral form (this firm will send them to
-- another lawyer). The original New lead follow-up stays manual.
--
-- Switched on so Watch and record has something to route to. Nothing is texted
-- until the mode is Live. Copy is a starting point, not legal advice — read it
-- with whoever signs off on client communications.
--
-- Spanish is written to stay in GSM-7 (no a/i/o/u accents, no inverted ?/!), so
-- a first text plus the opt-out line still fits in one segment.

do $$
declare
  qualified_id uuid;
  referral_id uuid;
begin

  if not exists (select 1 from followup_sequences where slug = 'qualified-lead') then
    insert into followup_sequences (
      slug, name, description, is_active, is_default, auto_routable, respond_immediately,
      timezone, quiet_hours_start, quiet_hours_end, send_days, append_opt_out_notice
    ) values (
      'qualified-lead',
      'Qualified lead',
      'An injured person who filled in a form or chatted on the website and whom this '
        || 'firm may represent — car accident, slip and fall, dog bite, truck, premises. '
        || 'Not a lead marked Referral (those go to another lawyer).',
      true,
      false,
      true,
      true,
      'America/Chicago',
      9,
      19,
      '{1,2,3,4,5,6}'::smallint[],
      true
    ) returning id into qualified_id;

    insert into followup_steps (
      sequence_id, position, label, delay_minutes,
      body_en, body_es, body_en_night, body_es_night
    ) values
    (qualified_id, 1, 'Right away', 0,
     'Hi {{first_name}}, this is {{firm_name}}. We got your message about your {{case_type}} and want to help. Is now a good time to talk?',
     'Hola {{first_name}}, le escribimos de {{firm_name}}. Recibimos su mensaje sobre su {{case_type}} y queremos ayudarle. Es buen momento para hablar?',
     'Hi {{first_name}}, this is {{firm_name}}. We got your message about your {{case_type}} tonight and will call you in the morning. Reply here if now is better.',
     'Hola {{first_name}}, le escribimos de {{firm_name}}. Recibimos su mensaje sobre su {{case_type}} esta noche y le llamamos por la manana. Si prefiere ahora, responda aqui.'),

    (qualified_id, 2, 'Same day, later', 240,
     'Hi {{first_name}}, following up on your {{case_type}}. Is now a better time to talk?',
     'Hola {{first_name}}, le escribimos de nuevo sobre su {{case_type}}. Es mejor momento para hablar?',
     null, null),

    (qualified_id, 3, 'Next day', 1440,
     'Hi {{first_name}}, we are still holding your {{case_type}} file open. If you would rather we stopped, just say so and we will note it.',
     'Hola {{first_name}}, su archivo de {{case_type}} sigue abierto con nosotros. Si prefiere que no le escribamos mas, digalo y lo anotamos.',
     null, null),

    (qualified_id, 4, 'Day three', 4320,
     'Hi {{first_name}}, a quick note: injury claims in Texas have filing deadlines, and evidence gets harder to gather as time passes. We can walk you through your {{case_type}} at no cost.',
     'Hola {{first_name}}: los reclamos por lesiones en Texas tienen plazos legales, y la evidencia es mas dificil de conseguir con el tiempo. Podemos explicarle su {{case_type}}, sin costo.',
     null, null),

    (qualified_id, 5, 'End of week one', 10080,
     'Hi {{first_name}}, checking in one more time about your {{case_type}}. If you have already hired someone else, no problem at all, just let us know and we will close the file.',
     'Hola {{first_name}}, le escribimos una vez mas sobre su {{case_type}}. Si ya contrato a otro abogado, no hay problema, solo diganos y cerramos el archivo.',
     null, null),

    (qualified_id, 6, 'Final', 20160,
     'Hi {{first_name}}, this is our last message about your {{case_type}}. Your file stays open if you want to pick it back up. Call or text us any time.',
     'Hola {{first_name}}, este es nuestro ultimo mensaje sobre su {{case_type}}. Su archivo queda abierto por si desea retomarlo. Puede llamarnos o escribirnos cuando quiera.',
     null, null);
  end if;

  if not exists (select 1 from followup_sequences where slug = 'referral') then
    insert into followup_sequences (
      slug, name, description, is_active, is_default, auto_routable, respond_immediately,
      timezone, quiet_hours_start, quiet_hours_end, send_days, append_opt_out_notice
    ) values (
      'referral',
      'Referral',
      'A lead this firm will send to another lawyer. The Slack form is marked Referral '
        || 'or Referal. Not a qualified lead we will represent ourselves, and not another '
        || 'attorney sending us a case.',
      true,
      false,
      true,
      true,
      'America/Chicago',
      9,
      19,
      '{1,2,3,4,5}'::smallint[],
      true
    ) returning id into referral_id;

    insert into followup_steps (
      sequence_id, position, label, delay_minutes,
      body_en, body_es, body_en_night, body_es_night
    ) values
    (referral_id, 1, 'Right away', 0,
     'Hi {{first_name}}, this is {{firm_name}}. We got your message about your {{case_type}}. We are referring you to a lawyer who is a better fit and will be in touch.',
     'Hola {{first_name}}, le escribimos de {{firm_name}}. Recibimos su mensaje sobre su {{case_type}}. Lo estamos refiriendo a un abogado que encaja mejor y nos pondremos en contacto.',
     'Hi {{first_name}}, this is {{firm_name}}. We got your message about your {{case_type}} tonight. We are referring you to a lawyer who is a better fit and will follow up in the morning.',
     'Hola {{first_name}}, le escribimos de {{firm_name}}. Recibimos su mensaje sobre su {{case_type}} esta noche. Lo estamos refiriendo a un abogado que encaja mejor y damos seguimiento por la manana.'),

    (referral_id, 2, 'Next day', 1440,
     'Hi {{first_name}}, following up on your {{case_type}}. We are connecting you with the right lawyer. Reply here if you have questions in the meantime.',
     'Hola {{first_name}}, sobre su {{case_type}}: lo estamos conectando con el abogado adecuado. Responda aqui si tiene preguntas.',
     null, null),

    (referral_id, 3, 'Day three', 4320,
     'Hi {{first_name}}, checking in on the {{case_type}} referral. Have you heard from the other lawyer, or would you like us to follow up?',
     'Hola {{first_name}}, sobre la referencia de su {{case_type}}. Ya le llamo el otro abogado, o prefiere que nosotros sigamos?',
     null, null),

    (referral_id, 4, 'Final', 10080,
     'Hi {{first_name}}, last note from us about your {{case_type}}. The lawyer we referred you to has your information. Call or text if you need anything.',
     'Hola {{first_name}}, ultimo mensaje sobre su {{case_type}}. El abogado a quien lo referimos tiene su informacion. Llame o escriba si necesita algo.',
     null, null);
  end if;

end;
$$;
