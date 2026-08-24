-- Replace the starter Qualified lead and Referral cadences with a seven-beat
-- track: instant confirm, empathy, objection-killer, low-friction ask,
-- stakes-lowering, credibility, urgency. Existing message rows keep their
-- history (step_id is ON DELETE SET NULL). Spanish stays in GSM-7.

do $$
declare
  qualified_id uuid;
  referral_id uuid;
begin
  select id into qualified_id from followup_sequences where slug = 'qualified-lead';
  select id into referral_id from followup_sequences where slug = 'referral';

  if qualified_id is not null then
    delete from followup_steps where sequence_id = qualified_id;

    insert into followup_steps (
      sequence_id, position, label, delay_minutes,
      body_en, body_es, body_en_night, body_es_night
    ) values
    (qualified_id, 1, 'Instant confirm', 0,
     'Hi {{first_name}}, thank you for contacting {{firm_name}} about your {{case_type}}. Please save this number so we can reach you.',
     'Hola {{first_name}}, gracias por contactar a {{firm_name}} sobre su {{case_type}}. Guarde este numero.',
     'Hi {{first_name}}, {{firm_name}} got your {{case_type}} tonight. Please save this number. We will call you in the morning.',
     'Hola {{first_name}}, gracias por contactarnos esta noche sobre su {{case_type}}. Guarde este numero. Le llamamos mañana.'),

    (qualified_id, 2, 'Empathy check-in · Day 1–2', 1440,
     'Hi {{first_name}}, this is {{assigned_user}} at {{firm_name}}. How are you feeling today after your {{case_type}}?',
     'Hola {{first_name}}, le escribe {{assigned_user}} de {{firm_name}}. Como se siente hoy despues de su {{case_type}}?',
     null, null),

    (qualified_id, 3, 'Objection-killer · Day 2–3', 2880,
     'Hi {{first_name}}, if calling during work is hard, text a time that works or reply here when you are free. No need to step out for a call.',
     'Hola {{first_name}}, si llamarnos en el trabajo es dificil, escriba una hora que le sirva o responda aqui cuando este libre. No hace falta salir a llamar.',
     null, null),

    (qualified_id, 4, 'Low-friction ask · Day 4–5', 5760,
     'Hi {{first_name}}, do you still need help with your {{case_type}}? Reply YES and we will follow up. No phone call required.',
     'Hola {{first_name}}, todavia necesita ayuda con su {{case_type}}? Responda SI y le damos seguimiento. No hace falta una llamada.',
     null, null),

    (qualified_id, 5, 'Stakes-lowering · Day 6–8', 8640,
     'Hi {{first_name}}, even if you are not ready to hire anyone, we can look at your {{case_type}} and at least point you in the right direction.',
     'Hola {{first_name}}, aunque no este listo para contratar a nadie, podemos revisar su {{case_type}} y al menos orientarle.',
     null, null),

    (qualified_id, 6, 'Credibility · Day 8–10', 11520,
     'Hi {{first_name}}, {{firm_name}} handles injury cases like yours on a contingency fee - you do not pay us unless we recover for you.',
     'Hola {{first_name}}, {{firm_name}} lleva casos de lesiones como el suyo a porcentaje: no nos paga a menos que recuperemos para usted.',
     null, null),

    (qualified_id, 7, 'Urgency / loss · Day 12–14', 17280,
     'Hi {{first_name}}, this is our last message about your {{case_type}}. Texas filing deadlines do not wait, and we will close your file if we do not hear back. Reply here if you still want help.',
     'Hola {{first_name}}, este es nuestro ultimo mensaje sobre su {{case_type}}. Los plazos en Texas no esperan, y cerraremos su archivo si no tenemos noticias. Responda aqui si todavia quiere ayuda.',
     null, null);
  end if;

  if referral_id is not null then
    delete from followup_steps where sequence_id = referral_id;

    insert into followup_steps (
      sequence_id, position, label, delay_minutes,
      body_en, body_es, body_en_night, body_es_night
    ) values
    (referral_id, 1, 'Instant confirm', 0,
     'Hi {{first_name}}, thank you for contacting {{firm_name}} about your {{case_type}}. We are referring you out. Please save this number.',
     'Hola {{first_name}}, gracias por contactarnos sobre su {{case_type}}. Lo referimos a otro abogado. Guarde este numero.',
     'Hi {{first_name}}, {{firm_name}} got your {{case_type}} tonight. We will refer you out in the morning. Please save this number.',
     'Hola {{first_name}}, gracias por escribirnos esta noche sobre su {{case_type}}. Lo referimos mañana. Guarde este numero.'),

    (referral_id, 2, 'Empathy check-in · Day 1–2', 1440,
     'Hi {{first_name}}, how are you feeling today? We are lining up the right lawyer for your {{case_type}} and wanted to check in.',
     'Hola {{first_name}}, como se siente hoy? Estamos buscando el abogado adecuado para su {{case_type}} y queriamos saber de usted.',
     null, null),

    (referral_id, 3, 'Objection-killer · Day 2–3', 2880,
     'Hi {{first_name}}, if calling during work is hard, reply with a time you are free or text us here. We can pass that to the lawyer we are referring you to.',
     'Hola {{first_name}}, si llamarnos en el trabajo es dificil, escriba una hora libre o responda aqui. Se lo pasamos al abogado a quien lo referimos.',
     null, null),

    (referral_id, 4, 'Low-friction ask · Day 4–5', 5760,
     'Hi {{first_name}}, do you still want us to connect you with a lawyer for your {{case_type}}? Reply YES and we will keep it moving. No phone call required.',
     'Hola {{first_name}}, todavia quiere que lo conectemos con un abogado para su {{case_type}}? Responda SI y lo seguimos. No hace falta una llamada.',
     null, null),

    (referral_id, 5, 'Stakes-lowering · Day 6–8', 8640,
     'Hi {{first_name}}, even if you are not sure yet, we can still point you toward the right lawyer for your {{case_type}} so you are not starting from scratch.',
     'Hola {{first_name}}, aunque no este seguro todavia, podemos orientarle al abogado adecuado para su {{case_type}} para que no empiece de cero.',
     null, null),

    (referral_id, 6, 'Credibility · Day 8–10', 11520,
     'Hi {{first_name}}, we refer {{case_type}} cases to lawyers we know handle this kind of work. You are not being passed to a stranger from a list.',
     'Hola {{first_name}}, referimos casos de {{case_type}} a abogados que conocemos y que llevan este tipo de trabajo. No lo estamos pasando a un desconocido de una lista.',
     null, null),

    (referral_id, 7, 'Urgency / loss · Day 12–14', 17280,
     'Hi {{first_name}}, last note from us about your {{case_type}}. We will close this referral if we do not hear back. Reply here if you still want us to connect you.',
     'Hola {{first_name}}, ultimo mensaje sobre su {{case_type}}. Cerraremos esta referencia si no tenemos noticias. Responda aqui si todavia quiere que lo conectemos.',
     null, null);
  end if;
end;
$$;
