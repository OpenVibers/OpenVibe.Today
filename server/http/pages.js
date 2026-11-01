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

/** One event's end: its own, or an hour after it starts. */
const eventEnd = (e) => e.ends_at || new Date(new Date(e.starts_at).getTime() + 60 * 60_000).toISOString();

/**
 * The page's JSON-LD in one script: every node in one @graph, so a page carries exactly one JSON-LD script.
 * The nodes keep their own fields; only their own @context goes, because the graph carries it once.
 */
const oneGraph = (nodes) => {
    const graph = nodes.filter(Boolean).map((n) => { const c = { ...n }; delete c['@context']; return c; });
    return [{ '@context': 'https://schema.org', '@graph': graph }];
};

/** schema.org Event for one of this site's events. */
function eventJsonLd(e, config) {
    const base = String(config.baseUrl).replace(/\/+$/, '');
    const end = eventEnd(e);
    const organizer = e.channel
        ? { '@type': 'Person', name: `@${e.channel}`, url: `https://openvibe.live/@${encodeURIComponent(e.channel)}` }
        : { '@type': 'Organization', name: SITE_NAME, url: base };
    return {
        '@context': 'https://schema.org',
        '@type': 'Event',
        name: e.title,
        startDate: e.starts_at,
        endDate: end,
        eventStatus: e.status === 'cancelled' ? 'https://schema.org/EventCancelled' : 'https://schema.org/EventScheduled',
        eventAttendanceMode: 'https://schema.org/OnlineEventAttendanceMode',
        location: { '@type': 'VirtualLocation', url: e.url || `${base}/e/${e.id}` },
        organizer,
        ...(e.description ? { description: e.description } : {}),
        url: `${base}/e/${e.id}`,
    };
}

/**
 * The public pages' own options, so that the routes and the agent layer's Markdown twins
 * (openvibe-shared/agent-layer) render the very same page. `agent: true` marks a page that has a twin: the head and
 * the Link header advertise it. Nothing here is drawn for a signed-in person.
 */
function createPublicPageViews(ctx) {
    const { config, s, events } = ctx;
    const base = () => String(config.baseUrl).replace(/\/+$/, '');

    async function home() {
        const now = s.now();
        const HOLIDAYS = ['holiday', 'observance'];
        const rows = await events.listPublic({ from: new Date(now - 2 * 60 * 60_000).toISOString(), to: new Date(now + 60 * DAY).toISOString(), limit: 20, exceptKinds: HOLIDAYS });
        const holidays = await events.listPublic({ from: new Date(now - DAY).toISOString(), to: new Date(now + 8 * DAY).toISOString(), limit: 200, kinds: ['holiday'] });
        return {
            index: true, cache: PUBLIC_CACHE, agent: true,
            title: null,
            body: raw(views.home({ upcoming: rows, holidays, now })),
            description: 'Streams, events and reminders across OpenVibe on one calendar: schedule a stream, get reminded, and subscribe in your own calendar app.',
            // Every row on the page is a dated, public event the reader can open: that is exactly one Event node.
            jsonLd: oneGraph([...homeJsonLd(config), ...rows.map((e) => eventJsonLd(e, config)), seo.jsonLd.organization()]),
        };
    }

    function developers() {
        const description = 'The JSON API, the ICS feeds and the Events topics OpenVibe.Today publishes and consumes.';
        return {
            index: true, cache: PUBLIC_CACHE, agent: true,
            title: 'The OpenVibe.Today API',
            description,
            jsonLd: [seo.jsonLd.webPage({ name: 'The OpenVibe.Today API', url: `${base()}/developers`, description, siteUrl: base() })],
            body: raw(views.developers()),
        };
    }

    /** One public event as an anonymous visitor sees it (no reminders, no owner controls), or null. */
    async function event(id) {
        const row = await events.byIdForViewer(String(id || ''), null);
        if (!row) return null;
        const e = events.wire(row);
        if (e.visibility !== 'public' || e.status === 'cancelled') return null;
        return {
            index: true, cache: PUBLIC_CACHE, agent: true,
            title: e.title,
            description: (e.description || `${e.title} on OpenVibe.Today`).slice(0, 160),
            jsonLd: [eventJsonLd(e, config)],
            body: raw(views.event({ e, end: eventEnd(e), reminder: null, own: false, signedIn: false, path: `/e/${e.id}` })),
        };
    }

    return { home, developers, event };
}

function createPageRoutes(ctx) {
    const { config, s, events, feeds, agenda, brief, mine, calendarImports } = ctx;
    const r = asyncRouter();
    r.use(express.urlencoded({ extended: false, limit: '64kb' }));
    const base = () => String(config.baseUrl).replace(/\/+$/, '');
    const page = (req, res, o, status = 200) => send(res, status, { viewer: req.viewer, config, path: req.originalUrl, ...o });
    const signedIn = (req) => req.viewer && req.viewer.kind === 'user' && req.viewer.subject;
    const person = (req) => ({ subject: req.viewer.subject, token: req.viewer.token, username: req.viewer.username });
    const signInPrompt = (what, next) => html`<div class="notice">${what} <a href="/auth/login?next=${encodeURIComponent(next)}">Sign in with OpenVibe</a>.</div>`;

    // ── Home ─────────────────────────────────────────────────
    const publicViews = createPublicPageViews(ctx);
    r.get('/', async (req, res) => page(req, res, await publicViews.home()));

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
    r.get('/e/:id', async (req, res, next) => {
        // /e/<id>.md is the agent layer's Markdown twin (server/agent-pages.js), not an event id.
        if (String(req.params.id || '').endsWith('.md')) return next();
        const subject = signedIn(req) ? req.viewer.subject : null;
        const row = await events.byIdForViewer(String(req.params.id || ''), subject);
        if (!row) return notFound(req, res, 'No such event');
        const e = events.wire(row);
        const own = !!subject && row.owner_subject === subject;
        const reminder = subject ? ((await events.listReminders(subject)).find((x) => x.event_id === e.id) || null) : null;
        if (reminder && reminder.minutes_before == null) reminder.minutes_before = Math.round((new Date(e.starts_at).getTime() - new Date(reminder.remind_at).getTime()) / 60000);
        const end = eventEnd(e);
        const publicEvent = e.visibility === 'public' && e.status !== 'cancelled';
        return page(req, res, {
            index: publicEvent,
            cache: e.visibility === 'public' ? PUBLIC_CACHE : null,
            agent: publicEvent,
            title: e.title,
            description: (e.description || `${e.title} on OpenVibe.Today`).slice(0, 160),
            jsonLd: [eventJsonLd(e, config)],
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
        const own = mine ? await mine.list(p.subject) : [];
        const cals = calendarImports ? await calendarImports.list(p.subject) : [];
        return page(req, res, {
            title: 'Your agenda',
            description: 'Your own events, the reminders you set, the channels you follow and your private calendar feed.',
            body: raw(views.me({ name: req.viewer.displayName || req.viewer.username, agenda: a, reminders, feedUrl: feeds.url(config, token), now: s.now(), mine: own, myCalendars: cals, problem: String(req.query.problem || '').slice(0, 200) || null, said: String(req.query.said || '').slice(0, 500), calProblem: String(req.query.cal_problem || '').slice(0, 200) || null, calSaid: String(req.query.cal_url || '').slice(0, 500) })),
        });
    });

    // ── Your week (plan L48 R3): seven days in your own time zone ──
    // The zone: ?tz=, else the td_tz cookie today.js keeps from the browser, else the zone of the person's newest
    // reminder, else UTC.
    r.get('/me/week', async (req, res) => {
        if (!signedIn(req)) return page(req, res, { title: 'Your week', body: raw(views.signIn({ title: 'Your week', text: 'Your reminders, your events and the streams of the channels you follow, day by day.', next: '/me/week' })) }, 401);
        const p = person(req);
        const own = mine ? await mine.list(p.subject) : [];
        const asked = typeof req.query.tz === 'string' ? req.query.tz : (req.cookies && req.cookies.td_tz) || '';
        const tz = require('../when').validTz(asked) ? asked : ((own.find((x) => x.tz) || {}).tz || 'UTC');
        const start = typeof req.query.start === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.start) ? req.query.start : null;
        const first = require('../week').build({ tz, start, now: s.now(), reminders: [], events: [] });
        const rows = await agenda.windowFor({ subject: p.subject, token: p.token, fromMs: Date.parse(first.from), toMs: Date.parse(first.to), now: s.now() });
        const { wire: wireEvent } = require('../events/store');
        const reminded = new Set((await s.db.many('SELECT event_id FROM today_reminders WHERE subject = $1', [p.subject])).map((x) => x.event_id));
        const events = rows.map((x) => ({ ...wireEvent(x), own: x.owner_subject === p.subject, reminded: reminded.has(x.id) }));
        // The calendars they imported: read at most once every half hour, and drawn from the copy.
        const imported = calendarImports
            ? await calendarImports.events(p.subject, { from: Date.parse(first.from), to: Date.parse(first.to), tz })
            : { events: [], problems: [] };
        const w = require('../week').build({ tz, start, now: s.now(), reminders: own, events, imports: imported.events });
        return page(req, res, {
            title: 'Your week',
            description: 'Your reminders, your events and the streams of the channels you follow, day by day.',
            body: raw(views.week({ name: req.viewer.displayName || req.viewer.username, week: w, problems: imported.problems })),
        });
    });

    // ── "Remind me" from anywhere (plan L48 R3): /remind?title=&at=&url=&from= from any OpenVibe site ──
    const remindArgs = (q) => ({
        title: String(q.title || '').replace(/\s+/g, ' ').trim().slice(0, 200),
        at: String(q.at || '').slice(0, 40),
        url: /^https:\/\//.test(String(q.url || '')) ? String(q.url).slice(0, 2000) : '',
        from: /^[a-z][a-z0-9.-]{1,40}$/.test(String(q.from || '')) ? String(q.from) : '',
    });
    const zoneOf = (req, asked) => {
        const z = String(asked || (req.cookies && req.cookies.td_tz) || '');
        return require('../when').validTz(z) ? z : 'UTC';
    };
    r.get('/remind', async (req, res) => {
        const a = remindArgs(req.query || {});
        if (!signedIn(req)) {
            return page(req, res, { title: 'Remind me', body: raw(views.signIn({ title: a.title ? `Remind me: ${a.title}` : 'Remind me', text: 'Sign in with your OpenVibe account, and the reminder reaches you in the bell and as a push on every OpenVibe site.', next: req.originalUrl })) });
        }
        const tz = zoneOf(req, req.query.tz);
        res.set('Cache-Control', 'private, no-store');
        return page(req, res, { title: a.title ? `Remind me: ${a.title}` : 'Remind me', body: raw(views.remind({ ...a, tz, lead: 10 })) });
    });
    r.post('/remind', express.urlencoded({ extended: false, limit: '8kb' }), async (req, res) => {
        const b = req.body || {};
        const a = remindArgs(b);
        if (!signedIn(req)) return res.redirect(303, `/auth/login?next=${encodeURIComponent(`/remind?${new URLSearchParams(a)}`)}`);
        if (!sameOrigin(req, config.baseUrl)) return page(req, res, { title: 'Not from this site', body: raw(views.notFound()) }, 403);
        const tz = zoneOf(req, b.tz);
        if (!mine) return page(req, res, { title: 'Remind me', body: raw(views.remind({ ...a, tz, problem: 'Reminders are not available right now.' })) }, 503);
        const out = await mine.createAt(req.viewer.subject, { title: a.title, at: a.at, lead: b.lead, url: a.url, source: (a.from || hostOf(a.url) || 'today').replace(/^openvibe\./, '').replace(/[^a-z0-9-]/g, '-').slice(0, 30) || 'today', tz });
        if (out.error) return page(req, res, { title: 'Remind me', body: raw(views.remind({ ...a, tz, lead: Number(b.lead) || 10, problem: out.error })) }, 422);
        res.set('Cache-Control', 'private, no-store');
        return page(req, res, { title: 'Reminder set', body: raw(views.remindDone({ reminder: out.reminder, back: a.url, already: out.already, tz })) }, out.already ? 200 : 201);
    });
    const hostOf = (u) => { try { return new URL(u).host; } catch { return ''; } };

    // ── A person's own reminders (plan L48, R1): plain forms, so the page works without its script ──
    const mineGuard = (req, res, next) => {
        if (!signedIn(req)) return res.redirect(303, '/auth/login?next=%2Fme%23reminders');
        if (!sameOrigin(req, config.baseUrl)) return page(req, res, { title: 'Not from this site', body: raw(views.notFound()) }, 403);
        return next();
    };
    const toMine = (res, extra = '') => res.redirect(303, `/me${extra}#reminders`);
    r.post('/me/reminders', express.urlencoded({ extended: false, limit: '8kb' }), mineGuard, async (req, res) => {
        const b = req.body || {};
        const out = await mine.create(req.viewer.subject, { text: b.text, tz: b.tz, source: 'today' });
        if (out.error) return toMine(res, `?problem=${encodeURIComponent(out.error)}&said=${encodeURIComponent(String(b.text || '').slice(0, 500))}`);
        // Added from the week: back to the week, the one the reminder lands in.
        if (b.back === 'week') return res.redirect(303, '/me/week');
        return toMine(res);
    });
    r.post('/me/reminders/:id/:act(done|snooze|remove)', express.urlencoded({ extended: false, limit: '2kb' }), mineGuard, async (req, res) => {
        const id = String(req.params.id || '');
        if (req.params.act === 'done') await mine.done(req.viewer.subject, id);
        else if (req.params.act === 'snooze') await mine.snooze(req.viewer.subject, id, (req.body || {}).minutes || 60);
        else await mine.remove(req.viewer.subject, id);
        return toMine(res);
    });

    // ── The calendars a person imports (plan L48 R3): plain forms, so the page works without its script ──
    const calendarGuard = (req, res, next) => {
        if (!signedIn(req)) return res.redirect(303, '/auth/login?next=%2Fme%23calendars');
        if (!sameOrigin(req, config.baseUrl)) return page(req, res, { title: 'Not from this site', body: raw(views.notFound()) }, 403);
        return next();
    };
    r.post('/me/calendars', express.urlencoded({ extended: false, limit: '8kb' }), calendarGuard, async (req, res) => {
        const b = req.body || {};
        const out = await calendarImports.add(req.viewer.subject, { url: b.url, name: b.name });
        if (out.error) {
            return res.redirect(303, `/me?cal_problem=${encodeURIComponent(out.error)}&cal_url=${encodeURIComponent(String(b.url || '').slice(0, 500))}`);
        }
        return res.redirect(303, '/me#calendars');
    });
    r.post('/me/calendars/:id/remove', express.urlencoded({ extended: false, limit: '2kb' }), calendarGuard, async (req, res) => {
        await calendarImports.remove(req.viewer.subject, String(req.params.id || ''));
        return res.redirect(303, '/me#calendars');
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
    r.get('/developers', (req, res) => page(req, res, publicViews.developers()));

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

module.exports = { createPageRoutes, createPublicPageViews };
