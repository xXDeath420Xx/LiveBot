// Free games — with dedup (the Prime Gaming scraper returns card-per-button, creating
// ~27× duplicates per title on the site's carousel). Dedup by lowercased title.
import 'dotenv/config';
import FreeGamesManager from '/home/death/CertiFriedUtility/core/free-games-manager.js';
import mysql from 'mysql2/promise';

const CHANNEL = '1369779062859497532';
const H = { Authorization: 'Bot ' + process.env.DISCORD_TOKEN, 'Content-Type': 'application/json' };
const pool = mysql.createPool({ host: process.env.DB_HOST, user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME });
const mgr = new FreeGamesManager({ pool });

const byPlatform = {};
for (const [name, scraper] of Object.entries(mgr.scrapers || {})) {
    let games;
    try { games = await scraper.getCachedOrFetch() || []; } catch { games = []; }
    // Dedup by lowercased title (keep first occurrence — preserves useful url/platforms)
    const seen = new Map();
    for (const g of games) {
        const key = (g.title || '').toLowerCase().trim();
        if (!key) continue;
        if (!seen.has(key)) seen.set(key, g);
    }
    byPlatform[name] = Array.from(seen.values());
}

const total = Object.values(byPlatform).reduce((a, b) => a + b.length, 0);
console.log('unique total:', total, '— per store:', Object.fromEntries(Object.entries(byPlatform).map(([k, v]) => [k, v.length])));

const ICONS = { epic: '🎮', steam: '🎲', gog: '🕹️', prime: '👑' };
const COLORS = { epic: 0x2F2D2E, steam: 0x1B2838, gog: 0x6A0EAA, prime: 0x00A8E1 };
const NAMES = { epic: 'Epic Games', steam: 'Steam', gog: 'GOG', prime: 'Prime Gaming' };

async function post(body) {
    const r = await fetch(`https://discord.com/api/v10/channels/${CHANNEL}/messages`, { method: 'POST', headers: H, body: JSON.stringify(body) });
    if (!r.ok) console.log('  POST ' + r.status + ': ' + (await r.text()).slice(0, 200));
    return r;
}

await post({ embeds: [{
    color: 0x00FF00, title: '🎁 Free Games Available Right Now',
    description: `**${total} unique** free games across ${Object.values(byPlatform).filter(g => g.length).length} stores — grab 'em while they last!`,
}] });

for (const [platform, games] of Object.entries(byPlatform)) {
    if (!games.length) continue;
    const lines = games.map(g => `• [${(g.title || '(untitled)').slice(0, 90)}](${g.url || 'https://example.com'})`);
    let buf = '';
    for (const line of lines) {
        if ((buf + '\n' + line).length > 3800) {
            await post({ embeds: [{ color: COLORS[platform], title: `${ICONS[platform]} ${NAMES[platform]}`, description: buf }] });
            buf = line;
        } else {
            buf = buf ? buf + '\n' + line : line;
        }
    }
    if (buf) await post({ embeds: [{ color: COLORS[platform], title: `${ICONS[platform]} ${NAMES[platform]}`, description: buf, footer: { text: `${games.length} unique games` } }] });
    console.log('  ' + platform + ' posted');
}

await pool.end();
console.log('DONE');
