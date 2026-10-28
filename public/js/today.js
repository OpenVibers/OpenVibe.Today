/* OpenVibe.Today: small things the pages are complete without.
 *   - an event's time in the reader's own zone beside the event's own (when they differ);
 *   - the schedule form starts in the device's time zone;
 *   - copy buttons; a confirm before cancelling or replacing the feed link;
 *   - the day's ring's hand follows the clock. */
(function () {
    'use strict';
    var zone = (function () { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (e) { return 'UTC'; } })();
    function fmt(d, opts) { try { return new Intl.DateTimeFormat(undefined, opts).format(d); } catch (e) { return d.toISOString(); } }

    function run() {
        // "Your time" on an event page.
        document.querySelectorAll('[data-local="range"]').forEach(function (el) {
            var a = new Date(el.getAttribute('data-start')), b = new Date(el.getAttribute('data-end'));
            if (isNaN(a)) return;
            var mine = fmt(a, { weekday: 'short', month: 'short', day: 'numeric' }) + ' · ' + fmt(a, { hour: 'numeric', minute: '2-digit' }) + ' – ' + fmt(b, { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
            var page = document.querySelector('.td-when');
            if (page && page.textContent.indexOf(mine.split(' · ')[1]) !== -1) return;
            el.textContent = 'Your time: ' + mine;
            el.hidden = false;
        });
        // List times in the reader's zone.
        document.querySelectorAll('time[data-local="time"]').forEach(function (el) {
            var d = new Date(el.getAttribute('datetime'));
            if (!isNaN(d)) { el.title = el.textContent; el.textContent = fmt(d, { hour: 'numeric', minute: '2-digit' }); }
        });
        document.querySelectorAll('time[data-local="ago"]').forEach(function (el) {
            var d = new Date(el.getAttribute('datetime'));
            if (!isNaN(d)) el.textContent = fmt(d, { dateStyle: 'medium', timeStyle: 'short' });
        });
        // The schedule form starts in this device's zone.
        document.querySelectorAll('select[data-tz]').forEach(function (sel) {
            if (sel.value !== 'UTC' || sel.dataset.picked) return;
            if (![].some.call(sel.options, function (o) { return o.value === zone; })) {
                var o = document.createElement('option'); o.value = zone; o.textContent = zone.replace(/_/g, ' ');
                sel.insertBefore(o, sel.firstChild);
            }
            sel.value = zone;
            sel.dataset.picked = '1';
        });
        // Copy.
        document.querySelectorAll('[data-copy]').forEach(function (btn) {
            var src = document.querySelector(btn.getAttribute('data-copy'));
            if (!src || !navigator.clipboard) return;
            btn.hidden = false;
            btn.addEventListener('click', function () {
                navigator.clipboard.writeText(src.value || src.textContent || '').then(function () {
                    var was = btn.textContent; btn.textContent = 'Copied'; setTimeout(function () { btn.textContent = was; }, 1400);
                }, function () { src.select && src.select(); });
            });
        });
        // Confirm before something that cannot be undone.
        document.querySelectorAll('form[data-confirm]').forEach(function (f) {
            f.addEventListener('submit', function (e) { if (!window.confirm(f.getAttribute('data-confirm'))) e.preventDefault(); });
        });
        // The ring on the reader's own clock: each dot at its local hour, the hand at the local time now.
        document.querySelectorAll('[data-ring]').forEach(function (ring) {
            var deg = function (d) { return ((d.getHours() + d.getMinutes() / 60) / 24 * 360).toFixed(1) + 'deg'; };
            ring.querySelectorAll('[data-at]').forEach(function (dot) { var d = new Date(dot.getAttribute('data-at')); if (!isNaN(d)) dot.style.setProperty('--a', deg(d)); });
            var tick = function () { ring.style.setProperty('--now', deg(new Date())); };
            tick(); if (!ring.dataset.ticking) { ring.dataset.ticking = '1'; setInterval(tick, 60000); }
        });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run); else run();
    document.addEventListener('ov:boost:load', run);
})();
