# Call Handling and SMS Follow-Up Flow

## Overview

This document explains how phone calls interact with the SMS follow-up flow, and how this repo (`follow-up-text`) coordinates with `quo-router`.

## Call Duration Threshold

The threshold for "short" vs "long" outbound calls is defined in `shared/calls.js`:

```javascript
export const LONG_OUTBOUND_SECONDS = 120;  // 2 minutes
```

## Call Handling Logic

### Incoming Calls (Client Calls Back)

**All incoming calls stop the SMS follow-up flow immediately.**

- Rationale: If the client calls back, they're re-engaged and don't need automated texts
- This applies to all incoming calls regardless of duration
- The series is stopped and Slack is notified

### Outbound Calls (Staff Calls Client)

#### 1. Unanswered Outbound Calls
- **Action**: Do NOT stop the series
- **Reason**: No connection was made, client still needs follow-up texts
- Examples: Busy signal, no answer, voicemail greeting not reached

#### 2. Short Outbound Calls (< 2 minutes)
- **Action**: Do NOT stop the series automatically
- **Post to Slack**: Show a review card with two buttons:
  - "Keep texting" - Keep the series running (default)
  - "Stop follow-ups" - Manually stop the series
- **Reason**: Short calls are ambiguous (voicemail, wrong number, "call me back later")
- **Database event**: `short_call_review` is logged
- **Intake Manager**: Shows "Stop SMS" button remains available

#### 3. Long Outbound Calls (≥ 2 minutes)
- **Action**: Stop the series automatically
- **Reason**: A 2+ minute conversation means real contact was made
- **Slack notification**: Posts that the client was reached and series stopped

## Code Flow in `webhooks.js`

```javascript
async function handleCall(object, type, context = {}) {
  const incoming = isIncomingCall(object);
  const outgoing = isOutgoingCall(object);
  
  // Step 1: Ignore outgoing ring events
  if (outgoing && type === "call.ringing") return { ignored: "outgoing_ringing" };
  
  // Step 2: Ignore unanswered outbound calls (no connection, keep texting)
  if (outgoing && !isAnsweredCall(object)) return { ignored: "outgoing_unanswered" };
  
  // Step 3: SHORT OUTBOUND CALLS - Post review to Slack, DO NOT STOP
  if (outgoing && outboundCallOutcome(object) === "short") {
    return reviewShortOutbound(object, fromClient);  // stopped: false
  }
  
  // Step 4: LONG OUTBOUND CALLS and INCOMING CALLS - Stop series
  const result = await rpc("followup_record_inbound", { phone: fromClient, kind: "call", ... });
  // ... stop the series and post to Slack
}
```

## Slack Button Actions

The short-call review buttons are handled in `server/routes/slack.js`:

- `followup_short_call_keep`: Keeps the series running, posts confirmation
- `followup_short_call_stop`: Stops the series manually, posts confirmation

Both actions check permissions (only assignee or supervisor can decide).

## Coordination with `quo-router`

**CRITICAL**: If `quo-router` also processes Quo webhooks, it MUST NOT stop SMS follow-ups on short outbound calls.

### Potential Issues

1. **Duplicate Webhook Processing**: If both `quo-router` and `follow-up-text` receive the same `call.completed` event:
   - `follow-up-text` correctly keeps the series running for short calls
   - But if `quo-router` then calls `/intake/stop` API, it would stop the series

2. **Race Condition**: The short-call review is posted to Slack, but before anyone clicks a button, another service stops the series

### Required quo-router Changes

If quo-router processes call events, it should either:

**Option A: Don't Stop on Calls**
- Let `follow-up-text` handle all call-based series stopping
- quo-router focuses on routing webhooks only

**Option B: Apply Same Logic**
- Implement the same 2-minute threshold and short-call review logic
- Check call duration before calling `/intake/stop`
- For short calls, don't call stop - let the Slack review handle it

**Option C: Check with follow-up-text First**
- Before stopping, call `/intake/stop` only if:
  - Call is incoming, OR
  - Call is outgoing and duration >= 120 seconds

## Environment Variables

No environment variables control this threshold. To change the 2-minute threshold, modify `LONG_OUTBOUND_SECONDS` in `shared/calls.js`.

## Debugging

Added logging in `handleCall()` to track:
- Call type (incoming/outgoing)
- Call duration
- Whether call was answered
- Classification outcome (unanswered/short/long)
- Action taken (keep running vs stop)

Look for log lines starting with `[Call Webhook]` to trace call handling.

## Testing

End-to-end tests in `tests/e2e/walkthrough.mjs` verify:
- Short outbound calls post review and DON'T stop series
- Long outbound calls DO stop series
- Unanswered calls DON'T stop series

Run with: `TEST_DATABASE_URL=... ./tests/e2e/run.sh`

## Example Scenarios

### Scenario 1: Voicemail (45 seconds)
```
Call: Outgoing, answered, 45 seconds
Outcome: "short"
Action: Post Slack review with "Keep texting" / "Stop" buttons
Series: Continues running
Next text: Still scheduled
```

### Scenario 2: Brief Call (90 seconds)
```
Call: Outgoing, answered, 90 seconds  
Outcome: "short"
Action: Post Slack review
Series: Continues running
```

### Scenario 3: Real Conversation (3 minutes)
```
Call: Outgoing, answered, 180 seconds
Outcome: "long"
Action: Stop series, post to Slack
Series: Stopped automatically
```

### Scenario 4: Client Calls Back (any duration)
```
Call: Incoming, answered, any duration
Outcome: N/A (incoming always stops)
Action: Stop series, post to Slack  
Series: Stopped automatically
```

## Database Events

Short-call reviews create a `followup_events` record:
```sql
kind: 'short_call_review'
detail: { duration_seconds: 45 }
actor: 'system'
```

This tracks that a review was requested, even if the buttons are never clicked.
