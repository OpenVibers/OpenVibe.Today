'use strict';

/**
 * OpenVibe.Events → Today. POST /internal/events is this service's subscription endpoint (loopback only; nginx
 * answers 404 for /internal).
 *
 *   live.stream.started   the channel's scheduled event whose start is within 2 h of now becomes live
 *   live.stream.ended     a live event of that channel becomes done
 *   network.account.export_requested / network.account.deleted
 *                         handed to openvibe-sdk/account-data (server/identity/account-data.js), which keeps
 *                         its own idempotency and sends the export part / deletion confirmation to Network
 *
 * Every other inbound event id is recorded in today_processed in the same transaction as its effect, so a replay
 * changes nothing. A delivery is verified with the v2 signature (replay window, raw body) exactly as Help's
 * consumer verifies. The boot-time half, startSubscriptions(), creates any missing subscriptions at Events.
 */
const express = require('express');
const { http, serviceAuth } = require('openvibe-contracts');
const { parseDelivery } = require('openvibe-sdk/events');

const LIVE_TOPICS = Object.freeze(['live.stream.started', 'live.stream.ended']);
const TOPICS = Object.freeze([...LIVE_TOPICS, ...require('openvibe-sdk/account-data').TOPICS]);
const EVENT_ID_RE = /^evt_[0-9A-HJKMNP-TV-Z]{26}$/;

function createEventsConsumer({ config, s, accountData, accountSend = null, now = s.now, log = console }) {
    const db = s.db;
    const secrets = (config.events.secrets || []).filter((x) => typeof x === 'string' && x.length >= 32);
    const topics = [...LIVE_TOPICS, ...accountData.TOPICS];
    const stats = { received: 0, applied: 0, duplicates: 0, ignored: 0, refused: 0, failed: 0, last_at: null };
    const router = express.Router();

    function record(eventId, atIso) {
        return db.exec('INSERT INTO today_processed (event_id, processed_at) VALUES ($1, $2::timestamptz) ON CONFLICT (event_id) DO NOTHING', [eventId, atIso]);
    }

    async function applyLive(event) {
        const payload = event.payload && typeof event.payload === 'object' ? event.payload : {};
        const username = payload.channel && typeof payload.channel.username === 'string' ? payload.channel.username : null;
        if (!username) return 'ignored:payload';
        const subjectId = (payload.channel && payload.channel.subject && typeof payload.channel.subject.id === 'string' && payload.channel.subject.id)
            || (event.actor && typeof event.actor.id === 'string' && event.actor.id) || null;
        const atIso = new Date(now()).toISOString();
        return await s.tx(async () => {
            const inserted = await record(event.event_id, atIso);
            if (!inserted) return { duplicate: true, outcome: null };
            // The public Live list names a channel; the bus carries its Network subject. Remember the pair so a
            // follower's agenda can put an imported "on now" row first (server/agenda.js).
            if (subjectId && /^usr_[0-9A-HJKMNP-TV-Z]{26}$/.test(subjectId)) {
                await db.exec(
                    `INSERT INTO today_channels (username, subject, updated_at) VALUES ($1, $2, $3::timestamptz)
                     ON CONFLICT (username) DO UPDATE SET subject = EXCLUDED.subject, updated_at = EXCLUDED.updated_at`,
                    [username, subjectId, atIso],
                );
            }
            if (event.event_type === 'live.stream.started') {
                const at = new Date(now()).toISOString();
                // An on-now row imported from the public list already exists: give it the subject the bus knows.
                if (subjectId) {
                    await db.exec(
                        `UPDATE today_events SET owner_subject = $1, seq = seq + 1, updated_at = $2::timestamptz
                         WHERE source = 'live' AND LOWER(channel) = LOWER($3) AND status = 'live' AND owner_subject <> $1`,
                        [subjectId, atIso, username],
                    );
                }
                const row = await db.maybe(
                    `SELECT * FROM today_events
                     WHERE LOWER(channel) = LOWER($1) AND status = 'scheduled'
                       AND starts_at BETWEEN $2::timestamptz - interval '2 hours' AND $2::timestamptz + interval '2 hours'
                     ORDER BY ABS(EXTRACT(EPOCH FROM (starts_at - $2::timestamptz))) ASC, starts_at ASC LIMIT 1`,
                    [username, at],
                );
                if (!row) return { duplicate: false, outcome: 'ignored:no_event' };
                await db.exec("UPDATE today_events SET status = 'live', seq = seq + 1, updated_at = $1::timestamptz WHERE id = $2", [atIso, row.id]);
                return { duplicate: false, outcome: 'live', event_id: row.id };
            }
            // live.stream.ended: the imported on-now row ends with the stream it names (the public list catches up
            // on its own too, but the bus is immediate).
            const streamId = payload.stream_id == null ? null : String(payload.stream_id);
            if (streamId) {
                await db.exec(
                    "UPDATE today_events SET status = 'done', seq = seq + 1, updated_at = $1::timestamptz WHERE source = 'live' AND source_id = $2 AND status = 'live'",
                    [atIso, 'stream:' + streamId],
                );
            }
            const row = await db.maybe(
                "SELECT * FROM today_events WHERE LOWER(channel) = LOWER($1) AND status = 'live' ORDER BY starts_at DESC, updated_at DESC LIMIT 1",
                [username],
            );
            if (!row) return { duplicate: false, outcome: 'ignored:no_event' };
            await db.exec("UPDATE today_events SET status = 'done', seq = seq + 1, updated_at = $1::timestamptz WHERE id = $2", [atIso, row.id]);
            return { duplicate: false, outcome: 'done', event_id: row.id };
        });
    }

    router.post('/', express.raw({ type: () => true, limit: '256kb' }), async (req, res) => {
        const ctx = http.requestContext(req.headers);
        const problem = (status, code, detail) => http.sendProblem(res, status, code, { detail, ctx });
        if (req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.headers['cf-connecting-ip']) return problem(403, 'today.internal_only', 'internal route');
        if (!secrets.length) return problem(503, 'today.events_disabled', 'TODAY_EVENTS_SECRET is not set');
        const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        let delivery = null;
        for (const secret of secrets) { delivery = parseDelivery(raw, req.headers, secret, { requireV2: true, now: now() }); if (delivery) break; }
        if (!delivery) { stats.refused++; return problem(401, 'today.bad_signature', 'X-OpenVibe-Signature-V2 does not verify or is outside the replay window'); }
        const event = delivery.event;
        if (!event || !EVENT_ID_RE.test(String(event.event_id || '')) || typeof event.event_type !== 'string') { stats.refused++; return problem(400, 'today.bad_delivery', 'body must be { event: <envelope>, seq }'); }
        stats.received++;
        stats.last_at = new Date(now()).toISOString();

        if (accountData.TOPICS.includes(event.event_type)) {
            let outcome;
            try {
                outcome = await accountData.apply(event, { send: accountSend });
            } catch (err) {
                stats.failed++;
                log.error(`[OpenVibe.Today] account event ${event.event_id} failed:`, err.message);
                return problem(503, 'today.event_failed', 'processing failed; it will be retried');
            }
            if (String(outcome).startsWith('ignored:')) stats.ignored++; else stats.applied++;
            return res.json({ event_id: event.event_id, outcome });
        }

        if (!LIVE_TOPICS.includes(event.event_type)) {
            const inserted = await record(event.event_id, new Date(now()).toISOString());
            stats.ignored++;
            if (!inserted) { stats.duplicates++; return res.json({ event_id: event.event_id, duplicate: true, outcome: null }); }
            return res.json({ event_id: event.event_id, outcome: 'ignored:type' });
        }

        let result;
        try {
            result = await applyLive(event);
        } catch (err) {
            stats.failed++;
            log.error(`[OpenVibe.Today] event ${event.event_id} (${event.event_type}) failed:`, err.message);
            return problem(503, 'today.event_failed', 'processing failed; it will be retried');
        }
        if (result.duplicate) { stats.duplicates++; return res.json({ event_id: event.event_id, duplicate: true, outcome: null }); }
        if (String(result.outcome).startsWith('ignored:')) stats.ignored++; else stats.applied++;
        return res.json({ event_id: event.event_id, duplicate: false, outcome: result.outcome, ...(result.event_id ? { affected: result.event_id } : {}) });
    });

    /** The subscriptions this service needs: the two live topics plus the two account topics. */
    function startSubscriptions({ port = config.port, secret = secrets[0] || '', eventsUrl = config.events.url, fetchImpl = globalThis.fetch } = {}) {
        if (!eventsUrl || !secret || !config.oauth.clientSecret || process.env.TODAY_EVENTS_SUBSCRIBE === '0') return null;
        const base = String(eventsUrl).replace(/\/+$/, '');
        const endpoint = config.events.endpoint || `http://127.0.0.1:${port}/internal/events`;
        const tokens = serviceAuth.createTokenClient({
            tokenUrl: `${config.networkInternalUrl}/oauth/token`,
            clientId: config.oauth.clientId,
            clientSecret: config.oauth.clientSecret,
            audience: 'openvibe.events',
            scope: 'events.subscription.manage',
            fetchImpl,
        });
        const call = async (method, path, body) => {
            const res = await fetchImpl(`${base}${path}`, {
                method,
                headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...(await tokens.authHeaders()) },
                body: body ? JSON.stringify(body) : undefined,
                signal: AbortSignal.timeout(15000),
            });
            const json = await res.json().catch(() => ({}));
            return { status: res.status, ok: res.ok, body: json };
        };
        const attempt = async () => {
            const listed = await call('GET', '/api/v1/subscriptions');
            if (!listed.ok) throw new Error(`listing subscriptions: ${listed.status}`);
            const mine = (listed.body.subscriptions || []).filter((x) => x.endpoint === endpoint);
            for (const topic of topics) {
                if (mine.some((x) => x.topic_pattern === topic)) continue;
                const r = await call('POST', '/api/v1/subscriptions', { topic_pattern: topic, endpoint, secret });
                if (!r.ok && r.status !== 409) throw new Error(`subscribing to ${topic}: ${r.status} ${r.body.code || ''}`);
                if (r.ok) log.log(`[OpenVibe.Today] subscription created: ${r.body.id} (${topic} → ${endpoint})`);
            }
        };
        const delays = [0, 10_000, 60_000, 5 * 60_000, 15 * 60_000];
        let i = 0;
        let timer = null;
        let stopped = false;
        const run = () => {
            timer = null;
            if (stopped) return;
            attempt().catch((err) => {
                if (stopped) return;
                if (++i < delays.length) { timer = setTimeout(run, delays[i]); if (timer.unref) timer.unref(); } else log.warn('[OpenVibe.Today] subscriptions not created:', err.message);
            });
        };
        timer = setTimeout(run, delays[0]); if (timer.unref) timer.unref();
        return { topics, endpoint, stop() { stopped = true; if (timer) clearTimeout(timer); timer = null; } };
    }

    return { router, topics, stats: () => ({ ...stats, enabled: secrets.length > 0 }), startSubscriptions };
}

/** The boot-time half on its own (Help's shape): create the missing subscriptions for `topics`. */
function startSubscriptions({
    config, port = config.port, secret = '', eventsUrl = config.events.url, fetchImpl = globalThis.fetch,
    topics = [...LIVE_TOPICS, ...require('openvibe-sdk/account-data').TOPICS], log = console,
} = {}) {
    if (!eventsUrl || !secret || !config.oauth.clientSecret || process.env.TODAY_EVENTS_SUBSCRIBE === '0') return null;
    const base = String(eventsUrl).replace(/\/+$/, '');
    const endpoint = config.events.endpoint || `http://127.0.0.1:${port}/internal/events`;
    const tokens = serviceAuth.createTokenClient({
        tokenUrl: `${config.networkInternalUrl}/oauth/token`,
        clientId: config.oauth.clientId,
        clientSecret: config.oauth.clientSecret,
        audience: 'openvibe.events',
        scope: 'events.subscription.manage',
        fetchImpl,
    });
    const call = async (method, path, body) => {
        const res = await fetchImpl(`${base}${path}`, {
            method,
            headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...(await tokens.authHeaders()) },
            body: body ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(15000),
        });
        const json = await res.json().catch(() => ({}));
        return { status: res.status, ok: res.ok, body: json };
    };
    const attempt = async () => {
        const listed = await call('GET', '/api/v1/subscriptions');
        if (!listed.ok) throw new Error(`listing subscriptions: ${listed.status}`);
        const mine = (listed.body.subscriptions || []).filter((x) => x.endpoint === endpoint);
        for (const topic of topics) {
            if (mine.some((x) => x.topic_pattern === topic)) continue;
            const r = await call('POST', '/api/v1/subscriptions', { topic_pattern: topic, endpoint, secret });
            if (!r.ok && r.status !== 409) throw new Error(`subscribing to ${topic}: ${r.status} ${r.body.code || ''}`);
            if (r.ok) log.log(`[OpenVibe.Today] subscription created: ${r.body.id} (${topic} → ${endpoint})`);
        }
    };
    const delays = [0, 10_000, 60_000, 5 * 60_000, 15 * 60_000];
    let i = 0;
    let timer = null;
    let stopped = false;
    const run = () => {
        timer = null;
        if (stopped) return;
        attempt().catch((err) => {
            if (stopped) return;
            if (++i < delays.length) { timer = setTimeout(run, delays[i]); if (timer.unref) timer.unref(); }
            else log.warn('[OpenVibe.Today] subscriptions not created:', err.message);
        });
    };
    timer = setTimeout(run, delays[0]); if (timer.unref) timer.unref();
    return { topics, endpoint, stop() { stopped = true; if (timer) clearTimeout(timer); timer = null; } };
}

module.exports = { createEventsConsumer, startSubscriptions, LIVE_TOPICS, TOPICS, EVENT_ID_RE };
