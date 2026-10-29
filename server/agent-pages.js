'use strict';
// The Markdown twins of openvibe.today's public pages (openvibe-shared/agent-layer), rendered by the same
// server renderer the routes use (createPublicPageViews in http/pages.js + render/layout.js's renderPage), so a
// twin cannot drift from its page. Anonymous only: an event shows no reminders and no owner controls, and the
// pages drawn for a signed-in person (/me, /brief, /schedule) have no twin at all.
const { createPublicPageViews } = require('./http/pages');
const { renderPage } = require('./render/layout');

function createAgentPages(ctx) {
    const views = createPublicPageViews(ctx);
    const twin = (o, path) => (o ? { html: renderPage({ ...o, config: ctx.config, path }) } : null);

    async function renderPublicPage(path) {
        if (path === '/') return twin(await views.home(), '/');
        if (path === '/developers') return twin(views.developers(), '/developers');
        const one = /^\/e\/([^/]+)$/.exec(path);
        if (one) {
            const id = decodeURIComponent(one[1]);
            return twin(await views.event(id), `/e/${encodeURIComponent(id)}`);
        }
        return null;
    }

    return { renderPublicPage };
}

module.exports = { createAgentPages };
