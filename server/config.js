'use strict';

/**
 * OpenVibe.Today configuration. Every value comes from the environment (production: /etc/openvibe/today.env,
 * see .env.example). Only environment variable NAMES appear in code and docs; secrets are never logged.
 *
 * load(env) is pure so tests can build a config without touching process.env.
 */
require('dotenv').config();
const trim = (s) => String(s || '').replace(/\/+$/, '');
const int = (v, def) => (Number.isFinite(parseInt(v, 10)) ? parseInt(v, 10) : def);

function load(env = process.env) {
    const nodeEnv = env.NODE_ENV || 'development';
    const isProduction = nodeEnv === 'production';
    const port = int(env.PORT, 5100);
    const baseUrl = trim(env.BASE_URL || (isProduction ? 'https://openvibe.today' : `http://localhost:${port}`));
    const networkUrl = trim(env.OV_NETWORK_URL || 'https://openvibe.network');

    return {
        service: 'today',
        port,
        host: env.HOST || '127.0.0.1',
        nodeEnv,
        isProduction,
        baseUrl,
        trustProxy: env.TRUST_PROXY != null ? Number(env.TRUST_PROXY) : 2,
        drill: env.TODAY_DRILL === '1' || env.TODAY_DRILL === 'true',
        limits: {
            minute: Math.max(1, int(env.TODAY_LIMITS_MINUTE, 120)),
            hour: Math.max(1, int(env.TODAY_LIMITS_HOUR, 3000)),
        },

        // PostgreSQL (ADR-035): DATABASE_URL serves (PgBouncer), DATABASE_DIRECT_URL migrates (owner role). In
        // development without DATABASE_URL an embedded PGlite database in data/pglite is used (TODAY_PGLITE_DIR
        // overrides the directory).
        db: { url: env.DATABASE_URL || '', directUrl: env.DATABASE_DIRECT_URL || '', pgliteDir: env.TODAY_PGLITE_DIR || '' },
        valkey: { url: env.VALKEY_URL || '', prefix: env.VALKEY_PREFIX || 'ov:today:' },

        // OpenVibe.Network: SSO (OAuth2 authorization server with PKCE) and its JWKS.
        networkUrl,
        networkInternalUrl: trim(env.OV_NETWORK_INTERNAL_URL || 'http://127.0.0.1:4000'),
        networkIssuer: trim(env.OV_NETWORK_ISSUER || networkUrl),
        audience: env.TODAY_AUDIENCE || 'openvibe.today',
        oauth: {
            clientId: env.OV_OAUTH_CLIENT_ID || 'today',
            clientSecret: env.OV_OAUTH_CLIENT_SECRET || '',
            redirectUri: env.OV_OAUTH_REDIRECT_URI || `${baseUrl}/auth/callback`,
            scope: 'profile',
            sessionAudience: env.OV_SESSION_AUDIENCE || 'openvibe.network',
        },
        cookies: { secure: env.COOKIE_SECURE ? env.COOKIE_SECURE === 'true' : isProduction },

        // OpenVibe.Events → this service. The secret signs a delivery (comma-separated for rotation, 32+
        // characters each); unset turns POST /internal/events off (503). The url is where subscriptions are
        // created at boot, off when unset.
        events: {
            secrets: String(env.TODAY_EVENTS_SECRET || '').split(',').map((x) => x.trim()).filter(Boolean),
            url: trim(env.TODAY_EVENTS_URL || env.EVENTS_URL || ''),
            endpoint: env.TODAY_EVENTS_ENDPOINT || '',
            intervalMs: Math.max(500, int(env.TODAY_EVENTS_INTERVAL_MS, 5000)),
            // The scope this service's client-credentials token asks for when publishing. The product name is
            // events.publish; OpenVibe.Contracts names the capability events.event.publish, which the publisher
            // falls back to if the token endpoint refuses the product name. TODAY_EVENTS_SCOPE overrides both.
            scope: env.TODAY_EVENTS_SCOPE || 'events.event.publish',
        },

        // OpenVibe.Live's public Rundown API, for "Yesterday on OpenVibe" in the brief.
        live: {
            internalUrl: trim(env.OV_LIVE_INTERNAL_URL || 'http://127.0.0.1:3000'),
            timeoutMs: Math.max(300, int(env.TODAY_LIVE_TIMEOUT_MS, 2500)),
        },

        brief: {
            hourUtc: Math.min(23, Math.max(0, int(env.TODAY_BRIEF_HOUR_UTC, 6))),
            activeDays: Math.max(1, int(env.TODAY_BRIEF_ACTIVE_DAYS, 30)),
        },

        // The follows and notification calls this service makes on a person's behalf.
        follows: { cacheMs: Math.max(0, int(env.TODAY_FOLLOWS_CACHE_MS, 60_000)) },
        notifications: { resolveCacheMs: Math.max(0, int(env.TODAY_RESOLVE_CACHE_MS, 5 * 60_000)) },
    };
}

module.exports = { load };
