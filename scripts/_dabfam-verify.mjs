import dotenv from 'dotenv';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
dotenv.config();
const root = path.dirname(fileURLToPath(import.meta.url));
const cinemaEnv = dotenv.parse(readFileSync(path.join(root, '..', 'cinema', '.env')));
const SECRET = cinemaEnv.CINEMA_API_SECRET, PORT = cinemaEnv.CINEMA_PORT || 8099;
const encryption = (await import('../utils/encryption.js')).default;
const pool = (await import('../utils/db.js')).default;
const G = '844406178799943730', U = '791459428049223682', VC = '1393209290873114645'; // Movie night
const [r] = await pool.execute('SELECT bot_token FROM custom_bots WHERE bot_id=?', ['1438897897289552054']);
const BOT = encryption.decrypt(JSON.parse(r[0].bot_token));

const api = (p, b) => fetch(`http://127.0.0.1:${PORT}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-cinema-secret': SECRET }, body: b ? JSON.stringify(b) : undefined });
await api('/stop'); await new Promise(r => setTimeout(r, 1000));
const play = await api('/play', { guildId: G, voiceChannelId: VC, itemId: 'f0f07ef9ecf9d32114e1dc7e2a317f1f', itemName: 'Test', audioIndex: 1, subIndex: null, channelId: VC, startedBy: '365905620060340224' });
console.log('play ->', (await play.json()).ok ? 'ok' : 'FAIL', '| Movie night VC');
const check = async (label) => {
  const x = await fetch(`https://discord.com/api/v10/guilds/${G}/voice-states/${U}`, { headers: { Authorization: `Bot ${BOT}` } });
  console.log(x.status === 200 ? `${label}: IN voice ${(await x.json()).channel_id} ✓` : `${label}: NOT in voice (${x.status})`);
};
const sleep = s => new Promise(r => setTimeout(r, s * 1000));
await sleep(6); await check('t+6s');
await sleep(10); await check('t+16s');
await api('/stop');
process.exit(0);
