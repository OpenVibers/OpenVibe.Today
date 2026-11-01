-- phase: expand
-- The calendars a person imports (plan L48 R3): the addresses they added, and the copy of each one Today last read.
-- The address belongs to the person: it is never exported and it goes with the account (server/identity/account-data.js).
--
-- today_calendar_imports is the person's list. today_calendar_import_cache is the copy of the calendar itself: a
-- calendar is read at most once every half hour, and the week is drawn from the copy, so an address that cannot
-- be reached for a moment does not empty the week.

CREATE TABLE IF NOT EXISTS today_calendar_imports (
    id              text COLLATE "C" PRIMARY KEY,          -- cal_ + ULID
    subject         text COLLATE "C" NOT NULL,             -- usr_… the person
    url             text NOT NULL,                         -- the https address (webcal:// is turned into https://)
    name            text NOT NULL,                         -- the short name the week shows
    last_fetched_at timestamptz,                          -- when the copy was taken
    last_error      text,                                  -- why the last read did not work
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS today_calendar_imports_url ON today_calendar_imports (subject, url);
CREATE INDEX IF NOT EXISTS today_calendar_imports_by_subject ON today_calendar_imports (subject, created_at);

CREATE TABLE IF NOT EXISTS today_calendar_import_cache (
    import_id  text COLLATE "C" PRIMARY KEY REFERENCES today_calendar_imports(id) ON DELETE CASCADE,
    body       text NOT NULL,                              -- the calendar as it was read (RFC 5545)
    fetched_at timestamptz NOT NULL DEFAULT now()
);
