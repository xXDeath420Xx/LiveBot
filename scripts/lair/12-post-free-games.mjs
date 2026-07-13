// Scrape all configured platforms for currently-free games and post a consolidated
// list to #🎁┃free-games in Mama Bear's Lair. Uses the existing FreeGamesManager.
import 'dotenv/config';
import FreeGamesManager from '/home/death/CertiFriedUtility/core/free-games-manager.js';
import mysql from 'mysql2/promise';

const GUILD = '1216126780767731722';
const CHANNEL = '1369779062859497532';
const token = process.env.DISCORD_TOKEN;
const H = { Authorization: 'Bot ' + token, 'Content-Type': 'application/json' };

// Fake minimal "client" stub — FreeGamesManager's fetchAllCurrent only needs the pool.
// Inspect by reading the class shape.
const pool = mysql.createPool({ host: process.env.DB_HOST, user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME });
const mgr = new FreeGamesManager({ pool });

// Scrape fresh
console.log('scraping all platforms…');
const fetchAll = mgr.scrapers ? Object.entries(mgr.scrapers) : [];
const byPlatform = {};
for (const [name, scraper] of fetchAll) {
    try {
        const games = await scraper.getCachedOrFetch();
        byPlatform[name] = games || [];
        console.log(`  ${name}: ${byPlatform[name].length}`);
    } catch (e) {
        console.log(`  ${name}: ERR ${e.message}`);
        byPlatform[name] = [];
    }
}

const total = Object.values(byPlatform).reduce((a, b) => a + b.length, 0);
console.log(`total: ${total} free games`);
if (!total) { console.log('nothing free right now'); await pool.end(); process.exit(0); }

// Flatten + dedupe by title+store
const flat = [];
const seen = new Set();
for (const [platform, games] of Object.entries(byPlatform)) {
    for (const g of games) {
        const key = (g.title || '').toLowerCase() + '|' + platform;
        if (seen.has(key)) continue;
        seen.add(key);
        flat.push({ platform, ...g });
    }
}

// Group embeds by store, max 25 entries per embed, 4 embeds per message, multiple messages if needed
const ICONS = { epic: '🎮', steam: '🎲', gog: '🕹️', prime: '👑' };
const STORE_COLORS = { epic: 0x2F2D2E, steam: 0x1B2838, gog: 0x6A0EAA, prime: 0x00A8E1 };
const STORE_NAMES = { epic: 'Epic Games', steam: 'Steam', gog: 'GOG', prime: 'Prime Gaming' };

function formatGame(g) {
    const pieces = [];
    pieces.push(`[${g.title || '(untitled)'}](${g.url || '#'})`);
    const platforms = [];
    if (g.platform_windows || g.platforms?.includes?.('windows')) platforms.push('🪟');
    if (g.platform_mac || g.platforms?.includes?.('mac')) platforms.push('🍎');
    if (g.platform_linux || g.platforms?.includes?.('linux')) platforms.push('🐧');
    if (platforms.length) pieces.push(platforms.join(''));
    if (g.until_date || g.endDate) {
        const ts = Math.floor(new Date(g.until_date || g.endDate).getTime() / 1000);
        pieces.push(`until <t:${ts}:R>`);
    }
    return pieces.join(' • ');
}

const embeds = [];
for (const [platform, games] of Object.entries(byPlatform)) {
    if (!games.length) continue;
    const lines = games.map(formatGame);
    // Chunk into descriptions under 4096 chars
    let chunk = '';
    const chunks = [];
    for (const l of lines) {
        if ((chunk + '\n' + l).length > 3800) { chunks.push(chunk); chunk = l; }
        else chunk = chunk ? chunk + '\n' + l : l;
    }
    if (chunk) chunks.push(chunk);
    for (let i = 0; i < chunks.length; i++) {
        embeds.push({
            color: STORE_COLORS[platform] || 0x00FF00,
            title: `${ICONS[platform] || '🎁'} ${STORE_NAMES[platform] || platform} — Free Now${chunks.length > 1 ? ` (${i + 1}/${chunks.length})` : ''}`,
            description: chunks[i],
        });
    }
}

// Send in batches of 10 embeds per message
for (let i = 0; i < embeds.length; i += 10) {
    const batch = embeds.slice(i, i + 10);
    const content = i === 0 ? `🎁 **${total} free games currently available** — grab 'em while they last!` : undefined;
    const r = await fetch(`https://discord.com/api/v10/channels/${CHANNEL}/messages`, {
        method: 'POST', headers: H, body: JSON.stringify({ content, embeds: batch }),
    });
    if (!r.ok) { console.log('POST failed:', r.status, await r.text()); break; }
    const m = await r.json();
    console.log(`posted message ${m.id} (${batch.length} embeds)`);
}

await pool.end();
