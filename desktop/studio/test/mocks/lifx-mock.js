'use strict';
/*
 * Mock LIFX bulbs on one UDP socket on 127.0.0.1: answers a tagged GetService for every bulb (StateService with its MAC
 * as target), and Get / SetColor / SetPower addressed to one bulb's MAC (LightState, Acknowledgement).
 *
 *   const m = await startLifxMock({ bulbs: [{ mac: 'd073d5000001', label, hue, sat, bri, kelvin, power }] })
 *     → { port, bulbs (live state by mac), commands[], close() }
 */
const dgram = require('node:dgram');
const { encode, decode, T } = require('../../src/main/lights/lifx-lan');

async function startLifxMock({ bulbs = [] } = {}) {
    const state = new Map(bulbs.map((b) => [b.mac, { hue: 0, sat: 0, bri: 32768, kelvin: 3500, power: 0, label: 'Bulb', ...b }]));
    const commands = [];
    const s = dgram.createSocket('udp4');
    await new Promise((r, j) => { s.once('error', j); s.bind(0, '127.0.0.1', r); });
    const port = s.address().port;
    const send = (rinfo, req, mac, type, payload) => {
        s.send(encode({ type, target: Buffer.from(mac, 'hex'), source: req.source, sequence: req.sequence, payload }), rinfo.port, rinfo.address);
    };
    s.on('message', (buf, rinfo) => {
        const req = decode(buf);
        if (!req) return;
        const tagged = (buf.readUInt16LE(2) & 0x2000) !== 0;
        const ackRequired = (buf.readUInt8(22) & 2) !== 0;
        if (req.type === T.GetService && tagged) {
            for (const mac of state.keys()) { const p = Buffer.alloc(5); p.writeUInt8(1, 0); p.writeUInt32LE(port, 1); send(rinfo, req, mac, T.StateService, p); }
            return;
        }
        const b = state.get(req.target);
        if (!b) return;
        commands.push({ mac: req.target, type: req.type, payload: Buffer.from(req.payload) });
        if (req.type === T.SetColor) {
            b.hue = req.payload.readUInt16LE(1); b.sat = req.payload.readUInt16LE(3); b.bri = req.payload.readUInt16LE(5); b.kelvin = req.payload.readUInt16LE(7);
            b.lastDuration = req.payload.readUInt32LE(9);
        } else if (req.type === T.SetPower) {
            b.power = req.payload.readUInt16LE(0); b.lastDuration = req.payload.readUInt32LE(2);
        }
        if (req.type === T.Get) {
            const p = Buffer.alloc(52);
            p.writeUInt16LE(b.hue, 0); p.writeUInt16LE(b.sat, 2); p.writeUInt16LE(b.bri, 4); p.writeUInt16LE(b.kelvin, 6); p.writeUInt16LE(b.power, 10);
            Buffer.from(b.label).copy(p, 12, 0, 32);
            send(rinfo, req, req.target, T.State, p);
        } else if (ackRequired) send(rinfo, req, req.target, T.Ack, Buffer.alloc(0));
    });
    return { port, bulbs: state, commands, close: () => new Promise((r) => s.close(r)) };
}

module.exports = { startLifxMock };
