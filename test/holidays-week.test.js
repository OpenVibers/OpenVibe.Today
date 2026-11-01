'use strict';
/**
 * The public holidays of a country (server/holidays.js) and the week that shows them: the rules for several
 * years, the country a zone says, the ?country= and the td_country cookie, an unknown code ignored, and the
 * week with a holiday at the top of its day.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const holidays = require('../server/holidays');
const week = require('../server/week');

/** The dates of the holidays of a country in a year that carry a name. */
const dates = (country, year, name) => holidays.holidays(country, year)
    .filter((h) => !name || h.name.includes(name))
    .map((h) => h.date);

/** The dates of the holidays of a country in a year whose name is exactly this one. */
const named = (country, year, name) => holidays.holidays(country, year)
    .filter((h) => h.name === name)
    .map((h) => h.date);

(async () => {
    await check('the rules: Thanksgiving and Memorial Day in the United States, several years', () => {
        assert.deepStrictEqual(dates('US', 2026, 'Thanksgiving'), ['2026-11-26'], 'the fourth Thursday of November');
        assert.deepStrictEqual(dates('US', 2025, 'Thanksgiving'), ['2025-11-27']);
        assert.deepStrictEqual(dates('US', 2024, 'Thanksgiving'), ['2024-11-28']);
        assert.deepStrictEqual(dates('US', 2026, 'Memorial'), ['2026-05-25'], 'the last Monday of May');
        assert.deepStrictEqual(dates('US', 2025, 'Memorial'), ['2025-05-26']);
        assert.deepStrictEqual(dates('US', 2027, 'Memorial'), ['2027-05-31']);
        assert.deepStrictEqual(dates('US', 2026, "Washington"), ['2026-02-16'], 'the third Monday of February');
        assert.deepStrictEqual(dates('US', 2026, 'Labor'), ['2026-09-07'], 'the first Monday of September');
    });

    await check('a holiday on a weekend is taken the Friday before or the Monday after, in the United States', () => {
        assert.deepStrictEqual(named('US', 2026, 'Independence Day'), ['2026-07-03'], 'July 4 on a Saturday is taken Friday');
        assert.deepStrictEqual(named('US', 2027, 'Independence Day'), ['2027-07-05'], 'July 4 on a Sunday is taken Monday');
        assert.deepStrictEqual(named('US', 2028, 'Independence Day'), ['2028-07-04'], 'a weekday is the day itself');
        assert.deepStrictEqual(dates('US', 2022, "New Year"), ['2021-12-31'], 'New Year\'s Day on a Saturday is the Friday before');
        assert.deepStrictEqual(dates('US', 2022, 'Christmas'), ['2022-12-26'], 'Christmas on a Sunday is taken Monday');
    });

    await check('Great Britain: Easter Monday and the August bank holiday', () => {
        assert.deepStrictEqual(dates('GB', 2026, 'Easter Monday'), ['2026-04-06']);
        assert.deepStrictEqual(dates('GB', 2024, 'Easter Monday'), ['2024-04-01']);
        assert.deepStrictEqual(dates('GB', 2025, 'Easter Monday'), ['2025-04-21']);
        assert.deepStrictEqual(dates('GB', 2026, 'Summer'), ['2026-08-31'], 'the last Monday of August');
        assert.deepStrictEqual(dates('GB', 2024, 'Summer'), ['2024-08-26']);
        assert.deepStrictEqual(dates('GB', 2026, 'Early May'), ['2026-05-04'], 'the first Monday of May');
    });

    await check('Germany: Pfingstmontag, fifty days after Easter', () => {
        assert.deepStrictEqual(dates('DE', 2026, 'Pfingstmontag'), ['2026-05-25']);
        assert.deepStrictEqual(dates('DE', 2025, 'Pfingstmontag'), ['2025-06-09']);
        assert.deepStrictEqual(dates('DE', 2024, 'Pfingstmontag'), ['2024-05-20']);
        assert.deepStrictEqual(dates('DE', 2026, 'Ostermontag'), ['2026-04-06']);
    });

    await check('Japan: a fixed holiday, and the Monday ones', () => {
        assert.deepStrictEqual(dates('JP', 2026, '山の日'), ['2026-08-11'], 'Mountain Day is August 11');
        assert.deepStrictEqual(dates('JP', 2026, '海の日'), ['2026-07-20'], 'the third Monday of July');
        assert.deepStrictEqual(dates('JP', 2026, '成人の日'), ['2026-01-19'], 'the third Monday of January');
    });

    await check('Brazil: Carnaval, the days before Easter', () => {
        assert.deepStrictEqual(dates('BR', 2026, 'Carnaval'), ['2026-02-16', '2026-02-17']);
        assert.deepStrictEqual(dates('BR', 2025, 'Carnaval'), ['2025-03-03', '2025-03-04']);
    });

    await check('the zone says the country, and a zone that says nothing says none', () => {
        assert.strictEqual(holidays.countryOfZone('America/New_York'), 'US');
        assert.strictEqual(holidays.countryOfZone('Europe/London'), 'GB');
        assert.strictEqual(holidays.countryOfZone('Europe/Berlin'), 'DE');
        assert.strictEqual(holidays.countryOfZone('Asia/Tokyo'), 'JP');
        assert.strictEqual(holidays.countryOfZone('Asia/Kolkata'), 'IN');
        assert.strictEqual(holidays.countryOfZone('Australia/Sydney'), 'AU');
        assert.strictEqual(holidays.countryOfZone('Pacific/Auckland'), 'NZ');
        assert.strictEqual(holidays.countryOfZone('Europe/Paris'), 'FR');
        assert.strictEqual(holidays.countryOfZone('UTC'), null, 'UTC says nothing');
        assert.strictEqual(holidays.countryOfZone('Europe/Lisbon'), null, 'a country without a list says nothing');
        assert.strictEqual(holidays.countryOfZone(''), null);
    });

    await check('the country: the query, else the cookie, else the zone; an unknown code is ignored', () => {
        assert.strictEqual(holidays.resolveCountry({ query: 'GB', cookie: 'JP', tz: 'Europe/Berlin' }), 'GB');
        assert.strictEqual(holidays.resolveCountry({ query: null, cookie: 'JP', tz: 'Europe/Berlin' }), 'JP');
        assert.strictEqual(holidays.resolveCountry({ query: null, cookie: null, tz: 'Europe/Berlin' }), 'DE');
        assert.strictEqual(holidays.resolveCountry({ query: 'ZZ', cookie: null, tz: 'Europe/Berlin' }), 'DE', 'an unknown code is ignored');
        assert.strictEqual(holidays.resolveCountry({ query: null, cookie: 'ZZ', tz: 'UTC' }), null);
        assert.strictEqual(holidays.resolveCountry({}), null);
        assert.strictEqual(holidays.countryOf('us'), 'US', 'the code is read whatever its case');
        assert.strictEqual(holidays.countryOf('ZZ'), null);
        assert.strictEqual(holidays.countryName('DE'), 'Germany');
    });

    await check('the week: a holiday is an all-day item at the top of its day, with its own kind', () => {
        const w = week.build({
            tz: 'America/New_York', now: Date.parse('2026-11-25T12:00:00Z'),
            holidays: [{ date: '2026-11-26', name: 'Thanksgiving Day', country: 'US' }],
            imports: [{ date: '2026-11-26', allDay: true, title: 'Team offsite', calendar: 'Work' }],
        });
        const day = w.days.find((d) => d.key === '2026-11-26');
        assert.deepStrictEqual(day.items.map((i) => i.kind), ['holiday', 'import'], 'the holiday comes first');
        assert.strictEqual(day.items[0].title, 'Thanksgiving Day');
        assert.strictEqual(day.items[0].time, 'All day');
        assert.strictEqual(day.items[0].allDay, true);
        assert.strictEqual(day.items[0].country, 'US');
        assert.strictEqual(day.items[0].href, null, 'a holiday has no page of its own');
        assert.ok(!w.days.find((d) => d.key === '2026-11-24').items.length, 'a holiday outside the week is not shown');
    });

    const t = await boot();
    const ana = t.network.addUser('ana');
    try {
        await check('the page: the country asked for, the cookie, and the holiday at the top of its day', async () => {
            const us = await t.get('/me/week?start=2026-11-23&country=US', { as: ana });
            assert.strictEqual(us.status, 200);
            assert.ok(us.text.includes('Thanksgiving Day'), 'the holiday of the country asked for');
            assert.ok(us.text.includes('is-holiday'), 'its own kind');
            assert.match(us.text, /<li class="td-wi is-holiday"/, 'a holiday is a line of its own');
            assert.ok(us.text.includes('<option value="US" selected>United States</option>'), 'the select shows the country');
            assert.ok(us.text.includes('<option value="">None</option>'), 'and the choice of none');

            const jp = await t.get('/me/week?start=2026-11-23', { as: ana, headers: { cookie: 'td_country=JP' } });
            assert.ok(jp.text.includes('勤労感謝の日'), 'the cookie says the country');
            assert.ok(!jp.text.includes('Thanksgiving Day'), 'and only that country\'s holidays');

            const none = await t.get('/me/week?start=2026-11-23', { as: ana });
            assert.ok(!none.text.includes('Thanksgiving Day'), 'no country, no holidays');
            assert.ok(!none.text.includes('is-holiday'));

            const unknown = await t.get('/me/week?start=2026-11-23&country=ZZ', { as: ana });
            assert.ok(!unknown.text.includes('Thanksgiving Day'), 'an unknown code is ignored');
            assert.ok(unknown.text.includes('<option value="" selected>None</option>'), 'and no country is chosen');
        });

        await check('the page: the form that sets the country, and the week it comes back to', async () => {
            const set = await t.get('/me/week/country', { as: ana, form: { country: 'GB', start: '2026-08-31', tz: 'Europe/London' } });
            assert.strictEqual(set.status, 303);
            assert.strictEqual(set.headers.get('location'), '/me/week?start=2026-08-31&tz=Europe%2FLondon');
            const cookie = set.headers.get('set-cookie') || '';
            assert.match(cookie, /td_country=GB/, 'the country is kept in a cookie');
            assert.match(cookie, /HttpOnly/, 'and the page does not read it');
            assert.match(cookie, /SameSite=Lax/);

            const week2 = await t.get('/me/week?start=2026-08-31', { as: ana, headers: { cookie: 'td_country=GB' } });
            assert.ok(week2.text.includes('Summer bank holiday'), 'the country\'s holiday shows');
            assert.ok(week2.text.includes('<option value="GB" selected>United Kingdom</option>'));

            const none = await t.get('/me/week/country', { as: ana, form: { country: '' } });
            assert.strictEqual(none.status, 303);
            assert.match(none.headers.get('set-cookie') || '', /td_country=;/, 'none clears the cookie');

            const unknown = await t.get('/me/week/country', { as: ana, form: { country: 'ZZ' } });
            assert.strictEqual(unknown.status, 303);
            assert.strictEqual(unknown.headers.get('set-cookie'), null, 'an unknown code changes nothing');

            const away = await t.get('/me/week/country', { as: ana, form: { country: 'GB' }, headers: { origin: 'https://elsewhere.example' } });
            assert.strictEqual(away.status, 403, 'a write from another site is refused');
        });
    } finally {
        await done(t);
    }
})();
