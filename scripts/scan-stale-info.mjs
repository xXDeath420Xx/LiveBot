// Discovery-only: find every bot-authored message/embed that still mentions "Instagram"
// (our clearest staleness marker — IG go-live is a dead stub and we no longer advertise
// it) across info/promo/about/stream channels in every bot's guilds. REST-only, no edits.
//
//   node scripts/scan-stale-info.mjs

import 'dotenv/config';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';

const NAME_RE = /about|info|promo|self.?promo|go.?live|live|stream|welcome|start|read|rule|guide|feature|orient|certifried|how.?to/i;
const STALE_RE = /instagram/i;

async function rest(token, method, url) {
    for (let i = 0; i < 6; i++) {
        const r = await fetch(url, { method, headers: { Authorization: 'Bot ' + token } });
        if (r.status === 429) { const b = await r.json().catch(() => ({ retry_after: 1 })); await new Promise(res => setTimeout(res, Math.ceil((b.retry_after || 1) * 1000) + 200)); continue; }
        if (r.status === 404) return { __notfound: true };
        if (r.status === 403) return { __forbidden: true };
        if (!r.ok) return { __error: r.status };
        return r.status === 204 ? { __ok: true } : r.json();
    }
    return { __error: 'retries' };
}

const msgText = (m) => {
    let s = m.content || '';
    for (const e of (m.embeds || [])) {
        s += ' ' + (e.title || '') + ' ' + (e.description || '');
        for (const f of (e.fields || [])) s += ' ' + (f.name || '') + ' ' + (f.value || '');
        s += ' ' + (e.footer?.text || '');
    }
    return s;
};
const embedTitle = (m) => (m.embeds || []).map(e => e.title).filter(Boolean).join(' / ') || (m.content ? '(content)' : '(no embed)');

async function main() {
    const roster = [{ label: 'CertiFried Utility (main)', token: process.env.DISCORD_TOKEN }];
    const [bots] = await pool.execute('SELECT bot_id, bot_name, bot_token FROM custom_bots WHERE enabled = 1');
    for (const b of bots) {
        try { roster.push({ label: b.bot_name || b.bot_id, token: encryption.decrypt(JSON.parse(b.bot_token)) }); } catch {}
    }
    console.log(`Scanning ${roster.length} bots for bot-authored messages mentioning "Instagram"…\n`);

    const hits = [];
    const seen = new Set(); // dedupe message ids (multi-bot guilds)

    for (const bot of roster) {
        const me = await rest(bot.token, 'GET', 'https://discord.com/api/v10/users/@me');
        if (!me || me.__error || me.__forbidden) continue;
        const botId = me.id;
        const guilds = await rest(bot.token, 'GET', 'https://discord.com/api/v10/users/@me/guilds');
        if (!Array.isArray(guilds)) continue;

        for (const g of guilds) {
            const channels = await rest(bot.token, 'GET', `https://discord.com/api/v10/guilds/${g.id}/channels`);
            if (!Array.isArray(channels)) continue;
            const cand = channels.filter(c => c.type === 0 && NAME_RE.test(c.name || ''));

            for (const ch of cand) {
                // pinned first (info embeds are usually pinned), then recent 50
                const pins = await rest(bot.token, 'GET', `https://discord.com/api/v10/channels/${ch.id}/pins`);
                const recent = await rest(bot.token, 'GET', `https://discord.com/api/v10/channels/${ch.id}/messages?limit=50`);
                const pool2 = [...(Array.isArray(pins) ? pins : []), ...(Array.isArray(recent) ? recent : [])];
                for (const m of pool2) {
                    if (m.author?.id !== botId) continue;       // only our bot's messages
                    if (seen.has(m.id)) continue;
                    if (!STALE_RE.test(msgText(m))) continue;
                    seen.add(m.id);
                    hits.push({ guild: g.name, channel: ch.name, id: m.id, title: embedTitle(m), bot: bot.label });
                }
            }
        }
    }

    if (!hits.length) { console.log('No bot-authored messages mention "Instagram". Clean. ✓'); }
    else {
        console.log(`Found ${hits.length} stale message(s):\n`);
        for (const h of hits) console.log(`  • ${h.guild} / #${h.channel} — ${h.id}  [${h.title}]  via ${h.bot}`);
    }
    await pool.end();
    process.exit(0);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
