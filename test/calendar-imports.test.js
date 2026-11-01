'use strict';
/**
 * The calendars a person imports (plan L48 R3: "import any calendar by ICS address"). Reading a calendar: a time in
 * a zone, an all-day event, a weekly rule with BYDAY, an excluded day, a cancelled event, a rule that is too clever,
 * and a clock change. Reading it safely: a private address refused, a redirect to a private address refused, a body
 * too big, an answer that is not a calendar. Then the week that shows it, the five addresses a person may keep, the
 * half-hour between two reads, and a form post from another site refused.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const ical = require('../server/ical');
const week = require('../server/week');
const net = require('../server/net/calendar-fetch');
const imports = require('../server/calendar-imports');

const cal = (...lines) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//OpenVibe//Today//EN', ...lines, 'END:VCALENDAR'].join('\r\n');
const vevent = (...lines) => ['BEGIN:VEVENT', ...lines, 'END:VEVENT'];
const paris = (iso) => new Date(iso).toLocaleString('en-GB', { timeZone: 'Europe/Paris' });
// A refusal: the shared egress rule says no, or the guard says no.
const refused = (err) => err && (err.code === 'EGRESS_DENIED' || err.code === 'today.calendar.refused' || err.name === 'GuardedError');

// A name that answers a public address, and one that answers a private one.
const publicLookup = (host, opts, cb) => cb(null, [{ address: '93.184.216.34', family: 4 }]);
const privateLookup = (host, opts, cb) => cb(null, [{ address: '10.0.0.5', family: 4 }]);

(async () => {
    await check('the address a person may add', () => {
        assert.strictEqual(imports.normalizeUrl('webcal://calendar.example.com/work.ics'), 'https://calendar.example.com/work.ics', 'webcal becomes https');
        assert.strictEqual(imports.normalizeUrl('https://calendar.example.com/work.ics'), 'https://calendar.example.com/work.ics');
        assert.strictEqual(imports.normalizeUrl('http://calendar.example.com/work.ics'), null, 'https only');
        assert.strictEqual(imports.normalizeUrl('javascript:alert(1)'), null);
        assert.strictEqual(imports.normalizeUrl('https://user:pass@calendar.example.com/x.ics'), null, 'no credentials in an address');
        assert.strictEqual(imports.normalizeUrl('   '), null);
        assert.strictEqual(imports.normalizeUrl('https://localhost/cal.ics'), null, 'not this machine');
        assert.strictEqual(imports.shortName('https://calendar.google.com/x.ics', ''), 'Calendar', 'the host says who it is');
        assert.strictEqual(imports.shortName('https://calendar.google.com/x.ics', 'Work'), 'Work', 'or the name the person gave');
        assert.strictEqual(imports.shortAddress('https://calendar.google.com/private/secret-token.ics'), 'calendar.google.com', 'a path that holds a secret is left out');
        assert.strictEqual(imports.shortAddress('https://example.com/cal.ics'), 'example.com/cal.ics');
        assert.strictEqual(imports.MAX_PER_PERSON, 5);
    });

    await check('reading a calendar: a time in a zone, an all-day event, a weekly rule, an excluded day, a cancelled event', () => {
        const ics = cal(
            ...vevent('UID:1', 'SUMMARY:Berlin standup', 'DTSTART;TZID=Europe/Berlin:20261104T090000', 'DTEND;TZID=Europe/Berlin:20261104T093000'),
            ...vevent('UID:2', 'SUMMARY:Company day', 'DTSTART;VALUE=DATE:20261105'),
            ...vevent('UID:3', 'SUMMARY:Review', 'DTSTART;TZID=Europe/Paris:20261102T170000', 'RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6', 'EXDATE;TZID=Europe/Paris:20261104T170000'),
            ...vevent('UID:4', 'SUMMARY:Off', 'DTSTART:20261103T100000Z', 'STATUS:CANCELLED'),
        );
        const out = ical.occurrences(ics, { from: Date.parse('2026-11-01T00:00:00Z'), to: Date.parse('2026-12-01T00:00:00Z'), tz: 'Europe/Paris' });
        const standup = out.events.find((e) => e.title === 'Berlin standup');
        assert.strictEqual(standup.start, Date.parse('2026-11-04T08:00:00Z'), 'nine in the morning in Berlin');
        assert.strictEqual(standup.tz, 'Europe/Berlin');
        const allDay = out.events.find((e) => e.title === 'Company day');
        assert.strictEqual(allDay.allDay, true);
        assert.strictEqual(allDay.date, '2026-11-05', 'an all-day event is a day, not an instant');
        assert.strictEqual(allDay.start, null);
        const review = out.events.filter((e) => e.title === 'Review');
        assert.deepStrictEqual(review.map((e) => paris(e.start).slice(0, 10)), ['02/11/2026', '09/11/2026', '11/11/2026', '16/11/2026', '18/11/2026'],
            'Mondays and Wednesdays, six of them, minus the excluded Wednesday');
        assert.ok(!out.events.some((e) => e.title === 'Off'), 'a cancelled event is not shown');
        assert.strictEqual(out.skipped.cancelled, 1);
    });

    await check('a rule ends at its UNTIL', () => {
        const allDay = cal(...vevent('UID:1', 'SUMMARY:Every day', 'DTSTART;VALUE=DATE:20261101', 'RRULE:FREQ=DAILY;UNTIL=20261104'));
        const out = ical.occurrences(allDay, { from: Date.parse('2026-11-01T00:00:00Z'), to: Date.parse('2026-12-01T00:00:00Z'), tz: 'UTC' });
        assert.deepStrictEqual(out.events.map((e) => e.date), ['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04'], 'the fourth day is the last');
        const timed = cal(...vevent('UID:2', 'SUMMARY:Until', 'DTSTART;TZID=Europe/Paris:20261101T090000', 'RRULE:FREQ=DAILY;UNTIL=20261104T000000Z'));
        const out2 = ical.occurrences(timed, { from: Date.parse('2026-11-01T00:00:00Z'), to: Date.parse('2026-12-01T00:00:00Z'), tz: 'Europe/Paris' });
        assert.strictEqual(out2.events.length, 3, 'the fourth morning is past the UNTIL');
    });

    await check('a rule that is too clever is left out, not guessed at', () => {
        const ics = cal(
            ...vevent('UID:1', 'SUMMARY:Second Friday', 'DTSTART;TZID=Europe/Paris:20261101T090000', 'RRULE:FREQ=MONTHLY;BYDAY=2FR'),
            ...vevent('UID:2', 'SUMMARY:With a month', 'DTSTART;TZID=Europe/Paris:20261101T090000', 'RRULE:FREQ=MONTHLY;BYMONTH=11'),
            ...vevent('UID:3', 'SUMMARY:Ordinary', 'DTSTART:20261104T090000Z'),
        );
        const out = ical.occurrences(ics, { from: Date.parse('2026-11-01T00:00:00Z'), to: Date.parse('2026-12-01T00:00:00Z'), tz: 'Europe/Paris' });
        assert.deepStrictEqual(out.events.map((e) => e.title), ['Ordinary']);
        assert.strictEqual(out.skipped['rule:byday-ordinal'], 1, 'the second Friday is not read');
        assert.strictEqual(out.skipped['rule:bymonth'], 1, 'a month in the rule is not read');
    });

    await check('across a clock change the event keeps its hour', () => {
        const ics = cal(...vevent('UID:1', 'SUMMARY:Morning', 'DTSTART;TZID=America/New_York:20261030T090000', 'RRULE:FREQ=DAILY;COUNT=4'));
        const out = ical.occurrences(ics, { from: Date.parse('2026-10-29T00:00:00Z'), to: Date.parse('2026-11-05T00:00:00Z'), tz: 'America/New_York' });
        assert.deepStrictEqual(out.events.map((e) => new Date(e.start).toISOString()),
            ['2026-10-30T13:00:00.000Z', '2026-10-31T13:00:00.000Z', '2026-11-01T14:00:00.000Z', '2026-11-02T14:00:00.000Z'],
            'nine in the morning every day, although the clock went back on 1 November');
    });

    await check('the text of an event is read with its escapes undone', () => {
        const ics = cal(...vevent('UID:1', 'SUMMARY:Lunch\\, with Ana\\nsecond line', 'DTSTART:20261104T120000Z'));
        const out = ical.occurrences(ics, { from: Date.parse('2026-11-04T00:00:00Z'), to: Date.parse('2026-11-05T00:00:00Z'), tz: 'UTC' });
        assert.strictEqual(out.events[0].title, 'Lunch, with Ana second line');
    });

    await check('a private address is refused before a byte is sent', async () => {
        for (const url of ['https://127.0.0.1/cal.ics', 'https://10.1.2.3/cal.ics', 'https://192.168.1.1/cal.ics', 'https://169.254.169.254/latest/meta-data', 'https://localhost/cal.ics']) {
            await assert.rejects(() => net.assertReachable(url), refused, url);
        }
        await assert.rejects(() => net.assertReachable('https://calendar.example.com/cal.ics', { lookup: privateLookup }), refused);
    });

    await check('a redirect to a private address is refused, and so is a body that is too big', async () => {
        await assert.rejects(() => net.fetchCalendar('https://calendar.example.com/cal.ics', {
            lookup: (host, opts, cb) => cb(null, [{ address: host.includes('internal') ? '10.0.0.5' : '93.184.216.34', family: 4 }]),
            request: async () => ({ status: 302, headers: { location: 'https://internal.example.com/cal.ics' }, body: Buffer.alloc(0) }),
        }), refused, 'the second hop is checked the same way');
        await assert.rejects(() => net.fetchCalendar('https://calendar.example.com/cal.ics', {
            lookup: publicLookup,
            request: async () => ({ status: 200, headers: { 'content-type': 'text/calendar' }, body: Buffer.alloc(3 * 1024 * 1024) }),
        }), (err) => err.code === 'today.calendar.too_large', 'more than two megabytes is refused');
        await assert.rejects(() => net.fetchCalendar('https://calendar.example.com/cal.ics', {
            lookup: publicLookup,
            request: async () => ({ status: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from('{}') }),
        }), (err) => err.code === 'today.calendar.not_a_calendar', 'only a calendar is read');
        const good = await net.fetchCalendar('https://calendar.example.com/cal.ics', {
            lookup: publicLookup,
            request: async () => ({ status: 200, headers: { 'content-type': 'text/calendar; charset=utf-8' }, body: Buffer.from('BEGIN:VCALENDAR\r\nEND:VCALENDAR') }),
        });
        assert.ok(good.body.startsWith('BEGIN:VCALENDAR'));
    });

    await check('the week puts an all-day event at the top of its day', () => {
        const w = week.build({
            tz: 'Europe/Paris', now: Date.parse('2026-11-04T12:00:00Z'),
            imports: [
                { allDay: true, date: '2026-11-04', title: 'Company day', calendar: 'Work' },
                { allDay: false, start: Date.parse('2026-11-04T09:00:00Z'), title: 'Review', calendar: 'Work' },
            ],
        });
        const day = w.days.find((d) => d.key === '2026-11-04');
        assert.deepStrictEqual(day.items.map((i) => i.kind + ' ' + i.time), ['import All day', 'import 10:00']);
        assert.strictEqual(day.items[0].calendar, 'Work', 'the calendar\'s short name');
    });

    // ── The service ────────────────────────────────────────────────────────────
    const ICS = cal(
        ...vevent('UID:1', 'SUMMARY:Imported meeting', 'DTSTART:20261104T180000Z', 'DTEND:20261104T190000Z'),
        ...vevent('UID:2', 'SUMMARY:Imported day', 'DTSTART;VALUE=DATE:20261104'),
    );
    let calls = 0;
    const calendarFetch = async () => { calls++; return { status: 200, headers: { 'content-type': 'text/calendar' }, body: ICS }; };
    let clock = Date.parse('2026-11-04T15:00:00Z');
    const t = await boot({ now: () => clock, calendarFetch });
    const ana = t.network.addUser('ana');
    try {
        await check('a person adds a calendar on their agenda, and it shows on their week', async () => {
            const added = await t.get('/me/calendars', { as: ana, form: { url: 'webcal://calendar.example.com/work.ics', name: 'Work' } });
            assert.strictEqual(added.status, 303);
            assert.strictEqual(added.headers.get('location'), '/me#calendars');
            const me = await t.get('/me', { as: ana });
            assert.match(me.text, /id="calendars"/, 'the form is on the agenda');
            assert.ok(me.text.includes('calendar.example.com/work.ics'), 'the address is shown, shortened');
            assert.match(me.text, /action="\/me\/calendars\/[^"]+\/remove"/, 'and it can be taken away');
            const page = await t.get('/me/week', { as: ana });
            assert.match(page.text, /is-import/, 'the imported event is its own kind');
            assert.ok(page.text.includes('Imported meeting'), 'the event shows');
            assert.ok(page.text.includes('Imported day'));
            assert.ok(page.text.includes('Work'), 'with the calendar\'s short name');
            assert.ok(page.text.indexOf('All day') < page.text.indexOf('Imported meeting'), 'the all-day event is at the top of its day');
        });

        await check('the address is shown shortened', async () => {
            const kai = t.network.addUser('kai');
            await t.get('/me/calendars', { as: kai, form: { url: 'https://calendar.google.com/private/9f8e7d6c5b4a3210-secret.ics' } });
            const page = await t.get('/me', { as: kai });
            assert.ok(page.text.includes('>calendar.google.com</small>'), 'the host is shown, and the path that holds the secret is not');
        });

        await check('a calendar is read at most once every half hour', async () => {
            assert.strictEqual(calls, 1, 'the first view read it');
            await t.get('/me/week', { as: ana });
            assert.strictEqual(calls, 1, 'a second view a moment later does not read it again');
            clock += 31 * 60_000;
            await t.get('/me/week', { as: ana });
            assert.strictEqual(calls, 2, 'after half an hour it is read again');
            clock += 31 * 60_000;
        });

        await check('a person keeps at most five addresses', async () => {
            for (let i = 0; i < 4; i++) {
                const res = await t.get('/me/calendars', { as: ana, form: { url: 'https://c' + i + '.example.com/cal.ics' } });
                assert.strictEqual(res.status, 303);
            }
            const me = await t.get('/me', { as: ana });
            assert.strictEqual((me.text.match(/action="\/me\/calendars\/[^"]+\/remove"/g) || []).length, 5, 'five now');
            const sixth = await t.get('/me/calendars', { as: ana, form: { url: 'https://c9.example.com/cal.ics' } });
            assert.match(sixth.headers.get('location'), /cal_problem=/, 'the sixth is refused');
            const after = await t.get('/me', { as: ana });
            assert.strictEqual((after.text.match(/action="\/me\/calendars\/[^"]+\/remove"/g) || []).length, 5, 'and it is not added');
        });

        await check('a form post from another site is refused', async () => {
            const bad = await t.get('/me/calendars', { as: ana, form: { url: 'https://evil.example.com/cal.ics' }, origin: 'https://evil.example' });
            assert.strictEqual(bad.status, 403);
            const gone = await t.get('/me/calendars/cal_x/remove', { as: ana, method: 'POST', origin: 'https://evil.example' });
            assert.strictEqual(gone.status, 403);
        });

        await check('an address that cannot be read keeps the copy that is there', async () => {
            const t2 = await boot({ now: () => clock, calendarFetch: async () => { throw new Error('the address did not answer'); } });
            const bob = t2.network.addUser('bob');
            try {
                await t2.get('/me/calendars', { as: bob, form: { url: 'https://broken.example.com/cal.ics', name: 'Broken' } });
                const page = await t2.get('/me/week', { as: bob });
                assert.strictEqual(page.status, 200, 'the week still shows');
                assert.match(page.text, /the address did not answer/, 'and it says why');
            } finally {
                await t2.close();
            }
        });
    } finally {
        await done(t);
    }
})();
