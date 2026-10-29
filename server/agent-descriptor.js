'use strict';
// What openvibe.today tells an agent about itself (openvibe-shared/agent-layer): /.well-known/agent.json.
// Every field is something this site really serves; no OpenAPI document is published for Today, so none is named.
module.exports = {
    id: 'today',
    name: 'OpenVibe.Today',
    purpose: 'The OpenVibe network\'s calendar: one public schedule of streams and events, reminders sent through OpenVibe.Network, a private ICS feed per person, and a daily brief.',
    home: 'https://openvibe.today',
    site: 'openvibe.today',
    api: '/api/v1',
    docs: '/developers',
    policy: {
        auth: ['none', 'Network OIDC'],
        rateLimit: '240 API requests a minute per address; 300 page requests a minute',
    },
};
