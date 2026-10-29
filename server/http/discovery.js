'use strict';

/**
 * Crawl artifacts for openvibe.today: robots.txt, sitemap.xml, llms.txt and llms-full.txt. The public pages are for
 * search engines and AI crawlers; sign-in, the API, a person's agenda, brief and schedule form are not.
 */
const fs = require('fs');
const path = require('path');
const seo = require('openvibe-shared/seo');
const cache = require('openvibe-shared/cache-policy');
const { asyncRouter } = require('./router');

const SITE_NAME = 'OpenVibe.Today';
const DESCRIPTION = 'OpenVibe.Today is the network\'s time bus and calendar authority: one schedule for streams and events, reminders before they start, a private ICS feed, and a daily brief.';
const DISALLOW = ['/auth/', '/api/', '/me', '/brief', '/schedule', '/internal'];

function dayOf(ts) {
    const m = String(ts == null ? '' : ts).match(/^(\d{4}-\d{2}-\d{2})/);
    return m ? m[1] : null;
}
function siteUpdated() {
    try { return dayOf(JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'STATUS.json'), 'utf8')).updated); } catch { return null; }
}

function homeJsonLd(config) {
    const site = String(config.baseUrl).replace(/\/+$/, '');
    return [
        seo.jsonLd.website({ name: SITE_NAME, url: site, description: DESCRIPTION }),
        seo.jsonLd.softwareApp({ name: SITE_NAME, url: site, description: DESCRIPTION, category: 'ProductivityApplication', keywords: 'openvibe schedule, stream calendar, ics, reminders, events' }),
        seo.jsonLd.webPage({ name: SITE_NAME, url: `${site}/`, description: DESCRIPTION, siteUrl: site }),
    ];
}

/**
 * The public page catalogue: /sitemap.xml lists the entries marked for the sitemap and
 * /llms-full.txt describes every entry, so the two artifacts cannot drift apart. Dynamic pages are
 * described by their route pattern: no person's schedule, token or brief is ever listed.
 */
function publicPages() {
    return [
        { path: '/', sitemap: true, changefreq: 'daily', priority: 1.0, title: 'OpenVibe.Today home', text: 'The public schedule: every stream and event on OpenVibe, soonest first, with its time, channel and where to watch; reminders are sent through OpenVibe.Network.' },
        { path: '/developers', sitemap: true, changefreq: 'weekly', priority: 0.6, title: 'OpenVibe.Today API', text: 'The JSON API for public events, the ICS feeds per channel and per person, and the Events topics Today publishes and consumes.' },
        { path: '/@:username', changefreq: 'daily', priority: 0.5, title: 'One channel\'s public page', text: 'A channel\'s public schedule and its events, plus its public ICS feed at /ics/@<username>.ics. A person\'s own agenda and brief are never public.' },
        { path: '/e/:id', changefreq: 'daily', priority: 0.5, title: 'One event', text: 'One public stream or event: its time, channel, description and JSON-LD, with an .ics download at /e/<id>.ics and a link to watch it on OpenVibe.Live.' },
        { path: '/e/:id.ics', changefreq: 'daily', priority: 0.3, title: 'One event as a calendar file', text: 'The same public event as iCalendar for a calendar app.' },
        { path: '/ics/:file', changefreq: 'daily', priority: 0.3, title: 'A calendar feed', text: 'A public channel\'s ICS feed at /ics/@<username>.ics. A person\'s private feed is at /ics/<token>.ics and is theirs alone; tokens are never listed.' },
    ];
}

/** The legal pages every OpenVibe site serves, named from the shared kit rather than retyped here. */
function legalPages() {
    const labels = { '/terms': 'Terms of use', '/privacy': 'Privacy policy', '/dmca': 'DMCA and takedown policy' };
    return require('openvibe-shared/legal').PATHS.map((path) => ({ path, title: labels[path] || path.slice(1), text: `The ${(labels[path] || path.slice(1)).toLowerCase()} for OpenVibe.Today, served by the site itself.` }));
}

function createDiscoveryRoutes(ctx) {
    const { config } = ctx;
    const r = asyncRouter();
    const site = String(config.baseUrl).replace(/\/+$/, '');
    const abs = (p) => `${site}${p}`;
    const TEXT = cache.htmlHeaders({ maxAge: 3600 });
    const pages = publicPages();

    r.get('/robots.txt', (_req, res) => {
        res.type('text/plain').set('Cache-Control', TEXT).send(
            '# openvibe.today: the public pages are for search and AI crawlers; sign-in, the API, a person\'s agenda and brief are not.\n'
            + `# Agent manifest: ${abs('/.well-known/agent.json')}\n`
            + seo.robotsTxt({ sitemaps: [abs('/sitemap.xml')], disallow: DISALLOW }));
    });

    r.get('/llms.txt', (_req, res) => {
        res.type('text/plain').set('Cache-Control', TEXT).send(seo.llmsTxt({
            name: SITE_NAME,
            summary: 'OpenVibe.Today is the network\'s time bus and calendar authority: a public schedule of streams and events, reminders sent through OpenVibe.Network, a private ICS feed per person, and a daily brief that includes what OpenVibe.Live\'s Rundown talked about yesterday.',
            details: 'GET /api/v1/events lists public events (soonest first). GET /api/v1/events/:id is one event with JSON-LD on its page. A signed-in person schedules a stream or an event, changes it, cancels it and sets a reminder. GET /ics/@<username>.ics is a channel\'s public calendar; a person\'s private feed is at GET /ics/<token>.ics. Events are published as today.event.scheduled|updated|cancelled and live.stream.started|ended is consumed to move an event live and then done.',
            sections: [
                { title: 'Start here', links: [
                    { title: 'OpenVibe.Today', url: abs('/'), note: 'the public schedule' },
                    { title: 'The API', url: abs('/developers') },
                    { title: 'Public events (JSON)', url: abs('/api/v1/events') },
                ] },
                { title: 'Machine-readable', links: [
                    { title: 'Sitemap', url: abs('/sitemap.xml') },
                    { title: 'Full text for language models', url: abs('/llms-full.txt') },
                    { title: 'Release metadata (JSON)', url: abs('/release.json') },
                ] },
                { title: 'Elsewhere', links: [
                    { title: 'OpenVibe.Network', url: 'https://openvibe.network', note: 'accounts, follows and notifications' },
                    { title: 'OpenVibe.Live', url: 'https://openvibe.live', note: 'where a stream happens' },
                    { title: 'OpenVibe.Events', url: 'https://openvibe.events', note: 'the durable event backbone' },
                    { title: 'OpenVibe.Services', url: 'https://openvibe.services', note: 'apps, keys and capability grants' },
                ] },
            ],
        }));
    });

    r.get('/llms-full.txt', (_req, res) => {
        const entries = [...pages, ...legalPages()].map((p) => ({ url: p.path, title: p.title, text: p.text }));
        res.type('text/plain').set('Cache-Control', TEXT).send(seo.llmsFull({
            site: SITE_NAME,
            summary: 'Every public page of OpenVibe.Today: the schedule, its events and channels, and the API.',
            base: site,
            maxBytes: 256 * 1024,
            sections: [{ title: 'Pages', pages: entries }],
        }));
    });

    r.get('/sitemap.xml', (_req, res) => {
        const lastmod = siteUpdated();
        const urls = pages.filter((p) => p.sitemap).map((e) => ({ loc: abs(e.path), ...(lastmod ? { lastmod } : {}), changefreq: e.changefreq, priority: e.priority }));
        res.type('application/xml').set('Cache-Control', TEXT).send(seo.sitemapXml(urls));
    });

    return r;
}

module.exports = { createDiscoveryRoutes, homeJsonLd, publicPages, DESCRIPTION, SITE_NAME };
