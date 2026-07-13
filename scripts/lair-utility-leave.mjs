// Have CertiFried Utility (default bot) leave Mama Bear's Lair.
// A bot can always leave a guild regardless of role hierarchy, unlike kick.
import 'dotenv/config';
const GUILD = '1216126780767731722';
const H = { Authorization: 'Bot ' + process.env.DISCORD_TOKEN };
const r = await fetch(`https://discord.com/api/v10/users/@me/guilds/${GUILD}`, { method: 'DELETE', headers: H });
console.log('HTTP', r.status, r.status === 204 ? 'LEFT' : await r.text());
