// Add the "📝 Add My Socials" (selfpromo_join) form button to each guild's dedicated
// streaming opt-in panel so users can register their channels properly — matching the
// config we set for The Pac. Per-guild level gate comes from getJoinConfig. Edits the
// live panel message in place; never posts a new one.
//
//   node scripts/add-streaming-form-buttons.mjs           # dry run
//   node scripts/add-streaming-form-buttons.mjs --apply

import 'dotenv/config';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';
import { getJoinConfig } from '../core/self-promo-join.js';

const APPLY = process.argv.includes('--apply');

// Dedicated streaming opt-in panels (Chibi's Rules-Agreement panel + role=null/open
// presence guilds are intentionally excluded — see the audit notes).
const TARGETS = [
  { guild: '1142257437555032097', ch: '1192580198500147210', msg: '1517290983409062042', name: 'GirlGoGrr' },
  { guild: '1216126780767731722', ch: '1496410188737937561', msg: '1496432752738701372', name: "Mama Bear's Lair" },
  { guild: '1414753158999179286', ch: '1508621207191294105', msg: '1508621217647562752', name: 'WildWolf' },
  { guild: '879457883333464114',  ch: '879562874115194902',  msg: '1473258224923709605', name: 'Spoodercord' },
  { guild: '980331356196311070',  ch: '1482179928718966958', msg: '1482202821607817357', name: 'Stab Crazies' },
];

const NOTE = '\n\n📝 **Add My Socials** — streaming on Kick, Trovo, YouTube, or a Twitch you haven\'t linked to Discord (so auto-detect can\'t catch you)? Click and paste your channel link(s) to join the live rotation.';

async function tokenFor(guild) {
  const [m] = await pool.execute('SELECT bot_id FROM guild_bot_mapping WHERE guild_id = ?', [guild]);
  if (m.length) {
    const [b] = await pool.execute('SELECT bot_token FROM custom_bots WHERE bot_id = ?', [m[0].bot_id]);
    if (b.length) { try { return encryption.decrypt(JSON.parse(b[0].bot_token)); } catch {} }
  }
  return process.env.DISCORD_TOKEN;
}

// Re-emit only the fields Discord accepts on send (strip `id`, proxy fields, etc.)
const cleanButton = (c) => {
  const out = { type: 2, style: c.style };
  if (c.label) out.label = c.label;
  if (c.custom_id) out.custom_id = c.custom_id;
  if (c.url) out.url = c.url;
  if (c.emoji) out.emoji = { name: c.emoji.name, id: c.emoji.id ?? undefined, animated: c.emoji.animated ?? undefined };
  if (c.disabled) out.disabled = true;
  return out;
};

async function main() {
  for (const t of TARGETS) {
    const token = await tokenFor(t.guild);
    const cfg = await getJoinConfig(t.guild).catch(() => null);
    const gate = cfg?.minLevel || 0;
    const label = gate > 0 ? `Add My Socials (Lvl ${gate}+)` : 'Add My Socials';

    const res = await fetch(`https://discord.com/api/v10/channels/${t.ch}/messages/${t.msg}`, { headers: { Authorization: 'Bot ' + token } });
    if (!res.ok) { console.log(`✗ ${t.name}: fetch ${res.status}`); continue; }
    const m = await res.json();

    // Already has the form button?
    const has = (m.components || []).some(r => (r.components || []).some(c => c.custom_id === 'selfpromo_join'));
    if (has) { console.log(`· ${t.name}: already has the form button — skip`); continue; }

    // Rebuild rows, append the form button to a row with room (or a new row).
    const rows = (m.components || []).map(r => ({ type: 1, components: (r.components || []).map(cleanButton) }));
    const formBtn = { type: 2, style: 3, label, custom_id: 'selfpromo_join', emoji: { name: '📝' } };
    let placed = false;
    for (const r of rows) { if (r.components.length < 5) { r.components.push(formBtn); placed = true; break; } }
    if (!placed) { if (rows.length < 5) { rows.push({ type: 1, components: [formBtn] }); placed = true; } }
    if (!placed) { console.log(`✗ ${t.name}: panel is full (5 rows × 5 buttons)`); continue; }

    // Append the note to the embed description (if there is an embed and it isn't there yet).
    const embeds = (m.embeds || []).map(e => ({ ...e }));
    if (embeds[0] && typeof embeds[0].description === 'string' && !embeds[0].description.includes('Add My Socials')) {
      embeds[0] = { ...embeds[0], description: (embeds[0].description + NOTE).slice(0, 4096) };
    }

    console.log(`${APPLY ? '✓' : '·'} ${t.name}: ${APPLY ? 'adding' : 'would add'} "${label}" (gate ${gate}, announces → ${cfg?.channelId})`);
    if (APPLY) {
      const patch = await fetch(`https://discord.com/api/v10/channels/${t.ch}/messages/${t.msg}`, {
        method: 'PATCH', headers: { Authorization: 'Bot ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ embeds, components: rows }),
      });
      if (!patch.ok) console.log(`   ! PATCH failed ${patch.status}: ${(await patch.text()).slice(0, 200)}`);
      await new Promise(r => setTimeout(r, 400));
    }
  }
  await pool.end(); process.exit(0);
}
main().catch(e => { console.error('FATAL', e); process.exit(1); });
