import { REST, Routes } from 'discord.js';
import 'dotenv/config';
const rest = new REST().setToken(process.env.DISCORD_TOKEN);
const cmds = await rest.get(Routes.applicationCommands(process.env.DISCORD_CLIENT_ID));
const types = {1:'CHAT_INPUT',2:'USER',3:'MESSAGE'};
const byType = {};
for (const c of cmds) {
  const t = types[c.type] || c.type;
  byType[t] = (byType[t] || 0) + 1;
}
console.log('MAIN BOT registry totals:');
for (const [k,v] of Object.entries(byType)) console.log('  ' + k + ': ' + v);
const dm = cmds.find(c => c.name === 'Report DM spam');
console.log('Report DM spam registered:', !!dm, dm ? ('type=' + types[dm.type] + ' id=' + dm.id) : '');
process.exit(0);
