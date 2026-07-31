-- A starting six-touch sequence for a new personal injury lead who filled in a
-- form or called once and then went quiet.
--
-- Safe to re-run: it does nothing if a sequence with this slug already exists,
-- so edits made in the admin area survive.
--
-- The copy is a starting point, not legal advice. Read it with whoever signs off
-- on client communications before switching the sequence on. In particular:
--   * it never promises an outcome, quotes a value, or gives legal advice
--   * it identifies the firm in the first text, which is what makes it a
--     recognised sender rather than a cold text
--   * the cadence front-loads the first 48 hours, when a signed-up lead is most
--     reachable, then backs off rather than nagging

do $$
declare
  seq_id uuid;
  firm text := 'the firm';  -- replace, or set FIRM_NAME and use {{firm_name}}
begin
  if exists (select 1 from public.followup_sequences where slug = 'new-lead') then
    raise notice 'The new-lead sequence already exists; leaving it untouched.';
    return;
  end if;

  insert into public.followup_sequences (
    slug, name, description, is_active, is_default,
    timezone, quiet_hours_start, quiet_hours_end, send_days, append_opt_out_notice
  ) values (
    'new-lead',
    'New lead follow-up',
    'For a new injury lead who contacted us once and has not answered since.',
    false,  -- switch it on from the admin area once the copy has been reviewed
    true,
    'America/Chicago',
    9,      -- 9am rather than the legal 8am: a 9am text reads better than a 8:01am one
    19,     -- 7pm, comfortably inside the federal 8pm-to-9pm limits
    '{1,2,3,4,5,6}'::smallint[],  -- weekdays and Saturday, no Sunday
    true
  ) returning id into seq_id;

  insert into public.followup_steps (sequence_id, position, label, delay_minutes, body_en, body_es) values
  (seq_id, 1, 'Right away', 0,
   format('Hi {{first_name}}, this is %s. We got your message about your accident and want to help. Is now a good time to talk?', firm),
   format('Hola {{first_name}}, le escribimos de %s. Recibimos su mensaje sobre su accidente y queremos ayudarle. ¿Es buen momento para hablar?', firm)),

  (seq_id, 2, 'Same day, a few hours later', 240,
   'Hi {{first_name}}, we tried reaching you earlier about your accident. Just reply here and we will call you back whenever works.',
   'Hola {{first_name}}, intentamos comunicarnos con usted sobre su accidente. Responda aqui y le llamamos cuando le sea conveniente.'),

  (seq_id, 3, 'Next morning', 1440,
   'Good morning {{first_name}}. We are still holding your file open. If you would rather we stopped calling, just say so and we will note it.',
   'Buenos dias {{first_name}}. Su caso sigue abierto con nosotros. Si prefiere que no le llamemos mas, digalo y lo anotamos.'),

  (seq_id, 4, 'Day three', 4320,
   'Hi {{first_name}}, a quick note: injury claims in Texas have filing deadlines, and evidence gets harder to gather as time passes. We can walk you through where yours stands, at no cost.',
   'Hola {{first_name}}: los reclamos por lesiones en Texas tienen plazos legales, y la evidencia es mas dificil de conseguir con el tiempo. Podemos explicarle como esta el suyo, sin costo.'),

  (seq_id, 5, 'End of the first week', 10080,
   'Hi {{first_name}}, checking in one more time about your accident. If you have already hired someone else, no problem at all, just let us know and we will close the file.',
   'Hola {{first_name}}, le escribimos una vez mas sobre su accidente. Si ya contrato a otro abogado, no hay problema, solo diganos y cerramos el archivo.'),

  (seq_id, 6, 'Final', 20160,
   'Hi {{first_name}}, this is our last message. Your file stays open if you want to pick it back up. Call or text us any time.',
   'Hola {{first_name}}, este es nuestro ultimo mensaje. Su archivo queda abierto por si desea retomarlo. Puede llamarnos o escribirnos cuando quiera.');

  raise notice 'Created the new-lead sequence with 6 texts. It is switched OFF until you review the copy and set the sending number.';
end;
$$;
