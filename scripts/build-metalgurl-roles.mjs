/*
 * MetalGurl2K role build.
 *
 * Dry run by default. Pass --apply to write.
 *
 * Two things this handles that a plain "create some roles" script does not:
 *
 * 1. Colour roles have to sit ABOVE everything else coloured that a member might
 *    hold, because Discord paints a name with the member's HIGHEST coloured role.
 *    `Member` (#810707, held by everyone) currently sits above all eight colour
 *    roles, so the colour picker is decorative — everyone renders dark maroon
 *    whatever they choose. Staff colours stay above the picker deliberately:
 *    staff should read as staff.
 *
 * 2. Tag roles — fandoms and ping preferences — are created with NO colour. A
 *    coloured fandom role would compete with the picker, and a member holding
 *    three of them would get whichever happened to sit highest, which looks
 *    random to the person it happens to.
 */
import 'dotenv/config';
import mysql from 'mysql2/promise';
import { resolveBotForGuild } from '../utils/bot-resolver.js';

// The acting bot comes from guild_bot_mapping — never pinned here.
const G = '1486475912202424422';
const APPLY = process.argv.includes('--apply');

const STAFF_TOP = ['Owner', 'Co-Owner', 'Head Admin'];          // must outrank Admin
const STAFF_LOW = ['Head Mod', 'Mod'];                           // below Admin

const NEW_COLOURS = [
  ['Lavender', 0xC7A5E8], ['Mint', 0x93DCB8], ['Peach', 0xFFC4A0], ['Sky', 0x8CC6F2],
  ['Coral', 0xFA8E7C], ['Cherry Blossom', 0xF7C5DA], ['Sage', 0xA8C89A], ['Butter', 0xF5E1A4],
  // She asked for red on 2026-09-12. ED4245 is one of the few that clears 3:1 against
  // BOTH Discord grounds (3.29 on #313338, 3.84 on white). Crimson, firebrick and rose
  // red all fail on dark exactly the way her existing Green/Blue/Purple/Pink do.
  ['Red', 0xED4245],
];
const EXISTING_COLOURS = ['Green', 'Blue', 'Purple', 'Pink', 'Yellow', 'Teal', 'White', 'Hot Pink'];

const COMMUNITY = [
  ['VIP', 0xE8C46A], ['Streamer', 0x9146FF], ['Fans', 0xF9B8D0],
  ['Gamer', 0x57F287], ['Birthday', 0xFF9BD2], ['Newcomer', 0xB9C4D4],
];
// No colour: these are tags, not identities. Colour comes from the picker.
// 'Other' is deliberately last and deliberately there: a fixed list of eleven fandoms
// tells anyone whose thing is missing that they are not really catered for. Her words:
// "I need to be more open-minded since it is a community, after all."
const FANDOM = ['Kirby', 'Kuromi', 'Lord of the Rings', 'Harry Potter', 'Kingdom Hearts',
                'MMORPG', 'Fortnite', 'Minecraft', 'World of Warcraft', 'Metal & Rock',
                'Anime', 'Other'];
const PING = ['Going Live', 'Giveaways', 'Game Nights'];

const db = await mysql.createConnection({
  host: process.env.DB_HOST, user: process.env.DB_USER,
  password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
});

try {
  const bot = await resolveBotForGuild(G, { db });
  const B = bot.botId;
  const T = bot.token;
  const H = { Authorization: 'Bot ' + T, 'Content-Type': 'application/json',
              'X-Audit-Log-Reason': 'MetalGurl2K role build' };
  const api = (p, o = {}) => fetch('https://discord.com/api/v10' + p, { headers: H, ...o });

  let roles = await (await api(`/guilds/${G}/roles`)).json();
  const me = await (await api(`/guilds/${G}/members/${B}`)).json();
  const botTop = Math.max(...roles.filter(r => me.roles.includes(r.id)).map(r => r.position));
  const adminPos = roles.find(r => r.name === 'Admin')?.position ?? 0;
  const canDoTopStaff = botTop > adminPos;

  console.log(`MetalBot highest position ${botTop} · Admin at ${adminPos}`);
  console.log(canDoTopStaff
    ? '=> MetalBot outranks Admin: Owner / Co-Owner / Head Admin CAN be created\n'
    : '=> MetalBot is BELOW Admin: Owner / Co-Owner / Head Admin are skipped this run.\n   Drag MetalBot above Admin and re-run to add them.\n');

  const byName = new Map(roles.map(r => [r.name.toLowerCase(), r]));
  const plan = [];
  const want = (name, colour, hoist, group) => {
    if (byName.has(name.toLowerCase())) return;
    plan.push({ name, colour, hoist, group });
  };

  if (canDoTopStaff) STAFF_TOP.forEach((n, i) => want(n, [0xE91E63, 0xD81B60, 0xC2185B][i], true, 'Staff'));
  STAFF_LOW.forEach((n, i) => want(n, [0x5865F2, 0x7289DA][i], true, 'Staff'));
  NEW_COLOURS.forEach(([n, c]) => want(n, c, false, 'Colour'));
  COMMUNITY.forEach(([n, c]) => want(n, c, false, 'Community'));
  FANDOM.forEach(n => want(n, 0, false, 'Fandom (no colour)'));
  PING.forEach(n => want(n, 0, false, 'Ping (no colour)'));

  console.log(`CREATE: ${plan.length} roles`);
  let g = '';
  for (const p of plan) {
    if (p.group !== g) { console.log('\n  ── ' + p.group); g = p.group; }
    console.log('    ' + p.name.padEnd(20), p.colour ? '#' + p.colour.toString(16).padStart(6, '0').toUpperCase() : 'no colour');
  }

  // Show the hierarchy this would produce, so the ordering can be checked before
  // anything is written. The colour block is the part that matters: every role
  // under it must be colourless or willing to lose to a member's pick.
  const previewOrder = [
    ...(canDoTopStaff ? STAFF_TOP : []), 'Admin', ...STAFF_LOW,
    ...NEW_COLOURS.map(c => c[0]), ...EXISTING_COLOURS,
    ...COMMUNITY.map(c => c[0]),
    'Twitch Subscriber', 'Twitch Subscriber: Tier 1', 'Twitch Subscriber: Tier 2', 'Twitch Subscriber: Tier 3',
    ...FANDOM, ...PING, 'Member',
  ];
  const planned = new Set(plan.map(p => p.name));
  const pickers = new Set([...EXISTING_COLOURS, ...NEW_COLOURS.map(c => c[0])]);
  console.log('\nRESULTING ORDER (highest first):');
  let inColour = false;
  for (const n of previewOrder) {
    const existing = byName.get(n.toLowerCase());
    if (pickers.has(n) && !inColour) { console.log('  ┌─ colour picker — everything below loses to a member\'s pick'); inColour = true; }
    if (!pickers.has(n) && inColour) { console.log('  └─'); inColour = false; }
    const tag = planned.has(n) ? 'new' : existing ? 'moved' : 'MISSING';
    const col = existing && existing.color
      ? '#' + existing.color.toString(16).padStart(6, '0').toUpperCase()
      : planned.has(n) ? '' : 'no colour';
    console.log(`  ${pickers.has(n) ? '│ ' : '  '}${n.padEnd(26)} ${String(col).padEnd(10)} ${tag}`);
  }
  if (inColour) console.log('  └─');

  const stillBeats = [...byName.values()].filter(r =>
    r.color && r.name !== '@everyone' && !pickers.has(r.name) &&
    !previewOrder.includes(r.name) && r.position < botTop);
  if (stillBeats.length) console.log('\n  NOT reordered, check these:', stillBeats.map(r => r.name).join(', '));

  if (!APPLY) { console.log('\n(dry run — pass --apply)'); await db.end(); process.exit(0); }

  console.log('\nCREATING…');
  for (const p of plan) {
    const body = { name: p.name, color: p.colour, hoist: p.hoist, mentionable: false, permissions: '0' };
    const r = await api(`/guilds/${G}/roles`, { method: 'POST', body: JSON.stringify(body) });
    console.log(r.ok ? '  ✓ ' + p.name : '  ✗ ' + p.name + ' ' + r.status + ' ' + (await r.text()).slice(0, 140));
    await new Promise(s => setTimeout(s, 700));
  }

  // ---- order ----
  roles = await (await api(`/guilds/${G}/roles`)).json();
  const find = n => roles.find(r => r.name.toLowerCase() === n.toLowerCase());
  const order = [                       // highest first
    ...(canDoTopStaff ? STAFF_TOP : []), 'Admin', ...STAFF_LOW,
    ...NEW_COLOURS.map(c => c[0]), ...EXISTING_COLOURS,   // the whole picker, above all of the below
    ...COMMUNITY.map(c => c[0]),
    'Twitch Subscriber', 'Twitch Subscriber: Tier 1', 'Twitch Subscriber: Tier 2', 'Twitch Subscriber: Tier 3',
    ...FANDOM, ...PING, 'Member',
  ].map(find).filter(r => r && r.position < botTop);

  let pos = botTop - 1;
  const payload = order.map(r => ({ id: r.id, position: pos-- }));
  const rr = await api(`/guilds/${G}/roles`, { method: 'PATCH', body: JSON.stringify(payload) });
  console.log('\nreorder:', rr.status, rr.ok ? 'OK' : (await rr.text()).slice(0, 200));

  const after = await (await api(`/guilds/${G}/roles`)).json();
  const coloured = after.filter(r => r.color && r.name !== '@everyone').sort((a, b) => b.position - a.position);
  const lowestPicker = Math.min(...after.filter(r => [...EXISTING_COLOURS, ...NEW_COLOURS.map(c => c[0])].includes(r.name)).map(r => r.position));
  const beats = coloured.filter(r => r.position > Math.max(...after.filter(x => [...EXISTING_COLOURS, ...NEW_COLOURS.map(c => c[0])].includes(x.name)).map(x => x.position)));
  console.log(`\nColour picker now spans positions ${lowestPicker}+`);
  console.log('Still outranks the picker (staff only is correct):', beats.map(r => r.name).join(', ') || 'nothing');
} catch (e) {
  console.error('ERR', e.message);
} finally {
  await db.end();
}
process.exit(0);
