'use strict';
/**
 * A person's own reminders (plan L48, R1). The words are parsed by server/when.js; this keeps them, lists them,
 * marks them done, snoozes them, and hands the job the ones that are due.
 *
 *   createMyReminders({ s })
 *     preview({ text, tz, now })                 → { title, rule, tz, next_at, summary } or { error }
 *     create(subject, { text, tz, url, source }) → the reminder, or { error } (a person keeps at most MAX_ACTIVE)
 *     list(subject)                              → active first (soonest first), then the last done ones
 *     done(subject, id) · snooze(subject, id, minutes) · remove(subject, id)
 *     due(now) · claim(row, now) · release(row)   the job's side: claim moves next_at on in one UPDATE
 */
const when = require('./when');

const MAX_ACTIVE = 200;
const SOURCES = /^[a-z][a-z0-9-]{1,30}$/;
const safeUrl = (u) => { try { const x = new URL(String(u)); return x.protocol === 'https:' && String(u).length <= 2000 ? x.toString() : null; } catch { return null; } };

function wire(r, { now = Date.now() } = {}) {
    const rule = typeof r.rule === 'string' ? JSON.parse(r.rule) : r.rule;
    const iso = (v) => (v ? new Date(v).toISOString() : null);
    return {
        id: r.id, title: r.title, said: r.said, rule, tz: r.tz, url: r.url || null, source: r.source, status: r.status,
        next_at: iso(r.next_at), last_sent_at: iso(r.last_sent_at), sent_count: Number(r.sent_count) || 0,
        summary: when.describe(rule, { tz: r.tz, now: new Date(now) }), repeats: rule.kind !== 'once',
        created_at: iso(r.created_at),
    };
}

function createMyReminders({ s }) {
    const db = s.db;

    function preview({ text, tz, now = s.now() }) {
        return when.parse(String(text || '').slice(0, 500), { now: new Date(now), tz: when.validTz(tz) ? tz : 'UTC' });
    }

    async function create(subject, { text, tz, url = null, source = 'today' }) {
        const p = preview({ text, tz });
        if (p.error) return { error: p.error };
        const active = Number(await db.value("SELECT count(*)::int FROM today_my_reminders WHERE subject = $1 AND status = 'active'", [subject]));
        if (active >= MAX_ACTIVE) return { error: `You have ${MAX_ACTIVE} reminders already. Mark some done first.` };
        const id = s.newId('rem');
        const row = await db.maybe(
            `INSERT INTO today_my_reminders (id, subject, title, said, rule, tz, url, source, next_at)
             VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9) RETURNING *`,
            [id, subject, p.title, String(text).trim().slice(0, 500), JSON.stringify(p.rule), p.tz, safeUrl(url), SOURCES.test(String(source)) ? source : 'today', p.next_at],
        );
        return wire(row, { now: s.now() });
    }

    async function list(subject) {
        const rows = await db.many(
            `(SELECT * FROM today_my_reminders WHERE subject = $1 AND status = 'active' ORDER BY next_at ASC LIMIT ${MAX_ACTIVE})
             UNION ALL
             (SELECT * FROM today_my_reminders WHERE subject = $1 AND status = 'done' ORDER BY updated_at DESC LIMIT 10)`,
            [subject],
        );
        return rows.map((r) => wire(r, { now: s.now() }));
    }

    async function done(subject, id) {
        const r = await db.maybe("UPDATE today_my_reminders SET status = 'done', next_at = NULL, updated_at = now() WHERE id = $1 AND subject = $2 RETURNING *", [id, subject]);
        return r ? wire(r) : null;
    }

    /** Later by `minutes` from now (5 minutes to a week). A repeating one carries on from its rule after that. */
    async function snooze(subject, id, minutes) {
        const m = Math.min(7 * 24 * 60, Math.max(5, Math.round(Number(minutes) || 0)));
        const at = new Date(s.now() + m * 60_000).toISOString();
        const r = await db.maybe("UPDATE today_my_reminders SET status = 'active', next_at = $3, updated_at = now() WHERE id = $1 AND subject = $2 RETURNING *", [id, subject, at]);
        return r ? wire(r) : null;
    }

    async function remove(subject, id) {
        const r = await db.maybe('DELETE FROM today_my_reminders WHERE id = $1 AND subject = $2 RETURNING id', [id, subject]);
        return !!r;
    }

    async function due(now = s.now(), limit = 500) {
        return db.many("SELECT * FROM today_my_reminders WHERE status = 'active' AND next_at <= $1 ORDER BY next_at ASC LIMIT $2", [new Date(now).toISOString(), limit]);
    }

    /**
     * Claim one due reminder: next_at moves on to the rule's next time after now (or the reminder is done) in one
     * UPDATE that only matches the next_at the job read, so a second process gets nothing. → the claimed row or null.
     */
    async function claim(row, now = s.now()) {
        const rule = typeof row.rule === 'string' ? JSON.parse(row.rule) : row.rule;
        // A one-off is done once it has been sent, even when it was snoozed past its own time.
        const after = rule.kind === 'once' ? null : when.next(rule, { after: new Date(now), tz: row.tz });
        return db.maybe(
            `UPDATE today_my_reminders
                SET next_at = $3, status = CASE WHEN $3::timestamptz IS NULL THEN 'done' ELSE status END,
                    last_sent_at = $4, sent_count = sent_count + 1, updated_at = now()
              WHERE id = $1 AND next_at = $2 AND status = 'active' RETURNING *`,
            [row.id, row.next_at, after ? after.toISOString() : null, new Date(now).toISOString()],
        );
    }

    /** A send that failed: the reminder is due again on the next tick. */
    async function release(row) {
        await db.exec("UPDATE today_my_reminders SET next_at = $2, status = 'active', sent_count = GREATEST(sent_count - 1, 0) WHERE id = $1", [row.id, row.next_at]);
    }

    return { preview, create, list, done, snooze, remove, due, claim, release, wire, MAX_ACTIVE };
}

module.exports = { createMyReminders };
