'use strict';
/**
 * When a reminder fires, from plain words (plan L48, R1; the owner, 2026-11-01: "set reminders for some part of the
 * day or whatever timer or however often they want").
 *
 *   parse(text, { now, tz, parts })  → { title, rule, next_at, summary } or { error }
 *   next(rule, { after, tz, parts }) → the next time (a Date) strictly after `after`, or null when it is over
 *   describe(rule, { parts })        → the rule in words ("Every 2 hours, 9:00–17:00")
 *
 * Everything is computed in the person's own time zone (IANA, from their browser), so "every day at 9" is 9 o'clock
 * where they are, across daylight-saving changes.
 *
 * A rule is one of:
 *   { kind: 'once', at: ISO }
 *   { kind: 'daily', times: ['09:00'], days?: [1..7] }          days: ISO weekdays (1 Monday … 7 Sunday); none = every day
 *   { kind: 'interval', minutes: N, from?: '09:00', to?: '17:00', days?: [1..7] }
 *   { kind: 'monthly', day: 1..31, time: '09:00' }              a month without that day uses its last day
 *
 * The words it understands (English): "in 20 minutes", "at 3pm", "at 15:30", "tomorrow", "tonight", "this evening",
 * "on Friday at 5", "every day at 9", "daily", "every morning", "weekdays at 8:30", "weekends", "every Monday and
 * Thursday at 7pm", "every 2 hours", "every 30 minutes from 9 to 5", "hourly", "on the 1st of every month",
 * "monthly on the 15th". What remains is the title ("remind me to" and "to" dropped).
 */

const PARTS = { morning: '09:00', afternoon: '14:00', evening: '19:00', night: '21:30' };
const DAYS = { monday: 1, mon: 1, tuesday: 2, tue: 2, tues: 2, wednesday: 3, wed: 3, thursday: 4, thu: 4, thur: 4, thurs: 4, friday: 5, fri: 5, saturday: 6, sat: 6, sunday: 7, sun: 7 };
const DAY_NAMES = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const WEEKDAYS = [1, 2, 3, 4, 5];
const WEEKENDS = [6, 7];
const MAX_TITLE = 200;

// ── Time zones ────────────────────────────────────────────────────────────────────────────────────────────────────
function validTz(tz) {
    try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}
const fmtCache = new Map();
/** The wall clock in `tz` at instant `d`: { y, m, d, h, min, dow } (dow 1 Monday … 7 Sunday). */
function partsIn(date, tz) {
    let f = fmtCache.get(tz);
    if (!f) {
        f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'short' });
        fmtCache.set(tz, f);
    }
    const o = {};
    for (const p of f.formatToParts(date)) o[p.type] = p.value;
    const dow = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[o.weekday];
    return { y: Number(o.year), m: Number(o.month), d: Number(o.day), h: Number(o.hour) % 24, min: Number(o.minute), dow };
}
/** The instant when the wall clock in `tz` reads y-m-d h:min (a time skipped by a clock change moves forward). */
function atLocal(y, m, d, h, min, tz) {
    const guess = Date.UTC(y, m - 1, d, h, min);
    let t = guess;
    for (let i = 0; i < 3; i++) {
        const p = partsIn(new Date(t), tz);
        const shown = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min);
        const diff = shown - guess;
        if (diff === 0) return new Date(t);
        t -= diff;
    }
    return new Date(t);
}
/** y-m-d plus n days, as a calendar date (no time zone involved). */
function addDays(y, m, d, n) {
    const t = new Date(Date.UTC(y, m - 1, d + n));
    return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(), dow: ((t.getUTCDay() + 6) % 7) + 1 };
}
const hm = (s) => { const [h, min] = String(s).split(':').map(Number); return { h, min }; };
const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

// ── The next time ─────────────────────────────────────────────────────────────────────────────────────────────────
function next(rule, { after = new Date(), tz = 'UTC', parts = PARTS } = {}) {
    void parts;
    const a = after instanceof Date ? after : new Date(after);
    if (!rule || typeof rule !== 'object') return null;
    if (rule.kind === 'once') { const t = new Date(rule.at); return t > a ? t : null; }
    const today = partsIn(a, tz);
    if (rule.kind === 'daily') {
        const times = (rule.times || []).slice().sort();
        for (let k = 0; k < 15; k++) {
            const day = addDays(today.y, today.m, today.d, k);
            if (rule.days && rule.days.length && !rule.days.includes(day.dow)) continue;
            for (const t of times) { const { h, min } = hm(t); const at = atLocal(day.y, day.m, day.d, h, min, tz); if (at > a) return at; }
        }
        return null;
    }
    if (rule.kind === 'interval') {
        const stepMin = Math.max(5, Number(rule.minutes) || 60);
        if (!rule.from) {
            // No window: every step from the moment it was set ("every 2 hours" set at 10:15 fires at 12:15, 14:15…),
            // counted in real time, so midnight and clock changes do not move it.
            const step = stepMin * 60000;
            const start = new Date(rule.start || a).getTime();
            let t = start + Math.max(1, Math.floor((a.getTime() - start) / step) + 1) * step;
            for (let i = 0; i < 4000; i++, t += step) {
                const d = new Date(t);
                if (!rule.days || !rule.days.length || rule.days.includes(partsIn(d, tz).dow)) return d;
            }
            return null;
        }
        const from = hm(rule.from);
        const to = rule.to ? hm(rule.to) : { h: 23, min: 59 };
        const startMin = from.h * 60 + from.min;
        const endMin = to.h * 60 + to.min;
        for (let k = 0; k < 15; k++) {
            const day = addDays(today.y, today.m, today.d, k);
            if (rule.days && rule.days.length && !rule.days.includes(day.dow)) continue;
            for (let mins = startMin; mins <= endMin; mins += stepMin) {
                const at = atLocal(day.y, day.m, day.d, Math.floor(mins / 60), mins % 60, tz);
                if (at > a) return at;
            }
        }
        return null;
    }
    if (rule.kind === 'monthly') {
        const { h, min } = hm(rule.time || '09:00');
        for (let k = 0; k < 14; k++) {
            const mm = ((today.m - 1 + k) % 12) + 1;
            const yy = today.y + Math.floor((today.m - 1 + k) / 12);
            const dd = Math.min(Number(rule.day) || 1, lastDay(yy, mm));
            const at = atLocal(yy, mm, dd, h, min, tz);
            if (at > a) return at;
        }
        return null;
    }
    return null;
}

// ── Words ─────────────────────────────────────────────────────────────────────────────────────────────────────────
const two = (n) => String(n).padStart(2, '0');
/** 9 am, 9:30 am, 6 pm, 12 pm (noon), 12 am (midnight). */
const h12 = (h, min) => `${h % 12 || 12}${min ? `:${two(min)}` : ''} ${h < 12 ? 'am' : 'pm'}`;
const clock = (s) => { const { h, min } = hm(s); return h12(h, min); };
const MONTHS = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const listOf = (a) => (a.length < 2 ? a.join('') : `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`);
function daysWords(days) {
    if (!days || !days.length || days.length === 7) return '';
    const set = days.slice().sort().join(',');
    if (set === WEEKDAYS.join(',')) return 'weekdays';
    if (set === WEEKENDS.join(',')) return 'weekends';
    return listOf(days.slice().sort().map((d) => `${DAY_NAMES[d]}s`));
}
function everyMinutes(n) {
    if (n % 1440 === 0) return n === 1440 ? 'Every day' : `Every ${n / 1440} days`;
    if (n % 60 === 0) return n === 60 ? 'Every hour' : `Every ${n / 60} hours`;
    return `Every ${n} minutes`;
}
function describe(rule, { tz = 'UTC', now = new Date() } = {}) {
    if (!rule) return '';
    if (rule.kind === 'once') {
        const t = new Date(rule.at);
        const p = partsIn(t, tz), n = partsIn(now, tz);
        const tomorrow = addDays(n.y, n.m, n.d, 1);
        const day = p.y === n.y && p.m === n.m && p.d === n.d ? 'Today' : (p.y === tomorrow.y && p.m === tomorrow.m && p.d === tomorrow.d ? 'Tomorrow' : `${DAY_NAMES[p.dow].slice(0, 3)}, ${MONTHS[p.m]} ${p.d}`);
        return `${day} at ${h12(p.h, p.min)}`;
    }
    if (rule.kind === 'daily') {
        const d = daysWords(rule.days);
        const at = listOf((rule.times || []).map(clock));
        return d ? `${d[0].toUpperCase()}${d.slice(1)} at ${at}` : `Every day at ${at}`;
    }
    if (rule.kind === 'interval') {
        const d = daysWords(rule.days);
        const win = rule.from || rule.to ? `, ${clock(rule.from || '00:00')}–${clock(rule.to || '23:59')}` : '';
        return `${everyMinutes(rule.minutes)}${win}${d ? `, ${d}` : ''}`;
    }
    if (rule.kind === 'monthly') {
        const n = Number(rule.day);
        const th = n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th';
        return `Every month on the ${n}${th} at ${clock(rule.time || '09:00')}`;
    }
    return '';
}

// A time of day in words: "3pm", "3:30 pm", "15:30", "noon", "midnight", or a part of the day.
const TIME = String.raw`(?:(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?|noon|midday|midnight)`;
function toClock(m, parts, fallbackPart) {
    if (!m) return null;
    const word = String(m[0]).toLowerCase();
    if (/noon|midday/.test(word)) return '12:00';
    if (/midnight/.test(word)) return '00:00';
    let h = Number(m[1]);
    const min = m[2] ? Number(m[2]) : 0;
    const ap = m[3] ? m[3].replace(/\./g, '').toLowerCase() : null;
    if (ap === 'pm' && h < 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;
    // "at 5" with no am/pm in the afternoon or evening part of a sentence reads as 5 pm; plain hours under 7 do too.
    if (!ap && h >= 1 && h <= 6 && !m[2] && fallbackPart !== 'morning') h += 12;
    if (h > 23 || min > 59) return null;
    return `${two(h)}:${two(min)}`;
}

function parse(text, { now = new Date(), tz = 'UTC', parts = PARTS } = {}) {
    const zone = validTz(tz) ? tz : 'UTC';
    const P = { ...PARTS, ...(parts || {}) };
    let s = ` ${String(text || '').replace(/\s+/g, ' ').trim()} `;
    if (!s.trim()) return { error: 'Say what to remind you of, and when: "stretch every 2 hours from 9 to 5".' };
    const lower = () => s.toLowerCase();
    const cut = (re) => { const m = re.exec(s); if (m) s = `${s.slice(0, m.index)} ${s.slice(m.index + m[0].length)}`; return m; };
    let rule = null;
    let days = null;
    let times = [];
    let partWord = null;

    // Days of the week: "weekdays", "weekends", "every Monday and Thursday", "on Friday".
    let m;
    if ((m = cut(/\b(?:on\s+)?(?:every\s+)?week ?days\b/i))) days = WEEKDAYS;
    else if ((m = cut(/\b(?:on\s+)?(?:every\s+)?week ?ends?\b/i))) days = WEEKENDS;
    const dayRe = /\b(?:(every|each|on)\s+)?((?:mon|tues?|wed|thu(?:rs?)?|fri|sat|sun)(?:day)?s?)((?:\s*(?:,|and|&)\s*(?:mon|tues?|wed|thu(?:rs?)?|fri|sat|sun)(?:day)?s?)*)\b/i;
    let onceDay = null;
    if (!days && (m = dayRe.exec(s))) {
        const names = `${m[2]} ${m[3] || ''}`.toLowerCase().split(/[\s,&]+|and/).map((w) => w.replace(/s$/, '')).filter(Boolean);
        const list = [...new Set(names.map((w) => DAYS[w] || DAYS[`${w}day`] || DAYS[w.replace(/day$/, '')]).filter(Boolean))];
        const repeating = /every|each/i.test(m[1] || '') || /s$/i.test(m[2]) || list.length > 1;
        if (list.length) {
            cut(dayRe);
            if (repeating) days = list; else onceDay = list[0];
        }
    }

    // How often.
    if ((m = cut(/\b(?:every|each)\s+(\d+|an?|one|two|three|four|five|six|ten|fifteen|twenty|thirty|forty-five|ninety)?\s*(minutes?|mins?|hours?|hrs?)\b/i))) {
        const words = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, ten: 10, fifteen: 15, twenty: 20, thirty: 30, 'forty-five': 45, ninety: 90 };
        const n = m[1] ? (Number(m[1]) || words[m[1].toLowerCase()] || 1) : 1;
        const minutes = /^h/i.test(m[2]) ? n * 60 : n;
        if (minutes < 5) return { error: 'The shortest repeat is every 5 minutes.' };
        rule = { kind: 'interval', minutes };
    } else if ((m = cut(/\bhourly\b/i))) {
        rule = { kind: 'interval', minutes: 60 };
    } else if ((m = cut(/\b(?:on\s+the\s+)?(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?(?:every|each)\s+month\b|\b(?:every\s+month|monthly)\s+on\s+the\s+(\d{1,2})(?:st|nd|rd|th)?\b|\bmonthly\b/i))) {
        const day = Number(m[1] || m[2] || 1);
        if (day < 1 || day > 31) return { error: 'A day of the month is 1 to 31.' };
        rule = { kind: 'monthly', day, time: null };
    } else if ((m = cut(/\b(?:every\s*day|daily|each\s+day|every\s+(morning|afternoon|evening|night))\b/i))) {
        rule = { kind: 'daily', times: [] };
        if (m[1]) partWord = m[1].toLowerCase();
    }

    // A window: "from 9 to 5", "between 9am and 6pm".
    let from = null, to = null;
    const winRe = new RegExp(String.raw`\b(?:from|between)\s+${TIME}\s*(?:to|until|till|and|-|–)\s*${TIME}`, 'i');
    if ((m = winRe.exec(s))) {
        const f = toClock([m[0], m[1], m[2], m[3]], P, 'morning');
        let tt = toClock([m[0].slice(m[0].search(/(?:to|until|till|and|-|–)\s*/i)).replace(/^(?:to|until|till|and|-|–)\s*/i, ''), m[4], m[5], m[6]], P, 'afternoon');
        if (f && tt) {
            if (tt <= f && !m[6]) tt = `${two((hm(tt).h + 12) % 24)}:${two(hm(tt).min)}`;
            from = f; to = tt;
            cut(winRe);
        }
    }

    // A relative time: "in 20 minutes", "in an hour", "in 2 days".
    if (!rule && (m = cut(/\bin\s+(\d+|an?|one|two|three|half an?)\s*(minutes?|mins?|hours?|hrs?|days?)\b/i))) {
        const words = { a: 1, an: 1, one: 1, two: 2, three: 3 };
        let n = /half/i.test(m[1]) ? 0.5 : (Number(m[1]) || words[m[1].toLowerCase()] || 1);
        const unit = m[2].toLowerCase();
        const ms = /^d/.test(unit) ? n * 86400000 : /^h/.test(unit) ? n * 3600000 : n * 60000;
        if (/half/i.test(m[1]) && /^m/.test(unit)) n = 30;
        rule = { kind: 'once', at: new Date(now.getTime() + Math.round(ms / 60000) * 60000).toISOString() };
    }

    // Times of day: "at 3pm", "at 9 and 5", "noon", parts of the day ("tonight", "this evening", "in the morning").
    const atRe = new RegExp(String.raw`\b(?:at|@)\s+${TIME}(?:\s*(?:and|&|,)\s*${TIME})*`, 'i');
    if ((m = atRe.exec(s))) {
        const all = [...m[0].matchAll(new RegExp(TIME, 'gi'))].map((x) => toClock(x, P, partWord)).filter(Boolean);
        if (all.length) { times = all; cut(atRe); }
    } else if ((m = cut(/\b(noon|midday|midnight)\b/i))) {
        times = [toClock([m[1]], P)];
    }
    const partRe = /\b(?:this|in the|every|tomorrow|tonight)?\s*(morning|afternoon|evening|night|tonight)\b/i;
    let dayShift = 0;
    if ((m = cut(/\btomorrow\b/i))) dayShift = 1;
    if ((m = cut(/\b(?:today)\b/i))) dayShift = 0;
    if ((m = partRe.exec(s))) {
        const w = m[1].toLowerCase() === 'tonight' ? 'night' : m[1].toLowerCase();
        partWord = partWord || w;
        cut(partRe);
    }
    if (!times.length && partWord) times = [P[partWord]];

    // Build the rule.
    if (rule && rule.kind === 'interval') {
        if (from) { rule.from = from; rule.to = to; }
        if (days) rule.days = days;
        if (!from) rule.start = new Date(now).toISOString();
    } else if (rule && rule.kind === 'monthly') {
        rule.time = times[0] || P.morning;
    } else if (rule && rule.kind === 'daily') {
        rule.times = times.length ? times : [P.morning];
        if (days) rule.days = days;
    } else if (!rule && (days || (from && to))) {
        if (from && to) return { error: 'Say how often in that window: "every hour from 9 to 5".' };
        rule = { kind: 'daily', times: times.length ? times : [P.morning], days };
    } else if (!rule) {
        // Once: a day (today, tomorrow, a weekday) and a time (or a part of the day).
        if (!times.length && !onceDay && !dayShift) return { error: 'Say when: "at 3pm", "tomorrow morning", "every day at 9" or "in 20 minutes".' };
        const n = partsIn(now, zone);
        let k = dayShift;
        if (onceDay) { k = (onceDay - n.dow + 7) % 7; }
        const t = hm(times[0] || P.morning);
        let day = addDays(n.y, n.m, n.d, k);
        let at = atLocal(day.y, day.m, day.d, t.h, t.min, zone);
        if (at <= now) { day = addDays(n.y, n.m, n.d, k + (onceDay ? 7 : 1)); at = atLocal(day.y, day.m, day.d, t.h, t.min, zone); }
        rule = { kind: 'once', at: at.toISOString() };
    }

    // What is left is the title.
    let title = s.replace(/\s+/g, ' ').trim()
        .replace(/^(?:please\s+)?(?:remind\s+me|reminder|remember|set\s+a\s+reminder)(?:\s+(?:to|that|about|of))?\s*/i, '')
        .replace(/^(?:to|that)\s+/i, '')
        .replace(/\s+(?:at|on|every|from|in|for|the)$/i, '')
        .replace(/[,.;:\s]+$/, '')
        .trim();
    if (!title) return { error: 'Say what to remind you of, as well as when.' };
    title = `${title[0].toUpperCase()}${title.slice(1)}`.slice(0, MAX_TITLE);
    const nextAt = next(rule, { after: now, tz: zone, parts: P });
    if (!nextAt) return { error: 'That time has already passed.' };
    return { title, rule, tz: zone, next_at: nextAt.toISOString(), summary: describe(rule, { tz: zone, now }) };
}

module.exports = { parse, next, describe, partsIn, atLocal, validTz, h12, PARTS };
