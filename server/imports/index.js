'use strict';

/**
 * Import jobs that fill Today from the public services around the network. Each source is read through its public
 * API only, its items are normalised by server/imports/normalize.js (or holidays.js), and one row per (source,
 * source_id) is written to today_events. The unique index on that pair is the idempotency: a second run updates the
 * same row instead of adding one, and a changed source bumps seq (the ICS SEQUENCE) only once.
 *
 *   live       the streams on now from GET /api/streams; a stream that ended is marked done. Upcoming streams are
 *              not imported: the schedule card in Live's studio writes them into this service's own table.
 *   fun        public group plans (GET /api/v1/plans) and accepted/live IRL quests (GET /api/v1/quests).
 *   holidays   Nager.Date's open public-holiday API, per country, at local midnight in that country's zone.
 *   events     public people-facing events pulled from OpenVibe.Events, off until TODAY_IMPORTS_EVENTS_TOPICS
 *              names the topics to read (release notes, deploys and telemetry are never events).
 *
 * Nothing here reads a token or a person's identity from a source. A source row that stops being public is retired:
 * a stream is marked done, a plan or public event cancelled. The jobs are off under TODAY_DRILL and when
 * TODAY_IMPORTS=0; tests call runOnce() themselves.
 */
const { serviceAuth } = require('openvibe-contracts');
const { newEventId } = require('../db');
const { liveStream, funPlan, funQuest, networkEvent } = require('./normalize');
const { recordsFor, isZone } = require('./holidays');

const KINDS = Object.freeze(['stream', 'event', 'plan', 'quest', 'holiday', 'observance']);
const STATUSES = Object.freeze(['scheduled', 'live', 'done', 'cancelled']);
const MAX_TITLE = 120;
const MAX_DESCRIPTION = 1000;
const MAX_SOURCE_ID = 200;
const HOLIDAY_TTL_MS = 12 * 60 * 60_000;
const PAGE_LIMIT = 50;
const MAX_PAGES = 10;
const SOURCES = Object.freeze(['live', 'fun', 'holidays', 'events']);

const iso = (v) => (v == null ? null : (v instanceof Date ? v.toISOString() : String(v)));
const same = (a, b) => (a == null && b == null) || (a != null && b != null && String(a) === String(b));
const plain = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
const https = (v) => (typeof v === 'string' && /^https:\/\/[^\s"'<>]{1,300}$/.test(v) ? v : null);

/** One normalised source record, checked against the columns Today owns. */
function cleanRecord(record, { source, at }) {
    if (!record || record.source !== source) return null;
    const sourceId = plain(record.source_id, MAX_SOURCE_ID);
    const title = plain(record.title, MAX_TITLE);
    const starts = record.starts_at ? new Date(record.starts_at) : null;
    if (!sourceId || !title || !starts || Number.isNaN(starts.getTime())) return null;
    const ends = record.ends_at ? new Date(record.ends_at) : null;
    if (ends && Number.isNaN(ends.getTime())) return null;
    const kind = KINDS.includes(record.kind) ? record.kind : 'event';
    const status = STATUSES.includes(record.status) ? record.status : 'scheduled';
    const tz = typeof record.tz === 'string' && isZone(record.tz) ? record.tz : 'UTC';
    const description = plain(record.description, MAX_DESCRIPTION) || null;
    return {
        source,
        source_id: sourceId,
        source_kind: plain(record.source_kind, 40) || kind,
        kind,
        title,
        description,
        starts_at: starts.toISOString(),
        ends_at: ends ? ends.toISOString() : null,
        tz,
        status,
        visibility: 'public',
        url: https(record.url),
        source_url: https(record.source_url) || https(record.url),
        owner_subject: plain(record.owner_subject, 80) || 'sys:' + source,
        channel: plain(record.channel, 64) || null,
        updated_at: new Date(at).toISOString(),
    };
}

function changed(row, r) {
    return !same(iso(row.title), r.title)
        || !same(row.description, r.description)
        || !same(iso(row.starts_at), r.starts_at)
        || !same(iso(row.ends_at), r.ends_at)
        || !same(row.tz, r.tz)
        || !same(row.status, r.status)
        || !same(row.url, r.url)
        || !same(row.source_url, r.source_url)
        || !same(row.source_kind, r.source_kind)
        || !same(row.owner_subject, r.owner_subject)
        || !same(row.channel, r.channel);
}

function createImports({ config, s, fetchImpl = globalThis.fetch, log = console, now = s.now }) {
    const db = s.db;
    const holidays = new Map();   // `CC:year` -> { at, records }
    const stats = { last: null, running: false, started: false };
    let timer = null;
    let timeout = null;

    async function getJson(url, { headers = {}, fetch = fetchImpl } = {}) {
        const res = await fetch(url, {
            headers: { Accept: 'application/json', 'User-Agent': 'OpenVibe.Today (+https://openvibe.today)', ...headers },
            signal: AbortSignal.timeout(config.imports.timeoutMs),
        });
        if (!res.ok) {
            const err = new Error(`${new URL(url).host} answered ${res.status}`);
            err.status = res.status;
            throw err;
        }
        // Nager.Date answers 204 for a country it has no data for; that is an empty year, not a failure.
        if (res.status === 204) return [];
        const body = await res.json().catch(() => null);
        if (!body || typeof body !== 'object') throw new Error(`${new URL(url).host} answered without JSON`);
        return body;
    }

    async function channelSubjects() {
        const rows = await db.many('SELECT username, subject FROM today_channels');
        return new Map(rows.map((r) => [String(r.username).toLowerCase(), r.subject]));
    }

    /** Write a whole source's records in one transaction; returns the source ids that exist after it. */
    async function applyRecords(source, records, at) {
        const seen = [];
        await s.tx(async () => {
            for (const raw of records) {
                const r = cleanRecord(raw, { source, at });
                if (!r) continue;
                seen.push(r.source_id);
                const row = await db.maybe('SELECT * FROM today_events WHERE source = $1 AND source_id = $2', [source, r.source_id]);
                let event = row;
                if (!row) {
                    const id = newEventId();
                    event = await db.maybe(
                        `INSERT INTO today_events
                           (id, owner_subject, kind, channel, title, description, starts_at, ends_at, tz, status, visibility,
                            url, source, source_id, source_url, source_kind, seq, created_at, updated_at)
                         VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8::timestamptz, $9, $10, 'public',
                            $11, $12, $13, $14, $15, 0, $16::timestamptz, $16::timestamptz)
                         ON CONFLICT (source, source_id) WHERE source IS NOT NULL AND source_id IS NOT NULL DO NOTHING
                         RETURNING *`,
                        [id, r.owner_subject, r.kind, r.channel, r.title, r.description, r.starts_at, r.ends_at, r.tz, r.status,
                            r.url, r.source, r.source_id, r.source_url, r.source_kind, r.updated_at],
                    );
                    if (!event) event = await db.maybe('SELECT * FROM today_events WHERE source = $1 AND source_id = $2', [source, r.source_id]);
                } else if (changed(row, r)) {
                    event = await db.maybe(
                        `UPDATE today_events SET owner_subject = $2, kind = $3, channel = $4, title = $5, description = $6,
                           starts_at = $7::timestamptz, ends_at = $8::timestamptz, tz = $9, status = $10, url = $11,
                           source_url = $12, source_kind = $13, seq = seq + 1, updated_at = $14::timestamptz
                         WHERE id = $1 RETURNING *`,
                        [row.id, r.owner_subject, r.kind, r.channel, r.title, r.description, r.starts_at, r.ends_at, r.tz,
                            r.status, r.url, r.source_url, r.source_kind, r.updated_at],
                    );
                }
                if (event) {
                    await db.exec(
                        `INSERT INTO today_imports (source, source_id, event_id, seen_at) VALUES ($1, $2, $3, $4::timestamptz)
                         ON CONFLICT (source, source_id) DO UPDATE SET event_id = EXCLUDED.event_id, seen_at = EXCLUDED.seen_at`,
                        [source, r.source_id, event.id, r.updated_at],
                    );
                }
            }
        });
        return [...new Set(seen)];
    }

    /** Mark imported rows for this source that a successful read no longer lists. */
    async function retire(source, seen, at, status) {
        const when = new Date(at).toISOString();
        const n = await db.exec(
            `UPDATE today_events SET status = $1, seq = seq + 1, updated_at = $2::timestamptz
             WHERE source = $3 AND NOT (source_id = ANY($4::text[])) AND status NOT IN ('done', 'cancelled')`,
            [status, when, source, seen],
        );
        return Number(n) || 0;
    }

    async function runLive(at, fetch) {
        const body = await getJson(`${config.imports.live.url}/api/streams`, { fetch });
        if (!Array.isArray(body.streams)) throw new Error('Live answered without a streams list');
        const list = body.streams;
        const subjects = await channelSubjects();
        const records = [];
        for (const stream of list) {
            const username = plain(stream && stream.channel && stream.channel.username, 64);
            records.push(liveStream(stream, { subject: subjects.get(username.toLowerCase()) || null }));
        }
        const seen = await applyRecords('live', records, at);
        return { ok: true, imported: seen.length, retired: await retire('live', seen, at, 'done') };
    }

    async function pages(fetch, base, key) {
        const out = [];
        let cursor = null;
        for (let page = 0; page < MAX_PAGES; page++) {
            const url = `${base}${base.includes('?') ? '&' : '?'}limit=${PAGE_LIMIT}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
            const body = await getJson(url, { fetch });
            if (!Array.isArray(body[key])) throw new Error(`${new URL(url).host} answered without a ${key} list`);
            const rows = body[key];
            out.push(...rows);
            cursor = typeof body.next_cursor === 'string' && body.next_cursor ? body.next_cursor : null;
            if (!cursor) break;
        }
        return out;
    }

    async function runFun(at, fetch) {
        const plans = await pages(fetch, `${config.imports.fun.url}/api/v1/plans`, 'plans');
        const planSeen = await applyRecords('fun', plans.map(funPlan), at);
        const quests = await pages(fetch, `${config.imports.fun.url}/api/v1/quests`, 'quests');
        const questSeen = await applyRecords('fun', quests.map(funQuest), at);
        const seen = [...new Set([...planSeen, ...questSeen])];
        return { ok: true, imported: seen.length, retired: await retire('fun', seen, at, 'cancelled') };
    }

    async function holidayRecords(at, fetch, { force = false } = {}) {
        const year = new Date(at).getUTCFullYear();
        const years = [year, year + 1];
        const records = [];
        let failed = 0;
        let fetched = 0;
        for (const country of config.imports.holidays.countries) {
            const cc = String(country || '').trim().toUpperCase();
            if (!/^[A-Z]{2}$/.test(cc)) continue;
            for (const y of years) {
                const key = `${cc}:${y}`;
                const hit = holidays.get(key);
                if (!force && hit && at - hit.at < HOLIDAY_TTL_MS) { records.push(...hit.records); continue; }
                try {
                    const payload = await getJson(`https://date.nager.at/api/v3/PublicHolidays/${y}/${cc}`, { fetch });
                    const rows = recordsFor(payload, { country: cc, year: y });
                    holidays.set(key, { at, records: rows });
                    records.push(...rows);
                    fetched++;
                } catch (err) {
                    failed++;
                    log.warn(`[OpenVibe.Today] holidays ${cc}/${y}: ${(err && err.message) || err}`);
                }
            }
        }
        if (failed && !fetched && !records.length) throw new Error(`Nager.Date did not answer for ${failed} country-years`);
        return { records, failed };
    }

    async function runHolidays(at, fetch, opts) {
        const { records, failed } = await holidayRecords(at, fetch, opts);
        const seen = await applyRecords('holidays', records, at);
        return { ok: true, imported: seen.length, retired: 0, ...(failed ? { failed } : {}) };
    }

    async function runEvents(at, fetch) {
        const { topics, url, scope } = config.imports.events;
        if (!topics.length || !url || !config.oauth.clientSecret) return { ok: true, imported: 0, retired: 0, skipped: 'not_configured' };
        const tokens = serviceAuth.createTokenClient({
            tokenUrl: `${config.networkInternalUrl}/oauth/token`,
            clientId: config.oauth.clientId,
            clientSecret: config.oauth.clientSecret,
            audience: 'openvibe.events',
            scope,
            fetchImpl: fetch,
        });
        const body = await getJson(`${url.replace(/\/+$/, '')}/api/v1/events?topic=${encodeURIComponent(topics.join(','))}&limit=100`, { fetch,
            headers: await tokens.authHeaders(),
        });
        const records = (Array.isArray(body.events) ? body.events : [])
            .map((row) => networkEvent(row && row.event ? row.event : row))
            .filter(Boolean);
        const seen = await applyRecords('events', records, at);
        return { ok: true, imported: seen.length, retired: 0 };
    }

    const runners = { live: runLive, fun: runFun, holidays: runHolidays, events: runEvents };

    async function recordSource(source, result) {
        const at = new Date(now()).toISOString();
        await db.exec(
            `INSERT INTO today_import_sources (source, last_run_at, last_ok_at, last_error, imported, retired, updated_at)
             VALUES ($1, $2::timestamptz, $3::timestamptz, $4, $5, $6, $2::timestamptz)
             ON CONFLICT (source) DO UPDATE SET last_run_at = EXCLUDED.last_run_at,
               last_ok_at = CASE WHEN $3::timestamptz IS NULL THEN today_import_sources.last_ok_at ELSE EXCLUDED.last_ok_at END,
               last_error = EXCLUDED.last_error, imported = EXCLUDED.imported, retired = EXCLUDED.retired,
               updated_at = EXCLUDED.updated_at`,
            [source, at, result.ok ? at : null, result.ok ? null : String(result.error || 'failed').slice(0, 500), result.imported || 0, result.retired || 0],
        );
    }

    /**
     * Run one import pass. `sources` selects a subset (tests do); a source that throws is recorded and never stops
     * another source. Nothing is retired by a source that failed to read.
     */
    async function runOnce({ sources = SOURCES, fetchImpl: fetch = fetchImpl, force = false } = {}) {
        if (stats.running) return { busy: true, at: new Date(now()).toISOString(), sources: {} };
        stats.running = true;
        const at = now();
        const out = {};
        try {
            for (const source of sources) {
                const runner = runners[source];
                if (!runner) continue;
                try {
                    out[source] = await runner(at, fetch, { force });
                } catch (err) {
                    out[source] = { ok: false, imported: 0, retired: 0, error: (err && err.message) || String(err) };
                    log.warn(`[OpenVibe.Today] import ${source}: ${(err && err.message) || err}`);
                }
                await recordSource(source, out[source]);
            }
            stats.last = { at: new Date(at).toISOString(), sources: out };
            return stats.last;
        } finally {
            stats.running = false;
        }
    }

    function start() {
        if (!config.imports.enabled || config.drill) return false;
        if (stats.started) return true;
        stats.started = true;
        const tick = async () => {
            try { await runOnce(); } catch (err) { log.warn('[OpenVibe.Today] imports:', (err && err.message) || err); }
        };
        timeout = setTimeout(tick, 10_000);
        if (timeout.unref) timeout.unref();
        timer = setInterval(tick, config.imports.intervalMs);
        if (timer.unref) timer.unref();
        log.log(`[OpenVibe.Today] imports every ${Math.round(config.imports.intervalMs / 60_000)} min: ${SOURCES.join(', ')}`);
        return true;
    }

    function stop() {
        if (timeout) clearTimeout(timeout);
        if (timer) clearInterval(timer);
        timeout = null;
        timer = null;
        stats.started = false;
    }

    return { runOnce, start, stop, stats, sources: SOURCES };
}

module.exports = { createImports, cleanRecord, changed, SOURCES };
