-- phase: expand
-- A person's own reminders (plan L48, R1): "stretch every 2 hours from 9 to 5", "take my meds every day at 9 am and
-- 9 pm", "call mom on Sunday at 6 pm". The words are parsed once (server/when.js) into a rule; next_at is the next
-- time it fires, in the person's own time zone, and the job claims a due row by moving next_at on in one UPDATE, so
-- two processes never send twice. Private to the person: exported and erased with the account.
CREATE TABLE IF NOT EXISTS today_my_reminders (
    id           text COLLATE "C" PRIMARY KEY,               -- rem_ + ULID
    subject      text COLLATE "C" NOT NULL,                  -- usr_… the person
    title        text NOT NULL,                              -- what to remind them of, in their words
    said         text NOT NULL,                              -- what they typed or said, kept to show and edit
    rule         jsonb NOT NULL,                             -- server/when.js: once | daily | interval | monthly
    tz           text NOT NULL,                              -- IANA zone, validated with Intl
    url          text,                                       -- where it came from (a stream, a job, a page), https only
    source       text COLLATE "C" NOT NULL DEFAULT 'today',  -- today | vibe | live | work | … (the site that set it)
    status       text COLLATE "C" NOT NULL DEFAULT 'active', -- active | done
    next_at      timestamptz,                                -- null when it is done
    last_sent_at timestamptz,
    sent_count   integer NOT NULL DEFAULT 0,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT today_my_reminders_status CHECK (status IN ('active', 'done'))
);
CREATE INDEX IF NOT EXISTS today_my_reminders_due ON today_my_reminders (next_at) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS today_my_reminders_by_subject ON today_my_reminders (subject, created_at);
