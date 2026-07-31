-- A starting six-touch sequence for a new personal injury lead who called or
-- filled in a form once and then went quiet.
--
-- Created switched OFF. Nobody can start a series on it until somebody reviews
-- the copy, picks a Quo number, and turns it on. The wording is a starting point,
-- not legal advice: read it with whoever signs off on client communications.
--
-- It never promises an outcome or gives advice, it identifies the firm in the
-- first text, and the cadence front-loads the first 48 hours — when a lead is
-- most reachable — then backs off instead of nagging.

do $$
declare
  seq_id uuid;
begin
  if exists (select 1 from followup_sequences where slug = 'new-lead') then
    return;
  end if;

  insert into followup_sequences (
    slug, name, description, is_active, is_default,
    timezone, quiet_hours_start, quiet_hours_end, send_days, append_opt_out_notice
  ) values (
    'new-lead',
    'New lead follow-up',
    'For a new injury lead who contacted us once and has not answered since.',
    false,
    true,
    'America/Chicago',
    9,   -- 9am rather than the legal 8am: a 9am text reads better than an 8:01am one
    19,  -- 7pm, comfortably inside the federal limits
    '{1,2,3,4,5,6}'::smallint[],
    true
  ) returning id into seq_id;

  insert into followup_steps (sequence_id, position, label, delay_minutes, body_en, body_es) values
  (seq_id, 1, 'Right away', 0,
   'Hi {{first_name}}, this is {{firm_name}}. We got your message about your accident and want to help. Is now a good time to talk?',
   'Hola {{first_name}}, le escribimos de {{firm_name}}. Recibimos su mensaje sobre su accidente y queremos ayudarle. ¿Es buen momento para hablar?'),

  (seq_id, 2, 'Same day, later', 240,
   'Hi {{first_name}}, we tried reaching you earlier about your accident. Just reply here and we will call you back whenever works.',
   'Hola {{first_name}}, intentamos comunicarnos con usted sobre su accidente. Responda aqui y le llamamos cuando le sea conveniente.'),

  (seq_id, 3, 'Next morning', 1440,
   'Good morning {{first_name}}. We are still holding your file open. If you would rather we stopped calling, just say so and we will note it.',
   'Buenos dias {{first_name}}. Su caso sigue abierto con nosotros. Si prefiere que no le llamemos mas, digalo y lo anotamos.'),

  (seq_id, 4, 'Day three', 4320,
   'Hi {{first_name}}, a quick note: injury claims in Texas have filing deadlines, and evidence gets harder to gather as time passes. We can walk you through where yours stands, at no cost.',
   'Hola {{first_name}}: los reclamos por lesiones en Texas tienen plazos legales, y la evidencia es mas dificil de conseguir con el tiempo. Podemos explicarle como esta el suyo, sin costo.'),

  (seq_id, 5, 'End of week one', 10080,
   'Hi {{first_name}}, checking in one more time about your accident. If you have already hired someone else, no problem at all, just let us know and we will close the file.',
   'Hola {{first_name}}, le escribimos una vez mas sobre su accidente. Si ya contrato a otro abogado, no hay problema, solo diganos y cerramos el archivo.'),

  (seq_id, 6, 'Final', 20160,
   'Hi {{first_name}}, this is our last message. Your file stays open if you want to pick it back up. Call or text us any time.',
   'Hola {{first_name}}, este es nuestro ultimo mensaje. Su archivo queda abierto por si desea retomarlo. Puede llamarnos o escribirnos cuando quiera.');
end;
$$;
