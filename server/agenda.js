'use strict';

/**
 * A person's agenda: their own events, the events they set a reminder on, and the public or followers-only events
 * of the channels they follow. Follows come from OpenVibe.Network with the person's own token (server/identity/
 * follows.js, cached 60 s); when Network is down the agenda still answers with own and reminded events and says
 * follows_unavailable: true.
 */
const { wire } = require('./events/store');

function createAgenda({ s, follows }) {
    const db = s.db;

    async function forSubject({ subject, token, days = 14, now = s.now() }) {
        const from = new Date(now - 2 * 60 * 60_000).toISOString();
        const to = new Date(now + days * 24 * 60 * 60_000).toISOString();
        let followed = [];
        let unavailable = false;
        if (token) {
            const r = await follows.forSubject(subject, token);
            followed = r.follows;
            unavailable = r.unavailable;
        } else {
            unavailable = true;
        }
        const rows = await db.many(
            `SELECT e.*, (e.owner_subject = ANY($4::text[])
                    OR EXISTS (SELECT 1 FROM today_channels c WHERE LOWER(c.username) = LOWER(e.channel) AND c.subject = ANY($4::text[]))) AS followed
             FROM today_events e
             WHERE e.starts_at >= $1::timestamptz AND e.starts_at <= $2::timestamptz AND e.status <> 'cancelled'
               AND (e.owner_subject = $3
                    OR EXISTS (SELECT 1 FROM today_reminders r WHERE r.subject = $3 AND r.event_id = e.id)
                    OR (e.owner_subject = ANY($4::text[]) AND e.visibility IN ('public', 'followers'))
                    OR EXISTS (SELECT 1 FROM today_channels c WHERE LOWER(c.username) = LOWER(e.channel)
                               AND c.subject = ANY($4::text[]) AND e.visibility IN ('public', 'followers')))
             ORDER BY followed DESC, e.starts_at ASC, e.id ASC`,
            [from, to, subject, followed],
        );
        const reminded = new Set((await db.many('SELECT event_id FROM today_reminders WHERE subject = $1', [subject])).map((r) => r.event_id));
        return {
            from, to, days,
            events: rows.map((r) => ({ ...wire(r), own: r.owner_subject === subject, reminded: reminded.has(r.id) })),
            follows_unavailable: unavailable,
        };
    }

    /** For the ICS token feed and the brief: the same set, without the Network flag. */
    async function windowFor({ subject, token, fromMs, toMs, now = s.now() }) {
        const from = new Date(fromMs).toISOString();
        const to = new Date(toMs).toISOString();
        let followed = [];
        if (token) followed = (await follows.forSubject(subject, token)).follows;
        else followed = follows.peek(subject);
        return await db.many(
            `SELECT e.*, (e.owner_subject = ANY($5::text[])
                    OR EXISTS (SELECT 1 FROM today_channels c WHERE LOWER(c.username) = LOWER(e.channel) AND c.subject = ANY($5::text[]))) AS followed
             FROM today_events e
             WHERE e.starts_at >= $1::timestamptz AND e.starts_at <= $2::timestamptz
               AND (e.status <> 'cancelled' OR e.updated_at >= $3::timestamptz)
               AND (e.owner_subject = $4
                    OR EXISTS (SELECT 1 FROM today_reminders r WHERE r.subject = $4 AND r.event_id = e.id)
                    OR (e.owner_subject = ANY($5::text[]) AND e.visibility IN ('public', 'followers'))
                    OR EXISTS (SELECT 1 FROM today_channels c WHERE LOWER(c.username) = LOWER(e.channel)
                               AND c.subject = ANY($5::text[]) AND e.visibility IN ('public', 'followers')))
             ORDER BY followed DESC, e.starts_at ASC, e.id ASC`,
            [from, to, new Date(now - 7 * 24 * 60 * 60_000).toISOString(), subject, followed],
        );
    }

    return { forSubject, windowFor };
}

module.exports = { createAgenda };
