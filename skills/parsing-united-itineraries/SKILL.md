---
name: parsing-united-itineraries
description: Parse United Airlines confirmation and rebooking emails into StandardBooking format. Use when processing emails from United Airlines containing itinerary confirmations, schedule changes, or rebookings.
metadata: {"clawdbot":{"requires":{"bins":["gog"]}}}
---

# Parsing United Itineraries

Parse United Airlines itinerary emails into StandardBooking JSON and hand off to `viajero-calendar-core` for calendar reconciliation.

## Identifying United Emails

Search for unprocessed United itinerary emails. Check your memory for the email account and provider bookings label to build the search query (unread emails not yet labeled).

**Sender patterns:**
- `united@united.com`
- `*@united.com`

**Subject patterns:**
- "Your United flight confirmation"
- "Confirmation - ..."
- "Your flight itinerary"
- "Schedule change"
- "We've rebooked your flight"
- "Flight status update"

## Reading Emails

```bash
gog gmail messages search "<query>" --max 5 --account <account>
gog gmail get <messageId> --account <account>
```

Read the full email body. United emails are HTML-heavy but the key data is in structured text blocks.

## Fields to Extract

For each flight segment in the email:

| Field | Where to Find It |
|-------|-----------------|
| Confirmation code | Top of email, 6-character alphanumeric (e.g., `EP82E2`) |
| Flight number | `UA` followed by digits (e.g., `UA1875`) |
| Route | Origin → Destination airport codes (e.g., `ORD → MKE`) |
| Departure date/time | With timezone offset |
| Arrival date/time | With timezone offset |
| Seat | Seat assignment if shown |
| Fare class | Booking class letter if shown |
| Aircraft | Aircraft type if shown |

## Multi-Segment Itineraries

A single confirmation may contain connecting flights. Create a **separate StandardBooking for each flight segment**:

```
Confirmation EP82E2:
  Segment 1: UA1875 ORD→DEN 14:30-16:45
  Segment 2: UA2210 DEN→MKE 17:30-20:15
```

→ Produces 2 StandardBooking entries, both sharing the same confirmation code.

## Rebooking Detection

**Same confirmation number + different flight number = rebooking.**

When a United email shows a flight change:
- Set `isRebooking: true`
- Set `oldFlightNumber` to the previous flight number if visible in the email
- The calendar core will handle deleting the old event

Common rebooking indicators:
- Subject contains "rebooked", "schedule change", or "flight change"
- Email body shows old vs new flight comparison
- New itinerary email for a confirmation you've already processed

## Output Format

Produce a StandardBooking JSON array:

```json
[
  {
    "type": "flight",
    "confirmation": "EP82E2",
    "summary": "✈️ UA1875 ORD→MKE",
    "start": "2026-03-07T14:30:00-06:00",
    "end": "2026-03-07T15:45:00-06:00",
    "location": "Chicago O'Hare (ORD)",
    "description": "Confirmation: EP82E2\nFlight: UA1875\nRoute: ORD → MKE\nDeparture: 2:30 PM CDT\nArrival: 3:45 PM CDT\nSeat: 12C",
    "source": "united",
    "messageId": "<gmail-message-id>",
    "isRebooking": false,
    "oldFlightNumber": null
  }
]
```

**Summary format:** `✈️ UA{flightNumber} {origin}→{dest}`

**Location:** Use the departure airport name and code for the event location.

**Times:** Always include timezone offsets. Use the local time at each airport.

## Hand Off

After producing the StandardBooking array, pass each entry to `viajero-calendar-core` for:
- Calendar event creation/update/reconciliation
- Email labeling and archiving
- Conflict detection
- Group notifications
