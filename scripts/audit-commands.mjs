import { REST, Routes } from 'discord.js';
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';

const rest = new REST().setToken(process.env.DISCORD_TOKEN);
const live = await rest.get(Routes.applicationCommands(process.env.DISCORD_CLIENT_ID));
const liveNames = new Set(live.map(c => c.name));
const typeOf = {1:'CHAT',2:'USER',3:'MSG'};

// Load local
const commandsDir = path.resolve(process.cwd(), 'commands');
const localCommands = [];
for (const folder of fs.readdirSync(commandsDir)) {
  const folderPath = path.join(commandsDir, folder);
  if (!fs.statSync(folderPath).isDirectory()) continue;
  for (const file of fs.readdirSync(folderPath).filter(f => f.endsWith('.js'))) {
    try {
      const mod = await import('file://' + path.join(folderPath, file));
      const data = mod.data || mod.default?.data;
      if (!data) continue;
      const json = data.toJSON ? data.toJSON() : data;
      localCommands.push({ name: json.name, type: json.type || 1, folder, file });
    } catch (e) { console.error('load fail', folder, file, e.message); }
  }
}

console.log('LIVE (Discord registry):');
console.log('  CHAT_INPUT:', live.filter(c => (c.type||1)===1).length);
console.log('  USER:', live.filter(c => c.type===2).length);
console.log('  MESSAGE:', live.filter(c => c.type===3).length);
console.log('LOCAL (filesystem):');
const byType = {};
for (const c of localCommands) byType[typeOf[c.type]] = (byType[typeOf[c.type]]||0)+1;
console.log(' ', byType);
console.log();

console.log('LOCAL CHAT commands NOT in live registry (would be new on next PUT):');
const chatLocal = localCommands.filter(c => c.type===1);
for (const c of chatLocal) if (!liveNames.has(c.name)) console.log('  +', c.name.padEnd(28), c.folder+'/'+c.file);

console.log();
console.log('LIVE CHAT commands NOT in local (would be deleted on next PUT):');
const localNames = new Set(chatLocal.map(c => c.name));
for (const c of live) if ((c.type||1)===1 && !localNames.has(c.name)) console.log('  -', c.name);

console.log();
console.log('ALL LOCAL CHAT commands by folder:');
const byFolder = {};
for (const c of chatLocal) {
  byFolder[c.folder] = byFolder[c.folder] || [];
  byFolder[c.folder].push(c.name);
}
for (const [f, names] of Object.entries(byFolder).sort()) {
  console.log('  [' + f + '] (' + names.length + ')');
  for (const n of names.sort()) console.log('    ' + n);
}
process.exit(0);
