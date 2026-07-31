# Client follow-up texts

Automated text follow-ups for a personal injury intake team, started and stopped
from Slack and sent through [Quo](https://www.quo.com) (formerly OpenPhone).

A client contacts the firm, nobody can reach them again, and the file goes cold.
This puts them on a pre-written schedule of texts in English or Spanish, and
stops the moment they re-engage — a reply, a call back, or a text saying STOP.

- **Paralegals** live entirely in Slack. `/followup` opens a short form; the
  series announces itself in the channel with a Stop button.
- **Administrators** use this web app to write the message copy, set the
  schedule and sending window, and see every text that went out.
- **Clients** get texts only inside the hours the sequence allows, always with
  an opt-out on the first message, and never again after they opt out.

## How a series ends

This matters more than how it starts, so it is enforced in the database rather
than in application code, and every path ends up in the same place:

| What happens | Result |
| --- | --- |
| The client texts anything back | Series stops, the channel is told, with the message quoted |
| The client calls the office | Series stops (needs Quo call webhooks switched on) |
| The client texts STOP, ALTO, CANCEL… | Series stops **and** the number is opted out of all future sequences |
| The client texts START after opting out | The number can be texted again |
| The assigned paralegal hits Stop in Slack | Series stops |
| An administrator hits Stop in this app | Series stops |
| Every text has gone out with no reply | Series finishes, the channel is told |
| Quo rejects the number three times | Series stops and the assigned paralegal is told to try calling |

An opt-out is permanent until the client themselves texts START. Staff can opt
somebody out from the Contacts page but cannot opt anybody back in, because that
consent has to come from the client.

## Setup

### 1. Database

Apply the migrations in order in the Supabase SQL editor:

```
supabase/migrations/0001_followups.sql
supabase/migrations/0002_followup_functions.sql
```

Add yourself as an administrator, then load the starter sequence:

```sql
insert into public.admin_users (email) values ('you@yourfirm.com');
```

```
supabase/seed/default_sequence.sql
```

The starter sequence is six texts over two weeks in both languages, and it is
created **switched off**. Read the copy with whoever signs off on client
communications, set the sending number, then switch it on.

Enable Google under Authentication → Providers, and add your site URL plus
`http://127.0.0.1:4173/**` under Authentication → URL Configuration.

### 2. Quo

Create an API key under your Quo workspace settings (Owner or Admin only), and
note the number you want texts to come from.

Then add a webhook pointing at the `quo-webhook` function below, subscribed to
at least `message.received`. Add `message.delivered`, `message.failed` and the
`call.*` events too — delivery receipts catch landlines, and the call events are
what make a client calling back stop their series.

### 3. Slack

Create an app at api.slack.com/apps and configure:

- **Slash command** `/followup` → `https://PROJECT_REF.supabase.co/functions/v1/followups-slack`
- **Interactivity** → the same URL
- **Bot token scopes** → `commands`, `chat:write`. Add `chat:write.public` if you
  want it to post in channels it has not been invited to.

The bot token is optional. Without it the slash command still works and replies
in the channel, but the `/followup` form and the "they replied" notifications
need it.

### 4. Edge functions

Slack and Quo sign their own requests, so all three deploy without the JWT gate:

```bash
supabase functions deploy followups-slack    --no-verify-jwt
supabase functions deploy followups-dispatch --no-verify-jwt
supabase functions deploy quo-webhook        --no-verify-jwt
```

```bash
supabase secrets set \
  QUO_API_KEY=... \
  QUO_FROM_NUMBER=+15125550100 \
  QUO_WEBHOOK_SECRET=... \
  SLACK_SIGNING_SECRET=... \
  SLACK_BOT_TOKEN=xoxb-... \
  SLACK_ALERT_CHANNEL=C01234567 \
  FOLLOWUP_CRON_SECRET="$(openssl rand -hex 32)" \
  FIRM_NAME="Your Firm"
```

| Secret | Needed | What it does |
| --- | --- | --- |
| `QUO_API_KEY` | yes | Sends the texts |
| `QUO_FROM_NUMBER` | yes | Default sending number when a sequence sets none |
| `QUO_PHONE_NUMBER_ID` | no | Use instead of the number if you prefer Quo's `PN…` id |
| `QUO_API_BASE` | no | Defaults to `https://api.quo.com/v1`; set to `https://api.openphone.com/v1` on an unmigrated account |
| `QUO_WEBHOOK_SECRET` | yes | Verifies inbound webhooks |
| `QUO_WEBHOOK_TOKEN` | no | Alternative to the above: a shared secret passed as `?token=` |
| `SLACK_SIGNING_SECRET` | yes | Verifies every Slack request |
| `SLACK_BOT_TOKEN` | no | Needed for the form and for push notifications |
| `SLACK_WEBHOOK_URL` | no | Fallback for notifications if you have no bot token |
| `SLACK_ALERT_CHANNEL` | no | Where to post when there is no channel on the series |
| `SLACK_SHOW_FULL_PHONE` | no | `true` shows whole numbers in Slack instead of the last four |
| `FOLLOWUP_CRON_SECRET` | yes | Authenticates the scheduler |
| `FOLLOWUP_BATCH_SIZE` | no | Texts per run, default 25 |
| `FIRM_NAME` | no | Fills `{{firm_name}}` in message copy |
| `SEND_STOP_CONFIRMATION` | no | `false` if Quo already auto-replies to STOP |

### 5. Schedule the sender

**Nothing sends until this is done.** Edit and run `supabase/cron/dispatch.sql`,
or point any external scheduler at the same URL every five minutes:

```bash
curl -X POST https://PROJECT_REF.supabase.co/functions/v1/followups-dispatch \
  -H "x-cron-secret: $FOLLOWUP_CRON_SECRET"
```

### 6. This app

```bash
cp .env.example .env.local   # add the Supabase URL and anon key
npm install
npm run dev
```

Then add each paralegal's Slack member ID under **Operators**. Nobody can run
`/followup` until they are on that list.

## Using it

```
/followup                                  open the form
/followup start 512-555-0123 es Maria      start without the form
/followup stop 512-555-0123                stop a series you own
/followup status 512-555-0123              where a client is in their series
/followup list                             everything you have running
```

In the shorthand the order does not matter: anything shaped like a phone number
is the number, `en`/`es` sets the language, a sequence name picks the sequence,
and whatever is left over is the first name. The series is assigned to whoever
ran the command unless you `@mention` somebody else.

**Only the assigned person can stop a series** — that is the rule the firm asked
for, and it is enforced in the database, not just hidden in the UI. Operators
marked as supervisors can stop anyone's, and can see everyone's `/followup list`.
Administrators can always stop a series from the Activity page here.

## Writing the message copy

Every text carries both an English and a Spanish body. The language is chosen
per client when the series starts, so a sequence never has to be duplicated for
a second language, and the two versions cannot drift out of sync.

Available merge fields: `{{first_name}}`, `{{last_name}}`, `{{full_name}}`,
`{{case_reference}}`, `{{assigned_user}}`, `{{firm_name}}`. A missing English
name falls back to "there"; in Spanish, which has no neutral equivalent, the
greeting closes up instead, so `Hola {{first_name}},` becomes `Hola,`.

The editor shows exactly what will be sent, including the appended opt-out line,
and counts SMS segments live. Watch that count on Spanish copy: `é` and `ñ` are
in the GSM-7 character set, but `á`, `í`, `ó` and `ú` are not, and a single one
of them drops the whole message to UCS-2 and halves the per-segment budget from
160 characters to 70. The starter copy is written to stay inside GSM-7.

## Sending windows

Each sequence has a timezone, an earliest and latest hour, and the days texts may
go out. A text that comes due outside the window waits for the next opening
rather than being skipped, so a series started at 11pm sends its first text the
following morning.

The window is evaluated in the **client's** local time, because that is what both
the federal TCPA rules and the Texas Business & Commerce Code measure against.
The defaults are 9am to 7pm, weekdays and Saturday — deliberately tighter than
the legal 8am–9pm.

Delays on each step are measured from when the series started, not from the
previous text. Editing the timing of text 2 therefore never shifts text 3.

## Tests

```bash
npm test                                                    # message rendering, keywords, segments
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f supabase/tests/followups_test.sql                      # the state machine, ~100 checks
```

The database tests write real rows, so point them at a scratch database, not
production. They cover enrollment, quiet-hours arithmetic, the claim-and-lock
that stops double-sends, every way a series can end, the assignment rule, opt-out
stickiness, retry limits, and webhook replay.

The sender runs on Deno and cannot import the browser's copy of the message
rendering, so that logic exists twice. `npm test` fails if the two copies drift.

## Things worth knowing

**Consent.** This system assumes the client contacted the firm first, which is
what makes the follow-ups a reply rather than a cold text. It does not verify
that, and it should not be pointed at a purchased list.

**A2P 10DLC.** US carriers require the sending number to be registered to the
firm's brand and campaign, or messages get filtered silently — delivered as far
as the API is concerned but never arriving. Register through Quo before relying
on this. The delivery receipts in the Activity page are how you will notice.

**One series per number.** A second `/followup start` for a number that already
has one running is refused, and tells you who owns it. Two people covering the
same lead cannot double-text the client.

**Privacy.** Slack shows only the last four digits of a number by default, since
intake channels tend to be wide. Set `SLACK_SHOW_FULL_PHONE=true` to change that.
This app requires being on the `admin_users` allowlist, checked in the database,
not just in the browser.
