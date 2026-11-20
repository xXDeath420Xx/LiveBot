'use strict';
/*
 * A mock Govee light speaking the LAN API on 127.0.0.1: a scan socket and a control socket, answers sent to
 * 127.0.0.1:<listenPort> (where the driver listens, like the real UDP 4002).
 *
 *   const m = await startGoveeMock({ listenPort, mac?, sku?, answerStatus? })
 *     → { scanPort, controlPort, state, commands[], scans, close() }
 * state: { onOff, brightness, color: {r,g,b}, colorTemInKelvin }. answerStatus:false makes devStatus go unanswered
 * (as when LAN control is off).
 */
const dgram = require('node:dgram');

function bindSocket() {
    return new Promise((resolve, reject) => {
        const s = dgram.createSocket('udp4');
        s.once('error', reject);
        s.bind(0, '127.0.0.1', () => resolve(s));
    });
}

async function startGoveeMock({ listenPort, mac = '1F:80:C5:32:32:36:72:4E', sku = 'H6199', answerStatus = true } = {}) {
    const scan = await bindSocket();
    const control = await bindSocket();
    const state = { onOff: 0, brightness: 50, color: { r: 10, g: 20, b: 30 }, colorTemInKelvin: 0 };
    const commands = [];
    let scans = 0;
    const reply = (obj) => { const b = Buffer.from(JSON.stringify({ msg: obj })); scan.send(b, listenPort, '127.0.0.1'); };
    scan.on('message', (buf) => {
        let msg; try { msg = JSON.parse(buf.toString()).msg; } catch { return; }
        if (msg?.cmd !== 'scan' || msg.data?.account_topic !== 'reserve') return;
        scans++;
        reply({ cmd: 'scan', data: { ip: '127.0.0.1', device: mac, sku, bleVersionHard: '3.01.01', bleVersionSoft: '1.03.01', wifiVersionHard: '1.00.10', wifiVersionSoft: '1.02.03' } });
    });
    control.on('message', (buf) => {
        let msg; try { msg = JSON.parse(buf.toString()).msg; } catch { return; }
        if (!msg?.cmd) return;
        commands.push({ cmd: msg.cmd, data: msg.data });
        if (msg.cmd === 'turn') state.onOff = msg.data.value ? 1 : 0;
        else if (msg.cmd === 'brightness') state.brightness = msg.data.value;
        else if (msg.cmd === 'colorwc') {
            state.color = msg.data.color; state.colorTemInKelvin = msg.data.colorTemInKelvin;
            state.onOff = 1;
        } else if (msg.cmd === 'devStatus' && answerStatus) reply({ cmd: 'devStatus', data: { ...state, color: { ...state.color } } });
    });
    return {
        scanPort: scan.address().port,
        controlPort: control.address().port,
        state,
        commands,
        get scans() { return scans; },
        close: () => Promise.all([new Promise((r) => scan.close(r)), new Promise((r) => control.close(r))]),
    };
}

module.exports = { startGoveeMock };
