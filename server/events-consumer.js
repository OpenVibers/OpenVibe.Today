'use strict';

/**
 * Help's file name, today's consumer: POST /internal/events and the boot-time startSubscriptions(). The
 * implementation lives in server/events/consumer.js.
 */
const { createEventsConsumer, startSubscriptions, LIVE_TOPICS, TOPICS } = require('./events/consumer');

module.exports = { createEventsConsumer, startSubscriptions, LIVE_TOPICS, TOPICS };
