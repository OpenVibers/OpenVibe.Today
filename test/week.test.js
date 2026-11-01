'use strict';
/**
 * Your week (plan L48 R3): seven days from Monday in the person's own zone, each with its reminders' times (an
 * interval rule once a day, with its span), their own events and their followed channels' streams, in time order;
 * across a clock change; and the page: the zone from ?tz=, the cookie or the newest reminder; the week's navigation;
 * the quick box that adds a reminder and comes back to the week; signed out, sign in.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const week = require('../server/week');

(async () => {
    await check('the week: Monday to Sunday in the zone, reminders at their times, an interval once a day, events in order', () => {
        const now = Date.parse('2026-11-04T15:00:00Z');                       // Wednesday afternoon in Paris
        const w = week.build({
            tz: 'Europe/Paris', now,
            reminders: [
                { status: 'active', title: 'Stretch', tz: 'Europe/Paris', rule: { kind: 'interval', minutes: 120, from: '09:00', to: '17:00', days: [1, 2, 3, 4, 5] } },
                { status: 'active', title: 'Standup', tz: 'Europe/Paris', rule: { kind: 'daily', times: ['09:30'], days: [1, 2, 3, 4, 5] } },
                { status: 'active', title: 'Call Sam', tz: 'Europe/Paris', rule: { kind: 'once', at: '2026-11-06T08:00:00Z' } },
                { status: 'done', title: 'Old one', tz: 'Europe/Paris', rule: { kind: 'daily', times: ['10:00'] } },
            ],
            events: [
                { id: 'ev1', title: 'Speedrun night', starts_at: '2026-11-07T19:00:00Z', status: 'scheduled', channel: 'kai', own: false },
                { id: 'ev2', title: 'My stream', starts_at: '2026-11-03T18:00:00Z', status: 'live', channel: 'ana', own: true },
                { id: 'ev3', title: 'Cancelled', starts_at: '2026-11-05T18:00:00Z', status: 'cancelled' },
                { id: 'ev4', title: 'Next week', starts_at: '2026-11-10T18:00:00Z', status: 'scheduled' },
            ],
        });
        assert.deepStrictEqual([w.title, w.start, w.prev, w.next, w.thisWeek, w.tz], ['Nov 2 – 8, 2026', '2026-11-02', '2026-10-26', '2026-11-09', true, 'Europe/Paris']);
        assert.deepStrictEqual(w.days.map((d) => d.label), ['Mon 2', 'Tue 3', 'Wed 4', 'Thu 5', 'Fri 6', 'Sat 7', 'Sun 8']);
        assert.deepStrictEqual(w.days.map((d) => d.today), [false, false, true, false, false, false, false]);
        const line = (d) => d.items.map((i) => `${i.kind} ${i.time} ${i.title}`);
        assert.deepStrictEqual(line(w.days[0]), ['band 9:00 Stretch', 'reminder 9:30 Standup'], 'an interval rule is one line a day');
        assert.match(w.days[0].items[0].summary, /Every 2 hours/);
        assert.deepStrictEqual(line(w.days[1]), ['band 9:00 Stretch', 'reminder 9:30 Standup', 'event 19:00 My stream'], 'their own event, at its local time');
        assert.ok(w.days[1].items[2].live, 'live now');
        assert.deepStrictEqual(line(w.days[4]), ['band 9:00 Stretch', 'reminder 9:00 Call Sam', 'reminder 9:30 Standup']);
        assert.deepStrictEqual(line(w.days[5]), ['stream 20:00 Speedrun night'], 'a followed channel\'s stream; nothing cancelled, nothing done, nothing from next week');
        assert.deepStrictEqual(line(w.days[6]), []);
        const other = week.build({ tz: 'Europe/Paris', now, start: '2026-11-11' });
        assert.deepStrictEqual([other.start, other.thisWeek], ['2026-11-09', false], 'any day picks its Monday');
        assert.strictEqual(week.build({ tz: 'Mars/Olympus', now }).tz, 'UTC', 'an unknown zone is UTC');
    });

    await check('across a clock change a daily reminder keeps its hour, and the week still has seven days', () => {
        const w = week.build({ tz: 'America/New_York', now: Date.parse('2026-10-29T15:00:00Z'), reminders: [{ status: 'active', title: 'Walk', tz: 'America/New_York', rule: { kind: 'daily', times: ['09:00'] } }] });
        assert.strictEqual(w.days.length, 7);
        assert.deepStrictEqual(w.days.map((d) => d.items.map((i) => i.time).join()), ['9:00', '9:00', '9:00', '9:00', '9:00', '9:00', '9:00'], 'clocks went back on Sunday 1 November');
    });

    const t = await boot();
    const ana = t.network.addUser('ana');
    try {
        await check('the page: the zone, the days, the navigation, the quick box; signed out, sign in', async () => {
            assert.strictEqual((await t.get('/me/week')).status, 401);
            const made = await t.get('/me/reminders', { as: ana, form: { text: 'standup weekdays at 9:30', tz: 'Asia/Tokyo' } });
            assert.strictEqual(made.status, 303);
            const page = await t.get('/me/week', { as: ana });
            assert.strictEqual(page.status, 200);
            assert.match(page.text, /<div class="td-wrap td-page-pad" id="td-week" data-tz="Asia\/Tokyo">/, 'the zone of the newest reminder, when the browser has not said');
            assert.strictEqual((page.text.match(/<li class="td-wd/g) || []).length, 7, 'seven days');
            assert.ok(page.text.includes('Standup'), 'the reminder shows');
            assert.match(page.text, /href="\/me\/week\?start=\d{4}-\d{2}-\d{2}" rel="prev"/);
            const paris = await t.get('/me/week', { as: ana, headers: { cookie: 'td_tz=Europe%2FParis' } });
            assert.match(paris.text, /data-tz="Europe\/Paris"/, 'the browser\'s zone, from its cookie');
            const asked = await t.get('/me/week?tz=America%2FChicago&start=2026-11-11', { as: ana });
            assert.match(asked.text, /data-tz="America\/Chicago"/);
            assert.match(asked.text, /<h1>Nov 9 – 15, 2026<\/h1>/);
            assert.match(asked.text, /<a class="ovk-btn ovk-btn--quiet ovk-btn--small" href="\/me\/week">This week<\/a>/, 'another week offers the way back');
            const quick = await t.get('/me/reminders', { as: ana, form: { text: 'water the plants every Sunday at 10am', tz: 'Asia/Tokyo', back: 'week' } });
            assert.strictEqual(quick.headers.get('location'), '/me/week', 'added from the week: back to the week');
            assert.ok((await t.get('/me', { as: ana })).text.includes('href="/me/week"'), 'the agenda leads to the week');
        });
    } finally {
        await done(t);
    }
})();
