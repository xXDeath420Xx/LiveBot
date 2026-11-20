'use strict';
/*
 * mDNS service browsing for the light drivers (Hue, Nanoleaf, Elgato), on multicast-dns.
 *
 *   const mdns = createMdns({ factory?, logger?, setTimer?, clearTimer? })
 *   await mdns.browse('_hue._tcp.local', { timeoutMs }) → [{ instance, host, address, port, txt: { key: value } }]
 *
 * `factory(options)` returns a multicast-dns instance (or a fake with the same surface: on('response'), query(), destroy()).
 * Without one, multicast-dns itself is loaded, only when browse() is called, so nothing is opened at start-up.
 * The socket lives for one browse and is closed at its end. Only IPv4 LAN addresses are returned (no public addresses),
 * at most 50 services per browse.
 */
const { isLanIPv4 } = require('./util');

const MAX_RESULTS = 50;

function txtToObject(data) {
    const out = {};
    const list = Array.isArray(data) ? data : data != null ? [data] : [];
    for (const item of list.slice(0, 40)) {
        const s = Buffer.isBuffer(item) ? item.toString('utf8') : String(item);
        const i = s.indexOf('=');
        if (i <= 0) continue;
        const k = s.slice(0, i).trim().toLowerCase().slice(0, 40);
        if (k && !(k in out)) out[k] = s.slice(i + 1).slice(0, 200);
    }
    return out;
}

function createMdns({ factory = null, logger = null, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    const open = factory || ((opts) => require('multicast-dns')(opts));

    function browse(serviceType, { timeoutMs = 3000 } = {}) {
        const type = String(serviceType || '').toLowerCase();
        if (!/^_[a-z0-9-]{1,30}\._(tcp|udp)\.local$/.test(type)) return Promise.reject(Object.assign(new Error('bad service type'), { code: 'bad_params' }));
        return new Promise((resolve) => {
            let m;
            try { m = open({}); } catch (e) {
                logger?.warn?.('[lights] mDNS is not available', { error: String(e?.code || e?.message || e).slice(0, 80) });
                resolve([]);
                return;
            }
            const instances = new Set();
            const srv = new Map();
            const txt = new Map();
            const hosts = new Map();
            const onRecord = (rec) => {
                if (!rec || typeof rec.name !== 'string') return;
                const name = rec.name.toLowerCase();
                if (rec.type === 'PTR' && name === type && typeof rec.data === 'string' && instances.size < MAX_RESULTS) instances.add(rec.data.toLowerCase());
                else if (rec.type === 'SRV' && rec.data && Number.isInteger(rec.data.port)) srv.set(name, { port: rec.data.port, target: String(rec.data.target || '').toLowerCase() });
                else if (rec.type === 'TXT') txt.set(name, txtToObject(rec.data));
                else if (rec.type === 'A' && isLanIPv4(rec.data) && !hosts.has(name)) hosts.set(name, rec.data);
            };
            const onResponse = (res) => {
                try { for (const rec of [...(res?.answers || []), ...(res?.additionals || [])]) onRecord(rec); } catch { /* malformed packet */ }
            };
            const onError = (e) => logger?.warn?.('[lights] mDNS error', { error: String(e?.code || e?.message || e).slice(0, 80) });
            m.on('response', onResponse);
            m.on('error', onError);
            try { m.query({ questions: [{ name: type, type: 'PTR' }] }); } catch (e) { onError(e); }
            setTimer(() => {
                try { m.removeListener?.('response', onResponse); m.destroy(); } catch { /* already closed */ }
                const out = [];
                for (const inst of instances) {
                    const s = srv.get(inst);
                    if (!s) continue;
                    const address = hosts.get(s.target);
                    if (!address) continue;
                    out.push({ instance: inst.replace(`.${type}`, ''), host: s.target, address, port: s.port, txt: txt.get(inst) || {} });
                }
                resolve(out);
            }, Math.max(100, Math.min(Number(timeoutMs) || 3000, 15000)));
        });
    }

    return { browse };
}

module.exports = { createMdns, txtToObject };
