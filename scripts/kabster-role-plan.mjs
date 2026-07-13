/*
 * Kabster's Shit Cunts — role cleanup & repurposing.
 *
 *   node scripts/kabster-role-plan.mjs            # dry run: prints the plan, changes nothing
 *   node scripts/kabster-role-plan.mjs --apply    # performs the renames
 *
 * The server has 106 roles and a mess: every time Carl-bot's self-assign panels were rebuilt it
 * minted a fresh set of roles and abandoned the old one. "He/Him" exists SIX times; the region set
 * exists twice. Only the lowest set of each has any members.
 *
 * We do NOT delete these. Deleting throws the role away; RENAMING keeps the id, keeps its position
 * in the hierarchy, touches no permissions, and turns a corpse into something useful. Every role
 * below is renameable precisely because it has ZERO members — nobody can lose anything.
 *
 * Three groups are deliberately NOT touched, because they are not dead, they are waiting:
 *   BIRTHDAY!!!                — wire to our birthday system (grants on the day, strips after)
 *   Ko-fi Supporter <3 (x2)    — map to Ko-fi tiers once Karabi supplies the webhook token
 *   Africa, the colours, the timezone set — real roles with no panel; they get panels instead
 *
 * REST-only. Safe to run while PM2 is live.
 */
import 'dotenv/config';
import mysql from 'mysql2/promise';
import encryption from '../utils/encryption.js';

const GUILD = '814321716872347648';
const KABBOT = '1522493725526327386';
const APPLY = process.argv.includes('--apply');

/**
 * The 28 spare roles, and what each becomes.
 *
 * Allocation is driven by what the server ALREADY has half of, rather than by invention:
 *   • regions   — Europe/NA/SA/Asia/Oceania exist, Africa is orphaned, Middle East is missing
 *   • timezones — GMT/UTC/EST/PST/AEST exist; the US, EU, AU and NZ middles are missing
 *   • colours   — 7 exist with no panel at all; 8 more rounds it out
 *   • pings     — opt-in notification roles for channels we actually run
 * The last 7 are left blank ON PURPOSE: those should be game/interest roles, and Karabi knows what
 * this server plays. Inventing them here would just be more dead roles.
 */
const RENAMES = [
  // ── Regions: finish the set ────────────────────────────────────────────────
  { id: '1466950515253313711', was: 'Europe (dupe)',        name: 'Middle East',  color: 0xE67E22, set: 'Region' },

  // ── Timezones: finish the set ──────────────────────────────────────────────
  { id: '1466950516411076650', was: 'North America (dupe)', name: 'CST',  color: 0x3498DB, set: 'Timezone' },
  { id: '1466950518222885018', was: 'South America (dupe)', name: 'MST',  color: 0x3498DB, set: 'Timezone' },
  { id: '1466950519254814851', was: 'Asia (dupe)',          name: 'CET',  color: 0x3498DB, set: 'Timezone' },
  { id: '1466950520110317720', was: 'Oceania (dupe)',       name: 'EET',  color: 0x3498DB, set: 'Timezone' },
  { id: '1466949409446301788', was: 'He/Him (dupe)',        name: 'AWST', color: 0x3498DB, set: 'Timezone' },
  { id: '1466949410595278872', was: 'She/Her (dupe)',       name: 'ACST', color: 0x3498DB, set: 'Timezone' },
  { id: '1466949412013080617', was: 'They/Them (dupe)',     name: 'NZST', color: 0x3498DB, set: 'Timezone' },

  // ── Colours: 7 exist, no panel. Round it out to 15. ────────────────────────
  { id: '1466949413120512217', was: 'Ask (dupe)',           name: 'Cyan',     color: 0x1ABC9C, set: 'Colour' },
  { id: '1466949461216333907', was: 'He/Him (dupe)',        name: 'Teal',     color: 0x11806A, set: 'Colour' },
  { id: '1466949462290202847', was: 'She/Her (dupe)',       name: 'Lime',     color: 0x2ECC71, set: 'Colour' },
  { id: '1466949463124869233', was: 'They/Them (dupe)',     name: 'Magenta',  color: 0xE91E63, set: 'Colour' },
  { id: '1466949464190357729', was: 'Ask (dupe)',           name: 'Gold',     color: 0xF1C40F, set: 'Colour' },
  { id: '1466949546671210639', was: 'He/Him (dupe)',        name: 'Lavender', color: 0xB18FE0, set: 'Colour' },
  { id: '1466949547568660510', was: 'She/Her (dupe)',       name: 'Crimson',  color: 0x992D22, set: 'Colour' },
  { id: '1466949548508184597', was: 'They/Them (dupe)',     name: 'White',    color: 0xE6E7E8, set: 'Colour' },

  // ── Opt-in pings: one per thing we actually announce ───────────────────────
  { id: '1466950362702286918', was: 'Ask (dupe)',           name: '🔔 Stream Pings', color: 0x9146FF, set: 'Notify' },
  { id: '1466949549955219701', was: 'Ask (dupe)',           name: '🔔 Free Games',   color: 0x0074E4, set: 'Notify' },
  { id: '1466950313675198580', was: 'He/Him (dupe)',        name: '🔔 Giveaways',    color: 0xF47B67, set: 'Notify' },
  { id: '1466950315210178714', was: 'She/Her (dupe)',       name: '🔔 Events',       color: 0x5865F2, set: 'Notify' },
  { id: '1466950315784802519', was: 'They/Them (dupe)',     name: '🔔 Question of the Day', color: 0xFEE75C, set: 'Notify' },

  // ── The remaining 7 are intentionally unassigned. See the note above. ──────
];

/** Spare roles we are deliberately NOT renaming yet — Karabi picks what these become. */
const RESERVED = [
  '1466950316917526763', // Ask (dupe)
  '1466950360190156933', // He/Him (dupe)
  '1466950361305710623', // She/Her (dupe)
  '1466950362043908237', // They/Them (dupe)
  '1282556157969432576', // new role
  '1282557235385471006', // new role
  '1525748284193509467', // new role
];

/** Not dead — waiting on something. Listed so nobody "cleans" them up by mistake. */
const WAITING = [
  { id: '1488337520889696517', name: 'BIRTHDAY!!!',               why: 'ALREADY WIRED — we grant it on the day, strip it after. Empty only because the old bot never granted it' },
  { id: '1490586756188344320', name: 'Ko-fi Supporter <3',        why: 'Ko-fi tier — needs the webhook token' },
  { id: '1490587340249501737', name: 'MONTHLY Ko-fi Supporter <3', why: 'Ko-fi tier — needs the webhook token' },
  { id: '1466950520668422421', name: 'Africa',                    why: "restore as the 🦒 option on the region panel (it currently points at a DELETED role)" },
];

// ── run ──────────────────────────────────────────────────────────────────────

const db = await mysql.createConnection({
  host: process.env.DB_HOST, user: process.env.DB_USER,
  password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
});
const [[bot]] = await db.execute('SELECT bot_token FROM custom_bots WHERE bot_id = ?', [KABBOT]);
await db.end();
const token = encryption.decrypt(JSON.parse(bot.bot_token));

const api = async (path, opts = {}) => {
  for (;;) {
    const res = await fetch(`https://discord.com/api/v10${path}`, {
      ...opts,
      headers: {
        Authorization: `Bot ${token}`,
        'Content-Type': 'application/json',
        // X-Audit-Log-Reason must be pure ASCII.
        'X-Audit-Log-Reason': 'Role cleanup: repurposing abandoned duplicate roles',
        ...(opts.headers ?? {}),
      },
    });
    if (res.status === 429) {
      const j = await res.json().catch(() => ({}));
      await new Promise(s => setTimeout(s, (j.retry_after ?? 1) * 1000 + 250));
      continue;
    }
    if (!res.ok) throw new Error(`${res.status} ${path}: ${await res.text()}`);
    return res.status === 204 ? null : res.json();
  }
};

const roles = await api(`/guilds/${GUILD}/roles`);
const byId = new Map(roles.map(r => [r.id, r]));

// Re-verify emptiness LIVE. A role that has picked up a member since the plan was written must not
// be renamed out from under them.
let members = [], after = '0';
for (;;) {
  const page = await api(`/guilds/${GUILD}/members?limit=1000&after=${after}`);
  if (!page?.length) break;
  members.push(...page);
  if (page.length < 1000) break;
  after = page[page.length - 1].user.id;
}
const holders = new Map();
for (const m of members) for (const r of m.roles) holders.set(r, (holders.get(r) ?? 0) + 1);

console.log(`\n${APPLY ? 'APPLYING' : 'DRY RUN — nothing will change'}\n`);
console.log('renaming'.padEnd(30) + '→  becomes                    set');
console.log('─'.repeat(78));

let done = 0, skipped = 0;
for (const r of RENAMES) {
  const live = byId.get(r.id);
  if (!live) { console.log(`  SKIP  ${r.was} — role no longer exists`); skipped++; continue; }
  const n = holders.get(r.id) ?? 0;
  if (n > 0) { console.log(`  SKIP  ${live.name} — HAS ${n} MEMBER(S) NOW, refusing to rename`); skipped++; continue; }
  if (live.name === r.name) { console.log(`  =     ${r.name} — already done`); continue; }

  console.log(`  ${live.name.padEnd(28)}→  ${r.name.padEnd(26)}${r.set}`);
  if (APPLY) {
    await api(`/guilds/${GUILD}/roles/${r.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ name: r.name, color: r.color, hoist: false, mentionable: false }),
    });
    done++;
  }
}

console.log(`\n${RESERVED.length} spare roles left unassigned — Karabi picks what these become:`);
for (const id of RESERVED) console.log(`    ${(byId.get(id)?.name ?? id)}`);

console.log(`\nNOT touched (waiting on something, not dead):`);
for (const w of WAITING) console.log(`    ${w.name.padEnd(28)} ${w.why}`);

console.log(`\n${APPLY ? `renamed ${done}, skipped ${skipped}` : `${RENAMES.length} rename(s) planned. Re-run with --apply to perform them.`}\n`);
process.exit(0);
