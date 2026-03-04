---
name: parsing-navan-bookings
description: Parse Navan corporate travel booking emails into StandardBooking format. Handles flights, hotels, and car rentals from a single itinerary. Use when processing Navan booking confirmation or update emails.
metadata: {"clawdbot":{"requires":{"bins":["gog"]}}}
---

# Parsing Navan Bookings

Parse Navan (corporate travel platform) booking emails into StandardBooking JSON and hand off to `viajero-calendar-core` for calendar reconciliation.

## Identifying Navan Emails

Search for unprocessed Navan booking emails. Check your memory for the email account and provider bookings label to build the search query.

**Sender patterns:**
- `*@navan.com`
- `*@tripactions.com` (legacy Navan domain)

**Subject patterns:**
- "Your trip to ..."
- "Booking confirmation"
- "Itinerary for ..."
- "Updated booking"
- "Cancellation confirmation"

## Reading Emails

```bash
gog gmail messages search "<query>" --max 5 --account <account>
gog gmail get <messageId> --account <account>
```

## Multi-Type Itineraries

A single Navan email often bundles flights + hotel + car rental for one trip. Parse **each booking component separately** into its own StandardBooking entry.

## Fields to Extract

### Flights

| Field | Notes |
|-------|-------|
| Carrier + flight number | e.g., `UA1875`, `AA2340` |
| Route | Airport codes, origin → destination |
| Departure date/time | Local time with timezone |
| Arrival date/time | Local time with timezone |
| Confirmation code | Airline confirmation (PNR), not the Navan trip ID |
| Seat | If assigned |

**Summary format:** `✈️ {carrier}{flightNumber} {origin}→{dest}`

### Hotels

| Field | Notes |
|-------|-------|
| Property name | Full hotel name |
| Address | Street address of the hotel |
| Check-in date/time | Usually 3:00 PM or 4:00 PM local |
| Check-out date/time | Usually 11:00 AM or 12:00 PM local |
| Confirmation code | Hotel confirmation number |
| Room type | If shown |

**Summary format:** `🏨 {PropertyName}`

**Note:** If check-in/check-out times aren't specified, use sensible defaults (3 PM check-in, 11 AM check-out in the hotel's local timezone).

### Car Rentals

| Field | Notes |
|-------|-------|
| Rental company | e.g., National, Hertz, Enterprise |
| Pickup location | Airport or address |
| Pickup date/time | Local time |
| Dropoff location | May differ from pickup |
| Dropoff date/time | Local time |
| Confirmation code | Rental confirmation number |
| Car class | If shown (e.g., midsize, full-size) |

**Summary format:** `🚗 {RentalCompany}`

## Output Format

Produce a StandardBooking JSON array with one entry per booking component:

```json
[
  {
    "type": "flight",
    "confirmation": "ABC123",
    "summary": "✈️ UA1875 ORD→MKE",
    "start": "2026-03-07T14:30:00-06:00",
    "end": "2026-03-07T15:45:00-06:00",
    "location": "Chicago O'Hare (ORD)",
    "description": "Confirmation: ABC123\nFlight: UA1875\nRoute: ORD → MKE",
    "source": "navan",
    "messageId": "<gmail-message-id>",
    "isRebooking": false,
    "oldFlightNumber": null
  },
  {
    "type": "hotel",
    "confirmation": "H98765",
    "summary": "🏨 Hilton Garden Inn",
    "start": "2026-03-07T15:00:00-06:00",
    "end": "2026-03-10T11:00:00-06:00",
    "location": "123 Main St, Milwaukee, WI",
    "description": "Confirmation: H98765\nHotel: Hilton Garden Inn\nCheck-in: Mar 7\nCheck-out: Mar 10",
    "source": "navan",
    "messageId": "<gmail-message-id>",
    "isRebooking": false,
    "oldFlightNumber": null
  },
  {
    "type": "car",
    "confirmation": "R54321",
    "summary": "🚗 National Car Rental",
    "start": "2026-03-07T16:00:00-06:00",
    "end": "2026-03-10T10:00:00-06:00",
    "location": "MKE Airport",
    "description": "Confirmation: R54321\nCompany: National\nPickup: MKE Airport\nDropoff: MKE Airport",
    "source": "navan",
    "messageId": "<gmail-message-id>",
    "isRebooking": false,
    "oldFlightNumber": null
  }
]
```

## Hand Off

After producing the StandardBooking array, pass each entry to `viajero-calendar-core` for:
- Calendar event creation/update/reconciliation
- Email labeling and archiving
- Conflict detection
- Group notifications
