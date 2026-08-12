-- Quo delivered a message.received whose `from` was "@04961199404" — not a phone
-- number at all. followup_normalize_phone stripped the "@", saw eleven digits,
-- and returned "+04961199404". The contacts table then refused it, because its
-- own check requires the first digit to be 1-9:
--
--   check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$')
--
-- So the function was producing values the table would not accept. The insert
-- raised, the webhook answered 500, and after enough of those Quo disabled the
-- webhook — taking every reply with it.
--
-- The fix is to make the function agree with the constraint, which turns an
-- unusable value into a clean "invalid_phone" the caller already handles.
create or replace function followup_normalize_phone(raw text)
returns text language plpgsql immutable as $$
declare
  digits text;
  candidate text;
begin
  if raw is null then return null; end if;

  if left(btrim(raw), 1) = '+' then
    digits := regexp_replace(btrim(raw), '[^0-9]', '', 'g');
    candidate := '+' || digits;
  else
    digits := regexp_replace(raw, '[^0-9]', '', 'g');
    if char_length(digits) = 10 then
      candidate := '+1' || digits;
    elsif char_length(digits) between 11 and 15 then
      candidate := '+' || digits;
    else
      return null;
    end if;
  end if;

  -- One gate, and it is exactly the constraint the column carries. Anything that
  -- would be rejected on insert is rejected here instead, where the caller turns
  -- it into a 200 and a logged reason.
  if candidate ~ '^\+[1-9][0-9]{7,14}$' then return candidate; end if;
  return null;
end;
$$;
