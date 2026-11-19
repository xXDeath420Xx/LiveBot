'use strict';
/*
 * Every certifriedmultitool.com address the app uses, in one place, so test/site-urls.test.js can check each one
 * against the dashboard's routes (when run inside the repo) and against the live site (CF_STUDIO_LIVE_URLS=1).
 *
 *   SITE       the default server
 *   PAGES      pages opened in the browser
 *   SOURCE     the source code and its licence (GNU AGPL-3.0-or-later), opened from About and legal
 *   FEED       the update feed folder (electron-updater generic provider; also in package.json "publish")
 *   PATHS      paths on whichever server the app is set to (pairing, sign-in, realtime)
 */
const SITE = 'https://certifriedmultitool.com';

const PAGES = Object.freeze({
    download: `${SITE}/downloads/studio`,
    guide: `${SITE}/docs/guides/stream-bot`,
    devices: `${SITE}/stream/bot/devices`,
    overlays: `${SITE}/stream/bot/overlays`,
    studio: `${SITE}/studio`,
    howItWorks: `${SITE}/studio/how-it-works`,
    privacy: `${SITE}/studio/privacy`,
    faq: `${SITE}/studio/faq`,
    eula: `${SITE}/eula#certifried-studio`,
    terms: `${SITE}/terms`,
    legal: `${SITE}/legal`,
});

const FEED = `${SITE}/downloads/studio/`;

const SOURCE = Object.freeze({ source: 'https://github.com/xXDeath420Xx/LiveBot', license: 'https://github.com/xXDeath420Xx/LiveBot/blob/dev/LICENSE' });

const PATHS = Object.freeze({
    pair: '/stream/bot/api/pair',
    linkRequest: '/stream/bot/api/link/request',
    linkPoll: '/stream/bot/api/link/poll',
    linkPage: '/stream/bot/devices/link',
    ws: '/stream/bot/ws',
    deviceSound: '/stream/bot/api/device/sounds/:id',
});

module.exports = { SITE, PAGES, SOURCE, FEED, PATHS };
