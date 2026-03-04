---
name: viajero-calendar-core
description: Travel calendar orchestrator. Receives StandardBooking data from parser skills and manages Google Calendar events — creates, updates, deletes, deduplicates, and reconciles travel bookings. Use when processing parsed travel data into calendar events.
metadata: {"clawdbot":{"requires":{"bins":["gog"]}}}
---

# Viajero Calendar Core

Central orchestrator for travel calendar management. Receives StandardBooking JSON from parser skills and manages the full lifecycle of Google Calendar events.

## StandardBooking Format

All parser skills output this format. Each parsed email produces one or more bookings:

```json
{
  "type": "flight|hotel|car|assignment",
  "confirmation": "EP82E2",
  "summary": "✈️ UA1875 ORD→MKE",
  "start": "2026-03-07T14:30:00-06:00",
  "end": "2026-03-07T15:45:00-06:00",
  "location": "Chicago O'Hare (ORD)",
  "description": "Confirmation: EP82E2\nFlight: UA1875\nRoute: ORD → MKE\nSeat: 12C",
  "source": "united|navan|work-assignment",
  "messageId": "gmail-message-id",
  "isRebooking": false,
  "oldFlightNumber": null
}
```

## Summary Prefix Conventions

Use these prefixes so events are identifiable at a glance:

| Type | Prefix | Example |
|------|--------|---------|
| Flight | `✈️` | `✈️ UA1875 ORD→MKE` |
| Hotel | `🏨` | `🏨 Hilton Garden Inn` |
| Car rental | `🚗` | `🚗 National Car Rental` |
| Onsite work | `🏢` | `🏢 Onsite: Lake Geneva, WI` |
| Outbound travel day | `✈️` | `✈️ Out: Chicago` |
| Return travel day | `✈️` | `✈️ Home` |

## Calendar Operations

Check your memory for the user's calendar ID and email account.

### Creating Events

```bash
gog calendar create <calendarId> \
  --summary "✈️ UA1875 ORD→MKE" \
  --from "2026-03-07T14:30:00-06:00" \
  --to "2026-03-07T15:45:00-06:00" \
  --location "Chicago O'Hare (ORD)" \
  --description "Confirmation: EP82E2..."
```

**Defaults for all travel events:**
- No reminders: set `reminders.useDefault` to `false` with empty overrides
- No Google Meet: set `create_meeting_room` to `false`

### Searching Before Creating

Always search the calendar before creating to prevent duplicates:

```bash
gog calendar events <calendarId> --from <start-2d> --to <end+2d>
```

Look for existing events with matching confirmation number or flight number in the summary/description.

### Updating Events

```bash
gog calendar update <calendarId> <eventId> --summary "..." --from "..." --to "..."
```

### Deleting Events

```bash
gog calendar delete <calendarId> <eventId>
```

## Reconciliation Engine

Run this logic for every StandardBooking received:

### 1. Rebooking Detection
If `isRebooking` is true or you find an existing event with the same confirmation but different flight number/times:
- **Delete the old event** (it's obsolete)
- **Create a new event** with the updated booking

### 2. Gmail Auto-Event Cleanup
Gmail auto-creates events from confirmation emails. These have `eventType: "fromGmail"` and cannot be properly updated.
- Search for Gmail auto-created events matching the booking
- **Delete them** and create a proper Viajero event instead

### 3. Duplicate Prevention
- Search calendar window around the booking dates
- Match on: confirmation number, flight number, or summary prefix + date
- If a matching Viajero event exists, **update it** instead of creating a new one

### 4. Placeholder Cleanup
When a real flight or hotel booking arrives:
- Search for travel day placeholders (`✈️ Out:` or `✈️ Home`) covering the same dates
- **Delete placeholders** that are now superseded by real bookings

## Conflict Detection

After creating/updating events, check for scheduling conflicts:
- **< 90 minutes** between a flight arrival and the next calendar event = conflict
- **Overlapping bookings** = conflict
- Alert the user immediately via Telegram DM with details and suggested resolution

## Email Post-Processing

After successfully creating/updating calendar events:

1. **Label the email** with the provider bookings label (check memory for the label ID)
2. **Archive from INBOX** — remove the INBOX label

```bash
gog gmail labels add <messageId> --label <labelId> --account <account>
gog gmail labels remove <messageId> --label INBOX --account <account>
```

## Notifications

### Viajeros Group
Send a casual, brief notification to the Viajeros group chat (check memory for chat ID):
```bash
lettabot-message send --chat <groupChatId> --text "✈️ New booking: UA1875 ORD→MKE Mar 7"
```
Keep it short and scannable — this is for quick awareness.

### User DM
Send detailed booking info to the user's direct chat:
- Full confirmation details
- Any conflicts detected
- Link to calendar event

## Workflow Summary

For each StandardBooking received from a parser:

1. Search calendar for existing events (duplicates, old bookings, Gmail auto-events)
2. Reconcile: delete obsolete events, update existing, or create new
3. Check for conflicts with surrounding events
4. Label and archive the source email
5. Notify Viajeros group (casual) and user DM (detailed)
