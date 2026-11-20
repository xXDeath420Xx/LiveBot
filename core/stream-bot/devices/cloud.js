/*
 * Stream bot devices: cloud lights with the streamer's own key, carried out on this server (no CertiFried Studio needed).
 *
 *   Govee   Govee Platform API, https://openapi.api.govee.com/router/api/v1, header Govee-API-Key.
 *           GET /user/devices, POST /device/control, /device/state, /device/scenes ({ requestId, payload: { sku, device, ... } }).
 *           Limits (Govee's rate-limit page): 10 requests a minute per device for control and for state, 10 a minute for the
 *           device list, 10,000 a day per key. Kept here per profile in memory; a 429 pauses that key for Retry-After (else 60 s).
 *   LIFX    LIFX HTTP API, https://api.lifx.com/v1, Authorization: Bearer <token>. GET /lights/all, PUT /lights/<sel>/state,
 *           POST /lights/<sel>/effects/pulse|breathe (persist false puts the light back by itself), GET /scenes,
 *           PUT /scenes/scene_id:<uuid>/activate. Limit: 120 requests a minute per token.
 *
 *   createCloudLights({ accounts, fetch?, now?, setTimer?, clearTimer?, logger?, timeoutMs? })
 *     .check(profileId, provider)          list the devices with the saved key; marks the account ok / bad_key / error
 *     .devices(profileId)                  cached device lists of every account: [{ id, driver, name, model, online, caps }]
 *     .run(profileId, type, params)        one light action for one cloud device or 'all' cloud devices
 *                                          → { applied: [ids], skipped: [{ id, reason }], notes: [] } (throws CloudError when nothing applied)
 *     .scenes(profileId, id)               scene names for a cloud light (Govee: its dynamic scenes; LIFX: the account's scenes)
 *
 * Temporary changes (durationMs, flash on Govee) read the state first and put it back afterwards; a second temporary change
 * keeps the first saved state; a permanent change cancels a pending put-back. Timers live in this process: a restart drops
 * pending put-backs. Keys never reach a log line, an error message or a browser.
 * Tested in tests/stream-bot-devices.test.js (fake fetch).
 */
import crypto from 'node:crypto';
import { hexToRgb, parseColor, isAllDevices, cloudProviderOf, PROVIDER_LABEL } from './catalog.js';

export const GOVEE_BASE = 'https://openapi.api.govee.com/router/api/v1';
export const LIFX_BASE = 'https://api.lifx.com/v1';
export const CLOUD_LIMITS = Object.freeze({ goveePerDevice: 10, goveeList: 10, goveePerDay: 10000, lifxPerMinute: 120, devicesTtlMs: 6 * 3600_000 });

export class CloudError extends Error {
    constructor(code, message) { super(message || code); this.code = code; }
}

const rgbInt = ({ r, g, b }) => (r << 16) + (g << 8) + b;
const intRgb = (n) => ({ r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 });
const hex = ({ r, g, b }) => `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;

export function createCloudLights({
    accounts, fetch: fetchImpl = globalThis.fetch, now = () => Date.now(), setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (t) => clearTimeout(t),
    logger = null, timeoutMs = 8000,
} = {}) {
    const log = (lvl, m, meta) => { try { logger?.[lvl]?.(`[StreamBotLights] ${m}`, meta); } catch { /* ignore */ } };
    const windows = new Map();     // limiter key -> ms[]
    const pausedUntil = new Map(); // `${profileId}:${provider}` -> ms
    const restores = new Map();    // `${profileId}:${deviceId}` -> { timer, state }
    const sceneCache = new Map();  // `${profileId}:${deviceId}` -> { at, scenes: [{ name, value }] }

    function allow(key, max, windowMs) {
        const t = now();
        const list = (windows.get(key) || []).filter((x) => t - x < windowMs);
        if (list.length >= max) { windows.set(key, list); return false; }
        list.push(t);
        windows.set(key, list);
        if (windows.size > 20000) windows.clear();
        return true;
    }

    async function call(profileId, provider, key, method, url, body) {
        const pk = `${profileId}:${provider}`;
        if ((pausedUntil.get(pk) || 0) > now()) throw new CloudError('rate_limited', `${PROVIDER_LABEL[provider]} asked CertiFried to slow down; try again in a minute.`);
        const headers = provider === 'govee' ? { 'Govee-API-Key': key, 'Content-Type': 'application/json' } : { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
        let res;
        try {
            res = await fetchImpl(url, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
        } catch (err) {
            throw new CloudError('unreachable', `${PROVIDER_LABEL[provider]} did not answer (${err?.name === 'TimeoutError' ? 'timed out' : 'network error'}).`);
        }
        let data = null;
        try { data = await res.json(); } catch { /* not JSON */ }
        if (res.status === 401 || res.status === 403) throw new CloudError('bad_key', `${PROVIDER_LABEL[provider]} did not accept the key. Check it and save it again.`);
        if (res.status === 429) {
            const ra = Number(res.headers?.get?.('retry-after'));
            pausedUntil.set(pk, now() + (Number.isFinite(ra) && ra > 0 ? Math.min(ra, 3600) * 1000 : 60_000));
            throw new CloudError('rate_limited', `${PROVIDER_LABEL[provider]} asked CertiFried to slow down; try again in a minute.`);
        }
        if (res.status >= 400) throw new CloudError('refused', `${PROVIDER_LABEL[provider]} answered HTTP ${res.status}${data?.message || data?.error ? `: ${String(data.message || data.error).slice(0, 120)}` : ''}.`);
        if (provider === 'govee' && data && data.code != null && Number(data.code) !== 200) {
            throw new CloudError(Number(data.code) === 401 ? 'bad_key' : 'refused', `Govee answered: ${String(data.message || data.msg || data.code).slice(0, 120)}.`);
        }
        return data;
    }

    async function keyFor(profileId, provider) {
        const acc = await accounts.get(profileId, provider);
        if (!acc?.key) throw new CloudError('no_account', `Add your ${PROVIDER_LABEL[provider]} key on the Devices page first.`);
        return acc;
    }

    // ── Govee ────────────────────────────────────────────────────────────────────────────────
    function goveeDevice(d) {
        const caps = Array.isArray(d?.capabilities) ? d.capabilities : [];
        const has = (type, inst) => caps.some((c) => c?.type === type && (!inst || c?.instance === inst));
        const temp = caps.find((c) => c?.instance === 'colorTemperatureK')?.parameters?.range;
        return {
            id: `govee-cloud:${String(d.sku).slice(0, 20)}:${String(d.device).slice(0, 60)}`, driver: 'govee-cloud',
            name: String(d.deviceName || d.sku || 'Govee light').slice(0, 100), model: String(d.sku || '').slice(0, 30) || null, online: true, kind: 'light',
            caps: {
                power: has('devices.capabilities.on_off'), brightness: has('devices.capabilities.range', 'brightness'),
                color: has('devices.capabilities.color_setting', 'colorRgb'),
                white: temp ? { min: Number(temp.min) || 2000, max: Number(temp.max) || 9000 } : null,
                scenes: [], effects: [], cloudScenes: has('devices.capabilities.dynamic_scene'),
            },
        };
    }
    const goveeIds = (id) => { const m = String(id).match(/^govee-cloud:([^:]{1,20}):(.{1,60})$/); return m ? { sku: m[1], device: m[2] } : null; };

    async function goveeControl(profileId, acc, id, capability) {
        const ids = goveeIds(id);
        if (!ids) throw new CloudError('device_not_found', 'That Govee light is not in your account any more.');
        if (!allow(`gv:${profileId}:${ids.device}`, CLOUD_LIMITS.goveePerDevice, 60_000)) throw new CloudError('rate_limited', 'Govee allows 10 changes a minute per light; this one waits.');
        if (!allow(`gvday:${profileId}`, CLOUD_LIMITS.goveePerDay, 86_400_000)) throw new CloudError('rate_limited', 'Govee allows 10,000 requests a day per key.');
        await call(profileId, 'govee', acc.key, 'POST', `${GOVEE_BASE}/device/control`, { requestId: crypto.randomUUID(), payload: { sku: ids.sku, device: ids.device, capability } });
    }
    async function goveeState(profileId, acc, id) {
        const ids = goveeIds(id);
        if (!ids || !allow(`gvs:${profileId}:${ids.device}`, CLOUD_LIMITS.goveePerDevice, 60_000)) return null;
        const data = await call(profileId, 'govee', acc.key, 'POST', `${GOVEE_BASE}/device/state`, { requestId: crypto.randomUUID(), payload: { sku: ids.sku, device: ids.device } });
        const caps = data?.payload?.capabilities || [];
        const val = (inst) => caps.find((c) => c?.instance === inst)?.state?.value;
        const rgb = Number(val('colorRgb'));
        const k = Number(val('colorTemperatureK'));
        return { on: Number(val('powerSwitch')) === 1, brightness: Number(val('brightness')) || null, color: Number.isFinite(rgb) && rgb > 0 && !(k > 0) ? intRgb(rgb) : null, kelvin: k > 0 ? k : null };
    }
    async function goveeSet(profileId, acc, id, s) {
        if (s.on === false) return goveeControl(profileId, acc, id, { type: 'devices.capabilities.on_off', instance: 'powerSwitch', value: 0 });
        if (s.on === true && s.color == null && s.kelvin == null && s.brightness == null) return goveeControl(profileId, acc, id, { type: 'devices.capabilities.on_off', instance: 'powerSwitch', value: 1 });
        if (s.color) await goveeControl(profileId, acc, id, { type: 'devices.capabilities.color_setting', instance: 'colorRgb', value: rgbInt(s.color) });
        else if (s.kelvin) await goveeControl(profileId, acc, id, { type: 'devices.capabilities.color_setting', instance: 'colorTemperatureK', value: s.kelvin });
        if (s.brightness != null) await goveeControl(profileId, acc, id, { type: 'devices.capabilities.range', instance: 'brightness', value: Math.max(1, Math.min(100, s.brightness)) });
    }
    async function goveeScenes(profileId, acc, id) {
        const ck = `${profileId}:${id}`;
        const c = sceneCache.get(ck);
        if (c && now() - c.at < 3600_000) return c.scenes;
        const ids = goveeIds(id);
        if (!ids || !allow(`gvs:${profileId}:${ids.device}`, CLOUD_LIMITS.goveePerDevice, 60_000)) return c?.scenes || [];
        const data = await call(profileId, 'govee', acc.key, 'POST', `${GOVEE_BASE}/device/scenes`, { requestId: crypto.randomUUID(), payload: { sku: ids.sku, device: ids.device } });
        const opts = (data?.payload?.capabilities || []).flatMap((cap) => (cap?.instance === 'lightScene' ? cap?.parameters?.options || [] : []));
        const scenes = opts.filter((o) => o?.name && o?.value).slice(0, 300).map((o) => ({ name: String(o.name).slice(0, 60), value: o.value }));
        sceneCache.set(ck, { at: now(), scenes });
        return scenes;
    }

    // ── LIFX ─────────────────────────────────────────────────────────────────────────────────
    function lifxDevice(d) {
        const p = d?.product?.capabilities || {};
        return {
            id: `lifx-cloud:${String(d.id).slice(0, 40)}`, driver: 'lifx-cloud', name: String(d.label || 'LIFX light').slice(0, 100), model: String(d?.product?.name || '').slice(0, 40) || null,
            online: d.connected !== false, kind: 'light',
            caps: { power: true, brightness: true, color: p.has_color !== false, white: p.has_variable_color_temp === false ? null : { min: Number(p.min_kelvin) || 1500, max: Number(p.max_kelvin) || 9000 }, scenes: [], effects: ['pulse', 'breathe'] },
        };
    }
    const lifxSel = (id) => { const m = String(id).match(/^lifx-cloud:([A-Za-z0-9]{1,40})$/); if (!m) throw new CloudError('device_not_found', 'That LIFX light is not in your account any more.'); return `id:${m[1]}`; };
    async function lifxCall(profileId, acc, method, path, body) {
        if (!allow(`lx:${profileId}`, CLOUD_LIMITS.lifxPerMinute, 60_000)) throw new CloudError('rate_limited', 'LIFX allows 120 requests a minute; this one waits.');
        return call(profileId, 'lifx', acc.key, method, `${LIFX_BASE}${path}`, body);
    }
    async function lifxState(profileId, acc, id) {
        const list = await lifxCall(profileId, acc, 'GET', `/lights/${lifxSel(id)}`);
        const l = Array.isArray(list) ? list[0] : null;
        if (!l) return null;
        const sat = Number(l.color?.saturation) || 0;
        return { on: l.power === 'on', brightness: Math.round((Number(l.brightness) || 0) * 100), lifxColor: sat > 0.01 ? `hue:${Number(l.color.hue) || 0} saturation:${sat}` : `kelvin:${Number(l.color?.kelvin) || 3500} saturation:0` };
    }
    async function lifxSet(profileId, acc, id, s) {
        const body = { duration: Math.max(0, (s.transitionMs || 0) / 1000), fast: true };
        if (s.on === false) body.power = 'off';
        else {
            body.power = 'on';
            if (s.color) body.color = hex(s.color);
            else if (s.kelvin) body.color = `kelvin:${Math.max(1500, Math.min(9000, s.kelvin))} saturation:0`;
            else if (s.lifxColor) body.color = s.lifxColor;
            if (s.brightness != null) body.brightness = Math.max(0, Math.min(100, s.brightness)) / 100;
        }
        await lifxCall(profileId, acc, 'PUT', `/lights/${lifxSel(id)}/state`, body);
    }

    // ── shared ───────────────────────────────────────────────────────────────────────────────
    const getState = (provider, profileId, acc, id) => (provider === 'govee' ? goveeState(profileId, acc, id) : lifxState(profileId, acc, id));
    async function setState(provider, profileId, acc, id, s) {
        if (provider === 'govee') return goveeSet(profileId, acc, id, s);
        return lifxSet(profileId, acc, id, s);
    }
    async function restoreTo(provider, profileId, acc, id, st) {
        if (!st) return;
        if (!st.on) return setState(provider, profileId, acc, id, { on: false });
        return setState(provider, profileId, acc, id, { on: true, color: st.color || null, kelvin: st.kelvin || null, lifxColor: st.lifxColor || null, brightness: st.brightness ?? null });
    }

    function cancelRestore(profileId, id) {
        const k = `${profileId}:${id}`;
        const r = restores.get(k);
        if (r) { clearTimer(r.timer); restores.delete(k); }
    }
    async function temporary(provider, profileId, acc, id, ms, apply) {
        const k = `${profileId}:${id}`;
        const prev = restores.get(k);
        let saved = prev?.state;
        if (!prev) saved = await getState(provider, profileId, acc, id).catch(() => null);
        if (prev) clearTimer(prev.timer);
        await apply();
        const timer = setTimer(() => {
            restores.delete(k);
            restoreTo(provider, profileId, acc, id, saved).catch((e) => log('info', 'put back failed', { provider, code: e.code }));
        }, ms);
        timer?.unref?.();
        restores.set(k, { timer, state: saved });
    }

    async function devicesOf(profileId, provider, acc) {
        if (provider === 'govee') {
            if (!allow(`gvlist:${profileId}`, CLOUD_LIMITS.goveeList, 60_000)) throw new CloudError('rate_limited', 'Govee allows 10 device lists a minute.');
            const data = await call(profileId, 'govee', acc.key, 'GET', `${GOVEE_BASE}/user/devices`);
            return (Array.isArray(data?.data) ? data.data : []).filter((d) => d?.sku && d?.device && /light/i.test(String(d.type || 'light'))).slice(0, 200).map(goveeDevice);
        }
        const list = await lifxCall(profileId, acc, 'GET', '/lights/all');
        return (Array.isArray(list) ? list : []).filter((d) => d?.id).slice(0, 200).map(lifxDevice);
    }

    async function oneDevice(provider, profileId, acc, id, type, p) {
        const ms = Number(p.durationMs) || 0;
        const color = p.color ? hexToRgb(p.color) : null;
        const notes = [];
        switch (type) {
            case 'light.set':
            case 'light.color': {
                const c = type === 'light.color' ? parseColor(p.color) : (color ? { hex: p.color } : null);
                if (!c) throw new CloudError('bad_color', 'That colour was not understood.');
                const s = { on: true, brightness: p.brightness ?? 100, ...(c.hex ? { color: hexToRgb(c.hex) } : { kelvin: c.kelvin }) };
                if (ms > 0) await temporary(provider, profileId, acc, id, ms, () => setState(provider, profileId, acc, id, s));
                else { cancelRestore(profileId, id); await setState(provider, profileId, acc, id, s); }
                break;
            }
            case 'light.white':
            case 'light.brightness': {
                const s = type === 'light.white' ? { on: true, kelvin: p.kelvin, brightness: p.brightness ?? 100 } : { on: true, brightness: p.brightness ?? 50 };
                if (ms > 0) await temporary(provider, profileId, acc, id, ms, () => setState(provider, profileId, acc, id, s));
                else { cancelRestore(profileId, id); await setState(provider, profileId, acc, id, s); }
                break;
            }
            case 'light.power': {
                cancelRestore(profileId, id);
                let on = p.state === 'on';
                if (p.state === 'toggle') {
                    if (provider === 'lifx') { await lifxCall(profileId, acc, 'POST', `/lights/${lifxSel(id)}/toggle`, {}); break; }
                    const st = await goveeState(profileId, acc, id);
                    on = !(st?.on);
                }
                await setState(provider, profileId, acc, id, { on });
                break;
            }
            case 'light.scene': {
                const name = String(p.scene || '').trim().toLowerCase();
                if (provider === 'lifx') {
                    const scenes = await lifxCall(profileId, acc, 'GET', '/scenes');
                    const sc = (Array.isArray(scenes) ? scenes : []).find((x) => String(x?.name || '').toLowerCase() === name);
                    if (!sc) throw new CloudError('scene_not_found', `No LIFX scene called "${p.scene}".`);
                    await lifxCall(profileId, acc, 'PUT', `/scenes/scene_id:${encodeURIComponent(sc.uuid)}/activate`, { duration: 0 });
                    break;
                }
                const sc = (await goveeScenes(profileId, acc, id)).find((x) => x.name.toLowerCase() === name);
                if (!sc) throw new CloudError('scene_not_found', `This Govee light has no scene called "${p.scene}".`);
                const apply = () => goveeControl(profileId, acc, id, { type: 'devices.capabilities.dynamic_scene', instance: 'lightScene', value: sc.value });
                if (ms > 0) await temporary(provider, profileId, acc, id, ms, apply);
                else { cancelRestore(profileId, id); await apply(); }
                break;
            }
            case 'light.flash': {
                const times = Math.max(1, Math.min(20, Number(p.times) || 3));
                const period = Math.max(200, Math.min(5000, Number(p.periodMs) || 600));
                if (provider === 'lifx') {
                    await lifxCall(profileId, acc, 'POST', `/lights/${lifxSel(id)}/effects/${p.mode === 'pulse' ? 'breathe' : 'pulse'}`,
                        { color: `${p.color || '#b4e04f'} brightness:${(p.brightness ?? 100) / 100}`, period: period / 1000, cycles: times, persist: false, power_on: true });
                    break;
                }
                // Govee's cloud takes about a second per change and allows 10 a minute per light: one long flash, then put back.
                if (times > 1 || period < 1000) notes.push('Govee cloud lights flash once (Govee allows 10 changes a minute); use LAN control for more.');
                await temporary(provider, profileId, acc, id, Math.max(1500, period * 2), () => setState(provider, profileId, acc, id, { on: true, color: color || hexToRgb('#b4e04f'), brightness: p.brightness ?? 100 }));
                break;
            }
            default:
                throw new CloudError('not_supported', 'Cloud lights cannot do that.');
        }
        return notes;
    }

    return {
        async check(profileId, provider) {
            const acc = await keyFor(profileId, provider);
            try {
                const devices = await devicesOf(profileId, provider, acc);
                await accounts.mark(profileId, provider, { status: 'ok', lastError: null, devices });
                return { ok: true, devices };
            } catch (err) {
                const status = err.code === 'bad_key' ? 'bad_key' : 'error';
                await accounts.mark(profileId, provider, { status, lastError: err.message }).catch(() => {});
                return { ok: false, error: err.message, code: err.code };
            }
        },
        async devices(profileId) {
            const out = [];
            for (const a of await accounts.list(profileId)) if (a.status !== 'bad_key') out.push(...(a.devices || []));
            return out;
        },
        async scenes(profileId, id) {
            const provider = cloudProviderOf(id);
            if (!provider) return [];
            const acc = await keyFor(profileId, provider);
            if (provider === 'govee') return (await goveeScenes(profileId, acc, id)).map((s) => s.name);
            const scenes = await lifxCall(profileId, acc, 'GET', '/scenes');
            return (Array.isArray(scenes) ? scenes : []).map((s) => String(s?.name || '')).filter(Boolean).slice(0, 100);
        },
        /** `ids` (optional) limits 'all' to these cloud ids. */
        async run(profileId, type, params = {}) {
            const out = { applied: [], skipped: [], notes: [] };
            let targets;
            if (isAllDevices(params.device)) targets = (await this.devices(profileId)).filter((d) => d.online !== false).map((d) => d.id);
            else targets = [params.device];
            if (!targets.length) throw new CloudError('no_lights', 'No cloud lights.');
            const accs = {};
            for (const id of targets) {
                const provider = cloudProviderOf(id);
                try {
                    accs[provider] ||= await keyFor(profileId, provider);
                    out.notes.push(...await oneDevice(provider, profileId, accs[provider], id, type, params));
                    out.applied.push(id);
                } catch (err) {
                    out.skipped.push({ id, reason: err.code || 'failed', message: err.message });
                    if (err.code === 'bad_key') await accounts.mark(profileId, provider, { status: 'bad_key', lastError: err.message }).catch(() => {});
                }
            }
            if (!out.applied.length && out.skipped.length) {
                const first = out.skipped[0];
                throw new CloudError(first.reason, first.message);
            }
            return out;
        },
        _state: { windows, restores, pausedUntil },
        close() { for (const r of restores.values()) clearTimer(r.timer); restores.clear(); },
    };
}

export default { createCloudLights, CloudError, GOVEE_BASE, LIFX_BASE, CLOUD_LIMITS };
