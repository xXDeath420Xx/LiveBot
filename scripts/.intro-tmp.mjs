import 'dotenv/config';
import mysql from 'mysql2/promise';
import { writeFileSync } from 'node:fs';
import { resolveBotForGuild, getMainBotToken } from '../utils/bot-resolver.js';
const ME='365905620060340224';
const db = await mysql.createConnection({host:process.env.DB_HOST,user:process.env.DB_USER,password:process.env.DB_PASSWORD,database:process.env.DB_NAME});
const sleep = ms => new Promise(r=>setTimeout(r,ms));
async function get(auth, p) {
  for (let i=0;i<5;i++) { const r = await fetch('https://discord.com/api/v10'+p,{headers:{Authorization:auth}});
    if (r.status===429) { const j=await r.json(); await sleep((j.retry_after||1)*1000+200); continue; }
    if (!r.ok) return null; return r.json(); }
  return null;
}
const mainTok = await getMainBotToken();
const mainGuilds = (await get('Bot '+mainTok, '/users/@me/guilds?limit=200')) || [];
const [mapped] = await db.query('SELECT guild_id FROM guild_bot_mapping');
const guildIds = [...new Set([...mainGuilds.map(g=>g.id), ...mapped.map(m=>m.guild_id)])];
console.log('guilds to scan:', guildIds.length);
const found = []; let scanned = 0;
for (const gid of guildIds) {
  let bot; try { bot = await resolveBotForGuild(gid, { db }); } catch { continue; }
  const chans = await get(bot.auth, `/guilds/${gid}/channels`); if (!Array.isArray(chans)) continue;
  const g = await get(bot.auth, `/guilds/${gid}`);
  const intro = chans.filter(c => [0,5,15].includes(c.type) && /intro|about-?me|who-?am|meet|𝚒𝚗𝚝𝚛𝚘|ɪɴᴛʀᴏ/i.test(c.name.normalize('NFKC')));
  for (const c of intro) {
    scanned++;
    let before = null, pages = 0;
    while (pages++ < 15) {
      const msgs = await get(bot.auth, `/channels/${c.id}/messages?limit=100${before?'&before='+before:''}`);
      if (!Array.isArray(msgs) || !msgs.length) break;
      for (const m of msgs) if (m.author.id === ME && (m.content || m.embeds?.length)) found.push({ guild: g?.name, gid, channel: c.name, cid: c.id, id: m.id, ts: m.timestamp, content: m.content, embeds: m.embeds?.map(e=>e.description||e.title).filter(Boolean) });
      before = msgs[msgs.length-1].id; if (msgs.length < 100) break;
    }
  }
}
console.log('intro channels scanned:', scanned, 'messages by you:', found.length);
writeFileSync(process.argv[2], JSON.stringify(found, null, 2));
await db.end(); process.exit(0);
