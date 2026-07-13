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
const G = '844406178799943730', U = '791459428049223682', VC = '1393209290873114645';
const [r] = await pool.execute('SELECT bot_token FROM custom_bots WHERE bot_id=?', ['1438897897289552054']);
const BOT = encryption.decrypt(JSON.parse(r[0].bot_token));
const api = (p, b) => fetch(`http://127.0.0.1:${PORT}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-cinema-secret': SECRET }, body: b ? JSON.stringify(b) : undefined }).then(x => x.json()).catch(e => ({ err: e.message }));
const vstate = async () => { try { const x = await fetch(`https://discord.com/api/v10/guilds/${G}/voice-states/${U}`, { headers: { Authorization: `Bot ${BOT}` } }); return x.status === 200 ? 'IN ' + (await x.json()).channel_id : 'NOT in voice (' + x.status + ')'; } catch (e) { return 'err ' + e.message; } };
const sleep = s => new Promise(r => setTimeout(r, s * 1000));
try {
  await api('/stop'); await sleep(1);
  const p = await api('/play', { guildId: G, voiceChannelId: VC, itemId: 'f0f07ef9ecf9d32114e1dc7e2a317f1f', itemName: 'Test', audioIndex: 1, subIndex: null, channelId: VC, startedBy: '365905620060340224' });
  console.log('PLAY:', JSON.stringify(p));
  await sleep(7); console.log('t+7s :', await vstate());
  await sleep(9); console.log('t+16s:', await vstate());
  await api('/stop');
} catch (e) { console.log('SCRIPT ERROR:', e.message); }
process.exit(0);
