/*
 * Restyle every channel in MetalGurl2K's Utopia.
 *
 * Dry run by default; pass --apply to write.
 *
 *   keep   the Tibetan frame ༺ ༻ and the Mathematical Italic lettering
 *   drop   ♱ (EAST SYRIAC CROSS — a religious symbol she did not want)
 *   drop   U+168C2 (BAMUM LETTER PHASE-C MBERAE — a real letter from a rare African
 *          script. Most devices ship no Bamum font, so it shows as a blank box for
 *          plenty of people. She asked for it gone either way.)
 *   add    one emoji per section, so the sidebar carries some colour
 *
 * The SERVER name is deliberately untouched: her instruction was that it is fine as is.
 */
import 'dotenv/config';
import mysql from 'mysql2/promise';
import { resolveBotForGuild } from '../utils/bot-resolver.js';
import { applyStyle, toPlain } from '../utils/channel-name-style.js';

// The acting bot comes from guild_bot_mapping — never pinned here.
const G = '1486475912202424422';
const APPLY = process.argv.includes('--apply');

// Section emoji, keyed by the category's plain name.
const EMOJI = {
  'General': '🪷', 'Community': '🌸', 'Hangout Spot': '✨',
  'Streaming': '🎀', 'Voice Chats': '🎧', 'Admins': '🔒',
};
const CROSS = '♱', BAMUM = '\u{168C2}';

/** Strip her old ornaments, restyle the words, wrap in the frame + section emoji. */
function restyle(rawName, emoji, isVoice) {
  // toPlain converts the styled letters back. The Bamum character IS a letter as far
  // as Unicode is concerned, so an affix-detection pass would keep it — strip the
  // ornaments by name instead of inferring them.
  let core = toPlain(rawName)
    .replaceAll(CROSS, '').replaceAll(BAMUM, '')
    .replaceAll('༺', '').replaceAll('༻', '')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}️]/gu, '')
    .trim();
  const styled = applyStyle(core, { alphabet: 'italic', separator: isVoice ? ' ' : '-' });
  return `༺${emoji}${styled}${emoji}༻`;
}

const db = await mysql.createConnection({
  host: process.env.DB_HOST, user: process.env.DB_USER,
  password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
});

try {
  const bot = await resolveBotForGuild(G, { db });
  const H = { Authorization: bot.auth, 'Content-Type': 'application/json',
              'X-Audit-Log-Reason': 'Channel restyle - remove cross and unassigned char, add section emoji' };

  const chs = await (await fetch(`https://discord.com/api/v10/guilds/${G}/channels`, { headers: H })).json();
  const cats = Object.fromEntries(chs.filter(c => c.type === 4).map(c => [c.id, toPlain(c.name).replace(/[^A-Za-z ]/g, '').trim()]));

  const plan = [];
  for (const c of chs.filter(c => c.type === 4)) {
    const plain = cats[c.id];
    const emoji = EMOJI[plain];
    if (!emoji) { console.log(`  ?? no emoji mapped for category "${plain}" — skipping`); continue; }
    plan.push({ id: c.id, from: c.name, to: restyle(c.name, emoji, false), what: 'category' });
  }
  for (const c of chs.filter(c => c.type !== 4)) {
    const plain = cats[c.parent_id];
    const emoji = EMOJI[plain];
    if (!emoji) { console.log(`  ?? "${toPlain(c.name)}" has no mapped category — skipping`); continue; }
    plan.push({ id: c.id, from: c.name, to: restyle(c.name, emoji, c.type === 2), what: 'channel' });
  }

  const changing = plan.filter(p => p.from !== p.to);
  console.log(`${plan.length} named, ${changing.length} changing\n`);
  for (const p of changing) {
    const over = p.to.length > 100 ? `  ⚠ ${p.to.length} chars, over Discord's 100 limit` : '';
    console.log(`  ${p.from}\n    → ${p.to}${over}`);
  }
  const tooLong = changing.filter(p => p.to.length > 100);
  if (tooLong.length) { console.log(`\n${tooLong.length} name(s) exceed 100 characters — fix before applying.`); }

  if (!APPLY) { console.log('\n(dry run — pass --apply to rename)'); await db.end(); process.exit(0); }
  if (tooLong.length) { console.log('\nRefusing to apply while any name is too long.'); await db.end(); process.exit(1); }

  console.log('\nRENAMING…');
  let ok = 0, fail = 0;
  for (const p of changing) {
    const r = await fetch(`https://discord.com/api/v10/channels/${p.id}`, {
      method: 'PATCH', headers: H, body: JSON.stringify({ name: p.to }),
    });
    if (r.ok) {
      // Discord echoes the stored name. It silently drops characters it dislikes,
      // so compare what came back rather than trusting the 200.
      const echoed = (await r.json()).name;
      if (echoed === p.to) { ok++; console.log('  ✓', echoed); }
      else { ok++; console.log('  ~', echoed, '  (Discord altered it from', JSON.stringify(p.to) + ')'); }
    } else {
      fail++; console.log('  ✗', p.to, r.status, (await r.text()).slice(0, 140));
    }
    // Channel renames are rate-limited hard: 2 per 10 minutes per channel. One each
    // is fine, but pace the batch so the global bucket is not tripped.
    await new Promise(s => setTimeout(s, 1500));
  }
  console.log(`\n${ok} renamed, ${fail} failed`);
} catch (e) {
  console.error('ERR', e.message);
} finally {
  await db.end();
}
process.exit(0);
