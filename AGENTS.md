# AGENTS.md — OpenVibe.Today

## Project overview

OpenVibe.Today (`https://openvibe.today`) is the network's time bus and calendar authority: a person
puts a stream or an event on the schedule, the network subscribes through RFC 5545 calendars, reminders
go out through Network notifications, and every change publishes a `today.event.*` event. It also
serves the daily brief and imports public calendars/holidays.

- **Entry:** `server/index.js`; app `server/app.js`; port `5100`, service id `today`.
- **API:** `server/http/api.js` (`/api/v1`), `principal.js` (person resolution), `discovery.js`
  (robots/sitemap/llms); pages in `server/http/pages.js`, `server/views/index.js`,
  `server/render/layout.js`.
- **Events:** `server/events/` — `publisher.js`/`store.js` (transactional outbox), `consumer.js`
  (Live stream started/ended, account export/deletion), `validate.js`.
- **Calendar:** `server/ics.js` (RFC 5545 output), `server/reminders.js`, `server/agenda.js`,
  `server/brief.js`; HTTP fetch guard `server/net/`.
- **Imports:** `server/imports/` (`index.js`, `normalize.js`, `holidays.js`), `scripts/import-now.js`.
- **Browser:** `public/js/today.js` is the only own script; all pages are server-rendered through
  `openvibe-shared/shell`, readable without JavaScript, with stable `td-` ids/classes. No bundler.

## Owns, does not own

Owns `today_events` (`tev_…`: owner subject, kind `stream|event`, Live channel, title, description,
start/end, IANA tz, status, visibility, url, ICS `seq`), `today_idempotency` (subject + key → the first
event), `today_reminders`, `today_feeds` (one private 32-byte token per person) and `today_outbox`
(fixed `evt_` id, lease, backoff).

Does not own: identity, follows and notifications (Network — Today verifies tokens/JWKS, reads follows
with the person's own token, pushes reminders through `/internal/notifications/push` with its own
service token); the live stream and its lifecycle (Live — Today consumes `live.stream.started|ended`
and never starts/stops a stream); the Rundown (Live's public API, linked not copied); event delivery
(Events — Today publishes its outbox and subscribes to live/account topics).

## Who calls it, what it calls

People use the pages/API with the `today_at` session cookie or a `Bearer` Network user token. SDK
`openvibe-sdk/today` is the client surface (events, own agenda, feed token/rotate, brief, reminders).
Other sites link into Today, for example `GET /remind?title=&at=&url=&from=` for a reminder. Today
calls Network (JWKS, follows, identity resolve-batch, notification push), Events (outbox and
subscriptions), Live (the public Rundown for the brief) and, for imports, the configured public
calendar/holiday hosts through the guarded fetcher.

## Database and migrations

PostgreSQL through `openvibe-sdk/db` (PgBouncer for the app, owner role for migrations); tests use
PGlite. `migrations/0001_initial.sql` creates the event, idempotency, reminder, feed and outbox
tables; later migrations add the rest. Applied at boot; never edit a migration that has run. A change
writes its `today_outbox` row **in the same transaction** as the event. The inbound event id is
recorded in `today_processed` in the same transaction as its effect, so a replay does nothing.

## Auth

Network RS256 JWTs verified offline with JWKS; the `today_at` cookie is the page session, a Bearer
token the API. A write made with the session cookie must come from `https://openvibe.today`, else
`403 today.cross_site`. A person acts only on their own events, reminders and feed. `/internal/events`
is loopback-only, verified with the v2 signature over the raw body and the ±300 s window; `/internal`
and `/metrics` answer 404 from nginx.

## Deploy

`deploy/systemd/openvibe-today.service` (`127.0.0.1:5100`, env `/etc/openvibe/today.env`) and
`deploy/nginx/openvibe.today.conf` (TLS, www → apex, sign-in/API/ICS limits, `/auth/me` on the API
zone, `/ics/` GET only, `/internal` and `/metrics` 404). `sudo ovhost deploy today` is the production
path (git-checkout, install on lockfile change, restart, wait for `/api/ready`); rollback with
`sudo ovhost rollback today --to <sha>`.

## Commands and tests

```bash
npm ci
npm run dev                  # http://127.0.0.1:5100
npm test                     # every test/*.test.js, PGlite + mock Network
npm test -- events ics       # only matching files
npm run test:pg              # the same on PostgreSQL
npm run imports:run          # run the calendar imports once
```

`test/run.js` uses `openvibe-shared/test-runner` (60 s, serial); temp PGlite and an in-process Network
mock, never the network. Tests cover validation, ICS folding/escaping and cancellation, the outbox and
replay, reminders claimed once, the brief, the pages, imports and account export/deletion.

## Conventions and pitfalls

- CommonJS, 4-space indent, single quotes, semicolons; no linter. Errors are
  `{ code, field, message }`/problem+json; never a raw row.
- **The ICS output is a compatibility surface:** CRLF, 75-octet folding that never splits a UTF-8
  sequence, TEXT escaping, UTC DTSTART/DTEND (one hour when no end), `SEQUENCE` from `seq`, and a
  cancelled event emitted with `STATUS:CANCELLED` for 7 days. A calendar client is not a test you can
  apologize to.
- **Reminders are claimed atomically** (`UPDATE … WHERE sent_at IS NULL RETURNING`); a failed push
  releases the claim for the next tick, and a cancelled event never sends.
- **The event id is fixed at write time** and the outbox is retried with backoff; Events is
  idempotent on that id, so a retry/restart must not make a second event.
- **The private feed is a bearer token:** rotate replaces it and the old URL is 404 at once; export
  includes the feed row without the token.
- **Followers-only events are absent from public lists**, not filtered in the page; `follows_unavailable`
  is the honest answer when Network is down.
- **Imports never invent a date:** a parsed calendar entry keeps its source and time; a holiday is
  labelled as a holiday.
