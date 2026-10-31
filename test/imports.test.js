'use strict';
/**
 * The import jobs: public Live streams on now, Fun plans and quests, Nager.Date holidays, and the source link every
 * row keeps. The same source item is one row across runs, a changed item bumps seq once, a stream that ends is
 * retired, no private field leaks, and a follower's agenda puts the channels they follow first.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const { networkEvent, funQuest, funPlan } = require('../server/imports/normalize');

const NOW = Date.UTC(2026, 9, 31, 12, 0, 0);
const iso = (ms) => new Date(ms).toISOString();

const LIVE = {
    streams: [
        {
            id: 42,
            title: 'Night walk',
            started_at: '2026-10-31 11:30:00',
            channel: { username: 'goosely', display_name: 'Goose', email: 'goose@example.test' },
            stream_key: 'live_should_never_be_stored',
            is_nsfw: 0,
        },
        { id: 43, title: 'No channel', started_at: '2026-10-31 11:40:00', channel: {} },
    ],
};

const PLANS = {
    count: 1,
    plans: [{
        slug: 'berlin-picnic', title: 'Berlin picnic', summary: 'Bring bread and a blanket.',
        city: 'Berlin', timezone: 'Europe/Berlin', starts_at: '2026-10-31T11:00:00.000Z',
        closes_at: '2026-10-30T18:00:00.000Z', status: 'decided', visibility: 'public',
        owner_username: 'carol', owner_subject: 'usr_01JZ0000000000000000000CAR',
    }],
    next_cursor: null,
};

const QUESTS = {
    count: 2,
    quests: [
        { slug: 'find-the-cat', title: 'Find the cat', brief: 'The cat is somewhere in Alfama.',
          status: 'accepted', accepted_at: '2026-10-31T13:00:00.000Z', city: 'Lisbon',
          place_name: 'Alfama', streamer_username: 'goosely', visibility: 'public' },
        { slug: 'already-done', title: 'Already done', status: 'completed', accepted_at: '2026-10-30T13:00:00.000Z', visibility: 'public' },
        { slug: 'hidden-quest', title: 'Hidden', status: 'accepted', accepted_at: '2026-10-31T14:00:00.000Z', visibility: 'hidden' },
    ],
    next_cursor: null,
};

const HOLIDAYS = {
    'DE:2026': [
        { date: '2026-12-25', localName: 'Erster Weihnachtstag', name: 'Christmas Day', countryCode: 'DE', types: ['Public'] },
        { date: '2026-06-03', localName: 'Sommerfest', name: 'Summer day', countryCode: 'DE', types: ['Public'] },
    ],
    'DE:2027': [],
    'US:2026': [{ date: '2026-12-25', localName: 'Christmas Day', name: 'Christmas Day', countryCode: 'US', types: ['Public'] }],
    'US:2027': [],
};

function fakeFetch({ live = LIVE, plans = PLANS, quests = QUESTS, failLive = false } = {}) {
    return async (url) => {
        const u = new URL(url);
        if (u.hostname === 'openvibe.live' && u.pathname === '/api/streams') {
            if (failLive) throw new Error('Live is restarting');
            return { ok: true, status: 200, json: async () => live };
        }
        if (u.hostname === 'openvibe.fun' && u.pathname === '/api/v1/plans') return { ok: true, status: 200, json: async () => plans };
        if (u.hostname === 'openvibe.fun' && u.pathname === '/api/v1/quests') return { ok: true, status: 200, json: async () => quests };
        if (u.hostname === 'date.nager.at') {
            const m = /^\/api\/v3\/PublicHolidays\/(\d{4})\/([A-Z]{2})$/.exec(u.pathname);
            const rows = m ? HOLIDAYS[`${m[2]}:${m[1]}`] : null;
            return rows ? { ok: true, status: 200, json: async () => rows } : { ok: false, status: 404, json: async () => ({}) };
        }
        return { ok: false, status: 404, json: async () => ({}) };
    };
}

(async () => {
    const t = await boot({ now: () => NOW, env: { TODAY_HOLIDAY_COUNTRIES: 'DE,US', TODAY_IMPORTS_EVENTS_TOPICS: 'network.meetup.*' } });
    try {
        const alice = t.network.addUser('alice');
        const bob = t.network.addUser('bob');
        const fetch = fakeFetch();

        let liveId = null;
        let planId = null;
        let firstSeq = null;

        await check('a first pass imports the on-now stream, the plan, the quest and the holidays', async () => {
            const out = await t.ctx.imports.runOnce({ sources: ['live', 'fun', 'holidays'], fetchImpl: fetch, force: true });
            assert.strictEqual(out.sources.live.ok, true, JSON.stringify(out.sources.live));
            assert.strictEqual(out.sources.live.imported, 1, 'one valid live stream');
            assert.strictEqual(out.sources.fun.imported, 2, 'one plan and one accepted quest');
            assert.strictEqual(out.sources.holidays.imported, 3);

            const r = await t.get(`/api/v1/events?from=2026-01-01T00:00:00Z&to=2027-01-01T00:00:00Z&limit=100`);
            assert.strictEqual(r.status, 200, r.text);
            const events = r.json().events;
            assert.strictEqual(events.length, 6);
            const bySource = (source, id) => events.find((e) => e.source === source && e.source_id === id);

            const live = bySource('live', 'stream:42');
            assert.ok(live, 'the live stream row');
            liveId = live.id;
            firstSeq = live.seq;
            assert.strictEqual(live.kind, 'stream');
            assert.strictEqual(live.status, 'live');
            assert.strictEqual(live.starts_at, '2026-10-31T11:30:00.000Z', 'SQLite UTC time read as UTC');
            assert.strictEqual(live.tz, 'UTC');
            assert.strictEqual(live.channel, 'goosely');
            assert.strictEqual(live.url, 'https://openvibe.live/@goosely');
            assert.strictEqual(live.source_url, 'https://openvibe.live/@goosely');
            assert.strictEqual(live.owner_subject, 'chan:goosely', 'no subject is invented from a public API');

            const plan = bySource('fun', 'plan:berlin-picnic');
            assert.ok(plan);
            planId = plan.id;
            assert.strictEqual(plan.kind, 'plan');
            assert.strictEqual(plan.starts_at, '2026-10-31T11:00:00.000Z');
            assert.strictEqual(plan.ends_at, '2026-10-31T13:00:00.000Z', 'two hours, not the voting close');
            assert.strictEqual(plan.tz, 'Europe/Berlin');
            assert.strictEqual(plan.url, 'https://openvibe.fun/plans/berlin-picnic');
            assert.strictEqual(plan.source_url, plan.url);

            const quest = bySource('fun', 'quest:find-the-cat');
            assert.ok(quest);
            assert.strictEqual(quest.kind, 'quest');
            assert.strictEqual(quest.starts_at, '2026-10-31T13:00:00.000Z');
            assert.strictEqual(quest.url, 'https://openvibe.fun/q/find-the-cat');
            assert.ok(!bySource('fun', 'quest:already-done'), 'completed quests are history');
            assert.ok(!bySource('fun', 'quest:hidden-quest'), 'hidden quests never enter');

            const de = events.find((e) => e.source === 'holidays' && e.title === 'Erster Weihnachtstag');
            assert.ok(de);
            assert.strictEqual(de.kind, 'holiday');
            assert.strictEqual(de.tz, 'Europe/Berlin');
            assert.strictEqual(de.starts_at, '2026-12-24T23:00:00.000Z', 'local midnight in CET');
            assert.strictEqual(de.ends_at, '2026-12-25T23:00:00.000Z');
            assert.strictEqual(de.url, 'https://date.nager.at/api/v3/PublicHolidays/2026/DE');

            const summer = events.find((e) => e.source === 'holidays' && e.title === 'Sommerfest');
            assert.strictEqual(summer.starts_at, '2026-06-02T22:00:00.000Z', 'local midnight in CEST');

            const us = events.find((e) => e.source === 'holidays' && e.title === 'Christmas Day');
            assert.strictEqual(us.starts_at, '2026-12-25T05:00:00.000Z', 'New York midnight is 05:00 UTC');
            assert.strictEqual(us.tz, 'America/New_York');
        });

        await check('a second pass changes nothing: same rows, same seq, no duplicates', async () => {
            const before = await t.ctx.s.db.value('SELECT COUNT(*)::int AS n FROM today_events');
            const out = await t.ctx.imports.runOnce({ sources: ['live', 'fun', 'holidays'], fetchImpl: fetch, force: true });
            assert.strictEqual(out.sources.live.imported, 1);
            assert.strictEqual(out.sources.fun.imported, 2);
            assert.strictEqual(out.sources.holidays.imported, 3);
            const after = await t.ctx.s.db.value('SELECT COUNT(*)::int AS n FROM today_events');
            assert.strictEqual(after, before);
            const row = await t.ctx.s.db.maybe('SELECT * FROM today_events WHERE source = $1 AND source_id = $2', ['live', 'stream:42']);
            assert.strictEqual(row.id, liveId);
            assert.strictEqual(Number(row.seq), Number(firstSeq), 'an unchanged row does not bump seq');
            const dupes = await t.ctx.s.db.many('SELECT source, source_id, COUNT(*)::int AS n FROM today_events WHERE source IS NOT NULL GROUP BY 1, 2 HAVING COUNT(*) > 1');
            assert.deepStrictEqual(dupes, []);
        });

        await check('a changed source title updates the same row and bumps seq once', async () => {
            const changed = { streams: [{ ...LIVE.streams[0], title: 'Night walk (part 2)' }] };
            const out = await t.ctx.imports.runOnce({ sources: ['live'], fetchImpl: fakeFetch({ live: changed }) });
            assert.strictEqual(out.sources.live.imported, 1);
            const row = await t.ctx.s.db.maybe('SELECT * FROM today_events WHERE source = $1 AND source_id = $2', ['live', 'stream:42']);
            assert.strictEqual(row.id, liveId);
            assert.strictEqual(row.title, 'Night walk (part 2)');
            assert.strictEqual(Number(row.seq), Number(firstSeq) + 1);
            assert.strictEqual(await t.ctx.s.db.value('SELECT COUNT(*)::int AS n FROM today_events WHERE source = $1', ['live']), 1);
        });

        await check('a failing source retires nothing and records the error', async () => {
            const out = await t.ctx.imports.runOnce({ sources: ['live'], fetchImpl: fakeFetch({ failLive: true }) });
            assert.strictEqual(out.sources.live.ok, false);
            assert.match(out.sources.live.error, /restarting/);
            const row = await t.ctx.s.db.maybe('SELECT * FROM today_events WHERE source = $1 AND source_id = $2', ['live', 'stream:42']);
            assert.strictEqual(row.status, 'live', 'a failed read must not retire the stream');
            const source = await t.ctx.s.db.maybe('SELECT * FROM today_import_sources WHERE source = $1', ['live']);
            assert.match(source.last_error, /restarting/);
        });

        await check('a stream that is no longer listed is marked done and no longer says on now', async () => {
            const out = await t.ctx.imports.runOnce({ sources: ['live'], fetchImpl: fakeFetch({ live: { streams: [] } }) });
            assert.strictEqual(out.sources.live.retired, 1);
            const row = await t.ctx.s.db.maybe('SELECT * FROM today_events WHERE id = $1', [liveId]);
            assert.strictEqual(row.status, 'done');
            // A done stream stays readable as history (calendars need it); it is not live any more.
            const r = await t.get('/api/v1/events?from=2026-10-31T10:00:00Z&to=2026-10-31T20:00:00Z&limit=100');
            const served = r.json().events.find((e) => e.id === liveId);
            assert.ok(served);
            assert.strictEqual(served.status, 'done');
        });

        await check('a stream that is live now stays on the public list however long ago it started', async () => {
            await t.ctx.s.db.exec(
                `INSERT INTO today_events (id, owner_subject, kind, channel, title, starts_at, tz, status, visibility)
                 VALUES ('tev_01JZ000000000000000000L1', 'chan:long', 'stream', 'long', 'A five-hour stream', $1::timestamptz, 'UTC', 'live', 'public')`,
                [iso(NOW - 5 * 60 * 60_000)],
            );
            const r = await t.get('/api/v1/events?limit=100');
            const served = r.json().events.find((e) => e.id === 'tev_01JZ000000000000000000L1');
            assert.ok(served, 'default window still shows the live stream');
            assert.strictEqual(served.status, 'live');
        });

        await check('nothing private from a source is stored or served', async () => {
            const row = await t.ctx.s.db.maybe('SELECT * FROM today_events WHERE id = $1', [planId]);
            const dump = JSON.stringify(row) + JSON.stringify(await t.get(`/api/v1/events/${planId}`).then((x) => x.json()));
            assert.ok(!/goose@example\.test/.test(dump), 'no source email');
            assert.ok(!/live_should_never_be_stored/.test(dump), 'no Live ingest key');
            assert.ok(!/usr_01JZ0000000000000000000CAR/.test(dump), 'no plan owner subject');
            assert.strictEqual(row.visibility, 'public');
            assert.strictEqual(row.owner_subject, 'sys:fun');
        });

        await check('a follower\'s agenda puts their followed channel first, and later learns its subject', async () => {
            // The public API only says "goosely"; the bus is what tells Today which usr_ owns it.
            await t.ctx.s.db.exec(
                'INSERT INTO today_channels (username, subject, updated_at) VALUES ($1, $2, $3::timestamptz) ON CONFLICT (username) DO UPDATE SET subject = EXCLUDED.subject',
                ['goosely', alice.subject, iso(NOW)],
            );
            t.network.setFollow(bob, alice.subject);
            const out = await t.ctx.imports.runOnce({ sources: ['live'], fetchImpl: fakeFetch() });
            assert.strictEqual(out.sources.live.imported, 1);
            const row = await t.ctx.s.db.maybe('SELECT * FROM today_events WHERE source = $1 AND source_id = $2', ['live', 'stream:42']);
            assert.strictEqual(row.status, 'live');
            assert.strictEqual(row.owner_subject, alice.subject, 'the importer used the channel map');
            const agenda = await t.get('/api/v1/me/agenda?days=30', { as: bob });
            assert.strictEqual(agenda.status, 200, agenda.text);
            const ids = agenda.json().events.map((e) => e.id);
            assert.ok(ids.includes(row.id), 'the followed channel\'s stream is in the agenda');
            assert.strictEqual(ids[0], row.id, `followed first, got ${ids.join(', ')}`);
        });

        await check('the optional Events pull imports a public people-facing event and drops the rest', async () => {
            const eventsFetch = async (url, opts = {}) => {
                const u = new URL(url);
                if (u.pathname === '/oauth/token') {
                    return { ok: true, status: 200, json: async () => ({ access_token: 'tok_events_fixture', token_type: 'Bearer', expires_in: 300 }) };
                }
                if (u.pathname === '/api/v1/events') {
                    assert.strictEqual(opts.headers.Authorization, 'Bearer tok_events_fixture');
                    assert.strictEqual(u.searchParams.get('topic'), 'network.meetup.*');
                    return {
                        ok: true, status: 200,
                        json: async () => ({
                            events: [
                                { cursor: 'c1', event: { event_id: 'evt_01JZ000000000000000000M01', event_type: 'network.meetup.scheduled', visibility: 'public', payload: { title: 'Berlin meetup', starts_at: '2026-11-01T18:00:00Z', tz: 'Europe/Berlin', url: 'https://openvibe.network/@meetup' } } },
                                { cursor: 'c2', event: { event_id: 'evt_01JZ000000000000000000M02', event_type: 'live.release.deployed', visibility: 'public', payload: { title: 'v1.2.3', starts_at: '2026-11-01T18:00:00Z' } } },
                                { cursor: 'c3', event: { event_id: 'evt_01JZ000000000000000000M03', event_type: 'network.meetup.scheduled', visibility: 'internal', payload: { title: 'Private', starts_at: '2026-11-01T18:00:00Z' } } },
                                { cursor: 'c4', event: { event_id: 'evt_01JZ000000000000000000M04', event_type: 'network.meetup.scheduled', visibility: 'public', payload: { title: 'No time' } } },
                            ],
                        }),
                    };
                }
                throw new Error(`unexpected ${url}`);
            };
            const out = await t.ctx.imports.runOnce({ sources: ['events'], fetchImpl: eventsFetch });
            assert.strictEqual(out.sources.events.ok, true, JSON.stringify(out.sources.events));
            assert.strictEqual(out.sources.events.imported, 1);
            const row = await t.ctx.s.db.maybe('SELECT * FROM today_events WHERE source = $1', ['events']);
            assert.strictEqual(row.title, 'Berlin meetup');
            assert.strictEqual(row.source_url, 'https://openvibe.network/@meetup');
            assert.strictEqual(row.owner_subject, 'sys:events');
        });

        await check('the normalisers refuse non-public and non-people events', async () => {
            assert.strictEqual(networkEvent({
                event_id: 'evt_01JZ00000000000000000000', event_type: 'live.release.deployed', visibility: 'public',
                payload: { title: 'v1.2.3', starts_at: '2026-11-01T12:00:00Z' },
            }), null, 'a release note is not an event');
            assert.strictEqual(funQuest({ slug: 'x', title: 'x', status: 'completed' }), null);
            assert.strictEqual(funQuest({ slug: 'x', title: 'x', status: 'accepted', accepted_at: '2026-11-01T12:00:00Z', visibility: 'hidden' }), null);
            assert.strictEqual(funPlan({ slug: 'x', title: 'x', starts_at: '2026-11-01T12:00:00Z', visibility: 'unlisted' }), null);
            const meeting = networkEvent({
                event_id: 'evt_01JZ00000000000000000001', event_type: 'network.meetup.scheduled', visibility: 'public',
                payload: { title: 'Berlin meetup', starts_at: '2026-11-01T18:00:00Z', tz: 'Europe/Berlin', url: 'https://openvibe.network/@meetup' },
            });
            assert.ok(meeting);
            assert.strictEqual(meeting.kind, 'event');
            assert.strictEqual(meeting.source_url, 'https://openvibe.network/@meetup');
        });

        await check('the job refuses to start under drill', async () => {
            const { createImports } = require('../server/imports');
            const imports = createImports({ config: { ...t.config, drill: true }, s: t.ctx.s, fetchImpl: fetch });
            assert.strictEqual(imports.start(), false);
            const off = createImports({ config: { ...t.config, imports: { ...t.config.imports, enabled: false } }, s: t.ctx.s, fetchImpl: fetch });
            assert.strictEqual(off.start(), false);
        });
    } finally {
        await t.close();
    }
    done();
})();
