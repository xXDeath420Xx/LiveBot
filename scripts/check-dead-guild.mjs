import { REST, Routes } from 'discord.js';
import 'dotenv/config';
const rest = new REST().setToken(process.env.DISCORD_TOKEN);
try {
  const g = await rest.get(Routes.guild('1414753158999179286'));
  console.log('Guild 1414753158999179286 exists:', g.name, 'members approx:', g.approximate_member_count);
} catch (e) {
  console.log('Guild 1414753158999179286:', e.status || '', e.message);
}
try {
  const g = await rest.get(Routes.guildPreview('1414753158999179286'));
  console.log('Preview:', g.name);
} catch (e) {
  console.log('Preview:', e.status || '', e.message);
}
process.exit(0);
