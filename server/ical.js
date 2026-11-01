'use strict';
/**
 * Reading a calendar in iCalendar (RFC 5545), far enough and no further (plan L48 R3: "import any calendar by ICS
 * address"). Pure: it reads text and gives back events; it fetches nothing and writes nothing, so every reading
 * can be tried on its own.
 *
 * What is read:
 *   VEVENT with SUMMARY, DTSTART and DTEND (a DATE-TIME with TZID, a DATE for an all-day event, or a time in
 *   UTC), DURATION when there is no DTEND, EXDATE, and STATUS (a CANCELLED event is not shown);
 *   RRULE with FREQ=DAILY, FREQ=WEEKLY with BYDAY, or FREQ=MONTHLY by the day of the month, each with INTERVAL,
 *   COUNT and UNTIL;
 *   a RECURRENCE-ID: the instance it names is left out of the series, and the moved instance is shown where it
 *   says it is.
 *
 * What is not read, on purpose: a rule with anything else in it (BYMONTH, BYSETPOS, an ordinal BYDAY such as
 * "2FR", a WKST that is not Monday), a zone this server does not know, an event with no DTSTART. A rule or an
 * event that is not read is left out and counted, never guessed at.
 *
 * A time with no zone (a "floating" time: no Z and no TZID) is read in the reader's own zone, because that is
 * what it means: the wall clock where it was written.
 *
 *   occurrences(text, { from, to, tz }) → { events, skipped }
 *     events:  [{ uid, title, start, end, allDay, date, tz }]   (start and end are epoch ms; an all-day event
 *              has a date "YYYY-MM-DD" and no instants)
 *     skipped: { reason: how many }   what was left out and why
 */
const when = require('./when');

const MAX_STEPS = 4000;      // the most recurrence steps one rule may take
const MAX_EVENTS = 2000;     // the most events one calendar may give in one window
const MAX_TITLE = 200;
const DAY_CODES = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
const SUPPORTED_PARTS = new Set(['FREQ', 'INTERVAL', 'COUNT', 'UNTIL', 'BYDAY', 'BYMONTHDAY', 'WKST']);

const pad2 = (n) => String(n).padStart(2, '0');
const keyOf = (d) => d.y + pad2(d.m) + pad2(d.d);
const dayNum = (d) => Date.UTC(d.y, d.m - 1, d.d) / 86400000;
const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const daysInMonth = (y, m) => [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1] || 30;
/** y-m-d plus n days, as a calendar date. */
function addDays(d, n) {
    const t = new Date(Date.UTC(d.y, d.m - 1, d.d + n));
    return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}
/** The weekday of a date: 1 Monday … 7 Sunday. */
const dowOf = (d) => ((new Date(Date.UTC(d.y, d.m - 1, d.d)).getUTCDay() + 6) % 7) + 1;

// ── The text ────────────────────────────────────────────────────────────────────────────────────────────────────
/** RFC 5545 folds a long line: a line break followed by a space or a tab is one line. */
function unfold(text) {
    return String(text == null ? '' : text)
        .replace(/^\uFEFF/, '')
        .replace(/\r\n[ \t]|\n[ \t]|\r[ \t]/g, '')
        .split(/\r\n|\n|\r/);
}
/** "SUMMARY;LANGUAGE=en:Hello" → { name, params, value }. */
function parseLine(line) {
    const colon = line.indexOf(':');
    if (colon < 0) return null;
    const bits = line.slice(0, colon).split(';');
    const name = bits[0].trim().toUpperCase();
    if (!name) return null;
    const params = {};
    for (const b of bits.slice(1)) {
        const eq = b.indexOf('=');
        if (eq < 0) continue;
        const key = b.slice(0, eq).trim().toUpperCase();
        let v = b.slice(eq + 1).trim();
        if (v.length > 1 && v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
        if (params[key] === undefined) params[key] = v;
    }
    return { name, params, value: line.slice(colon + 1) };
}
/** The components of a calendar, innermost first. */
function components(lines) {
    const stack = [];
    const out = [];
    for (const line of lines) {
        const p = parseLine(line);
        if (!p) continue;
        if (p.name === 'BEGIN') { stack.push({ type: String(p.value || '').trim().toUpperCase(), props: [] }); continue; }
        if (p.name === 'END') { const c = stack.pop(); if (c) out.push(c); continue; }
        if (stack.length) stack[stack.length - 1].props.push(p);
    }
    return out;
}
/** The properties of a component, by name. */
function propsOf(component) {
    const map = new Map();
    for (const p of component.props) {
        const list = map.get(p.name) || [];
        list.push(p);
        map.set(p.name, list);
    }
    return map;
}
const one = (map, name) => (map.get(name) || [null])[0];
/** A text value: the escapes undone, in one line, no longer than a title. */
function text(value) {
    return String(value == null ? '' : value)
        .replace(/\\([\\;,nN])/g, (_, c) => (c === 'n' || c === 'N') ? '\n' : c)
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, MAX_TITLE);
}

// ── Dates ──────────────────────────────────────────────────────────────────────────────────────────────────────
/** A DATE or DATE-TIME property → { kind, y, m, d, h, min, s, utc, tz }. */
function readDate(prop) {
    if (!prop) return null;
    const raw = String(prop.value == null ? '' : prop.value).trim();
    const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(raw);
    if (!m) return null;
    const isDate = String(prop.params.VALUE || '').toUpperCase() === 'DATE' || (!m[4] && !m[7]);
    const tzid = String(prop.params.TZID || '').trim().replace(/^\//, '');
    return {
        kind: isDate ? 'date' : 'datetime',
        y: +m[1], m: +m[2], d: +m[3],
        h: m[4] ? +m[4] : 0, min: m[5] ? +m[5] : 0, s: m[6] ? +m[6] : 0,
        utc: !!m[7],
        tz: isDate ? null : (tzid || null),
    };
}
/** The zone a time is written in: UTC, a zone this server knows, or null when it cannot be read. */
function zoneOf(d, readerZone) {
    if (!d || d.kind === 'date') return 'UTC';
    if (d.utc) return 'UTC';
    if (d.tz) return when.validTz(d.tz) ? d.tz : null;
    return when.validTz(readerZone) ? readerZone : 'UTC';
}
/** The instant a wall clock means in a zone (the seconds are added back: the zone helper works to the minute). */
function instantOf(wall, zone) {
    if (zone === 'UTC') return Date.UTC(wall.y, wall.m - 1, wall.d, wall.h, wall.min, wall.s);
    return when.atLocal(wall.y, wall.m, wall.d, wall.h, wall.min, zone).getTime() + wall.s * 1000;
}
/** A DURATION property (PT1H30M, P1D, P2W) in milliseconds, or null. */
function readDuration(prop) {
    if (!prop) return null;
    const m = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(String(prop.value || '').trim().toUpperCase());
    if (!m) return null;
    if (!m.slice(1).some((x) => x !== undefined)) return null;
    return ((+m[1] || 0) * 604800 + (+m[2] || 0) * 86400 + (+m[3] || 0) * 3600 + (+m[4] || 0) * 60 + (+m[5] || 0)) * 1000;
}

// ── The rule ───────────────────────────────────────────────────────────────────────────────────────────────────
/**
 * An RRULE, read only as far as this service reads rules. A part it does not know makes the whole rule
 * unreadable: the event is left out rather than shown at the wrong times.
 */
function readRRule(prop) {
    if (!prop) return null;
    const parts = {};
    for (const kv of String(prop.value || '').split(';')) {
        const eq = kv.indexOf('=');
        if (eq < 0) continue;
        parts[kv.slice(0, eq).trim().toUpperCase()] = kv.slice(eq + 1).trim();
    }
    for (const k of Object.keys(parts)) if (!SUPPORTED_PARTS.has(k)) return { error: 'rule:' + k.toLowerCase() };
    const freq = String(parts.FREQ || '').toUpperCase();
    if (!['DAILY', 'WEEKLY', 'MONTHLY'].includes(freq)) return { error: 'rule:freq' };
    if (parts.WKST && parts.WKST.toUpperCase() !== 'MO') return { error: 'rule:wkst' };
    const interval = Math.max(1, parseInt(parts.INTERVAL || '1', 10) || 1);
    let count = 0;
    if (parts.COUNT != null) {
        count = parseInt(parts.COUNT, 10);
        if (!Number.isFinite(count) || count < 1) return { error: 'rule:count' };
    }
    let until = null;
    if (parts.UNTIL != null) {
        until = readDate({ value: parts.UNTIL, params: {} });
        if (!until) return { error: 'rule:until' };
    }
    let bydays = null;
    if (parts.BYDAY != null) {
        bydays = [];
        for (const b of String(parts.BYDAY).split(',')) {
            const code = b.trim().toUpperCase();
            if (!DAY_CODES.includes(code)) return { error: /^-?\d/.test(code) ? 'rule:byday-ordinal' : 'rule:byday' };
            bydays.push(DAY_CODES.indexOf(code) + 1);
        }
        bydays.sort((a, b) => a - b);
    }
    let bymonthday = null;
    if (parts.BYMONTHDAY != null) {
        bymonthday = [];
        for (const b of String(parts.BYMONTHDAY).split(',')) {
            const n = parseInt(b.trim(), 10);
            if (!Number.isFinite(n) || n === 0 || n < -31 || n > 31) return { error: 'rule:bymonthday' };
            bymonthday.push(n);
        }
    }
    if (freq === 'DAILY' && bydays) return { error: 'rule:byday-daily' };
    if (freq === 'WEEKLY' && bymonthday) return { error: 'rule:bymonthday-weekly' };
    if (freq === 'MONTHLY' && bydays) return { error: 'rule:byday-monthly' };
    return { rule: { freq, interval, count, until, bydays, bymonthday } };
}

// ── The occurrences ───────────────────────────────────────────────────────────────────────────────────────────
/** The days a rule gives, in order. */
function* ruleDays(plan, rule, skip) {
    const step = rule.interval;
    if (rule.freq === 'DAILY') {
        let d = addDays(plan.start, skip * step);
        for (let k = 0; k < MAX_STEPS; k++) { yield d; d = addDays(d, step); }
        return;
    }
    if (rule.freq === 'WEEKLY') {
        const bydays = rule.bydays || [dowOf(plan.start)];
        const week0 = addDays(plan.start, -(dowOf(plan.start) - 1));
        let base = addDays(week0, skip * step * 7);
        for (let w = 0; w < MAX_STEPS; w++) {
            for (const b of bydays) yield addDays(base, b - 1);
            base = addDays(base, step * 7);
        }
        return;
    }
    // MONTHLY: the day of the month, the same day each month.
    let y = plan.start.y;
    let m = plan.start.m + skip * step;
    y += Math.floor((m - 1) / 12);
    m = ((m - 1) % 12 + 12) % 12 + 1;
    for (let k = 0; k < MAX_STEPS; k++) {
        const dim = daysInMonth(y, m);
        for (const dom of (rule.bymonthday || [plan.start.d])) {
            const d = dom > 0 ? dom : dim + 1 + dom;
            if (d >= 1 && d <= dim) yield { y, m, d };
        }
        const t = new Date(Date.UTC(y, m - 1 + step, 1));
        y = t.getUTCFullYear();
        m = t.getUTCMonth() + 1;
    }
}
/** "YYYYMMDD" → "YYYY-MM-DD". */
function isoDay(k) {
    return k.slice(0, 4) + '-' + k.slice(4, 6) + '-' + k.slice(6, 8);
}
/** "YYYYMMDD" → { y, m, d }. */
function fromDayDate(k) {
    return { y: +k.slice(0, 4), m: +k.slice(4, 6), d: +k.slice(6, 8) };
}

/**
 * The occurrences of one event in the window.
 *   plan:   { allDay, start: {y,m,d,h,min,s}, zone, duration, first }
 *   exdates { instants: Set<ms>, dates: Set<YYYYMMDD> }
 */
function expand(plan, rule, exdates, window) {
    const out = [];
    if (!plan) return out;
    const { from, to, fromDay, toDay } = window;
    const startKey = keyOf(plan.start);

    if (!rule) {
        if (plan.allDay) {
            const k = keyOf(plan.start);
            if (k >= fromDay && k <= toDay && !exdates.dates.has(k)) out.push({ date: k });
        } else {
            const at = plan.first;
            if (at >= from && at < to && !exdates.instants.has(at)) out.push({ start: at, end: at + plan.duration });
        }
        return out;
    }

    // UNTIL: an instant for a timed rule, a day for an all-day one.
    let untilAt = null;
    let untilDay = null;
    if (rule.until) {
        if (rule.until.kind === 'date') untilDay = keyOf(rule.until);
        else if (rule.until.utc) untilAt = Date.UTC(rule.until.y, rule.until.m - 1, rule.until.d, rule.until.h, rule.until.min, rule.until.s);
        else untilAt = instantOf(rule.until, plan.zone);
    }

    // A rule with no COUNT may be counted from near the window instead of from its first day.
    let skip = 0;
    if (!rule.count) {
        const fromDay0 = fromDayDate(fromDay);
        if (rule.freq === 'DAILY') {
            skip = Math.max(0, Math.floor((dayNum(fromDay0) - dayNum(plan.start)) / rule.interval) - 1);
        } else if (rule.freq === 'WEEKLY') {
            const week0 = addDays(plan.start, -(dowOf(plan.start) - 1));
            skip = Math.max(0, Math.floor((dayNum(fromDay0) - dayNum(week0)) / 7 / rule.interval) - 1);
        } else {
            const months = (fromDay0.y - plan.start.y) * 12 + (fromDay0.m - plan.start.m);
            skip = Math.max(0, Math.floor(months / rule.interval) - 1);
        }
    }

    let count = 0;
    let steps = 0;
    for (const day of ruleDays(plan, rule, skip)) {
        if (++steps > MAX_STEPS) break;
        const k = keyOf(day);
        if (k < startKey) continue;                       // before the rule's first day
        count++;
        if (rule.count && count > rule.count) break;
        if (untilDay && k > untilDay) break;
        const wall = { y: day.y, m: day.m, d: day.d, h: plan.start.h, min: plan.start.min, s: plan.start.s };
        const at = plan.allDay ? null : instantOf(wall, plan.zone);
        if (untilAt != null && at != null && at > untilAt) break;
        if (plan.allDay) {
            if (k < fromDay) continue;
            if (k > toDay) break;
            if (exdates.dates.has(k)) continue;
            out.push({ date: k });
        } else {
            if (at < from) continue;
            if (at >= to) break;
            if (exdates.instants.has(at)) continue;
            out.push({ start: at, end: at + plan.duration });
        }
        if (out.length >= MAX_EVENTS) break;
    }
    return out;
}

// ── Reading a calendar ─────────────────────────────────────────────────────────────────────────────────────────
/**
 * The events of one calendar in the window.
 *   from, to: epoch ms;  tz: the reader's own zone (a time with no zone is read in it).
 */
function occurrences(body, { from = Date.now(), to = from + 86400000, tz = 'UTC' } = {}) {
    const skipped = {};
    const skip = (reason) => { skipped[reason] = (skipped[reason] || 0) + 1; };
    const readerZone = when.validTz(tz) ? tz : 'UTC';
    const vevents = components(unfold(body)).filter((c) => c.type === 'VEVENT');

    // The window in the reader's own dates: an all-day event is a day, not an instant.
    const window = {
        from, to,
        fromDay: keyOf(when.partsIn(new Date(from), readerZone)),
        toDay: keyOf(when.partsIn(new Date(to - 1), readerZone)),
    };

    // By UID: the series (a master) and the instances that move it.
    const masters = new Map();
    const overrides = [];
    const taken = new Map();          // uid → the keys an instance takes away from the series
    for (const c of vevents) {
        const map = propsOf(c);
        const uid = text(one(map, 'UID') ? one(map, 'UID').value : '') || null;
        const rid = readDate(one(map, 'RECURRENCE-ID'));
        if (rid) {
            overrides.push({ map, uid });
            if (uid) {
                let key = null;
                if (rid.kind === 'date') key = 'd:' + keyOf(rid);
                else {
                    const z = zoneOf(rid, readerZone);
                    if (z) key = 'i:' + instantOf(rid, z);
                }
                if (key) {
                    if (!taken.has(uid)) taken.set(uid, new Set());
                    taken.get(uid).add(key);
                }
            }
            continue;
        }
        if (!uid) { skip('no-uid'); continue; }
        const seen = masters.get(uid);
        const seq = parseInt(String(one(map, 'SEQUENCE') ? one(map, 'SEQUENCE').value : '0'), 10) || 0;
        if (!seen || seq >= seen.seq) masters.set(uid, { map, seq });
    }

    const events = [];
    const read = (entry, single) => {
        const map = entry.map;
        const status = String(one(map, 'STATUS') ? one(map, 'STATUS').value : '').trim().toUpperCase();
        if (status === 'CANCELLED') { skip('cancelled'); return; }
        const dtstart = readDate(one(map, 'DTSTART'));
        if (!dtstart) { skip('no-start'); return; }
        const eventZone = zoneOf(dtstart, readerZone);
        if (!eventZone) { skip('unknown-zone'); return; }
        const uid = text(one(map, 'UID') ? one(map, 'UID').value : '') || null;

        // An instance that moves a series is one event; a series is read through its rule.
        const rruleProp = single ? null : one(map, 'RRULE');
        const rule = rruleProp ? readRRule(rruleProp) : null;
        if (rule && rule.error) { skip(rule.error); return; }

        // Where the first occurrence is, and how long it is.
        const allDay = dtstart.kind === 'date';
        const dtend = readDate(one(map, 'DTEND'));
        const durationProp = readDuration(one(map, 'DURATION'));
        let duration;
        if (dtend) {
            if (allDay || dtend.kind === 'date') {
                const a = Date.UTC(dtstart.y, dtstart.m - 1, dtstart.d);
                const b = Date.UTC(dtend.y, dtend.m - 1, dtend.d);
                duration = Math.max(b - a, 86400000);
            } else {
                const a = instantOf(dtstart, eventZone);
                const b = instantOf(dtend, zoneOf(dtend, readerZone) || eventZone);
                if (a == null || b == null || b < a) { skip('bad-end'); return; }
                duration = b - a;
            }
        } else if (durationProp) {
            duration = durationProp;
        } else {
            duration = allDay ? 86400000 : 3600000;
        }

        const wall = { y: dtstart.y, m: dtstart.m, d: dtstart.d, h: dtstart.h, min: dtstart.min, s: dtstart.s };
        const plan = {
            allDay, start: wall, zone: eventZone, duration,
            first: allDay ? null : instantOf(wall, eventZone),
        };

        // The days this event is not on.
        const exdates = { instants: new Set(), dates: new Set() };
        for (const p of (map.get('EXDATE') || [])) {
            for (const piece of String(p.value || '').split(',')) {
                const d = readDate({ value: piece.trim(), params: p.params });
                if (!d) continue;
                if (d.kind === 'date') exdates.dates.add(keyOf(d));
                else {
                    const z = zoneOf(d, readerZone);
                    if (z) exdates.instants.add(instantOf(d, z));
                }
            }
        }

        const title = text(one(map, 'SUMMARY') ? one(map, 'SUMMARY').value : '') || '(no title)';
        const gone = uid && taken.get(uid) ? taken.get(uid) : null;
        for (const o of expand(plan, rule && rule.rule, exdates, window)) {
            if (gone) {
                const key = o.date ? 'd:' + o.date : 'i:' + o.start;
                if (gone.has(key)) continue;
            }
            events.push({
                uid,
                title,
                allDay: !!o.date,
                date: o.date ? isoDay(o.date) : null,
                start: o.start == null ? null : o.start,
                end: o.end == null ? null : o.end,
                tz: allDay ? null : eventZone,
            });
        }
    };

    for (const entry of masters.values()) read(entry, false);
    for (const entry of overrides) read(entry, true);

    events.sort((a, b) => (a.allDay !== b.allDay ? (a.allDay ? -1 : 1) : ((a.start || 0) - (b.start || 0))));
    return { events: events.slice(0, MAX_EVENTS), skipped };
}

module.exports = { occurrences, unfold, parseLine, components, readDate, readRRule, readDuration, text };
