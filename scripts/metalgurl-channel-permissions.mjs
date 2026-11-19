#!/usr/bin/env node
/**
 * MetalGurl2K — explicit per-channel permission enforcement.
 *
 * Every channel is written and verified INDIVIDUALLY. Nothing here infers a
 * channel's state from its category, from Discord's "sync" button, or from what
 * a role happens to carry at guild level. Three reasons that matters:
 *
 *   1. Category sync is a one-shot copy, not a live link. A channel that "looks
 *      synced" in the client can carry different bits the moment anyone edits it.
 *   2. ADMINISTRATOR bypasses every overwrite, so a staff channel can appear to
 *      work while granting nobody anything — it breaks the day that role loses
 *      Administrator. #server-development is in exactly that state right now.
 *   3. Role-level VIEW_CHANNEL is invisible in the channel UI. @Member currently
 *      carries it guild-wide, so the server LOOKS locked down per channel when
 *      in fact almost nothing is set per channel at all.
 *
 * So: the desired overwrite set for each object is stated in full below, written
 * one overwrite at a time, then read back from a fresh GET and compared. On top
 * of the byte comparison the script computes the EFFECTIVE permission for each
 * audience per channel — the thing you actually care about — so a pass means
 * "a member of this role can/can't do this here", not merely "the bits we sent
 * came back".
 *
 *   node scripts/metalgurl-channel-permissions.mjs            # verify only (default)
 *   node scripts/metalgurl-channel-permissions.mjs --apply    # write, then verify
 *   node scripts/metalgurl-channel-permissions.mjs --json     # machine-readable report
 */
import 'dotenv/config';
import mysql from 'mysql2/promise';
import { resolveBotForGuild } from '../utils/bot-resolver.js';

const GUILD = '1486475912202424422';
// The acting bot comes from guild_bot_mapping — never pinned here.
const APPLY = process.argv.includes('--apply');
const JSON_OUT = process.argv.includes('--json');

// ── permission bits ────────────────────────────────────────────────────────
const F = {
  CREATE_INSTANT_INVITE: 1n << 0n,  ADD_REACTIONS: 1n << 6n,   STREAM: 1n << 9n,
  VIEW_CHANNEL: 1n << 10n,          SEND_MESSAGES: 1n << 11n,  MANAGE_MESSAGES: 1n << 13n,
  EMBED_LINKS: 1n << 14n,           ATTACH_FILES: 1n << 15n,   READ_MESSAGE_HISTORY: 1n << 16n,
  MENTION_EVERYONE: 1n << 17n,      USE_EXTERNAL_EMOJIS: 1n << 18n,
  CONNECT: 1n << 20n,               SPEAK: 1n << 21n,          MUTE_MEMBERS: 1n << 22n,
  DEAFEN_MEMBERS: 1n << 23n,        MOVE_MEMBERS: 1n << 24n,   USE_VAD: 1n << 25n,
  MANAGE_ROLES: 1n << 28n,          MANAGE_WEBHOOKS: 1n << 29n,
  USE_APPLICATION_COMMANDS: 1n << 31n, MANAGE_THREADS: 1n << 34n,
  CREATE_PUBLIC_THREADS: 1n << 35n, CREATE_PRIVATE_THREADS: 1n << 36n,
  USE_EXTERNAL_STICKERS: 1n << 37n, SEND_MESSAGES_IN_THREADS: 1n << 38n,
  ADMINISTRATOR: 1n << 3n,
};
const bits = names => names.reduce((a, n) => a | F[n], 0n);
const decode = v => Object.entries(F).filter(([, m]) => (BigInt(v) & m) === m).map(([k]) => k);

// ── the audiences, in the order Discord resolves them ──────────────────────
const EVERYONE = '@everyone';
const MEMBER   = 'Member';
const STAFF    = ['Owner', 'Co-Owner', 'Head Admin', 'Admin', 'Head Mod', 'Mod'];
const MOD_ONLY = ['Owner', 'Co-Owner', 'Head Admin', 'Admin', 'Head Mod'];

// ── the permission shapes ──────────────────────────────────────────────────
const READ       = ['VIEW_CHANNEL', 'READ_MESSAGE_HISTORY', 'ADD_REACTIONS', 'USE_EXTERNAL_EMOJIS'];
const CHAT       = [...READ, 'SEND_MESSAGES', 'EMBED_LINKS', 'ATTACH_FILES',
                    'CREATE_PUBLIC_THREADS', 'SEND_MESSAGES_IN_THREADS', 'USE_EXTERNAL_STICKERS',
                    'USE_APPLICATION_COMMANDS'];
const VOICE      = ['VIEW_CHANNEL', 'CONNECT', 'SPEAK', 'STREAM', 'USE_VAD', 'READ_MESSAGE_HISTORY',
                    'SEND_MESSAGES', 'USE_APPLICATION_COMMANDS'];
const STAFF_TEXT = [...CHAT, 'MANAGE_MESSAGES', 'MANAGE_THREADS', 'CREATE_PRIVATE_THREADS',
                    'MENTION_EVERYONE'];
const STAFF_VC   = [...VOICE, 'MUTE_MEMBERS', 'DEAFEN_MEMBERS', 'MOVE_MEMBERS'];
const BOT_TEXT   = [...CHAT, 'MANAGE_MESSAGES', 'MANAGE_WEBHOOKS', 'MENTION_EVERYONE'];

/**
 * Plain-name → intent. Every channel in the guild must appear here or the run
 * aborts: an unlisted channel is the exact way a room quietly keeps its old
 * permissions through a "full" pass.
 *
 *   lobby   — visible before accepting the rules. Read-only.
 *   read    — @Member can read and react, not post. The bot posts.
 *   chat    — @Member can talk.
 *   voice   — @Member can join and speak.
 *   staff   — hidden from @everyone AND from @Member. Staff roles, explicitly.
 */
const INTENT = {
  // General
  'Rules-Guidelines':   'lobby',
  'Welcome-Center':     'lobby',
  'Announcements':      'read',
  'Community-Updates':  'read',
  'Reaction-Roles':     'read',
  // Metal's-Stream-Info
  'Twitch-Live':        'read',
  'Clips-Highlights':   'read',
  'Journey-2-Partner':  'read',
  'Stream-Signup':      'chat',   // people paste a link; the bot tidies it away
  // Community
  'Introductions':      'chat',
  'Ellies-Den':         'read',   // currently read-only; flip to 'chat' when she says so
  'FN-Leaks':           'read',
  'Games-News':         'read',
  'Self-Promo':         'chat',
  // Hangout-Spot
  'Utopia-Chat':        'chat',
  'Question-of-the-Day': 'chat',
  'Yummy-Eats':         'chat',
  'Pets':               'chat',
  'Pop-Culture':        'chat',
  'Music':              'chat',   // the TEXT one; the voice Music is matched by type
  'Travel':             'chat',
  'Other-Games':        'chat',
  'Fortnite':           'chat',
  'Minecraft':          'chat',
  'Gaming-Setups':      'chat',
  'Art-and-Creative':   'chat',
  'Cute-Corner':        'chat',
  // Voice-Chats
  'Lobby':              'voice',
  'Gaming':             'voice',
  // Admins
  'Admin VC':           'staff',
  'admin-chat':         'staff',
  'chat-logs':          'staff',
  'admin-logs':         'staff',
  'server-development': 'staff',
};
/** Categories get the same shape as their contents, so a channel created later inherits sanely. */
const CAT_INTENT = {
  'General': 'read', "Metal's-Stream-Info": 'read', 'Community': 'read',
  'Hangout-Spot': 'chat', 'Voice-Chats': 'voice', 'Admins': 'staff',
};

/** Build the desired overwrite list for one object. */
function desired(intent, isVoice, roleId, botRoleId) {
  const ow = [];
  const put = (name, allow, deny) => {
    const id = name === EVERYONE ? GUILD : roleId(name);
    if (!id) return { missing: name };
    ow.push({ id, type: 0, allow: String(bits(allow)), deny: String(bits(deny)) });
    return null;
  };
  const missing = [];
  const track = r => { if (r) missing.push(r.missing); };

  if (intent === 'staff') {
    // @everyone and @Member are both shut out, explicitly and separately.
    track(put(EVERYONE, [], ['VIEW_CHANNEL', 'CONNECT']));
    track(put(MEMBER,   [], ['VIEW_CHANNEL', 'CONNECT']));
    for (const s of (isVoice ? MOD_ONLY : STAFF)) track(put(s, isVoice ? STAFF_VC : STAFF_TEXT, []));
  } else if (intent === 'lobby') {
    // Readable before the rules are accepted — that is the whole point of it.
    track(put(EVERYONE, ['VIEW_CHANNEL', 'READ_MESSAGE_HISTORY'], ['SEND_MESSAGES', 'ADD_REACTIONS',
      'CREATE_PUBLIC_THREADS', 'SEND_MESSAGES_IN_THREADS']));
    track(put(MEMBER,   ['VIEW_CHANNEL', 'READ_MESSAGE_HISTORY'], ['SEND_MESSAGES']));
    for (const s of STAFF) track(put(s, STAFF_TEXT, []));
  } else {
    track(put(EVERYONE, [], ['VIEW_CHANNEL', 'CONNECT']));
    if (intent === 'read')  track(put(MEMBER, READ,  ['SEND_MESSAGES', 'CREATE_PUBLIC_THREADS', 'SEND_MESSAGES_IN_THREADS']));
    if (intent === 'chat')  track(put(MEMBER, CHAT,  []));
    if (intent === 'voice') track(put(MEMBER, VOICE, []));
    for (const s of STAFF) track(put(s, isVoice ? STAFF_VC : STAFF_TEXT, []));
  }
  // The bot is granted explicitly everywhere it posts, rather than leaning on
  // its Administrator bit — which is precisely the assumption we were told not
  // to make, and which silently breaks if that bit is ever removed.
  if (botRoleId) ow.push({ id: botRoleId, type: 0,
    allow: String(bits(isVoice ? [...STAFF_VC, 'MANAGE_WEBHOOKS'] : BOT_TEXT)), deny: '0' });

  return { ow, missing };
}

/** Effective permission for one role in one channel, per Discord's documented order. */
function effective(roleBase, overwrites, roleId) {
  let perms = BigInt(roleBase);
  if ((perms & F.ADMINISTRATOR) === F.ADMINISTRATOR) return { perms: ~0n, admin: true };
  const ev = overwrites.find(o => o.id === GUILD);
  if (ev) { perms &= ~BigInt(ev.deny); perms |= BigInt(ev.allow); }
  const mine = overwrites.find(o => o.id === roleId);
  if (mine) { perms &= ~BigInt(mine.deny); perms |= BigInt(mine.allow); }
  return { perms, admin: false };
}
const can = (eff, p) => (eff.perms & F[p]) === F[p];

// ── run ────────────────────────────────────────────────────────────────────
const db = await mysql.createConnection({
  host: process.env.DB_HOST, user: process.env.DB_USER,
  password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
});
let out = { applied: APPLY, checked: 0, pass: 0, fail: 0, channels: [], blockers: [] };
try {
  const bot = await resolveBotForGuild(GUILD, { db });
  const H = { Authorization: bot.auth, 'Content-Type': 'application/json' };
  const api = (p, o = {}) => fetch('https://discord.com/api/v10' + p, { headers: H, ...o });
  /* A 429 is Discord asking us to wait, not a failure. Recording it as one made four
     channels report FAIL on a write that simply hadn't happened yet. */
  const send = async (p, o = {}, tries = 5) => {
    for (let i = 0; i < tries; i++) {
      const r = await api(p, o);
      if (r.status !== 429) return r;
      const wait = Number(r.headers.get('retry-after') || 1) * 1000 + 250;
      console.log(`      rate limited, waiting ${Math.round(wait)}ms`);
      await new Promise(s => setTimeout(s, wait));
    }
    return api(p, o);
  };

  const roles = await (await api(`/guilds/${GUILD}/roles`)).json();
  const byName = new Map(roles.map(r => [r.name, r]));
  const roleId = n => byName.get(n)?.id;
  const botRole = roles.find(r => r.managed && r.tags?.bot_id === bot.botId);

  // strip the styling so INTENT can be keyed on readable names
  const bare = s => s.replace(/[\u{1D400}-\u{1D7FF}]/gu, c => {
        const cp = c.codePointAt(0);
        for (const [b, base] of [[0x1D434, 65], [0x1D44E, 97]])
          if (cp >= b && cp < b + 26) return String.fromCharCode(base + cp - b);
        return c; })
      .replace(/ℎ/g, 'h')
      .replace(/^[^A-Za-z0-9]+/, '').replace(/[^A-Za-z0-9 -]+$/, '').trim();

  const chans = await (await api(`/guilds/${GUILD}/channels`)).json();
  const cats = chans.filter(c => c.type === 4).sort((a, b) => a.position - b.position);

  // Abort rather than half-apply: an unlisted channel, or a missing role, means
  // the pass would leave something on its old permissions without saying so.
  for (const c of chans) {
    const n = bare(c.name);
    if (c.type === 4) { if (!CAT_INTENT[n]) out.blockers.push(`category not in CAT_INTENT: ${n}`); }
    else if (!INTENT[n]) out.blockers.push(`channel not in INTENT: ${n}`);
  }
  for (const r of [MEMBER, ...STAFF]) if (!roleId(r)) out.blockers.push(`role does not exist yet: ${r}`);
  if (!botRole) out.blockers.push('could not resolve MetalBot managed role');

  if (out.blockers.length) {
    console.log('\n\x1b[33mBLOCKED — not writing anything:\x1b[0m');
    out.blockers.forEach(b => console.log('  •', b));
    if (APPLY) { console.log('\nFix these first. Nothing was changed.'); process.exit(1); }
    console.log('\nContinuing in verify-only mode; rows needing a missing role are marked.\n');
  }

  const order = [];
  for (const cat of cats) {
    order.push(cat);
    chans.filter(c => c.parent_id === cat.id).sort((a, b) => a.position - b.position).forEach(c => order.push(c));
  }

  for (const ch of order) {
    const n = bare(ch.name);
    const isVoice = ch.type === 2;
    let intent = ch.type === 4 ? CAT_INTENT[n] : INTENT[n];
    // 'Music' exists twice — once as text, once as voice. Keying on name alone gave the
    // voice room the text shape, which left members able to see it but not connect.
    if (ch.type === 2 && intent !== 'staff') intent = 'voice';
    if (!intent) continue;
    const { ow, missing } = desired(intent, isVoice, roleId, botRole?.id);
    const rec = { id: ch.id, name: ch.name, plain: n, type: ch.type, intent, missing, ok: null, diffs: [] };

    if (APPLY) {
      // One overwrite at a time — PUT each wanted one, DELETE anything else.
      const before = await (await api(`/channels/${ch.id}`)).json();
      for (const o of ow) {
        const r = await send(`/channels/${ch.id}/permissions/${o.id}`, {
          method: 'PUT',
          headers: { ...H, 'X-Audit-Log-Reason': 'MetalGurl2K explicit channel permission pass' },
          body: JSON.stringify({ type: o.type, allow: o.allow, deny: o.deny }),
        });
        if (!r.ok) rec.diffs.push(`PUT ${o.id} failed: ${r.status} ${await r.text()}`);
        await new Promise(s => setTimeout(s, 250));
      }
      const keep = new Set(ow.map(o => o.id));
      for (const o of (before.permission_overwrites || [])) {
        if (keep.has(o.id)) continue;
        const r = await send(`/channels/${ch.id}/permissions/${o.id}`, {
          method: 'DELETE',
          headers: { ...H, 'X-Audit-Log-Reason': 'MetalGurl2K explicit channel permission pass' },
        });
        if (!r.ok) rec.diffs.push(`DELETE ${o.id} failed: ${r.status}`);
        await new Promise(s => setTimeout(s, 250));
      }
    }

    // Always read the channel back on its own — never trust the list we started from.
    const live = await (await api(`/channels/${ch.id}`)).json();
    const got = (live.permission_overwrites || []);
    const norm = l => l.map(o => `${o.id}:${o.type}:${BigInt(o.allow)}:${BigInt(o.deny)}`).sort();
    const wantN = norm(ow), gotN = norm(got);
    for (const w of wantN) if (!gotN.includes(w)) rec.diffs.push(`missing/wrong: ${w}`);
    for (const g of gotN) if (!wantN.includes(g)) rec.diffs.push(`unexpected:    ${g}`);

    // Outcome check — what each audience can actually do here.
    const ev = roles.find(r => r.id === GUILD);
    rec.effective = {};
    for (const [label, rid, base] of [
      ['@everyone', GUILD, ev.permissions],
      ['@Member', roleId(MEMBER), byName.get(MEMBER)?.permissions ?? '0'],
      ['@Mod', roleId('Mod'), byName.get('Mod')?.permissions ?? '0'],
    ]) {
      if (!rid) { rec.effective[label] = 'role missing'; continue; }
      const e = effective(base, got, rid);
      rec.effective[label] = e.admin ? 'ADMINISTRATOR (bypasses overwrites)'
        : [can(e, 'VIEW_CHANNEL') ? 'view' : '—',
           can(e, isVoice ? 'CONNECT' : 'SEND_MESSAGES') ? (isVoice ? 'connect' : 'post') : '—'].join('/');
    }
    rec.ok = rec.diffs.length === 0;
    out.channels.push(rec); out.checked++; rec.ok ? out.pass++ : out.fail++;

    if (!JSON_OUT) {
      const head = ch.type === 4 ? `\n\x1b[1m┏ ${ch.name}\x1b[0m` : `┃  ${ch.name}`;
      const mark = rec.ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
      console.log(`${head}\n┃    ${mark}  intent:${intent}  ` +
        Object.entries(rec.effective).map(([k, v]) => `${k}=${v}`).join('  '));
      rec.diffs.slice(0, 8).forEach(d => console.log(`┃      \x1b[31m${d}\x1b[0m`));
      if (rec.diffs.length > 8) console.log(`┃      …and ${rec.diffs.length - 8} more`);
      if (missing.length) console.log(`┃      \x1b[33mrole not created yet: ${missing.join(', ')}\x1b[0m`);
    }
  }

  if (JSON_OUT) console.log(JSON.stringify(out, null, 1));
  else {
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`${APPLY ? 'APPLIED then verified' : 'VERIFY ONLY (nothing written)'} — ` +
      `${out.checked} objects · \x1b[32m${out.pass} pass\x1b[0m · \x1b[31m${out.fail} fail\x1b[0m`);
    if (!APPLY && out.fail) console.log(`Run with --apply to write them.`);
  }
} catch (e) {
  console.error('ERR', e.message, e.stack);
} finally {
  await db.end();
}
process.exit(0);
