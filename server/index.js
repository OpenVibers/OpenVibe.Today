'use strict';

/**
 * OpenVibe.Today — process entry. `node server/index.js`
 * Listens on PORT (5100) behind nginx (deploy/).
 */
const { createApp } = require('./app');
const { gracefulStop } = require('openvibe-sdk/service');
const { startTelemetryRetention } = require('openvibe-sdk/telemetry');

/**
 * The process stop (openvibe-sdk/service): the HTTP drain runs, then the JWKS refresher stops, the jobs stop, the
 * store closes and the Events subscriptions stop. Exported so a test can inject `exit` and `signals: false`.
 */
function createLifecycle({ server, ctx, exit, signals, timers = [], extra = [] }) {
    return gracefulStop({
        name: 'OpenVibe.Today', server, deadlineExitCode: 0, exit, signals, deadlineMs: 10_000,
        close: [
            () => { for (const t of timers) clearInterval(t); },
            () => ctx.keys.client.stop(),
            () => ctx.publisher.stop(),
            () => ctx.reminders.stop(),
            () => ctx.brief.stop(),
            async () => { clearInterval(ctx.telemetryTick); if (ctx.retention) await ctx.retention.stop(); if (ctx.telemetry) await ctx.telemetry.stop(); },
            () => ctx.s.close(),
            ...extra,
        ],
    });
}

async function start() {
    const { app, ctx } = await createApp();
    const { config } = ctx;

    const server = app.listen(config.port, config.host, () => {
        console.log(`[OpenVibe.Today] ${config.nodeEnv} on http://${config.host}:${config.port} → ${config.baseUrl} (db ${ctx.s.db.store})`);
        // Warm the Network signing key immediately: a service nobody has signed in to yet must not read degraded
        // only because the first JWKS fetch had not happened.
        ctx.keys.ensure().catch(() => {});
    });
    server.keepAliveTimeout = 65_000;
    ctx.retention = startTelemetryRetention({ db: ctx.s.db, log: ctx.log || console, olderThanDays: 14 });
    ctx.telemetryTick = setInterval(() => { ctx.telemetry.flush().catch(() => {}); }, 60_000);
    ctx.telemetryTick.unref();
    ctx.keys.client.start();

    // Jobs. Each refuses to start under TODAY_DRILL (or when it is not configured); tests call their runOnce().
    ctx.publisher.start();
    ctx.reminders.start();
    ctx.brief.start();

    // Subscribe to the two live topics and the two account topics at OpenVibe.Events (idempotent; off without the
    // Events URL and secret). The consumer itself is mounted in server/app.js.
    const subscriptions = config.drill ? null : ctx.consumer.startSubscriptions({ config, port: config.port, secret: config.events.secrets[0] || '' });
    const extra = [() => { if (subscriptions) subscriptions.stop(); }];
    createLifecycle({ server, ctx, extra });
    return { server, ctx };
}

if (require.main === module) {
    start().catch((err) => { console.error('[OpenVibe.Today] failed to start:', err); process.exit(1); });
}

module.exports = { start, createLifecycle };
