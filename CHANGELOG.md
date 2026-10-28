# Changelog

What changed in OpenVibe.Today, newest first.

## 0.1.0 — 2026-10-28

The first version: the network's time bus and calendar authority.

- **Scheduling.** `POST|PATCH|DELETE /api/v1/events`, with title/description/time-zone/range validation, a stream's
  channel and URL taken from the caller's token, followers-only visibility, a cap of 60 scheduled future events per
  owner, an `Idempotency-Key` that returns the first event, and a same-origin rule for writes made with the session
  cookie (`403 today.cross_site`). The event and its `today.event.scheduled` outbox row commit in one transaction.
- **Public read.** `GET /api/v1/events` (soonest first, public cache 60 s) and `GET /api/v1/events/:id`; a cancelled
  event answers with its cancelled status, and a followers-only one is 404 unless the caller owns it.
- **ICS.** `/ics/@<username>.ics` (public) and `/ics/<token>.ics` (private, 300 s): RFC 5545 CRLF, 75-octet UTF-8-safe
  folding, TEXT escaping, UID/SEQUENCE/STATUS/LAST-MODIFIED, one-hour default end, a cancelled event as
  `STATUS:CANCELLED` for 7 days then dropped, and rotation that makes the old token 404 at once.
- **Reminders.** Upsert/remove/list and a 60 s job that claims a due row atomically before pushing one
  `TODAY_REMINDER` through OpenVibe.Network's `/internal/notifications/push` (user id resolved in batches and cached).
  A cancelled or done event's reminder never sends.
- **Agenda.** Own events, reminded events and the public or followers-only events of followed channels, with the
  follow graph read from Network with the person's own token and cached 60 s. Network down still answers own and
  reminded events with `follows_unavailable: true`.
- **Brief.** Later today, your reminders and up to three items from OpenVibe.Live's public Rundown; the Rundown
  section is omitted when it fails; one stored brief per person per day; a 06:00 UTC job for subjects active in the
  last 30 days (no notification in v1).
- **Events.** A transactional outbox with a fixed `evt_` id, claim lease, backoff and `attempts`/`last_error`, and a
  v2-signed consumer at `/internal/events` for `live.stream.started|ended`; `today_processed` makes a replay a no-op.
  Account export and deletion go through openvibe-sdk/account-data over every table that holds a subject; the feed
  token itself is never exported.
- **The service.** OpenVibe.Network sign-in as OAuth client `today` (PKCE S256, `today_at`/`today_rt`/`today_oauth`),
  truthful readiness (the database is required), Prometheus metrics on loopback, crawl artifacts, deploy files, and
  server-rendered pages with schema.org Event JSON-LD.
- **Tests.** `events`, `ics`, `consumer`, `outbox`, `reminders`, `agenda`, `brief`, `pages`, `sso`, `account-data` and
  `discovery`, each in its own process on a temporary PGlite database with a mock Network/Events.
