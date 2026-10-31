'use strict';

/**
 * Today's events and reminders in PostgreSQL. An event and the outbox row that announces it are written in one
 * transaction; a repeated Idempotency-Key returns the event it made the first time. Every change bumps seq (the ICS
 * SEQUENCE). A cancelled event stays readable (status cancelled) so calendars can remove it.
 */
const { ids } = require('openvibe-contracts');
const { newEventId } = require('../db');
const { validateCreate, validatePatch } = require('./validate');

const MAX_FUTURE = 60;

class StoreRefusal extends Error {
    constructor(status, code, field, message) {
        super(message);
        this.status = status; this.code = code; this.field = field;
    }
}

const iso = (v) => (v == null ? null : (v instanceof Date ? v.toISOString() : String(v)));

/** The JSON shape the API returns. */
function wire(row) {
    if (!row) return null;
    return {
        id: row.id,
        owner_subject: row.owner_subject,
        kind: row.kind,
        channel: row.channel || null,
        title: row.title,
        description: row.description == null ? null : row.description,
        starts_at: iso(row.starts_at),
        ends_at: iso(row.ends_at),
        tz: row.tz,
        status: row.status,
        visibility: row.visibility,
        url: row.url || null,
        source: row.source || null,
        source_id: row.source_id || null,
        source_url: row.source_url || null,
        source_kind: row.source_kind || null,
        seq: Number(row.seq) || 0,
        created_at: iso(row.created_at),
        updated_at: iso(row.updated_at),
    };
}

/** The payload of an Events envelope (never the owner: the envelope's subject carries that). */
function payloadOf(row) {
    return {
        event_id: row.id,
        kind: row.kind,
        channel: row.channel || null,
        title: row.title,
        starts_at: iso(row.starts_at),
        ends_at: iso(row.ends_at),
        tz: row.tz,
        status: row.status,
        visibility: row.visibility,
        url: row.url || null,
        seq: Number(row.seq) || 0,
    };
}

function createEventsStore({ s, log = console }) {
    const db = s.db;
    const nowIso = () => new Date(s.now()).toISOString();

    async function insertOutbox(topic, row) {
        const eventId = ids.newId('event', s.now());
        await db.exec(
            `INSERT INTO today_outbox (event_id, topic, payload, created_at, next_attempt_at)
             VALUES ($1, $2, $3::jsonb, $4::timestamptz, $4::timestamptz)`,
            [eventId, topic, JSON.stringify(payloadOf(row)), nowIso()],
        );
        return eventId;
    }

    async function byId(id) {
        return await db.maybe('SELECT * FROM today_events WHERE id = $1', [id]);
    }

    async function byIdForViewer(id, subject) {
        const row = await byId(id);
        if (!row) return null;
        if (row.visibility === 'followers' && row.owner_subject !== subject) return null;
        return row;
    }

    async function listPublic({ channel = null, from, to, limit = 50 } = {}) {
        const args = [from, to, Math.min(100, Math.max(1, Number(limit) || 50))];
        // A stream that is live now stays on the public list however long ago it started; everything else is
        // bounded by the window.
        let where = "visibility = 'public' AND status <> 'cancelled' AND ((starts_at >= $1::timestamptz AND starts_at <= $2::timestamptz) OR (status = 'live' AND starts_at <= $2::timestamptz))";
        if (channel) { args.push(channel); where += ` AND LOWER(channel) = LOWER($${args.length})`; }
        const rows = await db.many(
            `SELECT * FROM today_events WHERE ${where} ORDER BY starts_at ASC, id ASC LIMIT $3`,
            args,
        );
        return rows.map(wire);
    }

    async function listChannel(channel, { from, to, includeCancelled = false } = {}) {
        const args = [channel, from, to];
        const cancelled = includeCancelled ? '' : " AND status <> 'cancelled'";
        return (await db.many(
            `SELECT * FROM today_events WHERE LOWER(channel) = LOWER($1) AND visibility = 'public'${cancelled}
             AND starts_at >= $2::timestamptz AND starts_at <= $3::timestamptz ORDER BY starts_at ASC, id ASC`,
            args,
        )).map(wire);
    }

    async function countScheduledFuture(subject) {
        const row = await db.one(
            "SELECT COUNT(*)::int AS n FROM today_events WHERE owner_subject = $1 AND status = 'scheduled' AND starts_at > $2::timestamptz",
            [subject, nowIso()],
        );
        return Number(row.n) || 0;
    }

    async function create({ subject, username, body, idempotencyKey = null, now = s.now() }) {
        const check = validateCreate(body, { now, username });
        if (!check.ok) return check;
        const key = typeof idempotencyKey === 'string' && idempotencyKey ? idempotencyKey : null;
        try {
            return await s.tx(async () => {
                if (key) {
                    const claim = await db.maybe(
                        `INSERT INTO today_idempotency (subject, key, event_id, created_at)
                         VALUES ($1, $2, NULL, $3::timestamptz) ON CONFLICT (subject, key) DO NOTHING
                         RETURNING subject`,
                        [subject, key, nowIso()],
                    );
                    if (!claim) {
                        const prior = await db.maybe(
                            `SELECT e.* FROM today_idempotency i JOIN today_events e ON e.id = i.event_id
                             WHERE i.subject = $1 AND i.key = $2`,
                            [subject, key],
                        );
                        if (prior) return { ok: true, event: wire(prior), replayed: true };
                        throw new StoreRefusal(409, 'today.idempotency_in_progress', 'idempotency_key', 'a request with this key is still being handled; retry shortly');
                    }
                }
                if (await countScheduledFuture(subject) >= MAX_FUTURE) {
                    throw new StoreRefusal(409, 'today.too_many', 'events', `at most ${MAX_FUTURE} scheduled future events per owner`);
                }
                const id = newEventId();
                const row = await db.one(
                    `INSERT INTO today_events
                       (id, owner_subject, kind, channel, title, description, starts_at, ends_at, tz, status, visibility, url, seq, created_at, updated_at)
                     VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8::timestamptz, $9, 'scheduled', $10, $11, 0, $12::timestamptz, $12::timestamptz)
                     RETURNING *`,
                    [id, subject, check.fields.kind, check.fields.channel, check.fields.title, check.fields.description,
                        check.fields.starts_at, check.fields.ends_at, check.fields.tz, check.fields.visibility, check.fields.url, nowIso()],
                );
                if (key) await db.exec('UPDATE today_idempotency SET event_id = $1 WHERE subject = $2 AND key = $3', [id, subject, key]);
                await insertOutbox('today.event.scheduled', row);
                return { ok: true, event: wire(row), replayed: false };
            });
        } catch (err) {
            if (err instanceof StoreRefusal) return { ok: false, status: err.status, code: err.code, field: err.field, message: err.message };
            throw err;
        }
    }

    async function patch({ id, subject, body, now = s.now() }) {
        try {
            return await s.tx(async () => {
                const row = await db.maybe('SELECT * FROM today_events WHERE id = $1 FOR UPDATE', [id]);
                if (!row || row.owner_subject !== subject) throw new StoreRefusal(404, 'today.not_found', null, 'no such event');
                if (row.status === 'cancelled' || row.status === 'done') throw new StoreRefusal(409, 'today.locked', 'status', 'an event that is cancelled or done cannot be changed');
                const check = validatePatch(body, row, { now });
                if (!check.ok) return check;
                const after = await db.one(
                    `UPDATE today_events SET title = $1, description = $2, starts_at = $3::timestamptz, ends_at = $4::timestamptz,
                       tz = $5, visibility = $6, seq = seq + 1, updated_at = $7::timestamptz
                     WHERE id = $8 RETURNING *`,
                    [check.fields.title, check.fields.description, check.fields.starts_at, check.fields.ends_at,
                        check.fields.tz, check.fields.visibility, nowIso(), id],
                );
                await insertOutbox('today.event.updated', after);
                return { ok: true, event: wire(after) };
            });
        } catch (err) {
            if (err instanceof StoreRefusal) return { ok: false, status: err.status, code: err.code, field: err.field, message: err.message };
            throw err;
        }
    }

    async function cancel({ id, subject }) {
        try {
            return await s.tx(async () => {
                const row = await db.maybe('SELECT * FROM today_events WHERE id = $1 FOR UPDATE', [id]);
                if (!row || row.owner_subject !== subject) throw new StoreRefusal(404, 'today.not_found', null, 'no such event');
                if (row.status === 'cancelled') return { ok: true, event: wire(row), already: true };
                const after = await db.one(
                    `UPDATE today_events SET status = 'cancelled', seq = seq + 1, updated_at = $1::timestamptz
                     WHERE id = $2 RETURNING *`,
                    [nowIso(), id],
                );
                await db.exec('DELETE FROM today_reminders WHERE event_id = $1', [id]);
                await insertOutbox('today.event.cancelled', after);
                return { ok: true, event: wire(after), already: false };
            });
        } catch (err) {
            if (err instanceof StoreRefusal) return { ok: false, status: err.status, code: err.code, field: err.field, message: err.message };
            throw err;
        }
    }

    // ── Reminders ───────────────────────────────────────────
    function validateMinutes(v) {
        if (v == null || v === '') return { ok: true, value: 10 };
        const n = Number(v);
        if (!Number.isInteger(n) || n < 0 || n > 1440) return { ok: false, status: 400, code: 'today.invalid', field: 'minutes_before', message: 'minutes_before must be a whole number from 0 to 1440' };
        return { ok: true, value: n };
    }

    async function remind({ subject, id, minutesBefore, now = s.now() }) {
        const minutes = validateMinutes(minutesBefore);
        if (!minutes.ok) return minutes;
        try {
            return await s.tx(async () => {
                const row = await db.maybe('SELECT * FROM today_events WHERE id = $1', [id]);
                if (!row || (row.visibility === 'followers' && row.owner_subject !== subject)) throw new StoreRefusal(404, 'today.not_found', null, 'no such event');
                if (row.status === 'cancelled' || row.status === 'done') throw new StoreRefusal(409, 'today.locked', 'status', 'a cancelled or done event cannot be reminded');
                const remindAt = new Date(new Date(row.starts_at).getTime() - minutes.value * 60_000).toISOString();
                const saved = await db.one(
                    `INSERT INTO today_reminders (subject, event_id, remind_at, sent_at, created_at)
                     VALUES ($1, $2, $3::timestamptz, NULL, $4::timestamptz)
                     ON CONFLICT (subject, event_id) DO UPDATE SET remind_at = EXCLUDED.remind_at, sent_at = NULL
                     RETURNING *`,
                    [subject, id, remindAt, nowIso()],
                );
                return { ok: true, reminder: { event_id: id, remind_at: iso(saved.remind_at), minutes_before: minutes.value }, event: wire(row) };
            });
        } catch (err) {
            if (err instanceof StoreRefusal) return { ok: false, status: err.status, code: err.code, field: err.field, message: err.message };
            throw err;
        }
    }

    async function unremind({ subject, id }) {
        const n = await db.exec('DELETE FROM today_reminders WHERE subject = $1 AND event_id = $2', [subject, id]);
        return { ok: true, removed: Number(n) > 0 };
    }

    async function listReminders(subject, { now = s.now() } = {}) {
        const rows = await db.many(
            `SELECT r.event_id, r.remind_at, r.sent_at, r.created_at, e.*
             FROM today_reminders r JOIN today_events e ON e.id = r.event_id
             WHERE r.subject = $1 AND r.remind_at >= $2::timestamptz AND e.status IN ('scheduled', 'live')
             ORDER BY r.remind_at ASC, r.event_id ASC`,
            [subject, new Date(now).toISOString()],
        );
        return rows.map((r) => ({
            event_id: r.event_id,
            remind_at: iso(r.remind_at),
            sent_at: iso(r.sent_at),
            minutes_before: Math.max(0, Math.round((new Date(r.starts_at).getTime() - new Date(r.remind_at).getTime()) / 60_000)),
            event: wire(r),
        }));
    }

    /** Due reminders with their events, soonest first. The job claims each row before sending. */
    async function dueReminders(now = s.now(), limit = 100) {
        return await db.many(
            `SELECT r.subject, r.event_id, r.remind_at, e.*
             FROM today_reminders r JOIN today_events e ON e.id = r.event_id
             WHERE r.sent_at IS NULL AND r.remind_at <= $1::timestamptz AND e.status IN ('scheduled', 'live')
             ORDER BY r.remind_at ASC, r.event_id ASC LIMIT $2`,
            [new Date(now).toISOString(), Math.min(500, Math.max(1, limit))],
        );
    }

    /** Claim one due reminder atomically; null when another run already took it. */
    async function claimReminder(subject, eventId, now = s.now()) {
        const row = await db.maybe(
            `UPDATE today_reminders r SET sent_at = $3::timestamptz
             WHERE r.subject = $1 AND r.event_id = $2 AND r.sent_at IS NULL
               AND EXISTS (SELECT 1 FROM today_events e WHERE e.id = r.event_id AND e.status IN ('scheduled', 'live'))
             RETURNING r.*`,
            [subject, eventId, new Date(now).toISOString()],
        );
        if (!row) return null;
        return { reminder: row, event: await byId(eventId) };
    }

    /** Put a claimed reminder back when the notification could not be sent. */
    async function releaseReminder(subject, eventId) {
        await db.exec('UPDATE today_reminders SET sent_at = NULL WHERE subject = $1 AND event_id = $2', [subject, eventId]);
    }

    return {
        wire, payloadOf, byId, byIdForViewer, listPublic, listChannel,
        countScheduledFuture, create, patch, cancel,
        remind, unremind, listReminders, dueReminders, claimReminder, releaseReminder,
        MAX_FUTURE,
    };
}

module.exports = { createEventsStore, wire, payloadOf, StoreRefusal, MAX_FUTURE };
