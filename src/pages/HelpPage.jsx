import { ChevronDown } from "lucide-react";
import { useState } from "react";
import AppNav from "../components/AppNav";

const FAQ = [
  {
    q: "How does a paralegal actually start follow-ups?",
    a: [
      "Three ways, all in Slack. From any message — hover it, open the ⋯ menu, choose “Start follow-up texts”. The client's number is read out of the message and the form opens with it filled in.",
      "Inside a thread — “@Follow-ups start 512-555-0123 es Maria”. If the number is already in the message that started the thread, you can leave it out.",
      "Or the slash command — “/followup” on its own opens the form, and “/followup start 512-555-0123” skips it.",
    ],
  },
  {
    q: "Why do updates land in a thread?",
    a: [
      "Because intake conversations already happen in threads. When a series starts from a message or a thread, every later update about that client — the reply, the stop, the “no answer after six texts” — posts back into that same thread instead of scattering down the channel.",
      "A series started with the slash command has no thread to attach to, so its own confirmation message becomes the thread that later updates hang off.",
    ],
  },
  {
    q: "What stops a series?",
    a: [
      "The client replying to a text. The client calling the office. The client texting STOP, ALTO, CANCEL or any of the other opt-out words. The assigned paralegal hitting Stop in Slack. An administrator hitting Stop here. Or the sequence simply running out of texts.",
      "Anything the client does stops it immediately — that is the whole point of the system. Nobody who has already re-engaged should keep getting drip texts.",
    ],
  },
  {
    q: "Who can stop a series?",
    a: [
      "The person it is assigned to, or anybody marked as a supervisor. This is enforced in the database, not just hidden in the interface, so there is no way around it from Slack.",
      "Administrators can always stop any series from the Activity page here. That is the deliberate override for when somebody is on holiday.",
    ],
  },
  {
    q: "What happens if somebody texts STOP?",
    a: [
      "The number is opted out of every sequence, not just the one it was in, and any running series stops. A confirmation text goes back to them (you can switch that off under Settings if your carrier already sends one).",
      "The opt-out is permanent until the client texts START themselves. Staff can opt somebody out from the Contacts page but cannot opt anybody back in — that consent has to come from the client.",
    ],
  },
  {
    q: "Could a normal reply be mistaken for an opt-out?",
    a: [
      "No. Opt-out words are matched against the whole message, never as a fragment. “Please stop by the office tomorrow” is a reply, not an opt-out; only a message that is exactly “stop” counts.",
      "This is deliberate and tested: silently unsubscribing a client who was actually re-engaging would be the worst thing this system could do.",
    ],
  },
  {
    q: "Why are my texts sending but not arriving?",
    a: [
      "Almost always A2P 10DLC registration. US carriers require the sending number to be registered to your firm's brand and campaign. An unregistered number gets filtered silently — the API reports success and the message never lands.",
      "Register through Quo before relying on this. The “Texts that never arrived” number on the dashboard, and the delivery status on each message in Activity, are how you will notice.",
    ],
  },
  {
    q: "Why is my Spanish message suddenly two texts?",
    a: [
      "Accented characters. The GSM-7 character set that lets a text be 160 characters includes é, è, ñ and ü, but not á, í, ó or ú. A single “está” or “último” drops the whole message to a different encoding where the limit is 70 characters.",
      "The editor shows the encoding and segment count live under every message, and warns when a message will bill as more than one. Rewriting to avoid one accented word often halves the cost.",
    ],
  },
  {
    q: "When do texts go out?",
    a: [
      "Only inside each sequence's sending window, measured in the client's local time — that is what both the federal TCPA rules and the Texas Business & Commerce Code key off. The default is 9am to 7pm on weekdays and Saturday, deliberately tighter than the legal 8am–9pm.",
      "A text that comes due outside the window waits for the next opening rather than being skipped. A series started at 11pm sends its first text the following morning.",
    ],
  },
  {
    q: "If I edit a sequence, what happens to series already running?",
    a: [
      "They pick up the change from their next text onwards. Timings are measured from when each series started, so editing text 2 never shifts text 3.",
      "Switching a sequence off holds every series running on it — nothing further goes out until you switch it back on. That is the safest thing to reach for if something looks wrong.",
    ],
  },
  {
    q: "Can two people start follow-ups for the same client?",
    a: [
      "No. A second start for a number that already has a running series is refused, and tells you who it is assigned to. Two people covering the same lead cannot double-text the client.",
    ],
  },
  {
    q: "What if the client's number is a landline?",
    a: [
      "Quo rejects it and the system retries a couple of times before giving up, marking the series as failed and telling the assigned paralegal in Slack to try calling instead. How many attempts, and how far apart, is under Settings.",
    ],
  },
  {
    q: "Who can sign in to this dashboard?",
    a: [
      "Only the people on the Access list, and only those with dashboard access ticked. Signing in with Google proves who somebody is; the Access list decides whether that person is allowed in. A Google account that is not on the list is refused, whatever domain it is on.",
      "The list is matched on email address, so it has to be the address they sign in to Google with. Somebody can also be given a Slack member ID, which is what lets them start follow-ups from Slack — the two are separate, and a person can have either or both.",
      "Turning off Active or Dashboard access ends that person's session on their next click, rather than waiting for their cookie to expire. The system will not let you remove the last account that can sign in.",
    ],
  },
  {
    q: "How do I set up the Quo webhook, and how do I know it works?",
    a: [
      "Quo has no webhook screen in its app — webhooks are created through its API, and the signing secret only appears in the response when you create one. Run `npm run webhook setup` with QUO_API_KEY and PUBLIC_URL set. It registers this app's endpoint for both messages and calls, deletes any earlier attempt so replies are not delivered twice, and prints the QUO_WEBHOOK_SECRET to put into Railway.",
      "After redeploying, `npm run webhook test` sends a properly signed request of a type this app ignores. A green tick means the secret matches, and because the event is ignored it creates no contact, stops no series and posts nothing to Slack. Then text the Quo number from a real phone and watch it appear under Activity.",
      "`npm run webhook list` shows what is currently registered, which is the first thing to check if replies stop arriving.",
    ],
  },
  {
    q: "Could we poll the API for replies instead of using the webhook?",
    a: [
      "Only partly, and it is not recommended as a replacement. Quo's list-messages endpoint returns one conversation at a time, so polling costs one API call per active client per cycle — the busier intake gets, the closer you sit to the rate limit.",
      "It also cannot cheaply see call-backs, which is one of the ways a series is meant to stop, and it gives you no delivery receipts, which is how landlines and filtered messages are spotted.",
      "Polling does make sense as a safety net rather than a replacement, because webhooks can fail silently. Message ingest is already idempotent, so re-reading the same message is harmless.",
    ],
  },
  {
    q: "What is the administrator password for?",
    a: [
      "Getting in the first time, before anybody is on the Access list, and getting back in if Google sign-in breaks. It is a break-glass, not a normal way in.",
      "Once you have added yourself with your work email and dashboard access, you can remove ADMIN_PASSWORD from the environment entirely.",
    ],
  },
  {
    q: "Does this need a case management system?",
    a: [
      "No. Slack is the system of record. The number, the language, who owns the client and the reference are all captured when the series starts, and the whole history stays in the Activity page here.",
    ],
  },
  {
    q: "Is it safe to text a client we have not spoken to?",
    a: [
      "This system assumes the client contacted the firm first, which is what makes a follow-up a reply rather than a cold text. It does not verify that, and it should not be pointed at a purchased list.",
    ],
  },
];

const ENV = [
  {
    group: "Required",
    vars: [
      ["DATABASE_URL", "Railway sets this automatically when you attach a Postgres service. Do not set it by hand."],
      ["QUO_API_KEY", "Quo workspace settings → API. Needs Owner or Admin permissions. Without it nothing sends."],
      ["SLACK_SIGNING_SECRET", "Slack app → Basic Information → App Credentials. Verifies every request Slack sends; without it all Slack requests are rejected."],
      ["SLACK_BOT_TOKEN", "Slack app → OAuth & Permissions, starts xoxb-. Needed for the start form, thread replies and notifications."],
      ["QUO_WEBHOOK_SECRET", "Given to you when you create the webhook in Quo. Verifies that inbound replies really came from Quo."],
      ["PUBLIC_URL", "Your Railway URL, e.g. https://followups.up.railway.app. Used to build the Slack sign-in redirect."],
    ],
  },
  {
    group: "Sign-in",
    vars: [
      ["GOOGLE_CLIENT_ID", "Google Cloud console → APIs & Services → Credentials → OAuth client ID (Web application). Enables “Continue with Google”."],
      ["GOOGLE_CLIENT_SECRET", "Same credential as the client ID."],
      ["GOOGLE_HOSTED_DOMAIN", "Optional. A Workspace domain such as yourfirm.com. Accounts outside it are refused before the access list is even checked."],
      ["ADMIN_PASSWORD", "A password for getting in the first time, before anybody is on the access list. Set a long random one, and remove it once Google sign-in works."],
      ["SLACK_CLIENT_ID", "Optional. Slack app → Basic Information. Enables “Continue with Slack” as well."],
      ["SLACK_CLIENT_SECRET", "Same page as the Slack client ID."],
      ["SLACK_TEAM_ID", "Optional. Pins Slack sign-in to one workspace."],
    ],
  },
  {
    group: "Optional",
    vars: [
      ["QUO_API_BASE", "Defaults to https://api.quo.com/v1. Set to https://api.openphone.com/v1 if your account has not been migrated from OpenPhone."],
      ["QUO_WEBHOOK_TOKEN", "An alternative to the signing secret: a shared value passed as ?token= on the webhook URL. Use it only if signature verification will not work."],
      ["SLACK_WEBHOOK_URL", "An incoming-webhook fallback for notifications if you have no bot token. It cannot post into threads."],
      ["NODE_ENV", "Leave unset. Session cookies are already marked Secure whenever PUBLIC_URL is https. Setting it to production on Railway applies at build time too, where it can make npm skip the dev dependencies the front-end build needs."],
      ["PGSSLMODE", "Set to disable only if your Postgres does not use TLS."],
    ],
  },
];

const SETUP = [
  ["Add a Postgres service in Railway", "It sets DATABASE_URL for you. Migrations run automatically every time the app boots."],
  ["Deploy this repository", "Railway detects Node, runs npm run build, then npm start."],
  ["Set the environment variables", "At minimum the Required group below, plus ADMIN_PASSWORD so you can get in."],
  ["Create a Google OAuth client", "Google Cloud console → Credentials → OAuth client ID → Web application. Authorised redirect URI: PUBLIC_URL/auth/google/callback. Put the ID and secret in the environment."],
  ["Sign in with the password and add yourself under Access", "Use your work email and tick dashboard access, then you can sign in with Google from then on."],
  ["Refresh your Quo numbers under Settings", "Then pick which one each sequence sends from."],
  ["Point Slack at your URL", "Slash command and Interactivity → PUBLIC_URL/slack/commands and /slack/interactivity. Event Subscriptions → /slack/events, subscribed to app_mention. Add a message shortcut with callback ID start_followups."],
  ["Set up the Quo webhook", "Quo has no webhook screen — run `npm run webhook setup` with QUO_API_KEY and PUBLIC_URL set. It registers the endpoint and prints QUO_WEBHOOK_SECRET. Put that in Railway, redeploy, then `npm run webhook test` to prove it."],
  ["Review the starter sequence and switch it on", "It ships switched off on purpose."],
];

function Question({ item, open, onToggle }) {
  return (
    <div className={`faq-item ${open ? "open" : ""}`}>
      <button type="button" onClick={onToggle}>
        <span>{item.q}</span>
        <ChevronDown size={16} />
      </button>
      {open && <div className="faq-answer">{item.a.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}</div>}
    </div>
  );
}

export default function HelpPage() {
  const [open, setOpen] = useState(0);

  return (
    <main className="page">
      <div className="shell">
        <AppNav />

        <header className="page-heading">
          <div>
            <p className="eyebrow">Reference</p>
            <h1>Help</h1>
            <p>How the system behaves, and everything it needs configured.</p>
          </div>
        </header>

        <section className="panel">
          <header className="panel-head"><div><h2>Common questions</h2></div></header>
          <div className="faq">
            {FAQ.map((item, index) => (
              <Question
                key={item.q}
                item={item}
                open={open === index}
                onToggle={() => setOpen(open === index ? -1 : index)}
              />
            ))}
          </div>
        </section>

        <section className="panel">
          <header className="panel-head">
            <div>
              <h2>Deploying on Railway</h2>
              <p>In order. Each step is quick.</p>
            </div>
          </header>
          <ol className="setup-list">
            {SETUP.map(([title, detail]) => (
              <li key={title}><strong>{title}</strong><span>{detail}</span></li>
            ))}
          </ol>
        </section>

        <section className="panel">
          <header className="panel-head">
            <div>
              <h2>Environment variables</h2>
              <p>
                Set these in Railway under your service's Variables tab. Everything else is
                configured in the app itself — only secrets belong here.
              </p>
            </div>
          </header>

          {ENV.map((section) => (
            <div key={section.group} className="env-group">
              <h3>{section.group}</h3>
              <div className="table-wrap">
                <table className="data-table">
                  <thead><tr><th>Variable</th><th>What it is</th></tr></thead>
                  <tbody>
                    {section.vars.map(([name, detail]) => (
                      <tr key={name}>
                        <td><code>{name}</code></td>
                        <td>{detail}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </section>

        <section className="panel">
          <header className="panel-head">
            <div>
              <h2>Slack app scopes</h2>
              <p>Under OAuth &amp; Permissions → Bot Token Scopes.</p>
            </div>
          </header>
          <div className="table-wrap">
            <table className="data-table">
              <thead><tr><th>Scope</th><th>Why</th></tr></thead>
              <tbody>
                <tr><td><code>commands</code></td><td>The /followup slash command and the message shortcut</td></tr>
                <tr><td><code>chat:write</code></td><td>Posting confirmations and replies into threads</td></tr>
                <tr><td><code>chat:write.public</code></td><td>Posting in channels the app has not been invited to</td></tr>
                <tr><td><code>app_mentions:read</code></td><td>Starting a series by mentioning the app in a thread</td></tr>
                <tr><td><code>channels:history</code></td><td>Reading the parent message of a thread to find the client's number</td></tr>
                <tr><td><code>users:read</code></td><td>Showing a real name instead of a raw Slack ID</td></tr>
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </main>
  );
}
