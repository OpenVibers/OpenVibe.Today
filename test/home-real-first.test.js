'use strict';
// Today's home leads with what is real (the owner, 10-31: empty sections made the rooms look unfinished). With nothing
// coming up there is no empty "Coming up" box under the hero: one short "be the first" row follows the scenes.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'server/views/index.js'), 'utf8');
assert.match(src, /const coming = upcoming\.length \? `<section class="td-coming" id="td-upcoming"/, 'Coming up only with something in it');
assert.match(src, /\$\{coming\}\$\{holidaysWeek\(holidays, now\)\}\$\{scenesHTML\}\$\{beFirst\}\$\{explore\}\$\{faq\}/, 'the real first, the missing after the scenes');
assert.ok(!src.includes('Nothing is scheduled yet'), 'no empty box under the hero');

const views = require('../server/views');
const page = views.home({ upcoming: [], live: [], now: Date.parse('2026-10-31T12:00:00Z') });
assert.ok(!page.includes('id="td-upcoming"'), 'no empty Coming up');
assert.ok(page.indexOf('Be the first') > page.indexOf('class="sc-room-scenes"'), 'the row follows the scenes');
assert.ok(page.includes('href="/schedule">Schedule a stream</a>'), 'it says how the first one starts');
console.log('today home: real first, one "be the first" row while nothing is coming up');
