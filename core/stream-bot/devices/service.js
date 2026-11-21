/*
 * Stream bot devices (Phase 5): lights, Voicemeeter and the Stream Deck, on the server side.
 *
 *   createDeviceService({ store, hub, accounts, cloud, logger?, now?, ackWaitMs? })
 *     .dispatch(d, next)             wraps hub.dispatch for target 'studio' light actions:
 *                                    - light.color: the colour text is read here (#hex, name, 3200K); not understood → failed
 *                                    - light.preset: the preset is looked up; its cloud lights run here, the rest go to Studio as
 *                                      { preset, lights: [...] }
 *                                    - a cloud light (govee-cloud:…, lifx-cloud:…) runs here with the streamer's key, except
 *                                      (Studio 0.2.11) when the connected Studio reaches that same light over Bluetooth
 *                                      (a goveeble light with this cloudId, paired and online): then Studio does it, and the
 *                                      cloud is the fallback when Studio fails or does not answer in time
 *                                    - every light ('' / 'all'): cloud lights here, and Studio's own lights through `next`
 *                                    Cloud work gets its own dispatch row (capability 'light-cloud', acked or failed) so the run
 *                                    page shows it; the result is { id, status: 'done' | 'failed', detail } (engine.js maps it)
 *     .localDevices(profileId)       lights, Voicemeeter and Stream Deck as the newest Studio reported them (live, else saved)
 *     .choices(profileId)            what the automation editor offers: lights (Studio's and cloud), presets, Voicemeeter
 *     .pageData(profileId)           the Devices page's Lights, Audio and Stream Deck sections
 *     .presets / savePreset / deletePreset (settings.lights.presets; 50 at most)
 *     .test(profileId, device)       a short flash in CertiFried green; waits for Studio's answer (up to ackWaitMs)
 *     .checkStudio(profileId)        asks Studio to look for lights and Voicemeeter again ('devices.check'), waits for the answer
 *     .onStudioRequest(conn, method, params)   'lights.presets' | 'lights.apply' | 'counters.list' | 'counters.add' |
 *                                    'lights.cloud' (Studio 0.2.10's Lights tab: the cloud lights on the streamer's Govee / LIFX
 *                                    key, no keys) | 'lights.cloudTest' { device } (the same test flash as the Devices page)
 *
 * Tested in tests/stream-bot-devices.test.js.
 */
import crypto from 'node:crypto';
import { parseColor, isCloudDevice, isAllDevices, validatePreset, PRESET_LIMITS, DRIVER_LABEL, PROVIDER_LABEL, CLOUD_PROVIDERS } from './catalog.js';
import { RequestError } from '../studio.js';

const KEY = /^[a-z0-9_.-]{1,64}$/;
const newId = () => `d_${crypto.randomBytes(12).toString('hex')}`;
const newPresetId = () => `p_${crypto.randomBytes(6).toString('hex')}`;

export function createDeviceService({ store, hub, accounts, cloud, rawDispatch = null, logger = null, now = () => Date.now(), ackWaitMs = 8000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
    const log = (lvl, m, meta) => { try { logger?.[lvl]?.(`[StreamBotDevices] ${m}`, meta); } catch { /* ignore */ } };
    // The hub's own dispatch (before any wrapper): what the light actions hand on to CertiFried Studio.
    const sendToHub = (x) => (rawDispatch ? rawDispatch(x) : hub.dispatch(x));

    function newestStudio(profileId) {
        return (hub?.connected?.(profileId) || []).filter((c) => c.kind === 'studio').sort((a, b) => new Date(b.connectedAt) - new Date(a.connectedAt))[0] || null;
    }
    async function localDevices(profileId) {
        const live = newestStudio(profileId);
        if (live?.state?.devices) return { ...live.state.devices, live: true, deviceId: live.deviceId, deviceName: live.name || null };
        const saved = (await store.getSettingsKey(profileId, 'studio').catch(() => null)) || null;
        return { lights: saved?.devices?.lights || [], voicemeeter: saved?.devices?.voicemeeter || null, streamdeck: saved?.devices?.streamdeck || null,
            live: false, deviceId: saved?.deviceId || null, deviceName: saved?.deviceName || null, reportedAt: saved?.reportedAt || null };
    }

    async function presets(profileId) {
        const s = await store.getSettingsKey(profileId, 'lights').catch(() => null);
        return Array.isArray(s?.presets) ? s.presets : [];
    }
    async function writePresets(profileId, list) {
        const cur = (await store.getSettingsKey(profileId, 'lights').catch(() => null)) || {};
        await store.setSettingsKey(profileId, 'lights', { ...cur, presets: list });
    }

    async function record(d, status, { result = null, error = null, params = null } = {}) {
        const id = newId();
        await store.insertDispatch({ id, profileId: d.profileId, runId: d.runId ?? null, target: 'studio', capability: 'light-cloud', actionType: d.actionType,
            params: params || d.params || {}, status: status === 'acked' ? 'sent' : status, expiresAt: new Date(now() + 60_000) });
        if (status === 'acked') await store.updateDispatch(id, { status: 'acked', result, ackedAt: new Date(now()), attempts: 1 });
        else if (error) await store.updateDispatch(id, { error });
        return id;
    }

    const describe = (r) => {
        const parts = [`${r.applied.length} cloud light${r.applied.length === 1 ? '' : 's'}`];
        if (r.skipped.length) parts.push(`${r.skipped.length} skipped (${[...new Set(r.skipped.map((s) => s.reason))].join(', ')})`);
        if (r.notes.length) parts.push(r.notes[0]);
        return parts.join('; ');
    };
    async function runCloud(d, type, params) {
        try {
            const r = await cloud.run(d.profileId, type, params);
            const id = await record(d, 'acked', { result: r, params });
            return { id, status: 'done', detail: describe(r), r };
        } catch (err) {
            const id = await record(d, 'failed', { error: `${err.code || 'failed'}: ${err.message}`.slice(0, 250), params });
            return { id, status: 'failed', detail: `${err.code || 'failed'}: ${err.message}`, r: null };
        }
    }

    /** The connected Studio's Bluetooth light for this cloud light (0.2.11), when paired and online; else null. */
    function bleFor(profileId, cloudId) {
        const st = newestStudio(profileId);
        const l = (st?.state?.devices?.lights || []).find((x) => x.driver === 'goveeble' && x.cloudId === cloudId);
        return l && l.online && !l.needsPairing ? l : null;
    }

    const cloudCount = async (profileId) => (await cloud.devices(profileId).catch(() => [])).length;
    const hasLocalLights = async (profileId) => !!newestStudio(profileId) || (await localDevices(profileId)).lights.length > 0;

    async function presetSteps(entries) {
        return entries.map((e) => {
            if (e.power === 'off') return ['light.power', { device: e.device, state: 'off' }];
            if (e.scene) return ['light.scene', { device: e.device, scene: e.scene, durationMs: 0 }];
            if (e.kelvin) return ['light.white', { device: e.device, kelvin: e.kelvin, brightness: e.brightness ?? 100, durationMs: 0 }];
            if (e.color) return ['light.set', { device: e.device, color: e.color, brightness: e.brightness ?? 100, durationMs: 0 }];
            return ['light.brightness', { device: e.device, brightness: e.brightness ?? 100, durationMs: 0 }];
        });
    }

    async function dispatch(d, next) {
        if (d?.target !== 'studio' || !/^light\./.test(String(d.actionType || ''))) return next(d);
        let params = { ...(d.params || {}) };
        if (d.actionType === 'light.color') {
            const c = parseColor(params.color);
            if (!c) {
                const id = await record(d, 'failed', { error: `bad_color: "${String(params.color || '').slice(0, 60)}" is not a colour` });
                return { id, status: 'failed', detail: `the colour "${String(params.color || '').slice(0, 60)}" was not understood (use #ff0000, a name such as red, or 3200K)` };
            }
            params.color = c.hex || `${c.kelvin}K`;
        }
        if (d.actionType === 'light.preset') {
            const p = (await presets(d.profileId)).find((x) => x.id === params.preset);
            if (!p) {
                const id = await record(d, 'failed', { error: 'preset_not_found' });
                return { id, status: 'failed', detail: 'that light preset was deleted' };
            }
            const cloudEntries = p.lights.filter((e) => isCloudDevice(e.device));
            const local = p.lights.filter((e) => !isCloudDevice(e.device));
            const details = [];
            let failed = 0;
            for (const [type, sp] of await presetSteps(cloudEntries)) {
                const r = await runCloud(d, type, sp);
                if (r.status === 'failed') failed++;
                details.push(r.detail);
            }
            if (!local.length) {
                return { id: null, status: failed && failed === cloudEntries.length ? 'failed' : 'done', detail: `preset ${p.name}: ${details.join('; ') || 'nothing to do'}` };
            }
            return next({ ...d, params: { preset: p.name, lights: local } });
        }
        const device = params.device || '';
        if (isCloudDevice(device)) {
            const ble = bleFor(d.profileId, device);
            if (ble) {
                const sent = await sendToHub({ ...d, params: { ...params, device: ble.id } }).catch(() => null);
                if (sent?.status === 'sent') {
                    const row = await waitAck(sent.id);
                    if (row?.status === 'acked') return { id: sent.id, status: 'done', detail: `${ble.name}: over Bluetooth through CertiFried Studio` };
                    log('info', 'Bluetooth light failed; using the cloud', { profileId: d.profileId, error: String(row?.error || row?.status || 'no answer').slice(0, 120) });
                }
            }
            const r = await runCloud(d, d.actionType, params);
            return { id: r.id, status: r.status, detail: r.detail };
        }
        if (isAllDevices(device) && await cloudCount(d.profileId)) {
            const r = await runCloud(d, d.actionType, { ...params, device: '' });
            if (!(await hasLocalLights(d.profileId))) return { id: r.id, status: r.status, detail: r.detail };
            const sent = await next({ ...d, params });
            return sent;
        }
        return next({ ...d, params });
    }

    /** Wait for a dispatch's answer (Studio's ack) by reading its row. */
    async function waitAck(id, ms = ackWaitMs) {
        const end = now() + ms;
        for (;;) {
            const row = await store.getDispatch(id).catch(() => null);
            if (row && ['acked', 'failed', 'expired'].includes(row.status)) return row;
            if (now() >= end) return row;
            await sleep(250);
        }
    }

    function lightOption(l, source) {
        const what = source === 'cloud' ? DRIVER_LABEL[l.driver] : `${DRIVER_LABEL[l.driver] || l.driver}${l.kind === 'group' ? ', room' : ''}`;
        return { value: l.id, label: `${l.name} (${what})`, driver: l.driver, source, online: l.online !== false, needsPairing: !!l.needsPairing, kind: l.kind || 'light',
            scenes: [...(l.caps?.scenes || []), ...(l.caps?.effects || [])].slice(0, 200), color: !!l.caps?.color, white: !!l.caps?.white, cloudScenes: !!l.caps?.cloudScenes };
    }

    function applyPreset(profileId, presetId, runId = null) {
        return dispatch({ profileId, runId, target: 'studio', capability: 'light', actionType: 'light.preset', params: { preset: presetId }, queueSeconds: 0 }, sendToHub);
    }

    async function choices(profileId) {
        const local = await localDevices(profileId);
        const cloudList = await cloud.devices(profileId).catch(() => []);
        const vm = local.voicemeeter;
        const vmTargets = [];
        if (vm?.type) {
            for (const s of vm.strips || []) vmTargets.push({ value: `strip:${s.index}`, label: `Strip ${s.index + 1}${s.label ? `: ${s.label}` : ''}` });
            for (const b of vm.buses || []) vmTargets.push({ value: `bus:${b.index}`, label: `Bus ${b.index + 1}${b.label ? `: ${b.label}` : ''}` });
        }
        return {
            lights: [...(local.lights || []).filter((l) => l.kind !== 'bridge' || (l.caps?.scenes || []).length).map((l) => lightOption(l, 'studio')), ...cloudList.map((l) => lightOption(l, 'cloud'))],
            presets: (await presets(profileId)).map((p) => ({ value: p.id, label: p.name })),
            vm: { type: vm?.type || null, targets: vmTargets, profiles: (vm?.profiles || []).map((p) => ({ value: p, label: p.replace(/\.xml$/i, '') })), installed: !!vm?.installed },
            studioLive: !!local.live,
        };
    }

    return {
        dispatch,
        localDevices,
        choices,
        waitAck,
        presets,
        async savePreset(profileId, raw) {
            const v = validatePreset(raw);
            if (!v.ok) return v;
            const list = await presets(profileId);
            const value = { ...v.value, id: v.value.id || newPresetId() };
            const i = list.findIndex((p) => p.id === value.id);
            if (i < 0 && list.length >= PRESET_LIMITS.presets) return { ok: false, errors: [`At most ${PRESET_LIMITS.presets} presets.`] };
            if (list.some((p) => p.id !== value.id && p.name.toLowerCase() === value.name.toLowerCase())) return { ok: false, errors: ['Another preset has that name.'] };
            if (i < 0) list.push(value); else list[i] = value;
            await writePresets(profileId, list);
            return { ok: true, value };
        },
        async deletePreset(profileId, id) {
            const list = await presets(profileId);
            const keep = list.filter((p) => p.id !== id);
            if (keep.length === list.length) return false;
            await writePresets(profileId, keep);
            return true;
        },
        applyPreset,
        async test(profileId, device) {
            const d = { profileId, runId: null, target: 'studio', capability: 'light', actionType: 'light.flash',
                params: { device, color: '#b4e04f', brightness: 100, times: 2, periodMs: 500, mode: 'flash' }, queueSeconds: 0 };
            const r = await dispatch(d, sendToHub);
            if (r.status === 'done') return { ok: true, message: 'Flashed.', detail: r.detail };
            if (r.status === 'failed') return { ok: false, message: r.detail };
            if (r.status !== 'sent') return { ok: false, message: 'CertiFried Studio is not connected. Open it on your PC and try again.' };
            const row = await waitAck(r.id);
            if (row?.status === 'acked') return { ok: true, message: 'Flashed.' };
            if (row?.status === 'failed') return { ok: false, message: lightError(row.error) };
            return { ok: false, message: 'CertiFried Studio did not answer in time.' };
        },
        async checkStudio(profileId) {
            const r = await sendToHub({ profileId, runId: null, target: 'studio', capability: null, actionType: 'devices.check', params: {}, queueSeconds: 0 });
            if (r.status !== 'sent') return { ok: false, message: 'CertiFried Studio is not connected. Open it on your PC and try again.' };
            const row = await waitAck(r.id, Math.max(ackWaitMs, 12000));
            if (row?.status === 'acked') return { ok: true, result: row.result || {} };
            if (row?.status === 'failed' && /unsupported_action/.test(String(row.error))) return { ok: false, message: 'Update CertiFried Studio to 0.2.6 or later for lights, Voicemeeter and the Stream Deck.' };
            return { ok: false, message: 'CertiFried Studio did not answer in time.' };
        },
        async pageData(profileId) {
            const local = await localDevices(profileId);
            const accs = await accounts.list(profileId);
            return {
                studio: { live: !!local.live, name: local.deviceName, reportedAt: local.reportedAt || null, reported: !!(local.lights?.length || local.voicemeeter || local.streamdeck) },
                lights: (local.lights || []).map((l) => ({ ...l, driverLabel: DRIVER_LABEL[l.driver] || l.driver })),
                cloud: CLOUD_PROVIDERS.map((p) => {
                    const a = accs.find((x) => x.provider === p);
                    return { provider: p, label: PROVIDER_LABEL[p], connected: !!a, keyHint: a?.keyHint || null, status: a?.status || null, lastError: a?.lastError || null,
                        devices: (a?.devices || []).map((d) => ({ id: d.id, name: d.name, model: d.model || null })), checkedAt: a?.devicesAt ? a.devicesAt.toISOString() : null };
                }),
                presets: await presets(profileId),
                voicemeeter: local.voicemeeter,
                streamdeck: local.streamdeck,
            };
        },
        async onStudioRequest(conn, method, params = {}) {
            const within = (key, max, ms) => {
                const t = now();
                conn[key] = (conn[key] || []).filter((x) => t - x < ms);
                if (conn[key].length >= max) return false;
                conn[key].push(t);
                return true;
            };
            switch (method) {
                case 'lights.presets':
                    return { presets: (await presets(conn.profileId)).map((p) => ({ id: p.id, name: p.name })) };
                case 'lights.cloud': {
                    const accs = await accounts.list(conn.profileId);
                    const lights = [];
                    for (const a of accs) {
                        for (const d of a.devices || []) {
                            if (lights.length >= 200) break;
                            lights.push({ id: d.id, name: String(d.name || d.id).slice(0, 100), model: d.model || null, provider: a.provider, providerLabel: PROVIDER_LABEL[a.provider] || a.provider, online: d.online !== false });
                        }
                    }
                    return { lights, accounts: accs.map((a) => ({ provider: a.provider, label: PROVIDER_LABEL[a.provider] || a.provider, status: a.status || null, lastError: a.lastError ? String(a.lastError).slice(0, 200) : null })) };
                }
                case 'lights.cloudTest': {
                    const device = String(params?.device || '');
                    if (!isCloudDevice(device)) throw new RequestError('bad_params', 'device must be a cloud light');
                    if (!within('_cloudTest', 6, 60_000)) throw new RequestError('rate', 'Too many tests; wait a minute');
                    return this.test(conn.profileId, device);
                }
                case 'lights.apply': {
                    const id = String(params?.presetId || '');
                    if (!/^p_[a-z0-9]{6,16}$/.test(id)) throw new RequestError('bad_params', 'presetId is required');
                    if (!within('_lightApply', 20, 10_000)) throw new RequestError('rate', 'Too many presets at once; wait a few seconds');
                    const r = await applyPreset(conn.profileId, id);
                    return { status: r.status, detail: r.detail || null };
                }
                case 'counters.list': {
                    const rows = await store.listVariables(conn.profileId, { owner: 'server', limit: 100 });
                    return { counters: rows.map((v) => ({ key: v.key_name, value: String(v.value_text ?? '').slice(0, 60) })) };
                }
                case 'counters.add': {
                    const key = String(params?.key || '').trim().toLowerCase();
                    const by = Number(params?.by ?? 1);
                    if (!KEY.test(key)) throw new RequestError('bad_params', 'key is 1 to 64 letters, numbers, _ . or -');
                    if (!Number.isInteger(by) || Math.abs(by) > 1000) throw new RequestError('bad_params', 'by is a whole number from -1000 to 1000');
                    if (!within('_counters', 20, 10_000)) throw new RequestError('rate', 'Too many counter changes; wait a few seconds');
                    const r = await store.variableStore.incr(conn.profileId, 'server', key, by, 1000);
                    if (r.full) throw new RequestError('full', 'This channel has 1000 values already');
                    return { key, value: r.value };
                }
                default:
                    throw new RequestError('unknown_method', 'Unknown method');
            }
        },
    };
}

/** Studio's short error codes as plain sentences for the dashboard. */
export function lightError(code) {
    const c = String(code || '').split(':')[0].trim();
    const map = {
        no_lights: 'Studio has no lights yet. In Studio open Lights and choose Find lights.',
        device_not_found: 'Studio does not know that light any more. In Studio choose Find lights.',
        device_offline: 'That light did not answer. Check that it is on and on the same network as your PC.',
        needs_pairing: 'Pair that light in Studio first (Lights, Pair).',
        not_supported: 'That light cannot do this.',
        bad_color: 'That colour was not understood.',
        unsupported_action: 'Update CertiFried Studio to 0.2.6 or later for lights.',
        lights_off: 'Lights are turned off in CertiFried Studio. Turn them on under Lights.',
    };
    return map[c] || (code ? `Studio said: ${String(code).slice(0, 160)}` : 'It did not work.');
}

export default { createDeviceService, lightError };
