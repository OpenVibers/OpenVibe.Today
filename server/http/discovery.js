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

function publicPages() {
    return [
        { path: '/', changefreq: 'daily', priority: 1.0, title: 'OpenVibe.Today home', text: 'One schedule for every stream and event on OpenVibe, with reminders and a private calendar feed.' },
        { path: '/developers', changefreq: 'weekly', priority: 0.6, title: 'OpenVibe.Today API', text: 'The JSON API, the ICS feeds and the Events topics Today publishes and consumes.' },
    ];
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
        const entries = pages.map((p) => ({ url: p.path, title: p.title, text: p.text }));
        res.type('text/plain').set('Cache-Control', TEXT).send(seo.llmsFull({
            site: SITE_NAME,
            summary: 'Every public page of OpenVibe.Today: the schedule and the API.',
            base: site,
            maxBytes: 256 * 1024,
            sections: [{ title: 'Pages', pages: entries }],
        }));
    });

    r.get('/sitemap.xml', (_req, res) => {
        const lastmod = siteUpdated();
        const urls = pages.map((e) => ({ loc: abs(e.path), ...(lastmod ? { lastmod } : {}), changefreq: e.changefreq, priority: e.priority }));
        res.type('application/xml').set('Cache-Control', TEXT).send(seo.sitemapXml(urls));
    });

    return r;
}

module.exports = { createDiscoveryRoutes, homeJsonLd, publicPages, DESCRIPTION, SITE_NAME };
