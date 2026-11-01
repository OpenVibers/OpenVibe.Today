'use strict';
/**
 * The Today room's pages (plan 2026-10-28 §5.3, v1: the authority, schedules, Remind, ICS and the brief). Server-
 * rendered and whole without JavaScript: every action is a plain form or link. public/js/today.js adds the reader's
 * own time beside each event's, picks the device's time zone on the schedule form, and copies the feed URL.
 *
 *   home({ upcoming, now })                          the front door: the day's ring, what is coming, three scenes
 *   channel({ username, rows, now })                 a channel's schedule and its calendar
 *   event({ e, end, reminder, own, signedIn, path }) one event: when, Remind, Add to calendar, Watch, Cancel (owner)
 *   me({ name, agenda, reminders, feedUrl, now })    the person's agenda, reminders and private feed
 *   week({ name, week })                             the person's week, day by day (server/week.js, plan L48 R3)
 *   brief({ out, name, tz })                         the day's brief
 *   schedule({ values, problem, zones })             the schedule form
 *   signIn({ title, text, next })                    a page that needs an account
 *   developers()                                     the API, the feeds and the topics
 *   notFound()
 * Each returns HTML for the page body; server/http/pages.js sends it through the layout.
 */
const kit = require('openvibe-shared/kit');
const sc = require('openvibe-shared/showcase');
const rooms = require('openvibe-shared/rooms');
const { esc } = require('../render/html');

const ROOM = rooms.get('today');
const DAY = 24 * 60 * 60_000;

/** Parts of an instant in a zone (UTC when the zone is unknown). */
function parts(iso, tz) {
    const d = new Date(iso);
    const f = (zone) => Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })
        .formatToParts(d).map((p) => [p.type, p.value]));
    try { return f(tz || 'UTC'); } catch { return f('UTC'); }
}
const timeText = (p) => `${p.hour}:${p.minute} ${p.dayPeriod || ''}`.trim();
function dayKey(iso, tz) {
    try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso)); } catch { return String(iso).slice(0, 10); }
}
function dayLabel(iso, tz, now) {
    const k = dayKey(iso, tz);
    if (k === dayKey(new Date(now).toISOString(), tz)) return 'Today';
    if (k === dayKey(new Date(now + DAY).toISOString(), tz)) return 'Tomorrow';
    const p = parts(iso, tz);
    return `${p.weekday}, ${p.month} ${p.day}`;
}
/** "8:00 PM – 9:30 PM PDT" in the event's zone. */
function range(e, end) {
    const a = parts(e.starts_at, e.tz);
    const b = parts(end, e.tz);
    return `${timeText(a)} – ${timeText(b)} ${b.timeZoneName}`;
}
const statusPill = (st) => (st === 'live' ? '<span class="td-pill is-live">Live now</span>'
    : st === 'cancelled' ? '<span class="td-pill is-off">Cancelled</span>'
        : st === 'done' ? '<span class="td-pill is-done">Ended</span>' : '');

/** A date tile: MON / 28. */
function tile(iso, tz) {
    const p = parts(iso, tz);
    return `<span class="td-tile" aria-hidden="true"><span class="td-tile-m">${esc(p.month)}</span><span class="td-tile-d">${esc(p.day)}</span></span>`;
}

/** One event as a row in a list. */
function row(e, { now, showChannel = true } = {}) {
    const p = parts(e.starts_at, e.tz);
    const tags = [e.own ? '<span class="td-tag">Yours</span>' : '', e.reminded ? '<span class="td-tag is-remind">Reminder set</span>' : '', e.visibility === 'followers' ? '<span class="td-tag">Followers</span>' : ''].join('');
    return `<li class="td-ev td-ev-${esc(e.status)}">
<a class="td-ev-link" href="/e/${esc(e.id)}">
${tile(e.starts_at, e.tz)}
<span class="td-ev-body"><span class="td-ev-title">${esc(e.title)}</span>
<span class="td-ev-meta"><time datetime="${esc(e.starts_at)}" data-local="time">${esc(timeText(p))} ${esc(p.timeZoneName)}</time>${showChannel && e.channel ? `<span>@${esc(e.channel)}</span>` : ''}${e.kind === 'event' ? '<span>Event</span>' : ''}</span></span>
<span class="td-ev-end">${statusPill(e.status)}${tags}</span>
</a></li>`;
}

/** Events grouped by day (in each event's zone), soonest first. */
function days(rows, { now, empty, showChannel = true } = {}) {
    if (!rows.length) return `<div class="td-empty">${kit.icon('calendar')}<p>${esc(empty)}</p></div>`;
    const groups = [];
    for (const e of rows) {
        const label = dayLabel(e.starts_at, e.tz, now);
        const g = groups[groups.length - 1];
        if (g && g.label === label) g.rows.push(e); else groups.push({ label, rows: [e] });
    }
    return groups.map((g) => `<section class="td-day" aria-label="${esc(g.label)}"><h3 class="td-day-h">${esc(g.label)}</h3><ul class="td-evs">${g.rows.map((e) => row(e, { now, showChannel })).join('')}</ul></section>`).join('');
}

/** The day's ring: 24 hours, today's events as dots at their hour, and "now" as a hand. Drawn in UTC; today.js turns it
 * to the reader's own clock (the dots move to their local hours, the hand follows the time). */
function ring(rows, now) {
    const today = dayKey(new Date(now).toISOString(), 'UTC');
    const hourOf = (iso) => { const d = new Date(iso); return d.getUTCHours() + d.getUTCMinutes() / 60; };
    const dots = rows.filter((e) => e.status !== 'cancelled' && dayKey(e.starts_at, 'UTC') === today).slice(0, 12)
        .map((e, i) => `<i class="td-ring-dot${e.status === 'live' ? ' is-live' : ''}" data-at="${esc(e.starts_at)}" style="--a:${(hourOf(e.starts_at) / 24 * 360).toFixed(1)}deg;--i:${i}" title="${esc(e.title)}"></i>`);
    // A quiet day still shows the ring's shape: a few sample hours, marked as examples.
    const sample = dots.length ? '' : [9, 13.5, 19, 21].map((h, i) => `<i class="td-ring-dot is-sample" style="--a:${(h / 24 * 360).toFixed(1)}deg;--i:${i}"></i>`).join('');
    const ticks = Array.from({ length: 24 }, (_, h) => `<b class="td-ring-tick${h % 6 === 0 ? ' is-major' : ''}" style="--a:${h * 15}deg"></b>`).join('');
    const nowDeg = (hourOf(new Date(now).toISOString()) / 24 * 360).toFixed(1);
    return `<div class="td-ring" aria-hidden="true" data-ring style="--now:${nowDeg}deg">
<span class="td-ring-face"></span>${ticks}${dots.join('')}${sample}
<span class="td-ring-hand"></span><span class="td-ring-hub"></span>
<span class="td-ring-label td-ring-l0">00</span><span class="td-ring-label td-ring-l6">06</span><span class="td-ring-label td-ring-l12">12</span><span class="td-ring-label td-ring-l18">18</span>
</div>`;
}

/**
 * The week's public holidays, one line per holiday and day: its English name and the countries that keep it, the ones
 * most countries share first. The same for every visitor (the page is cached), so no country is guessed.
 */
function holidaysWeek(rows, now) {
    const groups = new Map();
    for (const e of rows) {
        const day = dayKey(e.starts_at, e.tz);
        // The dataset spells some names two ways ("All Saints' Day", "All Saints Day"): one line for both.
        const key = `${day}|${String(e.title).replace(/['\u2019]/g, '').toLowerCase()}`;
        const cc = String(e.source_id || '').split(':')[1] || '';
        const g = groups.get(key) || { day, title: e.title, at: e.starts_at, tz: e.tz, countries: [], id: e.id };
        if (cc && !g.countries.includes(cc)) g.countries.push(cc);
        groups.set(key, g);
    }
    if (!groups.size) return '';
    let names = null;
    const name = (cc) => { try { names = names || new Intl.DisplayNames(['en'], { type: 'region' }); return names.of(cc) || cc; } catch { return cc; } };
    const byDay = new Map();
    for (const g of groups.values()) { const list = byDay.get(g.day) || []; list.push(g); byDay.set(g.day, list); }
    const days = [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0])).slice(0, 7);
    return `<section class="td-coming td-holidays" id="td-holidays" aria-labelledby="td-hol-h"><div class="td-head-row"><h2 id="td-hol-h">Holidays this week</h2><a class="td-more" href="https://date.nager.at" rel="noopener">From Nager.Date${kit.icon('chevron')}</a></div>
<ol class="td-hol-days">${days.map(([, list]) => `<li class="td-hol-day"><span class="td-hol-date">${esc(dayLabel(list[0].at, list[0].tz, now))}</span><ul>${list.sort((a, b) => b.countries.length - a.countries.length || a.title.localeCompare(b.title)).map((g) => {
        const all = g.countries.map(name).sort();
        const shown = all.length > 4 ? `${all.slice(0, 3).join(', ')} and ${all.length - 3} more` : all.join(', ');
        return `<li><a href="/e/${esc(g.id)}"><b>${esc(g.title)}</b><span title="${esc(all.join(', '))}">${esc(shown)}</span></a></li>`;
    }).join('')}</ul></li>`).join('')}</ol></section>`;
}

function home({ upcoming = [], holidays = [], now = Date.now() } = {}) {
    const channels = new Set(upcoming.map((e) => e.channel).filter(Boolean));
    const live = upcoming.filter((e) => e.status === 'live');
    const scenes = [
        { title: 'A reminder that finds you', text: 'Tap Remind on anything coming up and it arrives in the bell on whichever OpenVibe site you have open.',
            html: `<div class="td-demo td-demo-remind"><div class="td-demo-card">${tile(new Date(now + DAY).toISOString(), 'UTC')}<span><b>Night owls: Seattle walk</b><small>goosely · 8:00 PM</small></span><span class="td-demo-btn">Remind me</span></div>
<div class="td-demo-toast">${kit.icon('calendar')}<span><b>Night owls: Seattle walk starts in 10 min</b><small>Today · openvibe.today</small></span></div></div>`,
            action: { href: '/me', label: 'Your agenda' } },
        { title: 'In the calendar you already use', text: 'Subscribe once in Google Calendar, Apple Calendar or Outlook, and every change follows on its own.',
            html: `<div class="td-demo td-demo-cal" aria-hidden="true"><div class="td-cal-head"><span>Fri</span><span>Sat</span><span>Sun</span></div><div class="td-cal-grid"><i style="--c:1;--r:3">Robot build, part 2</i><i style="--c:2;--r:5" class="is-room">Night owls</i><i style="--c:3;--r:2">Speedrun Sunday</i></div></div>`,
            action: { href: '/developers#feeds', label: 'Calendar feeds' } },
        { title: 'Schedule once, your followers know', text: 'A scheduled stream shows on your channel and in your followers’ calendars; a cancellation disappears everywhere.',
            html: `<div class="td-demo td-demo-sched"><div class="td-demo-card is-form"><span class="td-demo-k">Stream</span><b>Robot build, part 2</b><small>Fri, 8:00 PM PDT · 2 hours · Public</small><span class="td-demo-btn">Schedule it</span></div>
<div class="td-demo-toast">${kit.icon('live')}<span><b>carol scheduled a stream</b><small>Robot build, part 2 · Fri, 8:00 PM PDT</small></span></div></div>`,
            action: { href: '/schedule', label: 'Schedule a stream' } },
    ];
    // The hero (and its live numbers) come from the shared room kit; the schedule and the scenes follow in Today's own
    // order: the one thing to see today first, then what a reminder, a calendar and a schedule do for you.
    const hero = sc.room({
        room: 'today',
        hero: {
            title: ROOM.line,
            lede: 'One calendar for every stream and event.',
            start: { href: '/schedule', label: 'Schedule a stream' },
            chips: [{ label: 'Your agenda', href: '/me' }, { label: 'Your brief', href: '/brief' }],
            motif: ring(upcoming, now),
        },
        proof: [
            { value: live.length, label: 'live now' },
            { value: upcoming.length, label: 'coming up' },
            { value: channels.size, label: 'channels' },
        ].filter((p) => p.value),
    });
    // Real first (the owner, 10-31: empty sections made the rooms look unfinished): Coming up shows only with something in
    // it; an empty calendar is one short "be the first" row after the scenes.
    const coming = upcoming.length ? `<section class="td-coming" id="td-upcoming" aria-labelledby="td-coming-h"><div class="td-head-row"><h2 id="td-coming-h">Coming up</h2><a class="td-more" href="/developers#feeds">Subscribe${kit.icon('chevron')}</a></div>
${days(upcoming, { now })}</section>` : '';
    const beFirst = upcoming.length ? '' : `<section class="td-coming td-first" aria-labelledby="td-first-h"><h2 id="td-first-h">Be the first</h2>
<ul class="td-first-list"><li><b>Schedule the first stream</b><span>It shows here, on your channel and in your followers’ calendars, and anyone can set a reminder for it.</span><a href="/schedule">Schedule a stream</a></li></ul></section>`;
    const scenesHTML = `<section class="sc-room-scenes" aria-label="What you can do">${scenes.map((x, i) => `<article class="sc-scene${i % 2 ? ' is-flip' : ''}" data-ov-reveal">
<div class="sc-scene-text"><h2>${esc(x.title)}</h2>${x.text ? `<p>${esc(x.text)}</p>` : ''}${x.action ? `<a class="sc-scene-go" href="${esc(x.action.href)}">${esc(x.action.label)}${kit.icon('chevron')}</a>` : ''}</div>
<div class="sc-scene-stage">${x.html}</div></article>`).join('')}</section>`;
    const explore = sc.features({ title: 'More on Today', items: [
        { title: 'Your agenda', text: 'Your events, reminders and follows', href: '/me', icon: 'ov:calendar' },
        { title: 'Your brief', text: 'Today in one page', href: '/brief', icon: 'ov:news' },
        { title: 'The API', text: 'JSON, calendar feeds and topics', href: '/developers', icon: 'ov:code' },
    ] });
    const faq = sc.faq({ items: [
        ['How does a reminder reach me?', 'As an OpenVibe notification: it shows in the bell on every OpenVibe site you have open, and by email or push if you chose that for its kind. Your quiet hours hold it until they end.'],
        ['Can I see this in my own calendar app?', 'Yes. Every channel has a public calendar feed, and your agenda has a private one. Subscribe in any app that reads iCalendar (.ics); updates and cancellations follow.'],
        ['Who sees what I schedule?', 'A public stream is on your channel, here and in feeds. A followers-only one is seen only by the people who follow you. Followers hear about at most three new schedules from you a day.'],
    ] });
    const body = hero.replace(/<\/div>\s*$/, `${coming}${holidaysWeek(holidays, now)}${scenesHTML}${beFirst}${explore}${faq}</div>`);
    return `<div class="td-wrap" id="td-home">${body}</div>`;
}

function channel({ username, rows = [], now = Date.now() } = {}) {
    const feed = `/ics/@${encodeURIComponent(username)}.ics`;
    return `<div class="td-wrap td-page-pad" id="td-channel" data-channel="${esc(username)}">
<header class="td-page-h"><p class="td-kicker">Schedule</p><h1>@${esc(username)}</h1>
<p class="td-lede">What this channel has planned, and a calendar you can subscribe to.</p>
<div class="td-acts"><a class="ovk-btn ovk-btn--primary" href="webcal://openvibe.today${esc(feed)}" data-feed="${esc(feed)}">${kit.icon('calendar')}Subscribe</a>
${kit.button({ href: `https://openvibe.live/@${encodeURIComponent(username)}`, label: 'Watch on Live', kind: 'quiet' })}
<a class="ovk-btn ovk-btn--quiet" href="${esc(feed)}" download>Download .ics</a></div></header>
${days(rows, { now, showChannel: false, empty: 'Nothing public is planned on this channel yet.' })}
</div>`;
}

const MINUTES = [[0, 'When it starts'], [10, '10 minutes before'], [30, '30 minutes before'], [60, '1 hour before'], [1440, '1 day before']];

function event({ e, end, reminder = null, own = false, signedIn = false, path = '/' } = {}) {
    const p = parts(e.starts_at, e.tz);
    const done = e.status === 'cancelled' || e.status === 'done';
    const remindForm = done ? '' : !signedIn
        ? `<a class="ovk-btn ovk-btn--primary" href="/auth/login?next=${encodeURIComponent(path)}">${kit.icon('bell')}Sign in to get a reminder</a>`
        : reminder
            ? `<form method="post" action="/e/${esc(e.id)}/remind/remove" class="td-inline"><span class="td-set">${kit.icon('check')}Reminder set: ${esc((MINUTES.find(([m]) => m === reminder.minutes_before) || [0, `${reminder.minutes_before} minutes before`])[1].toLowerCase())}</span><button class="ovk-btn ovk-btn--quiet ovk-btn--small" type="submit">Remove</button></form>`
            : `<form method="post" action="/e/${esc(e.id)}/remind" class="td-inline td-remind"><label class="td-sr" for="td-min">When</label><select id="td-min" name="minutes_before">${MINUTES.map(([m, l]) => `<option value="${m}"${m === 10 ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select><button class="ovk-btn ovk-btn--primary" type="submit">${kit.icon('bell')}Remind me</button></form>`;
    const watch = e.channel ? kit.button({ href: `https://openvibe.live/@${encodeURIComponent(e.channel)}`, label: e.status === 'live' ? 'Watch now' : `@${e.channel} on Live`, kind: 'quiet' }) : '';
    return `<div class="td-wrap td-page-pad"><article class="td-event${done ? ' is-over' : ''}" data-event-id="${esc(e.id)}">
<header class="td-event-h">${tile(e.starts_at, e.tz)}
<div><p class="td-kicker">${e.kind === 'stream' ? 'Stream' : 'Event'}${e.channel ? ` · <a href="/@${esc(e.channel)}">@${esc(e.channel)}</a>` : ''}</p>
<h1>${esc(e.title)} ${statusPill(e.status)}</h1>
<p class="td-when"><time datetime="${esc(e.starts_at)}">${esc(`${p.weekday}, ${p.month} ${p.day}, ${p.year}`)}</time> · ${esc(range(e, end))}</p>
<p class="td-local" data-local="range" data-start="${esc(e.starts_at)}" data-end="${esc(end)}" hidden></p></div></header>
${e.description ? `<p class="td-desc">${esc(e.description)}</p>` : ''}
<div class="td-acts">${remindForm}<a class="ovk-btn ovk-btn--quiet" href="/e/${esc(e.id)}.ics" download>${kit.icon('calendar')}Add to calendar</a>${watch}</div>
${own && !done ? `<form method="post" action="/e/${esc(e.id)}/cancel" class="td-owner" data-confirm="Cancel this ${e.kind === 'stream' ? 'stream' : 'event'}? Followers' calendars and bells will drop it."><p>This is yours. Cancelling removes it from your channel, from calendars that subscribe, and from your followers' bells.</p><button class="ovk-btn ovk-btn--quiet ovk-btn--small" type="submit">Cancel it</button></form>` : ''}
<dl class="td-facts"><div><dt>Who can see it</dt><dd>${e.visibility === 'followers' ? 'Followers only' : 'Everyone'}</dd></div><div><dt>Time zone</dt><dd>${esc(e.tz.replace(/_/g, ' '))}</dd></div>${e.channel ? `<div><dt>Calendar</dt><dd><a href="/ics/@${esc(encodeURIComponent(e.channel))}.ics">@${esc(e.channel)}'s feed</a></dd></div>` : ''}<div><dt>Changed</dt><dd><time datetime="${esc(e.updated_at)}" data-local="ago">${esc(String(e.updated_at).slice(0, 16).replace('T', ' '))} UTC</time></dd></div></dl>
</article></div>`;
}

// A person's own reminders (plan L48, R1): one box in plain words with a preview of what it understood, and the list.
const SOURCE_NAMES = { today: '', vibe: 'Set by Vibe', live: 'From Live', work: 'From Work', deals: 'From Deals', coupons: 'From Coupons', watch: 'From Watch', chat: 'From Chat' };
function myReminders({ mine = [], problem = null, said = '' } = {}) {
    const active = mine.filter((r) => r.status === 'active');
    const done = mine.filter((r) => r.status === 'done');
    const act = (r, path, label, extra = '') => `<form method="post" action="/me/reminders/${esc(r.id)}/${path}" class="td-inline">${extra}<button class="td-chip-btn" type="submit">${esc(label)}</button></form>`;
    const row = (r) => `<li class="td-mine-row${r.status === 'done' ? ' is-done' : ''}">
<span class="td-mine-ico" aria-hidden="true">${kit.icon(r.repeats ? 'clock' : 'bell')}</span>
<span class="td-mine-main"><b>${r.url ? `<a href="${esc(r.url)}">${esc(r.title)}</a>` : esc(r.title)}</b>
<small>${esc(r.summary)}${r.status === 'active' && r.next_at ? ` · next <time datetime="${esc(r.next_at)}" data-local="when">${esc(r.next_at.slice(0, 16).replace('T', ' '))} UTC</time>` : ''}${SOURCE_NAMES[r.source] ? ` · ${esc(SOURCE_NAMES[r.source])}` : ''}</small></span>
<span class="td-mine-acts">${r.status === 'active' ? `${act(r, 'snooze', 'Snooze 1 h', '<input type="hidden" name="minutes" value="60">')}${act(r, 'done', r.repeats ? 'Stop' : 'Done')}` : ''}${act(r, 'remove', 'Remove')}</span>
</li>`;
    return `<section class="td-card td-remind" id="reminders" aria-labelledby="td-mine-h">
<h2 id="td-mine-h">${kit.icon('bell')}Remind me</h2>
<form method="post" action="/me/reminders" class="td-remind-form" data-remind-preview="/api/v1/reminders/parse">
<input type="hidden" name="tz" value="UTC" data-tz>
<label class="td-sr" for="td-remind-text">What, and when, in your own words</label>
<input id="td-remind-text" name="text" required maxlength="500" autocomplete="off" value="${esc(said)}" placeholder="Stretch every 2 hours from 9 to 5">
<button class="ovk-btn ovk-btn--primary" type="submit">Remind me</button>
<p class="td-remind-out${problem ? ' is-bad' : ''}" data-remind-out aria-live="polite">${problem ? esc(problem) : 'Try “take my meds every day at 9 am and 9 pm”, “call mom on Sunday at 6 pm” or “pay rent on the 1st of every month”.'}</p>
</form>
${active.length ? `<ul class="td-mine">${active.map(row).join('')}</ul>` : '<p class="td-fine">Nothing set yet. Reminders arrive in your bell on every OpenVibe site, and as a push notification if you allowed them.</p>'}
${done.length ? `<details class="td-mine-done"><summary>Done (${done.length})</summary><ul class="td-mine">${done.map(row).join('')}</ul></details>` : ''}
</section>`;
}

function me({ name, agenda = { events: [] }, reminders = [], feedUrl = '', now = Date.now(), mine = [], problem = null, said = '' } = {}) {
    const webcal = String(feedUrl).replace(/^https?:/, 'webcal:');
    return `<div class="td-wrap td-page-pad" id="td-me">
<header class="td-page-h"><p class="td-kicker">Your agenda</p><h1>The next two weeks</h1>
<p class="td-lede">Your own events, the ones you set reminders on, and the channels you follow, ${esc(name || 'you')}.</p>
<div class="td-acts">${kit.button({ href: '/me/week', label: 'Your week', kind: 'primary' })}${kit.button({ href: '/schedule', label: 'Schedule a stream', kind: 'quiet' })}${kit.button({ href: '/brief', label: 'Your brief', kind: 'quiet' })}</div></header>
${myReminders({ mine, problem, said })}
${agenda.follows_unavailable ? '<p class="td-note" role="status">OpenVibe.Network did not answer, so the channels you follow are missing for a moment. Your own and reminded events are all here.</p>' : ''}
<div class="td-me-grid"><div>${days(agenda.events || [], { now, empty: 'Nothing in the next two weeks. Follow a channel on Live, or set a reminder on something coming up.' })}</div>
<aside class="td-side">
<section class="td-card" aria-labelledby="td-rem-h"><h2 id="td-rem-h">${kit.icon('bell')}Before an event</h2>
${reminders.length ? `<ul class="td-rems">${reminders.map((x) => `<li><a href="/e/${esc(x.event_id)}">${esc(x.event.title)}</a><small><time datetime="${esc(x.remind_at)}" data-local="time">${esc(timeText(parts(x.remind_at, x.event.tz)))} ${esc(parts(x.remind_at, x.event.tz).timeZoneName)}</time>, ${esc(dayLabel(x.remind_at, x.event.tz, now).toLowerCase())}</small></li>`).join('')}</ul>` : '<p class="td-fine">None yet. Open anything coming up and tap Remind me.</p>'}
</section>
<section class="td-card" aria-labelledby="td-feed-h"><h2 id="td-feed-h">${kit.icon('calendar')}Your calendar feed</h2>
<p class="td-fine">Everything above, in Google Calendar, Apple Calendar or Outlook. Anyone with this link can read it, so keep it to yourself.</p>
<div class="td-feed"><input id="td-feed-url" type="text" readonly value="${esc(feedUrl)}" aria-label="Your private calendar link"><button type="button" class="ovk-btn ovk-btn--quiet ovk-btn--small" data-copy="#td-feed-url" hidden>Copy</button></div>
<div class="td-acts"><a class="ovk-btn ovk-btn--primary ovk-btn--small" href="${esc(webcal)}">Subscribe</a>
<form method="post" action="/me/feed/rotate" class="td-inline" data-confirm="Make a new link? Calendars using the old one stop updating."><button class="ovk-btn ovk-btn--quiet ovk-btn--small" type="submit">New link</button></form></div>
</section></aside></div>
</div>`;
}

/**
 * The person's week (plan L48 R3): seven days from Monday in their own time zone. On a computer, seven columns; on a
 * phone, the days one under another, with the empty ones said in one line. Each line is a time, what it is, and a
 * mark for its kind: a reminder (once or repeating), a repeating reminder's span for the day, their own event, or a
 * stream of a channel they follow.
 */
function week({ name, week: w }) {
    const KIND = { reminder: ['bell', 'Reminder'], band: ['retry', 'Repeats'], event: ['calendar', 'Your event'], stream: ['live', 'Stream'] };
    const item = (it) => {
        const [icon, word] = KIND[it.kind] || KIND.reminder;
        const meta = it.kind === 'band' ? it.summary : it.kind === 'stream' ? (it.channel ? `@${it.channel}` : word) : it.kind === 'reminder' && it.repeats ? 'Repeats' : word;
        return `<li class="td-wi is-${esc(it.kind)}${it.live ? ' is-live' : ''}"><a href="${esc(it.href)}"><span class="td-wi-k" aria-hidden="true">${kit.icon(icon)}</span><time datetime="${esc(it.at)}">${esc(it.time)}</time><span class="td-wi-t">${esc(it.title)}</span><span class="td-wi-m">${it.live ? '<span class="td-pill is-live">Live now</span>' : ''}<span class="ovk-sr">${esc(word)}: </span>${esc(meta)}</span></a></li>`;
    };
    // On a phone, a run of empty days is one line ("Nothing on Sat and Sun").
    const runs = [];
    for (const d of w.days) {
        const last = runs[runs.length - 1];
        if (!d.items.length && !d.today && last && last.empty) last.days.push(d); else runs.push({ empty: !d.items.length && !d.today, days: [d] });
    }
    const list = (arr) => (arr.length < 2 ? arr.join('') : `${arr.slice(0, -1).join(', ')} and ${arr[arr.length - 1]}`);
    const cols = w.days.map((d) => `<li class="td-wd${d.today ? ' is-today' : ''}${d.items.length ? '' : ' is-empty'}" aria-label="${esc(d.long)}${d.today ? ', today' : ''}">
<h2 class="td-wd-h"><span>${esc(d.label.split(' ')[0])}</span><b>${esc(String(d.date.d))}</b>${d.today ? '<i>Today</i>' : ''}</h2>
${d.items.length ? `<ul class="td-wis">${d.items.map(item).join('')}</ul>` : '<p class="td-wd-none">Nothing</p>'}</li>`).join('');
    const phone = runs.map((r) => (r.empty
        ? `<li class="td-pd is-empty">Nothing on ${esc(list(r.days.map((d) => d.label)))}</li>`
        : r.days.map((d) => `<li class="td-pd${d.today ? ' is-today' : ''}"><h2 class="td-pd-h">${esc(d.long)}${d.today ? ' <i>Today</i>' : ''}</h2>${d.items.length ? `<ul class="td-wis">${d.items.map(item).join('')}</ul>` : '<p class="td-wd-none">Nothing yet</p>'}</li>`).join(''))).join('');
    const count = w.days.reduce((a, d) => a + d.items.length, 0);
    return `<div class="td-wrap td-page-pad" id="td-week" data-tz="${esc(w.tz)}">
<header class="td-page-h"><p class="td-kicker">Your week</p><h1>${esc(w.title)}</h1>
<p class="td-lede">${count ? `${count} thing${count === 1 ? '' : 's'} this week` : 'A clear week so far'}: your reminders, your events and the streams of the channels you follow${name ? `, ${esc(name)}` : ''}. Times in ${esc(w.tz.replace(/_/g, ' '))}.</p>
<nav class="td-weeknav" aria-label="Weeks"><a class="ovk-btn ovk-btn--quiet ovk-btn--small" href="/me/week?start=${esc(w.prev)}" rel="prev">${kit.icon('back')}<span>Last week</span></a>${w.thisWeek ? '' : '<a class="ovk-btn ovk-btn--quiet ovk-btn--small" href="/me/week">This week</a>'}<a class="ovk-btn ovk-btn--quiet ovk-btn--small" href="/me/week?start=${esc(w.next)}" rel="next"><span>Next week</span>${kit.icon('chevron')}</a><a class="ovk-btn ovk-btn--quiet ovk-btn--small" href="/me">As a list</a></nav>
<form class="td-quick" method="post" action="/me/reminders"><input type="hidden" name="back" value="week"><input type="hidden" name="tz" value="${esc(w.tz)}" data-tz>
<label class="ovk-sr" for="td-quick-text">Add a reminder in plain words</label><input id="td-quick-text" name="text" maxlength="500" required placeholder="Remind me… every weekday at 9, tomorrow at 3pm, every 2 hours from 9 to 5" autocomplete="off">
<button class="ovk-btn ovk-btn--primary ovk-btn--small" type="submit">${kit.icon('plus')}Add</button></form>
</header>
<ol class="td-week" aria-label="The week">${cols}</ol>
<ol class="td-pweek" aria-label="The week, day by day">${phone}</ol>
</div>`;
}

function brief({ out, name, tz = 'UTC' } = {}) {
    const ACT = { remind: 'Remind', watch: 'Watch', buy: 'Buy from', approve: 'Approve', open: 'Open' };
    const sections = (out && out.sections) || [];
    return `<div class="td-wrap td-page-pad td-brief" id="td-brief">
<header class="td-page-h"><p class="td-kicker">Your brief</p><h1 data-typed>${esc(out.day)}</h1>
<p class="td-lede">What is left of today for ${esc(name || 'you')}${tz !== 'UTC' ? `, in ${esc(tz.replace(/_/g, ' '))}` : ''}.</p></header>
${sections.length ? `<div class="td-brief-grid">${sections.map((sec) => `<section class="td-card td-brief-sec" id="td-brief-${esc(sec.id)}"><h2>${esc(sec.title)}</h2><ul>${sec.items.map((it) => `<li><a href="${esc(it.url)}">${esc(it.text)}</a>${it.action && ACT[it.action] ? `<a class="td-chip" href="${esc(it.url)}">${esc(ACT[it.action])}</a>` : ''}</li>`).join('')}</ul></section>`).join('')}</div>`
        : `<div class="td-empty">${kit.icon('book')}<p>A quiet day so far. Schedule a stream, or set a reminder on something coming up, and it shows here tomorrow morning.</p>${kit.button({ href: '/', label: 'See what is coming up', kind: 'quiet' })}</div>`}
<p class="td-fine">Built each morning from your agenda, your reminders and what streamers talked about yesterday on The Rundown. Every line links to where it came from.</p>
</div>`;
}

const ZONES = ['UTC', 'America/Los_Angeles', 'America/Denver', 'America/Chicago', 'America/New_York', 'America/Halifax', 'America/Sao_Paulo', 'Europe/London', 'Europe/Dublin', 'Europe/Lisbon', 'Europe/Paris', 'Europe/Berlin', 'Europe/Madrid', 'Europe/Rome', 'Europe/Amsterdam', 'Europe/Stockholm', 'Europe/Warsaw', 'Europe/Athens', 'Europe/Istanbul', 'Africa/Lagos', 'Africa/Johannesburg', 'Asia/Dubai', 'Asia/Kolkata', 'Asia/Bangkok', 'Asia/Singapore', 'Asia/Shanghai', 'Asia/Seoul', 'Asia/Tokyo', 'Australia/Perth', 'Australia/Sydney', 'Pacific/Auckland', 'Pacific/Honolulu'];
const LENGTHS = [[30, '30 minutes'], [60, '1 hour'], [90, '1½ hours'], [120, '2 hours'], [180, '3 hours'], [240, '4 hours'], [360, '6 hours']];

function schedule({ values = {}, problem = null } = {}) {
    const v = { kind: 'stream', visibility: 'public', length: '120', tz: 'UTC', ...values };
    const zones = ZONES.includes(v.tz) ? ZONES : [v.tz, ...ZONES];
    const radio = (name, val, label, hint) => `<label class="td-opt"><input type="radio" name="${name}" value="${val}"${String(v[name]) === val ? ' checked' : ''}><span><b>${esc(label)}</b>${hint ? `<small>${esc(hint)}</small>` : ''}</span></label>`;
    return `<div class="td-wrap td-page-pad td-narrow">
<header class="td-page-h"><p class="td-kicker">Schedule</p><h1>Put it on the calendar</h1>
<p class="td-lede">It shows here, on your channel and in calendars that subscribe. Your followers hear about it in their bell.</p></header>
<form id="td-schedule-form" class="td-card td-form" method="post" action="/schedule">
${problem ? `<p class="td-note is-bad" role="alert">${esc(problem)}</p>` : ''}
<fieldset class="td-opts"><legend>What is it?</legend>${radio('kind', 'stream', 'A stream', 'On your Live channel')}${radio('kind', 'event', 'An event', 'Anything else with a time')}</fieldset>
<label class="td-field"><span>Title</span><input name="title" type="text" maxlength="120" required value="${esc(v.title || '')}" placeholder="Robot build, part 2"></label>
<div class="td-row"><label class="td-field"><span>Starts</span><input name="starts_at" type="datetime-local" required value="${esc(v.starts_at || '')}"></label>
<label class="td-field"><span>How long</span><select name="length">${LENGTHS.map(([m, l]) => `<option value="${m}"${String(v.length) === String(m) ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></label></div>
<label class="td-field"><span>Time zone</span><select name="tz" data-tz>${zones.map((z) => `<option value="${esc(z)}"${z === v.tz ? ' selected' : ''}>${esc(z.replace(/_/g, ' '))}</option>`).join('')}</select><small>The time above is read in this zone. Everyone sees it in their own.</small></label>
<label class="td-field"><span>Description <i>optional</i></span><textarea name="description" rows="3" maxlength="1000" placeholder="What you are doing, who is joining">${esc(v.description || '')}</textarea></label>
<fieldset class="td-opts"><legend>Who can see it?</legend>${radio('visibility', 'public', 'Everyone', 'Here, on your channel and in feeds')}${radio('visibility', 'followers', 'Followers', 'Only people who follow you')}</fieldset>
<div class="td-acts"><button class="ovk-btn ovk-btn--primary" type="submit">Schedule it</button><a class="ovk-btn ovk-btn--quiet" href="/me">Back to your agenda</a></div>
</form></div>`;
}

function signIn({ title, text, next }) {
    return `<div class="td-wrap td-page-pad td-narrow"><div class="td-empty td-signin">${kit.icon('calendar')}<h1>${esc(title)}</h1><p>${esc(text)}</p>${kit.button({ href: `/auth/login?next=${encodeURIComponent(next)}`, label: 'Sign in with OpenVibe', kind: 'primary' })}</div></div>`;
}

function developers() {
    const ep = (m, p, d) => `<div><dt><code>${esc(m)} ${esc(p)}</code></dt><dd>${d}</dd></div>`;
    return `<div class="td-wrap td-page-pad" id="td-developers">
<header class="td-page-h"><p class="td-kicker">Developers</p><h1>The Today API</h1>
<p class="td-lede">JSON under <code>/api/v1</code>, calendars under <code>/ics/</code>, and three topics on OpenVibe.Events. A person is the session cookie, or a Network user token as a Bearer.</p></header>
<section><h2>Read</h2><dl class="td-eps">
${ep('GET', '/api/v1/events?channel=&from=&to=&limit=', 'Public events, soonest first (at most 100; cached 60 s).')}
${ep('GET', '/api/v1/events/:id', 'One event. A cancelled one answers with <code>status: "cancelled"</code>; a followers-only one is 404 unless it is yours.')}
${ep('GET', '/api/v1/me/agenda?days=14', 'Your events, reminded events and followed channels’ events (up to 60 days).')}
${ep('GET', '/api/v1/me/brief', 'Today’s brief: sections of cited lines.')}
</dl></section>
<section><h2>Write (signed in)</h2><dl class="td-eps">
${ep('POST', '/api/v1/events', '<code>{ kind, title, starts_at, ends_at?, tz, description?, visibility? }</code>. <code>Idempotency-Key</code> is honoured; at most 60 future events per person.')}
${ep('PATCH', '/api/v1/events/:id', 'Change the title, times, zone, description or visibility (the calendar sequence goes up).')}
${ep('DELETE', '/api/v1/events/:id', 'Cancel it (again is fine).')}
${ep('POST', '/api/v1/events/:id/remind', '<code>{ minutes_before: 0–1440 }</code>; <code>DELETE</code> removes it.')}
</dl></section>
<section id="feeds"><h2>Calendar feeds</h2><dl class="td-eps">
${ep('GET', '/ics/@<username>.ics', 'A channel’s public calendar (RFC 5545). Subscribe with <code>webcal://openvibe.today/ics/@&lt;username&gt;.ics</code>.')}
${ep('GET', '/e/:id.ics', 'One event, for "Add to calendar".')}
${ep('GET', '/ics/<token>.ics', 'Your private agenda; the link is on <a href="/me">your agenda</a>, and a new one replaces it at once.')}
</dl></section>
<section><h2>Events</h2><p class="td-fine">Today publishes <code>today.event.scheduled</code>, <code>today.event.updated</code> and <code>today.event.cancelled</code>, and listens for <code>live.stream.started</code> and <code>live.stream.ended</code> to mark a stream live and then ended. A refusal is <code>400 { code: "today.invalid", field, message }</code>; others are <code>today.too_many</code>, <code>today.cross_site</code>, <code>today.not_found</code>.</p></section>
</div>`;
}

function notFound() {
    return `<div class="td-wrap td-page-pad td-narrow"><div class="td-empty">${kit.icon('calendar')}<h1>Not on the calendar</h1><p>There is nothing at this address. It may have been cancelled, or it is for followers only.</p>${kit.button({ href: '/', label: 'See what is coming up', kind: 'quiet' })}</div></div>`;
}

module.exports = { week, home, channel, event, me, brief, schedule, signIn, developers, notFound, ZONES, LENGTHS, parts, dayKey };
