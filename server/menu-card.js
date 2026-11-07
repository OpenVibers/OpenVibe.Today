'use strict';
// The menu's network card for OpenVibe.Today (frame.menu-card@1): GET /.well-known/openvibe-menu.json.
//
// Today publishes "Today": the next real public events scheduled for today (UTC), each with its own time and
// channel or place, linking to its event page. When nothing is left today the card moves to tomorrow and its
// title says "Tomorrow"; with nothing on either day it is still published, with no items, and Network skips it.
//
// Only public, non-cancelled events the public schedule already shows (events.listPublic) are read. Personal
// agendas, reminders and followers-only events never reach the card. The file is CORS *, cached for five
// minutes; a failed database keeps the last good card.
const BASE = 'https://openvibe.today';
const CARD_ID = 'today';
const SITE = 'today';
const CARD_TTL_S = 300;
const CACHE_MS = CARD_TTL_S * 1000;
const DAY = 24 * 60 * 60_000;
const LIMIT = 6;

/** Plain words for a card: no markup, no control characters, one line, within the schema's limit. */
function plain(value, max) {
    return String(value == null ? '' : value)
        .replace(/<[^>]*>/g, ' ')
        .replace(/[\u0000-\u001f\u007f]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, max);
}

/** The UTC day of an instant, YYYY-MM-DD. The card is the same for every reader, so "today" is UTC. */
const dayKey = (value) => new Date(value).toISOString().slice(0, 10);

/** The start of a UTC day, in milliseconds. */
const startOfDay = (value) => Date.parse(`${dayKey(value)}T00:00:00.000Z`);

/** "14:00 UTC" in the event's own zone (UTC when it has none or it is unknown). */
function timeLabel(iso, tz) {
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return '';
    const zone = tz || 'UTC';
    let parts;
    try {
        parts = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hour12: false, timeZoneName: 'short' }).formatToParts(d);
    } catch {
        parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit', hour12: false, timeZoneName: 'short' }).formatToParts(d);
    }
    const get = (type) => (parts.find((p) => p.type === type) || {}).value || '';
    const time = `${get('hour')}:${get('minute')}`;
    const zoneName = get('timeZoneName');
    return [time, zoneName].filter(Boolean).join(' ');
}

/** Where an event happens: its channel when it has one, else the host its link names, else the site. */
function placeOf(e) {
    if (e.channel) return `@${String(e.channel)}`;
    try {
        const host = new URL(String(e.url || '')).hostname.replace(/^www\./, '');
        if (host) return host;
    } catch { /* no link */ }
    return 'OpenVibe.Today';
}

/** The card itself. `events` are public events (events.listPublic rows); `at` is the build time. */
function cardFrom(events, at = Date.now()) {
    const upcoming = (Array.isArray(events) ? events : [])
        .filter((e) => e && e.starts_at && e.status !== 'cancelled' && e.status !== 'done')
        .filter((e) => !e.visibility || e.visibility === 'public')
        .filter((e) => {
            const start = Date.parse(String(e.starts_at));
            return Number.isFinite(start) && start >= at;
        })
        .sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at));
    const today = dayKey(at);
    const tomorrow = dayKey(at + DAY);
    const todayItems = upcoming.filter((e) => dayKey(e.starts_at) === today).slice(0, LIMIT);
    const next = todayItems.length ? todayItems : upcoming.filter((e) => dayKey(e.starts_at) === tomorrow).slice(0, LIMIT);
    const items = [];
    for (const e of next) {
        const title = plain(e.title, 80);
        if (!title) continue;
        const when = timeLabel(e.starts_at, e.tz);
        const meta = [when, plain(placeOf(e), 60)].filter(Boolean).join(' · ');
        items.push({ title, ...(meta ? { meta: plain(meta, 120) } : {}), url: `${BASE}/e/${encodeURIComponent(String(e.id))}` });
    }
    return {
        id: CARD_ID,
        site: SITE,
        title: todayItems.length ? 'Today' : (items.length ? 'Tomorrow' : 'Today'),
        kind: 'rows',
        items,
        more: { label: 'Full schedule', url: `${BASE}/` },
        updated_at: new Date(at).toISOString(),
        ttl_s: CARD_TTL_S,
    };
}

/** The route. `load(at)` returns the next two UTC days of public events; `now` is injectable for the test. */
function createMenuCard({ load, now = Date.now } = {}) {
    let cached = null;
    let cachedAt = 0;
    let pending = null;

    async function card() {
        const at = now();
        if (cached && at - cachedAt < CACHE_MS) return cached;
        if (pending) return pending;
        pending = (async () => {
            try {
                cached = cardFrom(await load(at), at);
                cachedAt = at;
            } catch {
                // Keep the last good card rather than publish an empty one on a database hiccup.
                if (!cached) { cached = cardFrom([], at); cachedAt = at; }
            }
            return cached;
        })().finally(() => { pending = null; });
        return pending;
    }

    async function handler(_req, res) {
        const body = await card();
        res.set('Cache-Control', 'public, max-age=60')
            .set('Access-Control-Allow-Origin', '*')
            .set('Cross-Origin-Resource-Policy', 'cross-origin')
            .json([body]);
    }

    return { card, handler, cardFrom, cacheMs: CACHE_MS };
}

module.exports = { createMenuCard, cardFrom, timeLabel, placeOf, dayKey, startOfDay, plain, BASE, CARD_ID, SITE, CARD_TTL_S, DAY, LIMIT };
