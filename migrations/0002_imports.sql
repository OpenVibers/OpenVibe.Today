-- phase: expand
-- OpenVibe.Today: the imports that fill the network's agenda from the public services around it. An imported
-- event is an ordinary today_events row with the source it came from written on it, so the public API, the ICS
-- feed and the agenda all read one table. The unique index on (source, source_id) is what makes an import
-- idempotent: the same item from the same source is one row, updated in place.
--
-- today_imports is the ledger of which event each source item became. today_import_sources is the last result of
-- each importer, so an operator can see a source that has stopped answering. today_channels remembers which
-- Network subject owns which Live username: the public Live API names the channel, the events bus carries the
-- subject, and the two together let a person's agenda put the channels they follow first.

ALTER TABLE today_events DROP CONSTRAINT today_events_kind;
ALTER TABLE today_events ADD CONSTRAINT today_events_kind
    CHECK (kind IN ('stream', 'event', 'plan', 'quest', 'holiday', 'observance'));

ALTER TABLE today_events ADD COLUMN source text COLLATE "C";
ALTER TABLE today_events ADD COLUMN source_id text COLLATE "C";
ALTER TABLE today_events ADD COLUMN source_url text;
ALTER TABLE today_events ADD COLUMN source_kind text COLLATE "C";

CREATE UNIQUE INDEX today_events_source_key
    ON today_events (source, source_id)
    WHERE source IS NOT NULL AND source_id IS NOT NULL;
CREATE INDEX today_events_by_source ON today_events (source, starts_at);

CREATE TABLE today_imports (
    source    text COLLATE "C" NOT NULL,
    source_id text COLLATE "C" NOT NULL,
    event_id  text COLLATE "C" NOT NULL REFERENCES today_events(id) ON DELETE CASCADE,
    seen_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (source, source_id)
);

CREATE TABLE today_import_sources (
    source      text COLLATE "C" PRIMARY KEY,
    last_run_at timestamptz,
    last_ok_at  timestamptz,
    last_error  text,
    imported    integer NOT NULL DEFAULT 0,
    retired     integer NOT NULL DEFAULT 0,
    updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE today_channels (
    username   text COLLATE "C" PRIMARY KEY,
    subject    text COLLATE "C" NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);
