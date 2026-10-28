-- phase: expand
-- OpenVibe.Today: the network's time bus and calendar authority. Every table here holds events a
-- person scheduled, the reminders other people set on them, the calendar feed tokens a person owns,
-- the outbox that tells OpenVibe.Events what changed, the receipts of inbound deliveries already
-- handled and the briefs built from a person's day. Nothing written here is a credential: a feed
-- token is a bearer capability for one calendar, and it is never logged.

CREATE TABLE today_events (
    id            text COLLATE "C" PRIMARY KEY,              -- tev_ + 20 base32 characters
    owner_subject text COLLATE "C" NOT NULL,                 -- usr_…; the person who scheduled it
    kind          text COLLATE "C" NOT NULL,                 -- stream | event
    channel       text COLLATE "C",                          -- the owner's Live username, for a stream
    title         text NOT NULL,
    description   text,
    starts_at     timestamptz NOT NULL,
    ends_at       timestamptz,
    tz            text NOT NULL,                             -- IANA zone, validated with Intl
    status        text COLLATE "C" NOT NULL DEFAULT 'scheduled', -- scheduled | live | done | cancelled
    visibility    text COLLATE "C" NOT NULL DEFAULT 'public',    -- public | followers
    url           text,
    seq           integer NOT NULL DEFAULT 0,                -- the ICS SEQUENCE, bumped on every change
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT today_events_kind CHECK (kind IN ('stream', 'event')),
    CONSTRAINT today_events_status CHECK (status IN ('scheduled', 'live', 'done', 'cancelled')),
    CONSTRAINT today_events_visibility CHECK (visibility IN ('public', 'followers'))
);
CREATE INDEX today_events_by_channel ON today_events (channel, starts_at);
CREATE INDEX today_events_by_owner ON today_events (owner_subject, starts_at);
CREATE INDEX today_events_by_status ON today_events (status, starts_at);

-- A repeated Idempotency-Key on POST returns the first event, never a second one. event_id is null
-- only for the instant between claiming the key and inserting the event, inside one transaction.
CREATE TABLE today_idempotency (
    subject    text COLLATE "C" NOT NULL,
    key        text COLLATE "C" NOT NULL,
    event_id   text COLLATE "C",
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (subject, key)
);

CREATE TABLE today_reminders (
    subject    text COLLATE "C" NOT NULL,
    event_id   text COLLATE "C" NOT NULL,
    remind_at  timestamptz NOT NULL,
    sent_at    timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (subject, event_id)
);
CREATE INDEX today_reminders_due ON today_reminders (remind_at) WHERE sent_at IS NULL;

CREATE TABLE today_feeds (
    subject    text COLLATE "C" PRIMARY KEY,
    token      text COLLATE "C" UNIQUE NOT NULL,             -- 32 random bytes, base64url
    created_at timestamptz NOT NULL DEFAULT now()
);

-- The fixed Events evt_ id is chosen when the row is written, so a retry never creates a second event.
CREATE TABLE today_outbox (
    event_id      text COLLATE "C" PRIMARY KEY,
    topic         text COLLATE "C" NOT NULL,
    payload       jsonb NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    published_at  timestamptz,
    attempts      integer NOT NULL DEFAULT 0,
    last_error    text,
    next_attempt_at timestamptz NOT NULL DEFAULT now(),
    claimed_at    timestamptz,
    claimed_by    text
);
CREATE INDEX today_outbox_pending ON today_outbox (next_attempt_at) WHERE published_at IS NULL;

-- Inbound Events ids already handled: a replay is a no-op.
CREATE TABLE today_processed (
    event_id     text COLLATE "C" PRIMARY KEY,
    processed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE today_briefs (
    subject    text COLLATE "C" NOT NULL,
    day        date NOT NULL,
    body       jsonb NOT NULL,                               -- the sections
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (subject, day)
);

-- openvibe-sdk/account-data keeps its own idempotency here (ADR-033): a redelivered export or
-- deletion changes nothing. It holds an export_id or deletion_id, the subject and the counts sent
-- to Network; it is not a secret.
CREATE TABLE account_data_events (
    id         text PRIMARY KEY,
    kind       text NOT NULL,
    subject    text NOT NULL,
    outcome    jsonb,
    applied_at timestamptz NOT NULL DEFAULT now(),
    sent_at    timestamptz
);

-- Request telemetry (openvibe-sdk/telemetry): one row per aggregated sample, pruned after 14 days.
CREATE TABLE telemetry_samples (
    id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    at                    timestamptz NOT NULL,
    service               text NOT NULL,
    project               text,
    subject               text,
    resource              text,
    provider              text,
    node                  text,
    cell                  text,
    region                text,
    operation             text NOT NULL,
    latency_ms            double precision,
    queue_delay_ms        double precision,
    ttfb_ms               double precision,
    throughput_per_second double precision,
    bytes                 bigint,
    status                text,
    cache_status          text,
    cost_estimate         double precision,
    route_epoch           bigint,
    trace_id              text,
    extra                 jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX telemetry_samples_at_idx ON telemetry_samples (at);
CREATE INDEX telemetry_samples_service_idx ON telemetry_samples (service, operation, at);
