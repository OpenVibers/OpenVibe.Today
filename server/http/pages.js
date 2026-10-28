'use strict';

/**
 * OpenVibe.Today's server-rendered pages. They work without JavaScript: forms are plain POSTs and every link is a
 * real link. Public pages are served `public, max-age=60` with Vary: Cookie; a page drawn for a signed-in person is
 * `private, no-store`.
 *
 *   /                 the public schedule
 *   /@:username       a channel's schedule, with its ICS link
 *   /e/:id            one event, with schema.org Event JSON-LD
 *   /me               agenda, reminders and the private feed URL
 *   /brief            today's brief
 *   /schedule         schedule a stream (the form POSTs and redirects to /e/:id)
 *   /developers       the API
 *   /ics/:file        a private token feed or a channel's public calendar
 */
const express = require('express');
const seo = require('openvibe-shared/seo');
const { asyncRouter } = require('./router');
const { createDiscoveryRoutes, homeJsonLd } = require('./discovery');
const { sameOrigin } = require('./principal');
const { html, raw, notice, badge, time } = require('../render/html');
const { send, SITE_NAME } = require('../render/layout');
const { calendar } = require('../ics');
const views = require('../views');

const PUBLIC_CACHE = 'public, max-age=60';
const DAY = 24 * 60 * 60_000;

function createPageRoutes(ctx) {
    const { config, s, events, feeds, agenda, brief } = ctx;
    const r = asyncRouter();
    r.use(express.urlencoded({ extended: false, limit: '64kb' }));
    const base = () => String(config.baseUrl).replace(/\/+$/, '');
    const page = (req, res, o, status = 200) => send(res, status, { viewer: req.viewer, config, path: req.originalUrl, ...o });
    const signedIn = (req) => req.viewer && req.viewer.kind === 'user' && req.viewer.subject;
    const person = (req) => ({ subject: req.viewer.subject, token: req.viewer.token, username: req.viewer.username });
    const signInPrompt = (what, next) => html`<div class="notice">${what} <a href="/auth/login?next=${encodeURIComponent(next)}">Sign in with OpenVibe</a>.</div>`;

    // ── Home ─────────────────────────────────────────────────
    r.get('/', async (req, res) => {
        const now = s.now();
        const rows = await events.listPublic({ from: new Date(now - 2 * 60 * 60_000).toISOString(), to: new Date(now + 60 * DAY).toISOString(), limit: 20 });
        return page(req, res, {
            index: true, cache: PUBLIC_CACHE,
            title: null,
            body: raw(views.home({ upcoming: rows, now })),
            description: 'Streams, events and reminders across OpenVibe on one calendar: schedule a stream, get reminded, and subscribe in your own calendar app.',
            jsonLd: homeJsonLd(config),
        });
    });

    // ── A channel's schedule ────────────────────────────────
    r.get('/@:username', async (req, res) => {
        const username = String(req.params.username || '');
        if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/.test(username)) return notFound(req, res, 'No such channel');
        const now = s.now();
        const rows = await events.listChannel(username, { from: new Date(now - 7 * DAY).toISOString(), to: new Date(now + 60 * DAY).toISOString() });
        return page(req, res, {
            index: true, cache: PUBLIC_CACHE,
            title: `@${username}'s schedule`,
            description: `OpenVibe.Today's public schedule for @${username}, with an ICS calendar feed.`,
            body: raw(views.channel({ username, rows, now })),
        });
    });

    // ── One event's calendar file ("Add to calendar") ──────
    r.get('/e/:id.ics', async (req, res) => {
        const subject = signedIn(req) ? req.viewer.subject : null;
        const row = await events.byIdForViewer(String(req.params.id || ''), subject);
        if (!row) return res.status(404).type('text/plain').send('Not found');
        res.set('Content-Type', 'text/calendar; charset=utf-8');
        res.set('Content-Disposition', `attachment; filename="${row.id}.ics"`);
        res.set('Cache-Control', row.visibility === 'public' ? 'public, max-age=60' : 'private, no-store');
        return res.send(calendar({ name: row.title, events: [events.wire(row)], now: s.now(), baseUrl: base() }));
    });

    // ── Remind, remove, cancel (plain forms; the API does the same) ──
    const formGuard = (req, res, next) => {
        if (!signedIn(req)) return res.redirect(303, `/auth/login?next=${encodeURIComponent(`/e/${req.params.id}`)}`);
        if (!sameOrigin(req, config.baseUrl)) return page(req, res, { title: 'Not from this site', body: raw(views.notFound()) }, 403);
        return next();
    };
    r.post('/e/:id/remind', formGuard, async (req, res) => {
        await events.remind({ subject: req.viewer.subject, id: String(req.params.id), minutesBefore: (req.body || {}).minutes_before, now: s.now() });
        return res.redirect(303, `/e/${encodeURIComponent(req.params.id)}`);
    });
    r.post('/e/:id/remind/remove', formGuard, async (req, res) => {
        await events.unremind({ subject: req.viewer.subject, id: String(req.params.id) });
        return res.redirect(303, `/e/${encodeURIComponent(req.params.id)}`);
    });
    r.post('/e/:id/cancel', formGuard, async (req, res) => {
        await events.cancel({ id: String(req.params.id), subject: req.viewer.subject });
        return res.redirect(303, `/e/${encodeURIComponent(req.params.id)}`);
    });

    // ── One event ───────────────────────────────────────────
    r.get('/e/:id', async (req, res) => {
        const subject = signedIn(req) ? req.viewer.subject : null;
        const row = await events.byIdForViewer(String(req.params.id || ''), subject);
        if (!row) return notFound(req, res, 'No such event');
        const e = events.wire(row);
        const own = !!subject && row.owner_subject === subject;
        const reminder = subject ? ((await events.listReminders(subject)).find((x) => x.event_id === e.id) || null) : null;
        if (reminder && reminder.minutes_before == null) reminder.minutes_before = Math.round((new Date(e.starts_at).getTime() - new Date(reminder.remind_at).getTime()) / 60000);
        const end = e.ends_at || new Date(new Date(e.starts_at).getTime() + 60 * 60_000).toISOString();
        const organizer = e.channel
            ? { '@type': 'Person', name: `@${e.channel}`, url: `https://openvibe.live/@${encodeURIComponent(e.channel)}` }
            : { '@type': 'Organization', name: SITE_NAME, url: base() };
        const jsonLd = {
            '@context': 'https://schema.org',
            '@type': 'Event',
            name: e.title,
            startDate: e.starts_at,
            endDate: end,
            eventStatus: e.status === 'cancelled' ? 'https://schema.org/EventCancelled' : 'https://schema.org/EventScheduled',
            eventAttendanceMode: 'https://schema.org/OnlineEventAttendanceMode',
            location: { '@type': 'VirtualLocation', url: e.url || `${base()}/e/${e.id}` },
            organizer,
            ...(e.description ? { description: e.description } : {}),
            url: `${base()}/e/${e.id}`,
        };
        return page(req, res, {
            index: e.visibility === 'public' && e.status !== 'cancelled',
            cache: e.visibility === 'public' ? PUBLIC_CACHE : null,
            title: e.title,
            description: (e.description || `${e.title} on OpenVibe.Today`).slice(0, 160),
            jsonLd: [jsonLd],
            body: raw(views.event({ e, end, reminder, own, signedIn: !!subject, path: req.originalUrl })),
        });
    });

    // ── Your agenda ─────────────────────────────────────────
    r.get('/me', async (req, res) => {
        if (!signedIn(req)) return page(req, res, { title: 'Your agenda', body: raw(views.signIn({ title: 'Your agenda', text: 'Your events, your reminders and the channels you follow, in one place and in your own calendar app.', next: '/me' })) }, 401);
        const p = person(req);
        const a = await agenda.forSubject({ subject: p.subject, token: p.token, days: 14, now: s.now() });
        const reminders = await events.listReminders(p.subject);
        const token = await feeds.getOrCreate(p.subject);
        return page(req, res, {
            title: 'Your agenda',
            description: 'Your own events, the reminders you set, the channels you follow and your private calendar feed.',
            body: raw(views.me({ name: req.viewer.displayName || req.viewer.username, agenda: a, reminders, feedUrl: feeds.url(config, token), now: s.now() })),
        });
    });

    r.post('/me/feed/rotate', async (req, res) => {
        if (!signedIn(req)) return page(req, res, { title: 'Sign in', body: html`<h1>Sign in first</h1>${signInPrompt('A feed belongs to an account.', '/me')}` }, 401);
        if (!sameOrigin(req, config.baseUrl)) return page(req, res, { title: 'Not from this site', body: html`<h1>That came from somewhere else</h1><p class="muted">Replace a feed from <a href="/me">your agenda</a>.</p>` }, 403);
        await feeds.rotate(req.viewer.subject);
        return res.redirect(303, '/me');
    });

    // ── The brief ───────────────────────────────────────────
    r.get('/brief', async (req, res) => {
        if (!signedIn(req)) return page(req, res, { title: 'Your brief', body: raw(views.signIn({ title: 'Your brief', text: 'One short page for your day: what is coming up, your reminders and what streamers talked about yesterday.', next: '/brief' })) }, 401);
        const tz = typeof req.query.tz === 'string' && req.query.tz ? req.query.tz : 'UTC';
        const out = await brief.getOrBuild(req.viewer.subject, { now: s.now(), tz, token: req.viewer.token });
        return page(req, res, {
            title: `Your brief for ${out.day}`,
            description: 'What is left of today, your reminders and what OpenVibe.Live talked about yesterday.',
            body: raw(views.brief({ out, name: req.viewer.displayName || req.viewer.username, tz })),
        });
    });

    // ── Schedule a stream ───────────────────────────────────
    /** "2026-10-30T20:00" read as wall time in tz → ISO UTC (null when it is not that shape). */
    function wallToUtc(local, tz) {
        const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(local || ''));
        if (!m) return null;
        const asUtc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
        const offset = (t) => {
            const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
                .formatToParts(new Date(t)).map((x) => [x.type, x.value]));
            return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) - t;
        };
        try { let t = asUtc - offset(asUtc); t = asUtc - offset(t); return new Date(t).toISOString(); } catch { return null; }
    }
    const scheduleForm = (values = {}, problem = null) => raw(views.schedule({ values, problem }));

    r.get('/schedule', async (req, res) => {
        if (!signedIn(req)) return page(req, res, { title: 'Schedule a stream', body: raw(views.signIn({ title: 'Schedule a stream', text: 'Scheduling belongs to your OpenVibe account, so it shows on your channel and you can change or cancel it later.', next: '/schedule' })) }, 401);
        return page(req, res, {
            title: 'Schedule a stream',
            description: 'Put a stream or an event on your OpenVibe.Today schedule.',
            body: scheduleForm({ tz: typeof req.query.tz === 'string' ? req.query.tz : 'UTC' }),
        });
    });

    r.post('/schedule', async (req, res) => {
        if (!signedIn(req)) return page(req, res, { title: 'Sign in', body: html`<h1>Sign in first</h1>${signInPrompt('Scheduling belongs to an account.', '/schedule')}` }, 401);
        if (!sameOrigin(req, config.baseUrl)) return page(req, res, { title: 'Not from this site', body: html`<h1>That came from somewhere else</h1><p class="muted">Schedule from <a href="/schedule">the form</a>.</p>` }, 403);
        const b = req.body || {};
        const tz = b.tz || 'UTC';
        // The form's datetime-local is wall time in the chosen zone; the API takes an instant.
        const startsAt = wallToUtc(b.starts_at, tz) || b.starts_at;
        const length = Math.min(24 * 60, Math.max(0, parseInt(b.length, 10) || 0));
        const body = { kind: b.kind || 'stream', title: b.title, description: b.description, visibility: b.visibility, tz, starts_at: startsAt,
            ...(length && startsAt && !Number.isNaN(Date.parse(startsAt)) ? { ends_at: new Date(Date.parse(startsAt) + length * 60_000).toISOString() } : {}) };
        const out = await events.create({ subject: req.viewer.subject, username: req.viewer.username, body, now: s.now() });
        if (!out.ok) {
            return page(req, res, {
                title: 'Schedule a stream',
                body: scheduleForm({ ...b, tz }, out.message || 'That could not be scheduled.'),
            }, out.status || 400);
        }
        return res.redirect(303, `/e/${out.event.id}`);
    });

    // ── Developers ──────────────────────────────────────────
    r.get('/developers', (req, res) => page(req, res, {
        index: true, cache: PUBLIC_CACHE,
        title: 'The OpenVibe.Today API',
        description: 'The JSON API, the ICS feeds and the Events topics OpenVibe.Today publishes and consumes.',
        jsonLd: [seo.jsonLd.webPage({ name: 'The OpenVibe.Today API', url: `${base()}/developers`, description: 'The JSON API, the ICS feeds and the Events topics OpenVibe.Today publishes and consumes.', siteUrl: base() })],
        body: raw(views.developers()),
    }));

    // ── ICS feeds ───────────────────────────────────────────
    r.get('/ics/:file', async (req, res) => {
        const file = String(req.params.file || '');
        if (!file.endsWith('.ics')) return res.status(404).type('text/plain').send('Not found');
        const key = file.slice(0, -4);
        const now = s.now();
        const fromMs = now - 7 * DAY;
        const toMs = now + 60 * DAY;
        const nowDate = new Date(now).toISOString();
        if (key.startsWith('@')) {
            const username = key.slice(1);
            if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/.test(username)) return res.status(404).type('text/plain').send('Not found');
            const rows = (await events.listChannel(username, { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString(), includeCancelled: true }))
                .filter((e) => e.status !== 'cancelled' || new Date(e.updated_at).getTime() >= fromMs);
            res.set('Content-Type', 'text/calendar; charset=utf-8');
            res.set('Cache-Control', 'public, max-age=300');
            return res.send(calendar({ name: `${SITE_NAME} — @${username}`, events: rows, now, baseUrl: base() }));
        }
        const feed = await feeds.findByToken(key);
        if (!feed) return res.status(404).type('text/plain').send('Not found');
        const rows = await agenda.windowFor({ subject: feed.subject, token: null, fromMs, toMs, now });
        res.set('Content-Type', 'text/calendar; charset=utf-8');
        res.set('Cache-Control', 'private, max-age=300');
        return res.send(calendar({ name: `${SITE_NAME} — your agenda`, events: rows.map((x) => events.wire(x)), now, baseUrl: base() }));
    });

    // ── Discovery ───────────────────────────────────────────
    r.use(createDiscoveryRoutes(ctx));

    function notFound(req, res, title) {
        return page(req, res, {
            title,
            body: raw(views.notFound()),
        }, 404);
    }

    return r;
}

module.exports = { createPageRoutes };
