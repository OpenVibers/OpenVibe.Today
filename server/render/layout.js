'use strict';

/**
 * Page shell. Every page is server-rendered through openvibe-shared/shell and is complete without JavaScript.
 * This is Help's layout with Today's name, navigation and assets.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const appIcon = require('openvibe-shared/app-icon');
const shell = require('openvibe-shared/shell');
const rooms = require('openvibe-shared/rooms');
const ovServe = require('openvibe-shared/serve');
const cache = require('openvibe-shared/cache-policy');
const { html, raw, render } = require('./html');

const NETWORK_URL = 'https://openvibe.network';
const SITE_NAME = 'OpenVibe.Today';
const TAGLINE = 'The network\'s time bus and calendar authority.';
const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');
const NAV = [
    { label: 'Home', href: '/' },
    { label: 'Schedule', href: '/schedule' },
    { label: 'Your brief', href: '/brief' },
    { label: 'Developers', href: '/developers' },
];

const hashes = new Map();
function assetVersion(rel) {
    if (hashes.has(rel)) return hashes.get(rel);
    let v = 'dev';
    try { v = crypto.createHash('sha256').update(fs.readFileSync(path.join(PUBLIC_DIR, rel))).digest('hex').slice(0, 10); } catch { /* missing asset */ }
    hashes.set(rel, v);
    return v;
}
const asset = (rel) => `/${rel}?v=${assetVersion(rel)}`;

let RELEASE = 'dev';
function setRelease(id) { if (id) RELEASE = String(id); }

/**
 * o: title, description, body (html), viewer, config, path, index, cache, crumbs, jsonLd, styles
 */
function renderPage(o) {
    const viewer = o.viewer || { kind: 'anonymous' };
    const signedIn = viewer.kind === 'user';
    const pathNow = o.path || '/';
    const loginNext = encodeURIComponent(pathNow);
    const canonical = `${o.config.baseUrl}${pathNow.split('?')[0]}`;
    const nav = {
        service: 'today',
        apiBase: NETWORK_URL,
        links: NAV.map((l) => ({ label: l.label, href: l.href, active: pathNow === l.href || pathNow.startsWith(`${l.href}/`) })),
        history: { type: 'page', title: o.title || SITE_NAME },
        silentLogin: `${o.config.baseUrl}/auth/login?silent=1&next={url}`,
        sessionUrl: '/auth/me',
        loginUrl: '/auth/login?next={path}',
        logoutUrl: '/auth/logout?next={path}',
        notificationsRealtime: true,
    };
    const footer = { service: 'today', variant: 'full', mount: '#ov-footer', brandName: SITE_NAME };
    const account = signedIn
        ? html`Signed in as <strong>${viewer.displayName || viewer.username || 'you'}</strong> · <a href="/me">Your agenda</a> · <a href="/auth/logout?next=${loginNext}">Sign out</a>`
        : html`<a href="/auth/login?next=${loginNext}">Sign in with OpenVibe</a>`;
    const crumbs = (o.crumbs || []).length
        ? html`<nav class="crumbs" aria-label="Breadcrumbs">${o.crumbs.map((c, i) => html`${i ? ' / ' : ''}${c.href ? html`<a href="${c.href}">${c.label}</a>` : c.label}`)}</nav>`
        : '';
    const scripts = (o.scripts || []).map((rel) => html`<script src="${asset(rel)}" defer></script>`);
    // A page with a Markdown twin (o.agent) advertises it in the head; the twin itself is server/agent-pages.js.
    const llms = `${String(o.config.baseUrl).replace(/\/+$/, '')}/llms.txt`;
    return shell.page({
        name: SITE_NAME,
        lang: 'en',
        title: o.title || `${SITE_NAME}: ${TAGLINE}`,
        titleSuffix: o.title ? ` · ${SITE_NAME}` : '',
        siteName: SITE_NAME,
        description: o.description || `${SITE_NAME} — ${TAGLINE}`,
        canonical,
        agentLayer: o.agent === true,
        llms,
        robots: o.index ? 'index, follow' : 'noindex, nofollow',
        jsonLd: (o.jsonLd || []).filter(Boolean),
        home: '/',
        navLinks: NAV,
        navbar: nav,
        footer,
        head: `<meta name="referrer" content="${o.noReferrer ? 'no-referrer' : 'strict-origin-when-cross-origin'}">
${appIcon.headTags({ site: 'today' })}
<link rel="stylesheet" href="${ovServe.url('kit.css')}">
<link rel="stylesheet" href="${ovServe.url('room.css')}">
<link rel="stylesheet" href="${ovServe.url('showcase.css')}">
<link rel="stylesheet" href="${asset('css/today.css')}">
<script src="${ovServe.url('motion.js')}" defer></script>
<script src="${asset('js/today.js')}" defer></script>
${(o.styles || []).map((name) => `<link rel="stylesheet" href="${require('openvibe-shared/serve').url(name)}">`).join('\n')}
${render(scripts)}
<meta name="ov-boost" content="today@${require('./html').esc(RELEASE)}">
<script src="${require('openvibe-shared/serve').url('boost.js')}" data-main="#main" defer></script>`,
        body: `<a class="skip" href="#main">Skip to content</a>
<div id="navbar-mount"></div>
<noscript><div class="account-bar" role="navigation" aria-label="Account">${render(account)}</div></noscript>
<main id="main" class="td ov-room" style="${rooms.style('today')}">
${render(crumbs)}
${render(o.body)}
</main>
<script>
window.__OV_PAGE = ${JSON.stringify({ navbar: nav, footer }).replace(/</g, '\\u003c')};
document.addEventListener('DOMContentLoaded', function () {
  try { if (window.OpenVibeFooter) OpenVibeFooter.init(window.__OV_PAGE.footer); } catch (e) { /* the Frame is optional */ }
});
</script>`,
    });
}

/** Send a page; a page rendered for a signed-in person is private and never cached. */
function send(res, status, o) {
    const personal = o.viewer && o.viewer.kind === 'user';
    if (!res.get('Cache-Control')) res.set('Cache-Control', personal ? cache.htmlHeaders({ private: true }) : (o.cache || cache.htmlHeaders({ private: true })));
    res.set('Vary', 'Cookie');
    // A page with a Markdown twin names it, as the agent layer's own responses do (openvibe-shared/agent-layer).
    if (o.agent) {
        const site = String(o.config.baseUrl).replace(/\/+$/, '');
        res.set('Link', require('openvibe-shared/agent-layer').linkHeaderTags(`${site}${String(o.path || '/').split('?')[0]}`, `${site}/llms.txt`).header);
    }
    res.status(status).type('html').send(renderPage(o));
}

module.exports = { renderPage, send, asset, assetVersion, setRelease, SITE_NAME, TAGLINE, NETWORK_URL, NAV, raw, html };
