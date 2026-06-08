// scripts/cinema-grant-vc.mjs
// Grant the Cinema selfbot account access to a voice channel so it can join + Go Live.
// Adds a per-member permission overwrite: View Channel + Connect + Speak + Stream.
// Usage: node scripts/cinema-grant-vc.mjs <voiceChannelId>
import dotenv from 'dotenv';
dotenv.config();

const VC = process.argv[2];
if (!VC) { console.error('usage: node scripts/cinema-grant-vc.mjs <voiceChannelId>'); process.exit(1); }

const BOT = process.env.DISCORD_TOKEN;
const UID = '791459428049223682'; // deathtest_ (Cinema account)
// VIEW_CHANNEL(1<<10) + CONNECT(1<<20) + SPEAK(1<<21) + STREAM(1<<9)
const allow = ((1n << 10n) | (1n << 20n) | (1n << 21n) | (1n << 9n)).toString();

const res = await fetch(`https://discord.com/api/v10/channels/${VC}/permissions/${UID}`, {
  method: 'PUT',
  headers: { Authorization: `Bot ${BOT}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ type: 1, allow, deny: '0' }),
});
if (res.status === 204) console.log(`✅ Cinema account granted View+Connect+Speak+Stream on VC ${VC}`);
else console.error(`❌ ${res.status}: ${(await res.text()).slice(0, 200)}`);
