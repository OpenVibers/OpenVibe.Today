'use strict';

/**
 * The brief (v1, text): what is left of today, the reminders due today, and up to three things from OpenVibe.Live's
 * public Rundown API. `buildBrief(subject, { now, tz })` returns `{ day, sections }`; `getOrBuild` stores one brief
 * per subject per day in today_briefs. The daily job at 06:00 UTC builds briefs for subjects active in the last
 * 30 days (a reminder, an own event or a feed); v1 does not notify.
 *
 * A brief built for a request with the person's token can include the channels they follow; the daily job has no
 * token and therefore uses the same agenda with own and reminded events only.
 */
const { isIanaZone } = require('./events/validate');

function dayIn(tz, ms) {
    try {
        const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(ms));
        const get = (t) => parts.find((p) => p.type === t).value;
        return `${get('year')}-${get('month')}-${get('day')}`;
    } catch {
        return new Date(ms).toISOString().slice(0, 10);
    }
}

function timeIn(tz, ms) {
    try {
        return new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(new Date(ms));
    } catch {
        return new Date(ms).toISOString().slice(11, 16) + ' UTC';
    }
}

function createBrief({ config, s, agenda, fetchImpl = globalThis.fetch, log = console }) {
    const db = s.db;
    const base = String(config.baseUrl).replace(/\/+$/, '');

    async function rundownItems(now) {
        try {
            const res = await fetchImpl(`${config.live.internalUrl.replace(/\/+$/, '')}/api/rundown`, {
                headers: { Accept: 'application/json' },
                signal: AbortSignal.timeout(config.live.timeoutMs),
            });
            if (!res.ok) throw new Error(`rundown ${res.status}`);
            const data = await res.json().catch(() => null);
            if (!data || typeof data !== 'object') throw new Error('rundown: no body');
            const yesterday = dayIn('UTC', now - 24 * 60 * 60_000);
            const isYesterday = (v) => {
                if (!v) return true;   // a fixture without a date is still a Rundown item
                const d = new Date(v);
                return Number.isNaN(d.getTime()) || dayIn('UTC', d.getTime()) === yesterday;
            };
            const items = [];
            const seen = new Set();
            const push = (text, url, at) => {
                if (items.length >= 3 || !text || !url || seen.has(url) || !isYesterday(at)) return;
                seen.add(url);
                items.push({ text: String(text).slice(0, 300), url, action: null });
            };
            const lead = data.lead;
            if (lead) {
                const who = lead.user && (lead.user.display_name || lead.user.username);
                const what = lead.take || lead.title || lead.topic && lead.topic.title;
                const url = lead.topic && lead.topic.slug
                    ? `https://openvibe.live/rundown/t/${encodeURIComponent(lead.topic.slug)}`
                    : `https://openvibe.live/rundown/e/${encodeURIComponent(lead.stream_id)}`;
                push(`${what || 'A moment'}${who ? ` — ${who}` : ''}`, url, lead.said_at);
            }
            for (const stream of Array.isArray(data.streams) ? data.streams : []) {
                const ep = stream.episode || stream;
                const who = (ep.user || stream.user) && ((ep.user || stream.user).display_name || (ep.user || stream.user).username);
                const what = ep.title || ep.logline || stream.talking_about;
                const id = ep.stream_id || stream.stream_id || stream.id;
                if (id) push(`${what || 'An episode'}${who ? ` — ${who}` : ''}`, `https://openvibe.live/rundown/e/${encodeURIComponent(id)}`, ep.aired_at || stream.said_at);
            }
            for (const topic of Array.isArray(data.trending) ? data.trending : []) {
                if (!topic.slug) continue;
                const extra = topic.streamers ? ` — ${topic.streamers} streamer${Number(topic.streamers) === 1 ? '' : 's'}` : '';
                push(`${topic.headline || topic.title}${extra}`, `https://openvibe.live/rundown/t/${encodeURIComponent(topic.slug)}`, topic.last_seen_at);
            }
            return items;
        } catch (err) {
            log.warn(`[OpenVibe.Today] Rundown unavailable for the brief: ${(err && err.message) || err}`);
            return null;
        }
    }

    async function buildBrief(subject, { now = s.now(), tz = 'UTC', token = null } = {}) {
        if (!isIanaZone(tz)) tz = 'UTC';
        const day = dayIn(tz, now);
        const sections = [];

        const agendaOut = await agenda.forSubject({ subject, token, days: 2, now });
        const today = agendaOut.events.filter((e) => (e.status === 'scheduled' || e.status === 'live') && dayIn(tz, new Date(e.starts_at).getTime()) === day);
        const later = [];
        for (const e of today) {
            const when = e.status === 'live' ? 'live now' : `at ${timeIn(tz, new Date(e.starts_at).getTime())}`;
            later.push({ text: `${e.title} ${when}`, url: `${base}/e/${e.id}`, action: 'remind' });
        }
        if (later.length) sections.push({ id: 'later-today', title: 'Later today', items: later });

        const reminderRows = await db.many(
            `SELECT r.remind_at, e.* FROM today_reminders r JOIN today_events e ON e.id = r.event_id
             WHERE r.subject = $1 AND e.status IN ('scheduled', 'live') ORDER BY r.remind_at ASC`,
            [subject],
        );
        const reminders = reminderRows
            .filter((r) => dayIn(tz, new Date(r.remind_at).getTime()) === day)
            .map((r) => ({ text: `${r.title} — reminder at ${timeIn(tz, new Date(r.remind_at).getTime())}`, url: `${base}/e/${r.id}`, action: 'remind' }));
        if (reminders.length) sections.push({ id: 'your-reminders', title: 'Your reminders', items: reminders });

        const rundown = await rundownItems(now);
        if (rundown && rundown.length) sections.push({ id: 'yesterday', title: 'Yesterday on OpenVibe', items: rundown });

        return { day, sections };
    }

    async function getOrBuild(subject, opts = {}) {
        const tz = isIanaZone(opts.tz) ? opts.tz : 'UTC';
        const day = dayIn(tz, opts.now == null ? s.now() : opts.now);
        const found = await db.maybe('SELECT body FROM today_briefs WHERE subject = $1 AND day = $2::date', [subject, day]);
        if (found) return { day, sections: found.body || [] };
        const built = await buildBrief(subject, { ...opts, tz });
        await db.exec(
            'INSERT INTO today_briefs (subject, day, body, created_at) VALUES ($1, $2::date, $3::jsonb, $4::timestamptz) ON CONFLICT (subject, day) DO NOTHING',
            [subject, built.day, JSON.stringify(built.sections), new Date(s.now()).toISOString()],
        );
        const stored = await db.maybe('SELECT body FROM today_briefs WHERE subject = $1 AND day = $2::date', [subject, built.day]);
        return { day: built.day, sections: stored ? (stored.body || []) : built.sections };
    }

    /** The daily job: subjects with a reminder, an own event or a feed in the last 30 days. */
    async function runOnce({ now = s.now(), force = false } = {}) {
        const at = new Date(now);
        if (!force && at.getUTCHours() !== config.brief.hourUtc) return { built: 0, skipped: 'hour' };
        const cutoff = new Date(now - config.brief.activeDays * 24 * 60 * 60_000).toISOString();
        const rows = await db.many(
            `SELECT DISTINCT subject FROM (
               SELECT subject FROM today_reminders WHERE created_at >= $1::timestamptz
               UNION SELECT owner_subject AS subject FROM today_events WHERE created_at >= $1::timestamptz OR updated_at >= $1::timestamptz
               UNION SELECT subject FROM today_feeds WHERE created_at >= $1::timestamptz
             ) s ORDER BY subject`,
            [cutoff],
        );
        let built = 0;
        for (const row of rows) {
            try {
                await getOrBuild(row.subject, { now, tz: 'UTC' });
                built++;
            } catch (err) {
                log.warn(`[OpenVibe.Today] brief for ${row.subject} failed: ${(err && err.message) || err}`);
            }
        }
        return { built, subjects: rows.length };
    }

    let timer = null;
    let lastDay = null;
    function start() {
        if (timer || config.drill) return false;
        timer = setInterval(() => {
            const now = s.now();
            const day = dayIn('UTC', now);
            if (day === lastDay) return;
            runOnce({ now }).then((r) => { if (r.subjects !== undefined) lastDay = day; }).catch((err) => log.warn('[OpenVibe.Today] brief tick failed:', err.message));
        }, 60_000);
        if (timer.unref) timer.unref();
        return true;
    }
    function stop() {
        if (timer) clearInterval(timer);
        timer = null;
    }

    const handle = { buildBrief, getOrBuild, runOnce, start, stop, rundownItems };
    active = handle;
    return handle;
}

// The module-level name the spec gives. It uses the builder the app created most recently; a test that boots one
// app can call require('../server/brief').buildBrief(subject, { now, tz }) directly.
let active = null;
async function buildBrief(subject, opts = {}) {
    if (!active) throw new Error('buildBrief: no Today app has created a brief builder in this process yet');
    return active.buildBrief(subject, opts);
}

module.exports = { createBrief, buildBrief, dayIn, timeIn };
