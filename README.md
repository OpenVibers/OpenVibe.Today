# OpenVibe.Today

> The network's time bus and calendar authority.

**Status:** v1 written and tested (see [STATUS.json](STATUS.json)).
**Domain:** `openvibe.today` · **Port:** 5100 · **Service id:** `today` · **Env prefix:** `TODAY`
**License:** AGPL-3.0-only (same as every OpenVibe service).

OpenVibe.Today is where a person puts a stream or an event on the network's calendar. It serves the public schedule,
one channel's schedule, a private calendar feed per person, reminders through OpenVibe.Network and a daily brief. It
is also the authority for those events over OpenVibe.Events: a producer writes an event to Today's outbox in the same
transaction as the change, and the calendar moves from scheduled to live to done as OpenVibe.Live says so.

## Purpose

One schedule for the whole network:

- **Public events** — `GET /api/v1/events` and the home page, soonest first. A stream belongs to the caller's Live
  channel; an event is a plain appointment. A followers-only event is visible to its owner and absent from public
  lists.
- **Calendars** — RFC 5545. `/ics/@<username>.ics` is a channel's public calendar; `/ics/<token>.ics` is one person's
  private agenda. Any calendar app can subscribe; rotation invalidates the old URL immediately.
- **Reminders** — one per person and event, sent once through OpenVibe.Network's notification push when due, and never
  for a cancelled event.
- **The brief** — later today, your reminders, and up to three things OpenVibe.Live's public Rundown talked about
  yesterday; one stored brief per person per day.
- **The bus** — `today.event.scheduled|updated|cancelled` published through a transactional outbox with a fixed `evt_`
  id, and `live.stream.started|ended` consumed to move events live and done exactly once.

## Owns

| Table | Holds | Migration |
|---|---|---|
| `today_events` | `tev_` + 20 base32 characters, `owner_subject` (`usr_…`), `kind` `stream\|event`, the owner's Live `channel` for a stream, title, description, `starts_at`, `ends_at`, IANA `tz`, `status` `scheduled\|live\|done\|cancelled`, `visibility` `public\|followers`, `url`, `seq` (the ICS SEQUENCE), timestamps | `migrations/0001_initial.sql` |
| `today_idempotency` | (`subject`, `key`) → the first event; a repeated `Idempotency-Key` never makes a second one | `0001_initial.sql` |
| `today_reminders` | (`subject`, `event_id`), `remind_at`, `sent_at`, `created_at` | `0001_initial.sql` |
| `today_feeds` | one private feed token per subject (32 random bytes, base64url) | `0001_initial.sql` |
| `today_outbox` | the fixed `evt_` id, topic, JSON payload, attempts, last error and a claim/backoff lease | `0001_initial.sql` |
| `today_processed` | inbound Events ids already handled, so a replay is a no-op | `0001_initial.sql` |
| `today_briefs` | (`subject`, `day`) → the sections, one per person per day | `0001_initial.sql` |
| `today_calendar_imports` | the addresses a person imported: `cal_` + ULID, `subject` (`usr_…`), the https `url`, its short `name`, when it was last read and why the last read failed; at most five per person | `migrations/0004_calendar_imports.sql` |
| `today_calendar_import_cache` | the copy of each imported calendar, read at most once every half hour; it goes with the address | `0004_calendar_imports.sql` |
| `account_data_events` | the receipts openvibe-sdk/account-data keeps for export and deletion deliveries | `0001_initial.sql` |
| `telemetry_samples` | aggregated request telemetry, pruned after 14 days | `0001_initial.sql` |

## Does not own

- **Identity, follows and notifications** — OpenVibe.Network. Today verifies its session tokens and JWKS, reads a
  person's follows with their own token (`GET /api/v1/me/follows`, cached 60 s), and pushes reminders through
  `/internal/notifications/push` with its own client-credentials token.
- **The live stream and its lifecycle** — OpenVibe.Live. Today consumes `live.stream.started|ended`; it never starts or
  stops a stream.
- **The Rundown** — OpenVibe.Live's public `/api/rundown`; Today reads it for the brief and links back to it.
- **Event delivery** — OpenVibe.Events. Today publishes its outbox and subscribes to the live and account topics.
- **Account export and deletion** — OpenVibe.Network (ADR-033). Today answers its part and confirms it.
- **The host, database and Valkey** — OpenVibe.Host.

## Depends on

Environment variable names are in [.env.example](.env.example); no value is committed.

- **OpenVibe.Network** — sign-in (OAuth client `today`, PKCE S256), JWKS, token exchange/refresh/revoke, follows,
  identity resolution and notifications: `OV_NETWORK_URL`, `OV_NETWORK_INTERNAL_URL`, `OV_NETWORK_ISSUER`,
  `OV_OAUTH_CLIENT_ID`, `OV_OAUTH_CLIENT_SECRET`, `OV_OAUTH_REDIRECT_URI`, `OV_SESSION_AUDIENCE`, `TODAY_AUDIENCE`.
- **OpenVibe.Events** — publishing and subscriptions: `TODAY_EVENTS_SECRET`, `TODAY_EVENTS_URL`,
  `TODAY_EVENTS_ENDPOINT`, `TODAY_EVENTS_INTERVAL_MS`, `TODAY_EVENTS_SCOPE` (the product scope `events.publish`;
  the publisher falls back to the capability `events.event.publish` if the token endpoint refuses it).
- **OpenVibe.Live** — the public Rundown API: `OV_LIVE_INTERNAL_URL`, `TODAY_LIVE_TIMEOUT_MS`.
- **PostgreSQL** — `DATABASE_URL` (through PgBouncer) and `DATABASE_DIRECT_URL` (migrations); embedded PGlite in
  `TODAY_PGLITE_DIR` for development.
- **Valkey** — optional `VALKEY_URL`, `VALKEY_PREFIX` (the readiness check lists it; the app's per-address limits do
  not require it).
- **Packages** — `openvibe-contracts`, `openvibe-sdk`, `openvibe-shared` (pinned to the same versions as
  OpenVibe.Help).

## API

Everything is JSON under `/api/v1`. A person is the `today_at` session cookie or `Authorization: Bearer <Network user
token>`, verified offline with the Network JWKS. A write made with the session cookie must come from
`https://openvibe.today` (403 `today.cross_site`).

| Route | What it does |
|---|---|
| `GET /events?channel=&from=&to=&limit=` | public events (`visibility=public`, not cancelled), soonest first; `from` is now − 2 h, `to` now + 60 days, `limit` ≤ 100; `Cache-Control: public, max-age=60` |
| `GET /events/:id` | one event; a cancelled one answers `status: "cancelled"`; a followers-only one is 404 unless the caller owns it |
| `POST /events` | signed in; `{ kind, title, starts_at, ends_at?, tz, description?, visibility? }`; a stream's `channel` and `url` come from the token, never the body; `Idempotency-Key` (≤ 100 characters) honoured; at most 60 scheduled future events per owner (409 `today.too_many`); the event and its `today.event.scheduled` outbox row commit together |
| `PATCH /events/:id` | owner; title, description, starts_at, ends_at, tz, visibility; `seq` + 1; `today.event.updated`; refused once cancelled or done |
| `DELETE /events/:id` | owner; status `cancelled`, `seq` + 1, `today.event.cancelled`, reminders dropped; idempotent (twice is 200) |
| `POST /events/:id/remind` | signed in; `{ minutes_before?: 0–1440 }` (default 10); upsert |
| `DELETE /events/:id/remind` | remove it (idempotent) |
| `GET /me/reminders` | the caller's upcoming reminders |
| `GET /me/agenda?days=14` | own events, reminded events and the public or followers-only events of followed channels; `follows_unavailable: true` when Network is down |
| `GET /me/feed` | `{ url: "https://openvibe.today/ics/<token>.ics" }`, creating the token on first call |
| `POST /me/feed/rotate` | replace the token; the old URL is 404 at once |
| `GET /me/brief` | today's brief, generated on demand when missing (`?tz=` optional IANA zone) |

Validation refusals are `400 { code: "today.invalid", field, message }`. Other codes:
`today.too_many`, `today.cross_site`, `today.locked`, `today.not_found`, `today.sign_in_required`.

### Validation

- title 1–120 characters; description ≤ 1000
- `starts_at` an ISO time no earlier than 5 minutes ago and no later than 366 days ahead
- `ends_at` after `starts_at` and within 24 hours of it
- `tz` a valid IANA zone (checked with `Intl`)
- `kind` `stream` or `event`; `visibility` `public` or `followers`

## ICS

`GET /ics/<token>.ics` is the token owner's agenda (60 days ahead, 7 back), `private, max-age=300`.
`GET /ics/@<username>.ics` is a channel's public events, `public, max-age=300`.

The calendars follow RFC 5545: CRLF line endings, lines folded at 75 octets without splitting a UTF-8 sequence, TEXT
escaping (`\\`, `\;`, `\,`, newline as `\n`), `PRODID:-//OpenVibe//Today//EN`, `VERSION:2.0`, `CALSCALE:GREGORIAN`,
`X-WR-CALNAME`, and a VEVENT per event with `UID:<id>@openvibe.today`, `DTSTAMP`, UTC `DTSTART`/`DTEND` (no end means
one hour), `SUMMARY`, `DESCRIPTION`, `URL`, `SEQUENCE`, `STATUS:CONFIRMED|CANCELLED` and `LAST-MODIFIED`. A cancelled
event is emitted with `STATUS:CANCELLED` for 7 days so calendars remove it, then dropped.

A token feed carries the owner's own and reminded events. When this process has read the person's follows (visiting
`/me` or `/api/v1/me/feed` warms the 60 s cache), it also carries their followed channels' public or followers-only
events. The feed request itself carries no person's Network token, so a freshly started process cannot read the follow
graph for that one URL.

## Events

**Publish.** Every change writes a `today_outbox` row in the same transaction, with the `evt_` id fixed at that
moment. A job every 5 s claims pending rows with a lease, posts each envelope to OpenVibe.Events `POST /api/v1/events`
with this service's client-credentials token (audience `openvibe.events`), and records the attempt. A failure backs
off (5 s doubling to 5 minutes), stores `last_error`, and never crashes the process. Because the id is fixed and Events
is idempotent on it, a retry or a restart cannot make a second event.

Envelope: `source: "today"`, `subject: { type: "user", id: <owner_subject> }`, `actor` the same person,
`event_type` `today.event.scheduled|updated|cancelled`, payload
`{ event_id, kind, channel, title, starts_at, ends_at, tz, status, visibility, url, seq }`.

**Consume.** `POST /internal/events` is loopback only (nginx answers 404 for `/internal`). Deliveries are verified with
the v2 signature over the raw body and the ±300 s replay window (openvibe-sdk/events `parseDelivery`, `requireV2`).
`live.stream.started` makes the channel's scheduled event whose start is within 2 hours of now live;
`live.stream.ended` makes a live event done. The inbound event id is recorded in `today_processed` in the same
transaction as the change, so a replay does nothing. Account export/deletion events go to openvibe-sdk/account-data
over every table that holds a subject. `startSubscriptions()` creates the two live and two account subscriptions at
boot, idempotently, with `events.subscription.manage`.

## Reminders

Every 60 s, due reminders (`remind_at <= now`, `sent_at` null, event scheduled or live) are claimed with
`UPDATE … SET sent_at = now() WHERE … AND sent_at IS NULL RETURNING`, so two processes never send twice. The Network
user id is resolved in batches via `/internal/identity/resolve-batch` (cached), then one notification is pushed:
type `TODAY_REMINDER`, category `stream` for a stream else `system`, title `"<title> starts in N min"` (or
`"<title> is live now"`), `service: "today"`, URL `https://openvibe.today/e/<id>`. A failed push releases the claim
for the next tick.

## The brief

`server/brief.js` builds `{ day, sections: [{ id, title, items: [{ text, url, action }] }] }` from:

1. **Later today** — events in the person's agenda that start today in their zone (action `remind`).
2. **Your reminders** — today's reminders.
3. **Yesterday on OpenVibe** — up to three items from OpenVibe.Live's public Rundown API, omitted when it fails.

Sections with no items are left out. The body (the sections) is stored in `today_briefs`, one row per subject per day.
A daily job at 06:00 UTC builds briefs for subjects active in the last 30 days (a reminder, an own event or a feed);
v1 does not notify.

## Pages

All server-rendered through the OpenVibe Frame (`openvibe-shared/shell`), readable without JavaScript, with semantic
HTML and stable `td-` ids/classes:

| Page | What it is |
|---|---|
| `/` | the room's front door: the day's ring (today's events on the reader's clock), what is coming up by day, three scenes |
| `/@:username` | a channel's schedule, with Subscribe (`webcal://`) and the `.ics` |
| `/e/:id` | one event, with `application/ld+json` `Event` (name, startDate, endDate, eventStatus, eventAttendanceMode, VirtualLocation, organizer); Remind me (`POST /e/:id/remind`, `/remind/remove`), Add to calendar (`/e/:id.ics`), Watch on Live, and Cancel for its owner (`POST /e/:id/cancel`) |
| `/me` | agenda, reminders, the calendars you imported (a form and a list, with a Remove button), the feed URL and its rotate form |
| `/me/week` | your week: seven days from Monday in your own zone — your reminders at each time they fire, your events, the streams of the channels you follow, and the events of the calendars you imported |
| `/brief` | today's brief |
| `/schedule` | a plain form that schedules a stream or an event: the start is wall time in the chosen zone (the device's, with JavaScript), plus a length (`POST /schedule` → 303 `/e/:id`) |
| `/developers` | the API |
| 404 | the not-found page |

Public pages are `public, max-age=60` with `Vary: Cookie`; a page drawn for a signed-in person is `private, no-store`.
The pages are built on the shared room kit (`kit.css`, `room.css`, `showcase.css`, `motion.js`; Today's amber from `openvibe-shared/rooms`) in `server/views/`. `public/js/today.js` adds the reader's own time, the device's zone on the form, copy and confirm; everything works without it. `scripts/seed-dev.js` puts a few events in the local development database.
`robots.txt`, `sitemap.xml`, `llms.txt` and `llms-full.txt` list the public pages only.

## Run and test

```sh
npm install
npm test                 # PGlite; every test file in its own process, no network needed
npm run test:pg          # the same through PostgreSQL + PgBouncer (openvibe-sdk scripts/test-services.sh up)
OV_ALLOW_SUITE=1 npm test
npm start                # PORT 5100, loopback; DATABASE_URL or an embedded PGlite in development
```

The tests boot the app with a mock Network and Events: events (validation, idempotency, cap, followers, cross-site,
transactional outbox), ICS (folding, escaping, cancellation window, token rotation), the consumer (signed, replay, bad
signature), the outbox (fixed id, backoff, restart), reminders (one notification, concurrency, cancelled), agenda
(follows and Network down), imports (idempotent, time zones, source links, retirement, no private fields), brief
(sections, Rundown failure, one per day), pages, sign-in, account export/deletion and discovery. The imported calendars
are tested on their own: reading a calendar (a zone, an all-day event, a weekly rule, an excluded day, a cancelled
event, a clock change), refusing a private address and a body that is too big, the week that shows them, the five
addresses a person may keep, and a form post from another site refused.

## Imports

`server/imports/` fills the public calendar from the services around the network: the streams on now on Live, public
Fun plans and accepted IRL quests, Nager.Date holidays per country, and (when `TODAY_IMPORTS_EVENTS_TOPICS` names
public people-facing topics) public events from OpenVibe.Events. Upcoming streams are not imported: the schedule card
in Live's studio writes them into this service's own table. The job runs at boot and every
`TODAY_IMPORTS_INTERVAL_MS`, is off under `TODAY_DRILL`, and `npm run imports:run` runs one pass by hand. Each row
keeps its `source`/`source_id`, its source URL and its time zone; a second run updates the same row, and a source
item that disappears retires its row.

## Imported calendars

A person can add up to five calendar addresses on their agenda (`POST /me/calendars`, `POST /me/calendars/:id/remove`):
`https://…` or the `webcal://` form of one, which becomes `https://`. The address is read through the shared egress
rule (`openvibe-shared/egress`): https only, a public host only, a name that resolves to a private or link-local
address refused before a byte is sent and again at connect time, a redirect followed only after the same check, a 10 s
timeout, at most 2 MB, and only `text/calendar` or `text/plain` is read. Each address is read at most once every
half hour, and the copy is what the week is drawn from, so an address that cannot be reached for a moment does not
empty the week.

`server/ical.js` reads RFC 5545 far enough and no further: `SUMMARY`, `DTSTART`/`DTEND` with a `TZID` or an
all-day `DATE`, `DURATION`, `EXDATE`, `STATUS:CANCELLED`, and a `RRULE` that is `DAILY`, `WEEKLY` with
`BYDAY` or `MONTHLY` by the day of the month, with `INTERVAL`, `COUNT` and `UNTIL`. A rule with anything else
in it (`BYMONTH`, `BYSETPOS`, an ordinal `BYDAY` such as `2FR`), a zone this server does not know and an event
with no `DTSTART` are left out and counted, never guessed at. The address belongs to the person: it is never
exported and it goes with the account.

## Deploy

`deploy/systemd/openvibe-today.service` (127.0.0.1:5100, `/etc/openvibe/today.env`) and
`deploy/nginx/openvibe.today.conf` (TLS, www → apex, sign-in/API/ICS limits, `/auth/me` on the API zone,
`/ics/` GET only, `/internal` and `/metrics` 404).

## License

AGPL-3.0-only. See [LICENSE](LICENSE).

<!-- versions:start -->
- openvibe-contracts: v0.233.0
- openvibe-sdk: v0.74.0
- openvibe-shared: v4.76.0
<!-- versions:end -->
