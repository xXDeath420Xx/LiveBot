// Surgically remove the dead "Instagram" platform from self-promo / stream-promo info
// embeds (each guild's is worded differently, so we strip the token rather than
// overwrite with a template). REST-only, edits in place via the authoring bot.
//
//   node scripts/fix-stale-selfpromo.mjs           # dry run (shows before/after)
//   node scripts/fix-stale-selfpromo.mjs --apply

import 'dotenv/config';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';

const APPLY = process.argv.includes('--apply');
const NAME_RE = /about|info|promo|self.?promo|go.?live|live|stream|welcome|start|read|rule|guide|feature|orient|certifried|how.?to/i;

// Remove "Instagram" from a separated list without leaving dangling separators.
// Handles ", Instagram" / " / Instagram" / " • Instagram" / "Instagram, " / standalone.
function stripInstagram(str) {
    if (!str || !/instagram/i.test(str)) return str;
    let s = str;
    s = s.replace(/\s*[,/•|]\s*instagram\b/gi, '');     // separator + Instagram (most common, trailing)
    s = s.replace(/\binstagram\s*[,/•|]\s*/gi, '');      // Instagram + separator (leading)
    s = s.replace(/\band\s+instagram\b/gi, '');          // "...and Instagram"
    s = s.replace(/\binstagram\b/gi, '');                // any leftover standalone
    // Collapse only horizontal whitespace — never newlines (preserve paragraph breaks).
    s = s.replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+([,.])/g, '$1').replace(/[ \t]+\n/g, '\n');
    return s.trim();
}

function transformEmbed(e) {
    const out = JSON.parse(JSON.stringify(e));
    let changed = false;
    const fix = (v) => { const n = stripInstagram(v); if (n !== v) changed = true; return n; };
    if (out.description) out.description = fix(out.description);
    if (out.title) out.title = fix(out.title);
    for (const f of (out.fields || [])) { f.name = fix(f.name); f.value = fix(f.value); }
    if (out.footer?.text) out.footer.text = fix(out.footer.text);
    return changed ? out : null;
}

async function rest(token, method, url, body) {
    for (let i = 0; i < 6; i++) {
        const headers = { Authorization: 'Bot ' + token };
        if (body) headers['Content-Type'] = 'application/json';
        const init = { method, headers };
        if (body) init.body = JSON.stringify(body);
        const r = await fetch(url, init);
        if (r.status === 429) { const b = await r.json().catch(() => ({ retry_after: 1 })); await new Promise(res => setTimeout(res, Math.ceil((b.retry_after || 1) * 1000) + 200)); continue; }
        if (r.status === 404) return { __notfound: true };
        if (r.status === 403) return { __forbidden: true };
        if (!r.ok) return { __error: r.status, body: (await r.text().catch(() => '')).slice(0, 160) };
        return r.status === 204 ? { __ok: true } : r.json();
    }
    return { __error: 'retries' };
}

async function main() {
    const roster = [{ label: 'CertiFried Utility (main)', token: process.env.DISCORD_TOKEN }];
    const [bots] = await pool.execute('SELECT bot_id, bot_name, bot_token FROM custom_bots WHERE enabled = 1');
    for (const b of bots) { try { roster.push({ label: b.bot_name || b.bot_id, token: encryption.decrypt(JSON.parse(b.bot_token)) }); } catch {} }

    const seen = new Set();
    const stats = { fixed: 0, errors: 0 };

    for (const bot of roster) {
        const me = await rest(bot.token, 'GET', 'https://discord.com/api/v10/users/@me');
        if (!me || me.__error || me.__forbidden) continue;
        const botId = me.id;
        const guilds = await rest(bot.token, 'GET', 'https://discord.com/api/v10/users/@me/guilds');
        if (!Array.isArray(guilds)) continue;

        for (const g of guilds) {
            const channels = await rest(bot.token, 'GET', `https://discord.com/api/v10/guilds/${g.id}/channels`);
            if (!Array.isArray(channels)) continue;
            for (const ch of channels.filter(c => c.type === 0 && NAME_RE.test(c.name || ''))) {
                const pins = await rest(bot.token, 'GET', `https://discord.com/api/v10/channels/${ch.id}/pins`);
                const recent = await rest(bot.token, 'GET', `https://discord.com/api/v10/channels/${ch.id}/messages?limit=50`);
                const msgs = [...(Array.isArray(pins) ? pins : []), ...(Array.isArray(recent) ? recent : [])];
                for (const m of msgs) {
                    if (m.author?.id !== botId || seen.has(m.id)) continue;
                    if (!(m.embeds || []).some(e => /instagram/i.test(JSON.stringify(e)))) continue;
                    seen.add(m.id);

                    const newEmbeds = m.embeds.map(e => transformEmbed(e) || e);
                    if (JSON.stringify(newEmbeds) === JSON.stringify(m.embeds)) continue;

                    // Show the specific line(s) that change
                    const before = m.embeds.map(e => [e.description, ...(e.fields || []).map(f => f.value)].filter(s => s && /instagram/i.test(s))).flat();
                    const after = newEmbeds.map(e => [e.description, ...(e.fields || []).map(f => f.value)].filter(Boolean)).flat();
                    console.log(`\n${g.name} / #${ch.name} — ${m.id} via ${bot.label}`);
                    for (const b0 of before) console.log(`  - ${b0.replace(/\n/g, ' ⏎ ').slice(0, 160)}`);

                    if (APPLY) {
                        const res = await rest(bot.token, 'PATCH', `https://discord.com/api/v10/channels/${ch.id}/messages/${m.id}`, { embeds: newEmbeds });
                        if (res && !res.__error && !res.__forbidden) { console.log('  ✓ patched'); stats.fixed++; }
                        else { console.log(`  ! failed: ${res?.__error || 'forbidden'} ${res?.body || ''}`); stats.errors++; }
                    } else { console.log('  · would strip Instagram'); stats.fixed++; }
                }
            }
        }
    }
    console.log(`\n${APPLY ? 'APPLIED' : 'DRY RUN'} — ${APPLY ? 'fixed' : 'would fix'}:${stats.fixed} errors:${stats.errors}`);
    await pool.end();
    process.exit(0);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
