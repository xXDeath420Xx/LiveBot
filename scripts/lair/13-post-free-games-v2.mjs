// Minimal free-games post — one compact embed per store, short lines, no 6000-char trap.
import 'dotenv/config';
import FreeGamesManager from '/home/death/CertiFriedUtility/core/free-games-manager.js';
import mysql from 'mysql2/promise';

const CHANNEL = '1369779062859497532';
const H = { Authorization: 'Bot ' + process.env.DISCORD_TOKEN, 'Content-Type': 'application/json' };
const pool = mysql.createPool({ host: process.env.DB_HOST, user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME });

const mgr = new FreeGamesManager({ pool });
const byPlatform = {};
for (const [name, scraper] of Object.entries(mgr.scrapers || {})) {
    try { byPlatform[name] = await scraper.getCachedOrFetch() || []; } catch { byPlatform[name] = []; }
}
const total = Object.values(byPlatform).reduce((a, b) => a + b.length, 0);
console.log('total:', total);

const ICONS = { epic: '🎮', steam: '🎲', gog: '🕹️', prime: '👑' };
const COLORS = { epic: 0x2F2D2E, steam: 0x1B2838, gog: 0x6A0EAA, prime: 0x00A8E1 };
const NAMES = { epic: 'Epic Games', steam: 'Steam', gog: 'GOG', prime: 'Prime Gaming' };

// Header
await fetch(`https://discord.com/api/v10/channels/${CHANNEL}/messages`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ embeds: [{ color: 0x00FF00, title: '🎁 Free Games Available Right Now', description: `**${total} free games** across ${Object.values(byPlatform).filter(g => g.length).length} stores — grab 'em while they last!` }] }),
});

// Per-store embeds, split if description > ~3500 chars to leave headroom
for (const [platform, games] of Object.entries(byPlatform)) {
    if (!games.length) continue;
    const lines = games.map(g => {
        const title = (g.title || '(untitled)').slice(0, 80);
        const url = g.url || '';
        return `• [${title}](${url})`;
    });
    const chunks = [];
    let buf = '';
    for (const line of lines) {
        if ((buf + '\n' + line).length > 3500) { chunks.push(buf); buf = line; }
        else buf = buf ? buf + '\n' + line : line;
    }
    if (buf) chunks.push(buf);
    for (let i = 0; i < chunks.length; i++) {
        const r = await fetch(`https://discord.com/api/v10/channels/${CHANNEL}/messages`, {
            method: 'POST', headers: H,
            body: JSON.stringify({ embeds: [{
                color: COLORS[platform] || 0x00FF00,
                title: `${ICONS[platform] || '🎁'} ${NAMES[platform] || platform}${chunks.length > 1 ? ` (${i + 1}/${chunks.length})` : ''}`,
                description: chunks[i],
                footer: { text: `${games.length} games` },
            }] }),
        });
        if (!r.ok) console.log(`  ${platform} chunk ${i+1} failed:`, r.status, await r.text());
        else console.log(`  ${platform} chunk ${i+1}/${chunks.length} posted`);
    }
}

await pool.end();
