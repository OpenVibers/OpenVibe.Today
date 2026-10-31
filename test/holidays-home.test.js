'use strict';
// Holidays on Today's home (10-31): the import brings 25 countries' public holidays, so they get one short section of
// their own, one line per holiday and day with the countries that keep it, most-shared first; "Coming up" stays what
// people scheduled. A holiday is titled in English, its local name kept in the description.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const views = require('../server/views');
const holidays = require('../server/imports/holidays');

const pages = fs.readFileSync(path.join(__dirname, '..', 'server/http/pages.js'), 'utf8');
const store = fs.readFileSync(path.join(__dirname, '..', 'server/events/store.js'), 'utf8');
assert.match(store, /kind = ANY\(\$\$\{args\.length\}::text\[\]\)/, 'a public list can keep only some kinds');
assert.match(store, /kind <> ALL\(\$\$\{args\.length\}::text\[\]\)/, 'or leave some out');
assert.match(pages, /exceptKinds: HOLIDAYS/, 'the home\'s Coming up leaves holidays out');
assert.match(pages, /kinds: \['holiday'\]/, 'and reads them on their own');

const now = Date.parse('2026-10-31T12:00:00Z');
const hol = (cc, title, date) => ({ id: `tev_${cc}${date}`, kind: 'holiday', title, starts_at: `${date}T00:00:00.000Z`, tz: 'UTC', status: 'scheduled', source_id: `holiday:${cc}:${date}:x` });
const rows = [hol('PL', 'All Saints\' Day', '2026-11-01'), hol('FR', 'All Saints\' Day', '2026-11-01'), hol('AT', 'All Saints\' Day', '2026-11-01'), hol('BE', 'All Saints\' Day', '2026-11-01'), hol('ES', 'All Saints Day', '2026-11-01'), hol('US', 'Veterans Day', '2026-11-11')];
const page = views.home({ upcoming: [], holidays: rows, now });
assert.ok(page.includes('id="td-holidays"'), 'the holidays have their own section');
assert.strictEqual((page.match(/<b>All Saints&#39;? ?Day<\/b>|<b>All Saints' Day<\/b>|<b>All Saints&#x27; Day<\/b>/g) || []).length, 1, 'one line for a holiday many countries keep');
assert.match(page, /Austria, Belgium, France and 2 more/, 'the countries by name, a long list cut short');
assert.ok(!page.includes('id="td-upcoming"'), 'no Coming up made of holidays');
assert.ok(page.indexOf('id="td-holidays"') < page.indexOf('class="sc-room-scenes"'), 'real data before the scenes');

const [pl] = holidays.recordsFor([{ date: '2026-11-01', localName: 'Wszystkich Świętych', name: 'All Saints\' Day', countryCode: 'PL', types: ['Public'] }], { country: 'PL', year: 2026 });
assert.strictEqual(pl.title, 'All Saints\' Day', 'titled in English');
assert.match(pl.description, /^Wszystkich Świętych: a public holiday in Poland/, 'the local name and the country in words');
assert.match(pl.source_id, /^holiday:PL:2026-11-01:/, 'the same source id as before, so a re-run updates the row');
console.log('today holidays: their own section, grouped, in English');
