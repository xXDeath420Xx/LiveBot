/*
 * Stream bot devices (Phase 5; docs/superpowers/specs/2026-11-19-stream-bot-design.md §10; migration 461): lights, Voicemeeter
 * and the Stream Deck. Module map:
 *
 *   catalog.js   the light.* and voicemeeter.* actions, colours, device ids, presets (pure)
 *   state.js     what CertiFried Studio reports about the PC's devices (pure; used by studio.js sanitiseState)
 *   accounts.js  Govee and LIFX cloud keys (stream_bot_light_accounts, encrypted) and light presets (profile settings)
 *   cloud.js     Govee Platform API and LIFX HTTP API with the streamer's own key, rate-limited
 *   service.js   routing light actions (cloud here, the rest to Studio), the editor's choices, the Devices page, Studio requests
 *   privacy.js   /privacy export and delete
 *
 *   attachDevices(box, { onRequest }) → { service, accounts, cloud, onRequest }
 *     Called once from core/stream-bot/index.js build(), before overlays. It registers the actions and only wraps what is there:
 *       hub.dispatch      target 'studio' light.* actions go through service.dispatch (cloud lights, presets, colour text)
 *       requests          Studio's 'lights.*' and 'counters.*' requests; every other method goes to `onRequest` as before
 */
import { createLightAccounts } from './accounts.js';
import { createCloudLights } from './cloud.js';
import { createDeviceService } from './service.js';
import { LIGHT_ACTIONS, VOICEMEETER_ACTIONS } from './catalog.js';

export async function attachDevices(box, { onRequest = null } = {}) {
    const { store, hub, logger, pool } = box;
    const encryption = (await import('../../../utils/encryption.js')).default;
    const actionsMod = await import('../actions.js');
    for (const def of [...LIGHT_ACTIONS, ...VOICEMEETER_ACTIONS]) actionsMod.registerActionType({ ...def });
    const accounts = createLightAccounts({ db: pool, prefix: store.prefix || 'stream_bot_', encryption });
    const cloud = createCloudLights({ accounts, logger });
    const rawDispatch = hub.dispatch.bind(hub);
    const service = createDeviceService({ store, hub, accounts, cloud, rawDispatch, logger });
    hub.dispatch = (d) => service.dispatch(d, rawDispatch);
    const handle = (conn, method, params) => {
        const m = String(method);
        if (m.startsWith('lights.') || m.startsWith('counters.')) return service.onStudioRequest(conn, m, params);
        return onRequest ? onRequest(conn, method, params) : Promise.reject(Object.assign(new Error('Unknown method'), { code: 'unknown_method' }));
    };
    hub.use({ onRequest: handle });
    return { service, accounts, cloud, onRequest: handle };
}

export default { attachDevices };
