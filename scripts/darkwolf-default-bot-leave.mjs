// Have CertiFried Utility (default bot 1409904443125665875) leave Wolves of shadows.
// Bots can always self-leave any guild regardless of role hierarchy — DELETE /users/@me/guilds/{id}.
import 'dotenv/config';
const GUILD = '1428091358522114090';
const H = { Authorization: 'Bot ' + process.env.DISCORD_TOKEN };
const r = await fetch(`https://discord.com/api/v10/users/@me/guilds/${GUILD}`, { method: 'DELETE', headers: H });
console.log('HTTP', r.status, r.status === 204 ? 'LEFT' : await r.text());
