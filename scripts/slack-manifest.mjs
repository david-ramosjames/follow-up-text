#!/usr/bin/env node
// Prints a Slack app manifest with your URL filled in.
//
//   PUBLIC_URL=https://your-app.up.railway.app npm run slack:manifest
//
// Paste it into api.slack.com/apps -> Create New App -> From a manifest, and
// Slack creates the slash command, the message shortcut, the event
// subscriptions and the scopes in one go. On an app that already exists, the
// same YAML goes into App Manifest and replaces the configuration.
//
// The bit worth knowing: a slash command cannot be declared in code. Slack has
// to be told the command exists and where to send it, so something has to
// configure it. A manifest is the closest thing to declaring it in the repo.
import "dotenv/config";

const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/$/, "");

if (!PUBLIC_URL) {
  console.error(`
Set PUBLIC_URL to your deployed URL first:

  PUBLIC_URL=https://your-app.up.railway.app npm run slack:manifest
`);
  process.exit(1);
}

if (!PUBLIC_URL.startsWith("https://")) {
  console.error(`\nPUBLIC_URL is "${PUBLIC_URL}". Slack only calls https URLs.\n`);
  process.exit(1);
}

// socket_mode_enabled: false is deliberate and load-bearing. With Socket Mode
// on, Slack delivers over a WebSocket and ignores every Request URL below, so
// nothing reaches this app and the failure looks like silence.
console.log(`display_information:
  name: Follow-ups
  description: Automated client follow-up texts
  long_description: Starts a scheduled series of English or Spanish follow-up texts for a client who has gone quiet, and stops the moment they reply, call back, or text STOP. Started from any message, from a thread, or with /followup.
  background_color: "#2f5f7a"
features:
  bot_user:
    display_name: Follow-ups
    always_online: true
  slash_commands:
    - command: /followup
      url: ${PUBLIC_URL}/slack/commands
      description: Start or stop client follow-up texts
      usage_hint: start 512-555-0123 es Maria
      should_escape: true
  shortcuts:
    - name: Start follow-up texts
      type: message
      callback_id: start_followups
      description: Start follow-up texts for the number in this message
oauth_config:
  scopes:
    bot:
      - commands
      - chat:write
      - chat:write.public
      - app_mentions:read
      - channels:history
      - users:read
settings:
  event_subscriptions:
    request_url: ${PUBLIC_URL}/slack/events
    bot_events:
      - app_mention
  interactivity:
    is_enabled: true
    request_url: ${PUBLIC_URL}/slack/interactivity
  org_deploy_enabled: false
  socket_mode_enabled: false
  token_rotation_enabled: false
`);

console.error(`# ----------------------------------------------------------------------
# Paste the YAML above into:
#   api.slack.com/apps -> Create New App -> From a manifest
#   (or an existing app -> Features -> App Manifest)
#
# Slack verifies the event URL as you save, so make sure
# SLACK_SIGNING_SECRET is already set in Railway and the deploy has
# restarted. That check is itself signature-verified.
#
# Afterwards: Install to Workspace, copy the Bot User OAuth Token
# (xoxb-...) into SLACK_BOT_TOKEN, and invite the bot to your intake
# channel with /invite.
# ----------------------------------------------------------------------`);
