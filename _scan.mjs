import 'dotenv/config';
import pool from './utils/db.js';
import mysql from 'mysql2/promise';
import encryption from './utils/encryption.js';
import { templateOf, triggerOf, hash16 } from './core/guild-analyzer.js';
const G='814321716872347648', BOT='1522493725526327386';
const db=await mysql.createConnection({host:process.env.DB_HOST,user:process.env.DB_USER,password:process.env.DB_PASSWORD,database:process.env.DB_NAME});
const [[r]]=await db.execute('SELECT bot_token FROM custom_bots WHERE bot_id=?',[BOT]);
const token=encryption.decrypt(JSON.parse(r.bot_token)); await db.end();
const H={Authorization:`Bot ${token}`};
let reqs=0;
const get=async(p)=>{for(;;){const res=await fetch(`https://discord.com/api/v10${p}`,{headers:H});reqs++;
  if(res.status===429){const j=await res.json().catch(()=>({retry_after:1}));await new Promise(s=>setTimeout(s,((j.retry_after||1)*1000)+250));continue;}
  if(res.status===403||res.status===404) return null;
  if(!res.ok){await new Promise(s=>setTimeout(s,600));continue;} return res.json();}};
const shim=(m)=>({content:m.content,embeds:m.embeds||[],
  components:(m.components||[]).map(row=>({components:(row.components||[]).map(c=>({label:c.label,customId:c.custom_id,placeholder:c.placeholder}))})),
  attachments:{size:(m.attachments||[]).length},
  interaction:m.interaction?{commandName:m.interaction.name}:null,
  author:m.author,webhookId:m.webhook_id||null,createdTimestamp:Date.parse(m.timestamp)});
const chans=await get(`/guilds/${G}/channels`);
const text=chans.filter(c=>[0,5].includes(c.type));
const [ins]=await pool.execute("INSERT INTO guild_scans (guild_id,status,depth,channels_total) VALUES (?,'running','deep',?)",[G,text.length]);
const scanId=ins.insertId;
console.log(`scan ${scanId}: ${text.length} channels`);
const bots=new Map(), tpls=new Map(); let total=0; const LOOK=6,WIN=30000;
for (const ch of text) {
  let before=null,n=0,carry=[];
  for(;;){
    const page=await get(`/channels/${ch.id}/messages?limit=100${before?`&before=${before}`:''}`);
    if(!page){console.log(`  #${ch.name}: UNREADABLE`);break;}
    if(!page.length) break;
    const msgs=page.map(shim); const win=[...carry,...msgs];
    for(let i=0;i<msgs.length;i++){const m=msgs[i];
      if(!m.author?.bot && !m.webhookId) continue;
      const isWH=!!m.webhookId&&!m.interaction; const id=isWH?`wh:${m.author.username}`:m.author.id;
      const a=bots.get(id)??{id,name:m.author.username,kind:isWH?'webhook':'bot',messages:0,first:m.createdTimestamp,last:m.createdTimestamp,channels:new Set()};
      a.messages++;a.first=Math.min(a.first,m.createdTimestamp);a.last=Math.max(a.last,m.createdTimestamp);a.channels.add(ch.id);bots.set(id,a);
      const shape=templateOf(m); if(!shape) continue;
      const key=`${id}:${hash16(shape)}`;
      const t=tpls.get(key)??{botId:id,hash:hash16(shape),sample:shape,count:0,triggers:new Set(),chans:new Set()};
      t.count++;t.chans.add(ch.id);
      if(m.interaction?.commandName) t.triggers.add('/'+m.interaction.commandName);
      else {const s=carry.length+i+1;
        for(let j=s;j<Math.min(s+LOOK,win.length);j++){const c=win[j];
          if(!c||c.author?.bot||c.webhookId) continue;
          if(m.createdTimestamp-c.createdTimestamp>WIN) break;
          const tr=triggerOf(c.content); if(tr) t.triggers.add(tr); break;}}
      tpls.set(key,t);}
    n+=msgs.length;total+=msgs.length;before=page[page.length-1].id;carry=msgs.slice(-LOOK);
    if(page.length<100) break;
  }
  console.log(`  #${ch.name}: ${n}`);
  await pool.execute('INSERT INTO guild_scan_channels (scan_id,channel_id,channel_name,messages_scanned,complete) VALUES (?,?,?,?,1)',[scanId,ch.id,ch.name.slice(0,120),n]);
}
for(const b of bots.values()){
  const present=b.kind==='bot' ? (await get(`/guilds/${G}/members/${b.id}`)?1:0) : 0;
  await pool.execute(`INSERT INTO guild_scan_bots (scan_id,bot_id,name,kind,present,messages,first_seen,last_seen,channels)
    VALUES (?,?,?,?,?,?,FROM_UNIXTIME(?),FROM_UNIXTIME(?),?)`,
    [scanId,b.id,b.name.slice(0,120),b.kind,present,b.messages,Math.floor(b.first/1000),Math.floor(b.last/1000),JSON.stringify([...b.channels])]);
}
for(const t of tpls.values()){
  await pool.execute(`INSERT INTO guild_scan_templates (scan_id,bot_id,template_hash,sample,occurrences,triggers,channels)
    VALUES (?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE occurrences=occurrences+VALUES(occurrences)`,
    [scanId,t.botId,t.hash,t.sample,t.count,JSON.stringify([...t.triggers]),JSON.stringify([...t.chans])]);
}
await pool.execute("UPDATE guild_scans SET status='complete',finished_at=NOW(),channels_done=?,messages_scanned=? WHERE id=?",[text.length,total,scanId]);
console.log(`\nDONE scan ${scanId}: ${total} msgs, ${bots.size} bots/webhooks, ${tpls.size} templates, ${reqs} REST calls`);
process.exit(0);
