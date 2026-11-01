'use strict';
/**
 * A person's week (plan L48 R3; the owner, 11-01: "view it through openvibe.today… calendar type shit"): seven days
 * from a Monday, in the person's own time zone, each with what happens in it, in time order:
 *   - their own reminders (server/my-reminders.js): each time a rule fires that week, except a rule that fires every
 *     few minutes or hours (interval), which is one line a day with its span ("Every 2 hours, 9:00–17:00");
 *   - their events, the events they set a reminder on, and the events of the channels they follow (server/agenda.js);
 *   - the events of the calendars they imported (server/calendar-imports.js), each with the calendar's short name;
 *   - the public holidays of their country (server/holidays.js), each at the top of its day.
 *
 *   build({ tz, start, now, reminders, events, imports, holidays }) → { tz, start, prev, next, thisWeek, days: [{ key,
 *                                                    label, date, today, items: [{ kind, at, time, title, href, … }] }] }
 * Pure: the callers fetch, this arranges. tz is an IANA zone (UTC when unknown); start is a YYYY-MM-DD (any day of the
 * week it is in) or null for this week.
 */
const when = require('./when');

const DAY_NAMES = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTHS = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const PER_RULE = 60;   // at most this many times one reminder shows in a week (a daily rule shows 7)

const pad = (n) => String(n).padStart(2, '0');
const keyOf = (p) => `${p.y}-${pad(p.m)}-${pad(p.d)}`;
function addDays(y, m, d, n) {
    const t = new Date(Date.UTC(y, m - 1, d + n));
    return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(), dow: ((t.getUTCDay() + 6) % 7) + 1 };
}
const clock = (p) => `${p.h}:${pad(p.min)}`;

function build({ tz = 'UTC', start = null, now = Date.now(), reminders = [], events = [], imports = [], holidays = [] } = {}) {
    const zone = when.validTz(tz) ? tz : 'UTC';
    const today = when.partsIn(new Date(now), zone);
    // The Monday of the week asked for (or this one).
    let base = today;
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(start || ''));
    if (m) base = { ...addDays(+m[1], +m[2], +m[3], 0) };
    const mon = addDays(base.y, base.m, base.d, -((base.dow || 1) - 1));
    const dates = Array.from({ length: 7 }, (_, i) => addDays(mon.y, mon.m, mon.d, i));
    const from = when.atLocal(dates[0].y, dates[0].m, dates[0].d, 0, 0, zone).getTime();
    const end = addDays(dates[6].y, dates[6].m, dates[6].d, 1);
    const to = when.atLocal(end.y, end.m, end.d, 0, 0, zone).getTime();
    const todayKey = keyOf(today);
    const days = dates.map((d) => ({
        key: keyOf(d), date: d, today: keyOf(d) === todayKey,
        label: `${DAY_NAMES[d.dow]} ${d.d}`, long: `${DAY_NAMES[d.dow]}, ${MONTHS[d.m]} ${d.d}`,
        items: [],
    }));
    const dayOf = (ms) => days.find((x) => x.key === keyOf(when.partsIn(new Date(ms), zone))) || null;

    // Reminders: each time it fires this week; an interval rule once a day, with its span.
    for (const r of reminders) {
        if (!r || r.status !== 'active' || !r.rule) continue;
        const rz = when.validTz(r.tz) ? r.tz : zone;
        if (r.rule.kind === 'interval') {
            const seen = new Set();
            let t = when.next(r.rule, { after: new Date(from - 1), tz: rz });
            for (let i = 0; t && t.getTime() < to && i < 2000; i++) {
                const day = dayOf(t.getTime());
                if (day && !seen.has(day.key)) {
                    seen.add(day.key);
                    day.items.push({ kind: 'band', at: t.toISOString(), time: clock(when.partsIn(t, zone)), title: r.title, summary: when.describe(r.rule, { tz: rz }), href: '/me#reminders', id: r.id });
                }
                t = when.next(r.rule, { after: t, tz: rz });
            }
            continue;
        }
        let t = when.next(r.rule, { after: new Date(from - 1), tz: rz });
        for (let i = 0; t && t.getTime() < to && i < PER_RULE; i++) {
            const day = dayOf(t.getTime());
            if (day) day.items.push({ kind: 'reminder', at: t.toISOString(), time: clock(when.partsIn(t, zone)), title: r.title, repeats: r.rule.kind !== 'once', href: '/me#reminders', id: r.id });
            t = when.next(r.rule, { after: t, tz: rz });
        }
    }
    // Events: theirs, reminded, and the channels they follow.
    for (const e of events) {
        if (!e || e.status === 'cancelled') continue;
        const at = Date.parse(e.starts_at);
        if (!(at >= from && at < to)) continue;
        const day = dayOf(at);
        if (!day) continue;
        day.items.push({ kind: e.own ? 'event' : 'stream', at: new Date(at).toISOString(), time: clock(when.partsIn(new Date(at), zone)), title: e.title, channel: e.channel || null, live: e.status === 'live', reminded: !!e.reminded, href: `/e/${e.id}`, id: e.id });
    }
    // The public holidays of their country: an all-day item at the top of its day, like an imported all-day event.
    for (const h of holidays || []) {
        if (!h || typeof h.date !== 'string') continue;
        const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(h.date);
        if (!d) continue;
        const day = days.find((x) => x.key === h.date);
        if (!day) continue;
        day.items.push({
            kind: 'holiday', at: when.atLocal(+d[1], +d[2], +d[3], 0, 0, zone).toISOString(),
            time: 'All day', allDay: true, title: h.name || 'A public holiday',
            country: h.country || null, href: null,
        });
    }
    // The calendars they imported: their own kind, in the person's zone. An all-day event sits at the top of its day.
    for (const it of imports || []) {
        if (!it) continue;
        let day = null;
        let at = null;
        let time = null;
        if (it.allDay) {
            const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(it.date || ''));
            if (!d) continue;
            day = days.find((x) => x.key === it.date) || null;
            if (!day) continue;
            at = when.atLocal(+d[1], +d[2], +d[3], 0, 0, zone).toISOString();
            time = 'All day';
        } else {
            const ms = Number.isFinite(it.start) ? it.start : Date.parse(it.at || '');
            if (!Number.isFinite(ms)) continue;
            day = dayOf(ms);
            if (!day) continue;
            at = new Date(ms).toISOString();
            time = clock(when.partsIn(new Date(ms), zone));
        }
        day.items.push({ kind: 'import', at, time, allDay: !!it.allDay, title: it.title || 'An event', calendar: it.calendar || null, href: null });
    }
    // The order of a day: the holidays first, then the all-day events, then the hours.
    const rank = (it) => (it.allDay ? (it.kind === 'holiday' ? 0 : 1) : 2);
    days.forEach((d) => d.items.sort((a, b) => (rank(a) - rank(b) || (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))));
    const prev = addDays(mon.y, mon.m, mon.d, -7), next = addDays(mon.y, mon.m, mon.d, 7);
    const thisMon = addDays(today.y, today.m, today.d, -((today.dow || 1) - 1));
    return {
        tz: zone, from: new Date(from).toISOString(), to: new Date(to).toISOString(), start: keyOf(mon),
        prev: keyOf(prev), next: keyOf(next), thisWeek: keyOf(mon) === keyOf(thisMon),
        title: `${MONTHS[dates[0].m]} ${dates[0].d} – ${dates[0].m === dates[6].m ? '' : `${MONTHS[dates[6].m]} `}${dates[6].d}, ${dates[6].y}`,
        days,
    };
}

module.exports = { build };
