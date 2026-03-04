---
name: parsing-work-assignments
description: Parse employer work assignment emails into calendar events. Detects onsite vs remote assignments based on travel-flagged emails, creates business-hours events and travel day placeholders. Use when processing work assignment notification emails.
metadata: {"clawdbot":{"requires":{"bins":["gog"]}}}
---

# Parsing Work Assignments

Parse employer work assignment emails into StandardBooking JSON and hand off to `viajero-calendar-core` for calendar reconciliation.

## Identifying Assignment Emails

Check your memory for:
- The email account to search
- The Gmail label and query for unprocessed assignment emails
- The assignment type codes used by the employer

Search for unprocessed assignment emails using the stored query pattern.

```bash
gog gmail messages search "<query>" --max 5 --account <account>
gog gmail get <messageId> --account <account>
```

## Assignment Type Detection

The employer uses category codes on assignment emails. Check your memory for the specific codes. The key distinction:

### Onsite Assignment (billable + travel-flagged)
- Travel-flagged emails exist for the same project/dates
- Employee must travel to a property location
- Creates: business-hours events at the property + travel day placeholders

### Remote Assignment (billable, no travel flag)
- No travel-flagged emails for this project
- Employee works from home base
- Creates: business-hours events at home base (check memory for home city)

**Detection rule:** Presence of travel-flagged emails for the same project determines onsite vs remote.

## Onsite Assignment Processing

### 1. Look Up Property Location
Extract the property/client name from the assignment email and look up the address:

```bash
gog calendar events <calendarId> --from <start> --to <end>
```

If no prior events exist for this property, use Google Maps to find the address.

### 2. Create Business-Hours Events
Create events spanning **business hours (Mon-Fri)** at the property location:

- **Hours:** 9:00 AM - 5:00 PM local time at the property
- **Days:** Monday through Friday only (skip weekends)
- **Summary:** `🏢 Onsite: {City/Location}`

### 3. Create Travel Day Placeholders
For travel dates (check travel-flagged emails for dates):

- If two distinct travel days exist for the same project:
  - Earlier date → `✈️ Out: {Nearest Airport City}` (check memory for airport city preference)
  - Later date → `✈️ Home`
- **Hours:** Full day (6:00 AM - 8:00 PM local time)

These placeholders are automatically cleaned up by `viajero-calendar-core` when real flight/hotel bookings arrive.

## Remote Assignment Processing

Create business-hours events at the user's home base:

- **Hours:** 9:00 AM - 5:00 PM in the user's home timezone (check memory)
- **Days:** Monday through Friday only
- **Summary:** `🏢 Onsite: {Home City}` (or appropriate remote work summary)

## Most Recent Email Wins

When multiple emails arrive for the same project and date range:
- The **most recent email** is authoritative
- Update existing calendar events rather than creating duplicates
- Search for events with matching project details in the date range before creating

## Output Format

Produce a StandardBooking JSON array:

```json
[
  {
    "type": "assignment",
    "confirmation": "PROJECT-12345",
    "summary": "🏢 Onsite: Lake Geneva, WI",
    "start": "2026-03-10T09:00:00-06:00",
    "end": "2026-03-10T17:00:00-06:00",
    "location": "123 Resort Dr, Lake Geneva, WI",
    "description": "Project: 12345\nType: Onsite\nProperty: Grand Geneva Resort",
    "source": "work-assignment",
    "messageId": "<gmail-message-id>",
    "isRebooking": false,
    "oldFlightNumber": null
  },
  {
    "type": "assignment",
    "confirmation": "PROJECT-12345-travel-out",
    "summary": "✈️ Out: Chicago",
    "start": "2026-03-09T06:00:00-07:00",
    "end": "2026-03-09T20:00:00-07:00",
    "location": "",
    "description": "Travel day: Outbound to Lake Geneva, WI",
    "source": "work-assignment",
    "messageId": "<gmail-message-id>",
    "isRebooking": false,
    "oldFlightNumber": null
  }
]
```

**Note:** Create one StandardBooking per day of the assignment (each weekday gets its own entry), plus travel day placeholders.

## Hand Off

After producing the StandardBooking array, pass each entry to `viajero-calendar-core` for:
- Calendar event creation/update/reconciliation
- Email labeling and archiving (using the assignment-specific label from memory)
- Placeholder cleanup when real bookings arrive
- Group notifications
