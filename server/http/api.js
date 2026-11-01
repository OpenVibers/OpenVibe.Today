'use strict';

/**
 * /api/v1 — OpenVibe.Today's JSON API.
 *
 *   GET    /events?channel=&from=&to=&limit=   public events, soonest first, cached 60 s
 *   GET    /events/:id                         one event (owner sees a followers-only one; cancelled answers)
 *   POST   /events                             schedule a stream or an event (signed in, Idempotency-Key honoured)
 *   PATCH  /events/:id                         change one (owner; seq + 1)
 *   DELETE /events/:id                         cancel one (owner; idempotent)
 *   POST   /events/:id/remind                  set a reminder (signed in)
 *   DELETE /events/:id/remind                  remove it
 *   GET    /me/reminders                       the caller's upcoming reminders
 *   GET    /me/agenda?days=14                  own + reminded + followed channels, or follows_unavailable
 *   GET    /me/feed                            the private ICS URL, created on first call
 *   POST   /me/feed/rotate                     replace it (the old URL is 404 at once)
 *   GET    /me/brief                           today's brief, built on demand when missing
 *   POST   /reminders/parse                    what plain words mean: { text, tz } → { title, summary, next_at, rule }
 *   GET    /reminders                          the caller's own reminders (active first)
 *   POST   /reminders                          set one from plain words: { text, tz, url?, source? }
 *   POST   /reminders/:id/done · /snooze       done, or later by { minutes }
 *   DELETE /reminders/:id                      remove it
 *
 * A person is the session cookie (today_at) or Authorization: Bearer <Network user token>, verified offline with
 * the Network JWKS. A write made with the session cookie must come from openvibe.today itself (403
 * today.cross_site). Errors are JSON: { code, message } (a validation refusal adds { field }).
 */
const express = require('express');
const { asyncRouter } = require('./router');
const { sameOrigin } = require('./principal');
const { parseTime, isIanaZone } = require('../events/validate');

function createApi(ctx) {
    const { config, s, principal, events, feeds, follows, agenda, brief, mine } = ctx;
    const r = asyncRouter();

    const invalid = (res, field, message) => res.status(400).json({ code: 'today.invalid', field, message });
    const refuse = (res, status, code, message) => res.status(status).json({ code, message });

    r.use(express.json({ limit: '64kb' }));
    r.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
    r.use(principal.middleware);

    function person(req, res) {
        const p = req.principal;
        if (p.kind === 'anonymous') { refuse(res, 401, 'today.sign_in_required', 'Sign in at openvibe.today, or send a person\'s Network token as a Bearer.'); return null; }
        if (p.kind !== 'user') { refuse(res, 403, 'today.person_required', 'A schedule belongs to a person; an app, agent or service token cannot change one.'); return null; }
        if (p.viaSession && req.method !== 'GET' && !sameOrigin(req, config.baseUrl)) {
            refuse(res, 403, 'today.cross_site', 'A signed-in request that changes something must come from openvibe.today itself.');
            return null;
        }
        return p;
    }
    const requirePerson = (req, res, next) => (person(req, res) ? next() : undefined);

    // A person's own reminders: the person (as for everything else here), or a first-party service holding
    // today.reminder.write that names the person with X-OV-Subject (Vibe's "remind me…", plan L48). An app or a
    // module never can, and a service acts for one person per request. req.actor = { subject, source }.
    const USR = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
    function reminderActor(req, res, next) {
        const p = req.principal;
        if (p.kind === 'user') {
            if (!person(req, res)) return undefined;
            req.actor = { subject: p.subject, source: null };
            return next();
        }
        if (p.kind === 'app') {
            const caps = Array.isArray(p.claims && p.claims.cap) ? p.claims.cap : String((p.claims && p.claims.cap) || '').split(/[\s,]+/);
            if (!String(p.requester || '').startsWith('service:')) return refuse(res, 403, 'today.person_required', 'Only a first-party service may set a person\'s reminders, for that person.');
            if (!caps.includes('today.reminder.write')) return refuse(res, 403, 'capability.denied', 'This service does not hold today.reminder.write.');
            const named = String(req.get('x-ov-subject') || '');
            if (!USR.test(named)) return refuse(res, 400, 'today.subject_required', 'Name the person with X-OV-Subject: usr_…');
            req.actor = { subject: named, source: String(p.requester).slice('service:'.length).replace(/[^a-z0-9-]/g, '').slice(0, 30) || null };
            return next();
        }
        return refuse(res, 401, 'today.sign_in_required', 'Sign in at openvibe.today, or send a person\'s Network token as a Bearer.');
    }

    function jsonError(res, out) {
        return res.status(out.status || 400).json({ code: out.code || 'today.invalid', ...(out.field ? { field: out.field } : {}), message: out.message || 'invalid request' });
    }

    /** A query bound: an ISO time, or a date (read as UTC midnight) for convenience in a URL. */
    function queryTime(v) {
        const d = parseTime(v);
        if (d) return d;
        if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
            const x = new Date(`${v}T00:00:00Z`);
            return Number.isNaN(x.getTime()) ? null : x;
        }
        return null;
    }

    r.get('/ping', (_req, res) => res.json({ ok: true, service: config.service }));

    // ── Public reads ────────────────────────────────────────
    r.get('/events', async (req, res) => {
        const now = s.now();
        let from = new Date(now - 2 * 60 * 60_000);
        if (req.query.from != null && req.query.from !== '') {
            const d = queryTime(req.query.from);
            if (!d) return invalid(res, 'from', 'from must be an ISO time');
            from = d;
        }
        let to = new Date(now + 60 * 24 * 60 * 60_000);
        if (req.query.to != null && req.query.to !== '') {
            const d = queryTime(req.query.to);
            if (!d) return invalid(res, 'to', 'to must be an ISO time');
            to = d;
        }
        if (from.getTime() > to.getTime()) return invalid(res, 'from', 'from must not be later than to');
        const channel = typeof req.query.channel === 'string' && req.query.channel.trim() ? req.query.channel.trim().replace(/^@/, '').slice(0, 64) : null;
        const limit = req.query.limit == null || req.query.limit === '' ? 50 : Number.parseInt(req.query.limit, 10);
        if (!Number.isFinite(limit) || limit < 1) return invalid(res, 'limit', 'limit must be from 1 to 100');
        const rows = await events.listPublic({ channel, from: from.toISOString(), to: to.toISOString(), limit });
        res.set('Cache-Control', 'public, max-age=60');
        return res.json({ from: from.toISOString(), to: to.toISOString(), count: rows.length, events: rows });
    });

    r.get('/events/:id', async (req, res) => {
        const subject = req.principal.kind === 'user' ? req.principal.subject : null;
        const row = await events.byIdForViewer(String(req.params.id || ''), subject);
        if (!row) return refuse(res, 404, 'today.not_found', 'No such event.');
        if (row.visibility === 'public') res.set('Cache-Control', 'public, max-age=60');
        return res.json(events.wire(row));
    });

    // ── Writes ──────────────────────────────────────────────
    r.post('/events', requirePerson, async (req, res) => {
        const p = req.principal;
        const key = req.get('Idempotency-Key');
        if (key != null && key.length > 100) return invalid(res, 'idempotency_key', 'Idempotency-Key must be at most 100 characters');
        const out = await events.create({ subject: p.subject, username: p.username, body: req.body || {}, idempotencyKey: key || null, now: s.now() });
        if (!out.ok) return jsonError(res, out);
        res.set('Location', `/api/v1/events/${out.event.id}`);
        return res.status(out.replayed ? 200 : 201).json(out.event);
    });

    r.patch('/events/:id', requirePerson, async (req, res) => {
        const out = await events.patch({ id: String(req.params.id || ''), subject: req.principal.subject, body: req.body || {}, now: s.now() });
        if (!out.ok) return jsonError(res, out);
        return res.json(out.event);
    });

    r.delete('/events/:id', requirePerson, async (req, res) => {
        const out = await events.cancel({ id: String(req.params.id || ''), subject: req.principal.subject });
        if (!out.ok) return jsonError(res, out);
        return res.json(out.event);
    });

    // ── Reminders ───────────────────────────────────────────
    r.post('/events/:id/remind', requirePerson, async (req, res) => {
        const b = req.body && typeof req.body === 'object' ? req.body : {};
        const out = await events.remind({ subject: req.principal.subject, id: String(req.params.id || ''), minutesBefore: b.minutes_before, now: s.now() });
        if (!out.ok) return jsonError(res, out);
        return res.json({ event_id: out.reminder.event_id, remind_at: out.reminder.remind_at, minutes_before: out.reminder.minutes_before });
    });

    r.delete('/events/:id/remind', requirePerson, async (req, res) => {
        const out = await events.unremind({ subject: req.principal.subject, id: String(req.params.id || '') });
        return res.json(out);
    });

    r.get('/me/reminders', requirePerson, async (req, res) => {
        res.json({ reminders: await events.listReminders(req.principal.subject) });
    });

    // ── A person's own reminders (plan L48, R1) ────────────
    const body = (req) => (req.body && typeof req.body === 'object' ? req.body : {});
    r.post('/reminders/parse', reminderActor, (req, res) => {
        const b = body(req);
        const out = mine.preview({ text: b.text, tz: b.tz });
        return out.error ? res.status(422).json({ error: out.error }) : res.json(out);
    });
    r.get('/reminders', reminderActor, async (req, res) => {
        res.set('Cache-Control', 'private, no-store').json({ reminders: await mine.list(req.actor.subject) });
    });
    r.post('/reminders', reminderActor, async (req, res) => {
        const b = body(req);
        const out = await mine.create(req.actor.subject, { text: b.text, tz: b.tz, url: b.url, source: b.source || req.actor.source || 'today' });
        return out.error ? res.status(422).json({ error: out.error }) : res.status(201).json(out);
    });
    r.post('/reminders/:id/done', reminderActor, async (req, res) => {
        const out = await mine.done(req.actor.subject, String(req.params.id));
        return out ? res.json(out) : res.status(404).json({ error: 'No such reminder' });
    });
    r.post('/reminders/:id/snooze', reminderActor, async (req, res) => {
        const out = await mine.snooze(req.actor.subject, String(req.params.id), body(req).minutes);
        return out ? res.json(out) : res.status(404).json({ error: 'No such reminder' });
    });
    r.delete('/reminders/:id', reminderActor, async (req, res) => {
        return (await mine.remove(req.actor.subject, String(req.params.id))) ? res.status(204).end() : res.status(404).json({ error: 'No such reminder' });
    });

    r.get('/me/agenda', requirePerson, async (req, res) => {
        const raw = req.query.days == null || req.query.days === '' ? 14 : Number.parseInt(req.query.days, 10);
        if (!Number.isFinite(raw) || raw < 1 || raw > 60) return invalid(res, 'days', 'days must be a whole number from 1 to 60');
        const out = await agenda.forSubject({ subject: req.principal.subject, token: req.principal.token, days: raw, now: s.now() });
        return res.json(out);
    });

    r.get('/me/feed', requirePerson, async (req, res) => {
        // Warm the follow cache with the person's own token so their token feed can include followed channels
        // while this process still knows them; a failure is the agenda's follows_unavailable, not this route's.
        if (req.principal.token) await follows.forSubject(req.principal.subject, req.principal.token).catch(() => {});
        const token = await feeds.getOrCreate(req.principal.subject);
        res.set('Cache-Control', 'no-store');
        return res.json({ url: feeds.url(config, token) });
    });

    r.post('/me/feed/rotate', requirePerson, async (req, res) => {
        if (req.principal.token) await follows.forSubject(req.principal.subject, req.principal.token).catch(() => {});
        const token = await feeds.rotate(req.principal.subject);
        return res.json({ url: feeds.url(config, token) });
    });

    r.get('/me/brief', requirePerson, async (req, res) => {
        const tz = typeof req.query.tz === 'string' && req.query.tz ? req.query.tz : 'UTC';
        if (!isIanaZone(tz)) return invalid(res, 'tz', 'tz must be a valid IANA time zone');
        const out = await brief.getOrBuild(req.principal.subject, { now: s.now(), tz, token: req.principal.token });
        return res.json(out);
    });

    return r;
}

module.exports = { createApi };
