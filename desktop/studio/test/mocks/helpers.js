'use strict';
/*
 * Shared test helpers for the lights tests.
 *
 *   guardNetwork()        patches dgram and net so any packet or connection to an address other than 127.0.0.1, any
 *                         broadcast flag and any multicast membership throws (a safety net: the owner has real lights)
 *   fakeClock({ auto })   { now(), setTimer(fn, ms), clearTimer(h), advance(ms) (runs due timers in order and awaits
 *                         the promises they return), pending() }. auto: timers fire on setImmediate and move now forward
 *                         (for retry loops such as pairing)
 *   fakeConfig(initial)   the config.js surface in memory: get, update (deep merge), getSecret, setSecret, hasSecret
 *   captureLogger()       { logger, lines } with every message and meta as JSON text
 *   freeUdpPort()         a UDP port that was free a moment ago on 127.0.0.1
 *   fakeMdns(services)    a multicast-dns factory that answers PTR queries with the given services
 */
const dgram = require('node:dgram');
const net = require('node:net');
const { EventEmitter } = require('node:events');
const { merge } = require('../../src/main/config');

let guarded = false;
const LOOP = new Set(['127.0.0.1', 'localhost', '::1']);

function guardNetwork() {
    if (guarded) return;
    guarded = true;
    const S = dgram.Socket.prototype;
    const send = S.send;
    S.send = function guardedSend(msg, ...args) {
        // send(msg, [offset, length,] port, [address,] [callback])
        const rest = args.filter((a) => typeof a !== 'function');
        const address = rest.length >= 2 && typeof rest[rest.length - 1] === 'string' ? rest[rest.length - 1] : (rest.length === 4 ? rest[3] : null);
        if (!address || !LOOP.has(address)) throw new Error(`TEST SAFETY: UDP send to ${address} refused`);
        return send.call(this, msg, ...args);
    };
    S.setBroadcast = function () { throw new Error('TEST SAFETY: setBroadcast refused'); };
    S.addMembership = function () { throw new Error('TEST SAFETY: addMembership refused'); };
    const bind = S.bind;
    S.bind = function guardedBind(...args) {
        const opts = args[0];
        const addr = typeof opts === 'object' && opts ? opts.address : typeof args[1] === 'string' ? args[1] : null;
        if (!addr || !LOOP.has(addr)) throw new Error(`TEST SAFETY: UDP bind to ${addr || 'all interfaces'} refused`);
        return bind.apply(this, args);
    };
    const connect = net.Socket.prototype.connect;
    net.Socket.prototype.connect = function guardedConnect(...args) {
        let o = args[0];
        if (Array.isArray(o)) o = o[0];
        let host = null;
        if (o && typeof o === 'object') { if (o.path) return connect.apply(this, args); host = o.host || 'localhost'; }
        else if (typeof args[1] === 'string') host = args[1];
        else host = 'localhost';
        if (!LOOP.has(host)) throw new Error(`TEST SAFETY: TCP connect to ${host} refused`);
        return connect.apply(this, args);
    };
}

function fakeClock({ auto = false, start = 1_000_000 } = {}) {
    let t = start;
    let seq = 0;
    const timers = new Map();
    return {
        now: () => t,
        setTimer(fn, ms) {
            const h = { id: ++seq };
            if (auto) {
                setImmediate(() => { if (timers.has(h.id)) { timers.delete(h.id); t += Math.max(0, ms); fn(); } });
                timers.set(h.id, { at: t + ms, fn });
                return h;
            }
            timers.set(h.id, { at: t + Math.max(0, Number(ms) || 0), fn, seq: h.id });
            return h;
        },
        clearTimer(h) { if (h) timers.delete(h.id); },
        pending: () => timers.size,
        async advance(ms) {
            const end = t + ms;
            for (;;) {
                let next = null;
                for (const [id, x] of timers) if (x.at <= end && (!next || x.at < next[1].at || (x.at === next[1].at && id < next[0]))) next = [id, x];
                if (!next) break;
                timers.delete(next[0]);
                t = Math.max(t, next[1].at);
                await next[1].fn();
                await new Promise((r) => setImmediate(r));
            }
            t = end;
        },
    };
}

function fakeConfig(initial = {}) {
    let settings = JSON.parse(JSON.stringify(initial));
    const secrets = new Map();
    const NAME = /^dev:[a-z0-9-]{1,20}:[A-Za-z0-9._-]{1,80}$/;
    return {
        get: () => JSON.parse(JSON.stringify(settings)),
        update(patch) { settings = merge(settings, patch); return JSON.parse(JSON.stringify(settings)); },
        getSecret: (n) => (secrets.has(n) ? secrets.get(n) : null),
        hasSecret: (n) => secrets.has(n),
        setSecret(n, v) {
            if (!NAME.test(n)) throw new Error('unknown_secret');
            if (v == null || v === '') { secrets.delete(n); return 'deleted'; }
            secrets.set(n, String(v)); return 'memory';
        },
        secrets,
    };
}

function captureLogger() {
    const lines = [];
    const add = (level) => (m, meta) => lines.push(`${level} ${m} ${meta === undefined ? '' : JSON.stringify(meta)}`);
    return { lines, logger: { info: add('info'), warn: add('warn'), error: add('error'), debug: add('debug') } };
}

function freeUdpPort() {
    return new Promise((resolve, reject) => {
        const s = dgram.createSocket('udp4');
        s.once('error', reject);
        s.bind(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    });
}

/** services: [{ type: '_hue._tcp.local', instance, host, address, port, txt: { k: v } }] */
function fakeMdns(services) {
    const queries = [];
    let destroyed = 0;
    const factory = () => {
        const em = new EventEmitter();
        em.query = (q) => {
            queries.push(q);
            const name = q?.questions?.[0]?.name;
            const hits = services.filter((s) => s.type === name);
            setImmediate(() => {
                for (const s of hits) {
                    const inst = `${s.instance}.${s.type}`;
                    em.emit('response', {
                        answers: [{ name: s.type, type: 'PTR', data: inst }],
                        additionals: [
                            { name: inst, type: 'SRV', data: { port: s.port, target: s.host } },
                            { name: inst, type: 'TXT', data: Object.entries(s.txt || {}).map(([k, v]) => Buffer.from(`${k}=${v}`)) },
                            { name: s.host, type: 'A', data: s.address },
                        ],
                    });
                }
            });
        };
        em.destroy = () => { destroyed++; };
        return em;
    };
    factory.queries = queries;
    factory.destroyed = () => destroyed;
    return factory;
}

module.exports = { guardNetwork, fakeClock, fakeConfig, captureLogger, freeUdpPort, fakeMdns };
