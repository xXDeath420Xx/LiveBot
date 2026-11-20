// Screenshots for the studio guide. The Devices page renders dashboard/views/stream-bot/devices.ejs with the stream bot demo locals
// (scripts/site-shots/stream-bot-demo.mjs) and one CertiFried Studio device built with dashboard/services/stream-bot-view.js
// deviceView(), carrying the studioView() shape the route adds. The PC name and OBS details are invented.
import { streamBotPages } from '../stream-bot-demo.mjs';

export default async function ({ page, ctx, demo }) {
    const sb = await streamBotPages(demo, { root: ctx.root });
    const base = sb['stream-bot-devices'];
    const iso = (...a) => demo.D(...a).toISOString();
    const studio = {
        id: 3, kind: 'studio', name: 'CertiFried Studio on MAPLE-STREAM', tokenHint: 'k2Pw', capabilities: [], clientInfo: null,
        createdAt: iso(2026, 11, 12, 18, 4), lastSeenAt: iso(2026, 11, 19, 18, 2), revoked: false, online: true,
        studio: { appVersion: null, reported: true, obs: { connected: true, version: '31.1.2', currentScene: 'Just Chatting', scenes: 6 }, sounds: 4 },
    };
    page('studio-devices', base.template, () => ({ ...base.locals, devices: [studio, ...base.locals.devices] }), {
        alt: 'The stream bot Devices page: CertiFried Studio on MAPLE-STREAM online and connected to OBS with Just Chatting on air, and the section for pairing Studio with a code.',
        guides: ['studio'],
    });
}
