'use strict';
/**
 * The calendars a person imports (plan L48 R3: "import any calendar by ICS address"). This keeps the addresses they
 * added, reads them at most once every half hour, and gives back the events of a week.
 *
 *   add(subject, { url, name })       → the import, or { error } (a person keeps at most MAX_PER_PERSON)
 *   list(subject)                     → the person's imports
 *   remove(subject, id)               → true when it was there
 *   events(subject, { from, to, tz }) → { events, problems }
 *
 * An address is read at most once every half hour: the copy Today read last is kept, and a view takes a fresh
 * one only when that copy is older than half an hour. A calendar that cannot be read does not empty the week: the
 * copy that is there stays, and the address is marked with the reason.
 *
 * The address belongs to the person: it is never exported and it goes with the account (server/identity/
 * account-data.js).
 */
const ical = require('./ical');
const { fetchCalendar: guardedFetch } = require('./net/calendar-fetch');

const MAX_PER_PERSON = 5;      // the most addresses one person may keep
const TTL_MS = 30 * 60_000;    // a calendar is read at most once every half hour
const TIMEOUT_MS = 10_000;     // how long an address may take
const MAX_BYTES = 2 * 1024 * 1024;   // the most a calendar may weigh

/** The address a person may add: https, or webcal:// turned into https. */
function normalizeUrl(value) {
    let s = String(value == null ? '' : value).trim();
    if (!s) return null;
    if (/^webcal:\/\//i.test(s)) s = 'https://' + s.slice('webcal://'.length);
    else if (!/^https:\/\//i.test(s)) return null;
    let u;
    try { u = new URL(s); } catch { return null; }
    if (u.username || u.password) return null;
    if (!u.hostname || !u.hostname.includes('.')) return null;   // a public host name, not this machine
    u.hash = '';
    return u.toString();
}

/** The short name of a calendar: what the person called it, or the first word of its host. */
function shortName(url, name) {
    const given = String(name == null ? '' : name).trim().replace(/\s+/g, ' ').slice(0, 60);
    if (given) return given;
    let host = '';
    try { host = new URL(url).hostname; } catch { host = ''; }
    host = host.replace(/^www\./, '');
    const word = host.split('.')[0] || host;
    return (word.charAt(0).toUpperCase() + word.slice(1)).slice(0, 40);
}

/**
 * The address as it is shown on the agenda: the host, and the path too when it is short. A path is often a secret
 * (a calendar's own token), so a long one is left out rather than shown half.
 */
function shortAddress(url) {
    let u;
    try { u = new URL(url); } catch { return String(url).slice(0, 60); }
    const host = u.hostname.replace(/^www\./, '');
    const path = u.pathname.replace(/^\/+|\/+$/g, '');
    if (!path) return host;
    return path.length <= 20 ? host + '/' + path : host;
}

function wire(row) {
    if (!row) return null;
    return {
        id: row.id,
        url: row.url,
        name: row.name,
        short: shortAddress(row.url),
        last_fetched_at: row.last_fetched_at ? new Date(row.last_fetched_at).toISOString() : null,
        last_error: row.last_error || null,
        created_at: row.created_at ? new Date(row.created_at).toISOString() : null,
    };
}

function createCalendarImports({ s, log = console, fetchImpl = null } = {}) {
    const db = s.db;
    const fetchOne = fetchImpl || guardedFetch;

    /** The person's addresses. */
    async function list(subject) {
        const rows = await db.many('SELECT * FROM today_calendar_imports WHERE subject = $1 ORDER BY created_at', [subject]);
        return rows.map(wire);
    }

    /** Add an address. */
    async function add(subject, { url, name = null }) {
        const address = normalizeUrl(url);
        if (!address) return { error: 'That is not an address Today can read. Use an https link, or the webcal:// form of one.' };
        const count = Number(await db.value('SELECT count(*)::int FROM today_calendar_imports WHERE subject = $1', [subject])) || 0;
        if (count >= MAX_PER_PERSON) return { error: 'You have ' + MAX_PER_PERSON + ' calendars already. Remove one to add another.' };
        const seen = await db.maybe('SELECT id FROM today_calendar_imports WHERE subject = $1 AND url = $2', [subject, address]);
        if (seen) return { error: 'That calendar is already on your list.' };
        const row = await db.maybe(
            'INSERT INTO today_calendar_imports (id, subject, url, name) VALUES ($1, $2, $3, $4) RETURNING *',
            [s.newId('cal'), subject, address, shortName(address, name)],
        );
        return wire(row);
    }

    /** Take an address away. The copy of the calendar goes with it. */
    async function remove(subject, id) {
        const r = await db.maybe('DELETE FROM today_calendar_imports WHERE id = $1 AND subject = $2 RETURNING id', [String(id || ''), subject]);
        return !!r;
    }

    /**
     * The events of the window, from the copies. An address whose copy is older than half an hour is read again
     * first; the ones that cannot be read keep the copy they have.
     */
    async function events(subject, { from, to, tz = 'UTC' } = {}) {
        const rows = await db.many('SELECT * FROM today_calendar_imports WHERE subject = $1 ORDER BY created_at', [subject]);
        if (!rows.length) return { events: [], problems: [] };
        const now = s.now();
        const due = [];
        for (const row of rows) {
            const cached = await db.maybe('SELECT body, fetched_at FROM today_calendar_import_cache WHERE import_id = $1', [row.id]);
            const age = cached ? now - new Date(cached.fetched_at).getTime() : Infinity;
            due.push({ row, body: cached ? cached.body : null, age });
        }
        const problems = [];
        // The addresses that are due are read together, so one slow calendar does not hold up the others.
        await Promise.all(due.filter((d) => d.age > TTL_MS).map(async (d) => {
            try {
                const res = await fetchOne(d.row.url, { timeoutMs: TIMEOUT_MS, maxBytes: MAX_BYTES });
                await db.maybe(
                    'INSERT INTO today_calendar_import_cache (import_id, body, fetched_at) VALUES ($1, $2, $3::timestamptz) '
                    + 'ON CONFLICT (import_id) DO UPDATE SET body = EXCLUDED.body, fetched_at = EXCLUDED.fetched_at',
                    [d.row.id, String(res.body), new Date(now).toISOString()],
                );
                await db.exec(
                    'UPDATE today_calendar_imports SET last_fetched_at = $2::timestamptz, last_error = NULL, updated_at = $2::timestamptz WHERE id = $1',
                    [d.row.id, new Date(now).toISOString()],
                );
                d.body = String(res.body);
            } catch (err) {
                const message = String(err && err.message ? err.message : err).slice(0, 200);
                await db.exec('UPDATE today_calendar_imports SET last_error = $2, updated_at = now() WHERE id = $1', [d.row.id, message]);
                log.warn('[OpenVibe.Today] a calendar could not be read: ' + message);
                problems.push({ id: d.row.id, name: d.row.name, message });
                // The copy that is there stays: a calendar that cannot be read does not empty the week.
            }
        }));
        const out = [];
        for (const d of due) {
            if (!d.body) continue;
            const parsed = ical.occurrences(d.body, { from, to, tz });
            for (const e of parsed.events) {
                out.push({ ...e, calendar: d.row.name, calendarId: d.row.id, source: d.row.url });
            }
        }
        return { events: out, problems };
    }

    return { list, add, remove, events, wire, MAX_PER_PERSON, TTL_MS, TIMEOUT_MS, MAX_BYTES };
}

module.exports = { createCalendarImports, normalizeUrl, shortName, shortAddress, MAX_PER_PERSON, TTL_MS, TIMEOUT_MS, MAX_BYTES };
