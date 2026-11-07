'use strict';
// The home's three scenes show the real calendar: the next public event with its own channel and time, the next events
// in their own day columns, and the next real schedule. With nothing coming up and nothing scheduled they say so and
// link the real schedule form; the written-in cast is gone.
const assert = require('assert');
const views = require('../server/views');

const NOW = Date.parse('2026-11-07T12:00:00Z');
const event = { id: 'ev1', title: 'Real Seattle meetup', channel: 'realstreamer', starts_at: '2026-11-07T14:00:00Z', tz: 'UTC', status: 'scheduled', kind: 'stream', visibility: 'public' };
const next = { id: 'ev2', title: 'A real workshop', channel: 'another_real', starts_at: '2026-11-08T18:00:00Z', tz: 'UTC', status: 'scheduled', kind: 'event', visibility: 'public' };
const page = views.home({ upcoming: [event, next], now: NOW });

assert.ok(page.includes('Real Seattle meetup'), 'the first real event is in the reminder');
assert.ok(page.includes('@realstreamer'), 'its own channel is named');
assert.ok(page.includes('2:00 PM UTC'), 'its own time is shown');
assert.ok(page.includes('href="/e/ev1"'), 'the reminder links the event');
assert.ok(page.includes('A real workshop'), 'the next event is on the calendar');
assert.ok(!/Night owls|goosely|Robot build|Speedrun Sunday|carol/.test(page), 'no written-in event, channel or person');

const empty = views.home({ upcoming: [], now: NOW });
assert.ok(empty.includes('No event to remind you of yet'), 'the reminder says there is nothing');
assert.ok(empty.includes('Nothing on the calendar yet'), 'the calendar says there is nothing');
assert.ok(empty.includes('Nothing scheduled yet'), 'the schedule scene says there is nothing');
assert.ok(empty.includes('href="/schedule">Schedule a stream</a>'), 'and each links the real schedule form');
assert.ok(!/Night owls|goosely|Robot build|Speedrun Sunday|carol/.test(empty), 'no written-in cast in the empty state');

console.log('today home: the scenes read the real calendar, or say there is nothing to show');
