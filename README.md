# Client follow-up texts

Automated text follow-ups for a personal injury intake team. Started and stopped
from Slack, sent through [Quo](https://www.quo.com) (formerly OpenPhone), managed
from a web dashboard, deployed on Railway.

A client contacts the firm, nobody can reach them again, and the file goes cold.
This puts them on a pre-written schedule of texts in English or Spanish and stops
the moment they re-engage — a reply, a call back, or a text saying STOP.

**Slack is the system of record.** There is no case management system to
integrate with: the number, the language, who owns the client and the reference
are all captured when the series starts, and the whole history lives in the
dashboard.

## How a paralegal starts one

Three ways, all in Slack:

| Where | How |
| --- | --- |
| **Any message** | Hover it → `⋯` → **Start follow-up texts**. The client's number is read out of the message and the form opens with it filled in. |
| **Inside a thread** | `@Follow-ups start 512-555-0123 es Maria` — or leave the number out if it is already in the message that started the thread. |
| **Slash command** | `/followup` opens the form; `/followup start 512-555-0123` skips it. |

Started from a message or a thread, **every later update about that client posts
back into that same thread** — the reply, the stop, the "no answer after six
texts". Intake conversations stay in one place instead of scattering down the
channel.

## How a series ends

This matters more than how it starts, so it is enforced in the database rather
than in application code, and every path ends up in the same place:

| What happens | Result |
| --- | --- |
| The client texts anything back | Series stops, the thread is told, with the message quoted |
| The client calls the office | Series stops (needs Quo call webhooks switched on) |
| The client texts STOP, ALTO, CANCEL… | Series stops **and** the number is opted out of every sequence |
| The client texts START after opting out | The number can be texted again |
| The assigned paralegal hits Stop in Slack | Series stops |
| An administrator hits Stop in the dashboard | Series stops |
| Every text has gone out with no reply | Series finishes, the thread is told |
| Quo rejects the number three times | Series stops and the assigned paralegal is told to try calling |

Only the assigned person, or a supervisor, can stop a series from Slack. An
opt-out is permanent until the client themselves texts START — staff can honour
an opt-out from the dashboard but cannot undo one.

## Deploying on Railway

1. **Add a Postgres service.** Railway sets `DATABASE_URL` for you. Migrations
   run automatically on every boot.
2. **Deploy this repository.** It builds from the `Dockerfile` — explicit and
   identical every time, rather than letting nixpacks infer it. Delete the
   Dockerfile to fall back to nixpacks.

   **No environment variable is needed to build.** The build is `npm ci` plus
   `vite build`, and neither reads any. Everything below is read at run time, and
   the app boots half-configured on purpose, printing exactly what is still
   missing in the deploy log.
3. **Set the environment variables** — see `.env.example`, or the Help page in
   the running app, which lists every one with an explanation. At minimum:
   `QUO_API_KEY`, `SLACK_SIGNING_SECRET`, `SLACK_BOT_TOKEN`,
   `QUO_WEBHOOK_SECRET`, `PUBLIC_URL`, and `ADMIN_PASSWORD` so you can get in.
4. **Create a Google OAuth client.** Google Cloud console → APIs & Services →
   Credentials → OAuth client ID → Web application, with the authorised redirect
   URI `PUBLIC_URL/auth/google/callback`. Put the ID and secret in the
   environment.
5. **Sign in** with that password and add yourself under **Access** using your
   work email, with dashboard access ticked. From then on everyone signs in with
   Google, and you can drop `ADMIN_PASSWORD` entirely.
6. **Refresh your Quo numbers** under Settings, then pick which one each sequence
   sends from.
7. **Point Slack at your URL:**
   - Slash command `/followup` → `PUBLIC_URL/slack/commands`
   - Interactivity → `PUBLIC_URL/slack/interactivity`
   - Event Subscriptions → `PUBLIC_URL/slack/events`, subscribed to `app_mention`
   - A message shortcut with callback ID **`start_followups`**
   - Bot scopes: `commands`, `chat:write`, `chat:write.public`,
     `app_mentions:read`, `channels:history`, `users:read`
8. **Set up the Quo webhook.** Quo has no webhook screen in its app — webhooks
   are created through the API, and the signing secret only ever appears in the
   create response. So there is a script:

   ```bash
   QUO_API_KEY=... PUBLIC_URL=https://your-app.up.railway.app npm run webhook setup
   ```

   It registers `PUBLIC_URL/webhooks/quo` for messages and calls, removes any
   earlier attempt so replies are not delivered twice, and prints the
   `QUO_WEBHOOK_SECRET` to paste into Railway. Redeploy, then prove it:

   ```bash
   npm run webhook test
   ```

   That sends a properly signed request your app is built to ignore, so a green
   tick means the secret matches without creating a contact or posting to Slack.
   `npm run webhook list` shows what is registered.
9. **Review the starter sequence and switch it on.** It ships switched off.

Nothing sends until step 9 — the dispatcher runs inside the same process, so
there is no cron to configure.

## Who can get in

One list, under **Access**, controls both things:

| Identity | What it grants |
| --- | --- |
| **Email address** + dashboard access | Signing in here with Google |
| **Slack member ID** | Starting and stopping follow-ups from Slack |
| **Supervisor** | Stopping anyone's series, and seeing everyone's `/followup list` |

A person can have either identity or both, so the office manager who never
touches Slack gets an email only, and a paralegal who never needs the dashboard
gets a Slack ID only.

Google sign-in proves who somebody is; the Access list decides whether they are
allowed in. An account that is not on the list is refused whatever domain it is
on. Set `GOOGLE_HOSTED_DOMAIN` to reject anything outside your Workspace before
the list is even consulted.

Permissions are read from the person's current row on **every request**, so
switching off Active or Dashboard access ends their session on the next click
rather than whenever their cookie expires. The system refuses to remove the last
account that can sign in.

`ADMIN_PASSWORD` is a break-glass for the first sign-in and for when an identity
provider is misconfigured — remove it once Google sign-in works.

## Configuration lives in the app, not the environment

Only secrets are environment variables. Everything the firm might want to change
is in the database and editable under **Settings**, taking effect within one
dispatch cycle:

firm name · default timezone · default Quo number · fallback Slack channel ·
whether Slack shows full phone numbers · whether we send our own STOP
confirmation · texts per run · seconds between runs · attempts before giving up ·
minutes between retries.

Per sequence: which Quo number it sends from, its timezone, its sending window,
which days it may send, and whether the opt-out line is appended.

## Writing the message copy

Every text carries an English **and** a Spanish body. The language is chosen per
client when the series starts, so a sequence never has to be duplicated and the
two versions cannot drift apart.

Merge fields: `{{first_name}}`, `{{last_name}}`, `{{full_name}}`,
`{{case_reference}}`, `{{assigned_user}}`, `{{firm_name}}`. A missing English
name falls back to "there"; in Spanish, which has no neutral equivalent, the
greeting closes up instead, so `Hola {{first_name}},` becomes `Hola,`.

The editor shows exactly what will be sent, including the appended opt-out line,
and counts SMS segments live. Watch that count on Spanish copy: `é` and `ñ` are
in the GSM-7 character set but `á`, `í`, `ó` and `ú` are not, and one of them
drops a message to UCS-2, cutting the per-segment budget from 160 characters to
70. The starter copy is written to stay inside GSM-7.

## Sending windows

Each sequence has a timezone, an earliest and latest hour, and the days it may
send. A text that comes due outside the window waits for the next opening rather
than being skipped, so a series started at 11pm sends its first text the
following morning.

The window is evaluated in the **client's** local time, because that is what both
the federal TCPA rules and the Texas Business & Commerce Code measure against.
The defaults are 9am to 7pm, weekdays and Saturday — deliberately tighter than
the legal 8am–9pm.

Delays are measured from when the series started, not from the previous text, so
editing the timing of text 2 never shifts text 3.

## Layout

```
server/           Express app: Slack routes, Quo webhook, JSON API, dispatcher
server/migrations Schema and the state-machine functions; run on every boot
shared/           Message rendering, keywords and segment counting
src/              The React dashboard
tests/            Unit, database and end-to-end suites
```

State transitions live in Postgres functions rather than in the Node layer, so
"stop this series" is one atomic statement no matter what triggered it — a Slack
button, a reply, a call back, or the dashboard. Due texts are claimed with
`FOR UPDATE SKIP LOCKED` and a five-minute lock, so overlapping dispatch cycles
cannot send the same text twice.

## Tests

```bash
npm test                                   # message rendering, keywords, segments, phone parsing
DATABASE_URL=…scratch… npm run test:db     # the state machine, ~108 checks
TEST_DATABASE_URL=…scratch… ./tests/e2e/run.sh   # the whole system against a stubbed Quo
```

The database and end-to-end suites drop and write real rows — point them at a
scratch database, never at production. Between them they cover enrollment, the
quiet-hours arithmetic, the claim-and-lock that prevents double-sends, every way
a series can end, the assignment rule, opt-out stickiness, retry limits, webhook
replay, Slack signature verification, and the dashboard's numbers.

## Things worth knowing

**A2P 10DLC.** US carriers require the sending number to be registered to the
firm's brand and campaign, or messages get filtered silently — delivered as far
as the API is concerned but never arriving. Register through Quo before relying
on this. The "Texts that never arrived" figure on the dashboard is how you will
notice.

**Consent.** This assumes the client contacted the firm first, which is what
makes the follow-ups a reply rather than a cold text. It does not verify that,
and it should not be pointed at a purchased list.

**One series per number.** A second start for a number that already has one
running is refused, and says who owns it. Two people covering the same lead
cannot double-text the client.

**Keyword matching is whole-message only.** "Please stop by the office tomorrow"
is a reply, not an opt-out. Silently unsubscribing a client who was actually
re-engaging would be the worst thing this system could do, so only a message that
is exactly `stop` counts.

**`npm audit` reports one high advisory, and that is the best available.** It is
a CSRF bypass in React Router's **RSC mode** (GHSA-qwww-vcr4-c8h2). This app is a
plain client-side SPA — `BrowserRouter` with element routes, no RSC, no data
router, no server actions — so the vulnerable path is not reachable. Do not
"fix" it by downgrading: every version below 7.18 sits inside a much larger
advisory range with fourteen further CVEs, several of which *are* reachable here.
Staying on the latest 7.x is the safer position; re-check when 8.3 ships.

**Privacy.** Slack shows only the last four digits of a number by default, since
intake channels tend to be wide. The dashboard requires being on the operator
list with dashboard access, checked server-side on every request.
