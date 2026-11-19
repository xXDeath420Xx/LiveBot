/*
 * Find every bot-authored rules / code-of-conduct message we control, and report which ones lack
 * explicit anti-commission wording.
 *
 *   node scripts/rules-commission-audit.mjs                 # audit everything we're in
 *   node scripts/rules-commission-audit.mjs --guild <id>
 *   node scripts/rules-commission-audit.mjs --out report.json
 *
 * READ-ONLY. Every Discord call is a GET, so this is safe against live guilds while PM2 is up.
 *
 * Only messages authored by the bot whose token we hold are reported as actionable — Discord will
 * not let a bot edit anyone else's message, so a human-written rules post is a "tell the owner"
 * item, not something we can patch. Those are reported separately rather than dropped, because
 * "your rules need updating and we can't do it for you" is still the answer to the question.
 *
 * Channel names are NFKC-normalised before matching. Servers love fancy unicode — the Forsaken
 * Warriors channel is literally "📒ℭ𝘰𝘥𝘦-𝔬𝔣-ℭ𝘰𝘯𝘥𝘶𝘤𝘵", which no ASCII regex will ever hit.
 */
import 'dotenv/config';
import mysql from 'mysql2/promise';
import { writeFileSync } from 'node:fs';
import encryption from '../utils/encryption.js';

const argv = process.argv.slice(2);
const val = (n, d = null) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const ONLY_GUILD = val('--guild');
const OUT = val('--out', 'rules-commission-audit.json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const flat = (s) => String(s || '').normalize('NFKC');

// Channels likely to hold rules. Matched against the NFKC-normalised name.
const RULES_CHANNEL = /rule|conduct|guideline|terms|read.?me|read.?first|start.?here|info|welcome|expectation|agreement|policy|policies/i;

// Does the message read like a rules post at all?
const LOOKS_LIKE_RULES = /\brules?\b|code of conduct|guidelines|terms of|by (taking part|participating|joining)/i;

// Existing advertising / self-promo policy of any kind.
const AD_POLICY = /self.?promo|self.?promotion|advertis|soliciting|solicitation|no promo\b|promote your/i;

// Explicit commission wording — what we're checking for.
const COMMISSION = /commission|paid work|for hire|freelance|rate sheet|price sheet|marketplace|selling (?:art|services)/i;

const db = await mysql.createConnection({
  host: process.env.DB_HOST, user: process.env.DB_USER,
  password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
});

async function main() {
  const [guilds] = await db.query(
    `SELECT g.guild_id, g.guild_name FROM guilds g ${ONLY_GUILD ? 'WHERE g.guild_id = ?' : ''} ORDER BY g.guild_name`,
    ONLY_GUILD ? [ONLY_GUILD] : []);

  // Message ids we already know point at a gate / panel, whatever the channel is called.
  const [verify] = await db.query('SELECT guild_id, gate_channel_id, gate_message_id FROM verify_config WHERE gate_message_id IS NOT NULL');
  const [panels] = await db.query('SELECT guild_id, channel_id, message_id, panel_name FROM reaction_role_panels');
  const known = new Map();
  for (const v of verify) addKnown(known, v.guild_id, v.gate_channel_id, v.gate_message_id, 'verify gate');
  for (const p of panels) {
    if (!RULES_CHANNEL.test(flat(p.panel_name || '')) && !/rule|conduct/i.test(flat(p.panel_name || ''))) continue;
    addKnown(known, p.guild_id, p.channel_id, p.message_id, `panel:${p.panel_name}`);
  }

  const findings = [];
  const unreachable = [];
  let scanned = 0;

  for (const g of guilds) {
    const auth = await tokenFor(g.guild_id);
    if (!auth) { unreachable.push({ ...g, why: 'no bot token' }); continue; }

    const chRes = await api(`/guilds/${g.guild_id}/channels`, auth.token);
    if (!chRes.ok) { unreachable.push({ ...g, why: `channels ${chRes.status}` }); continue; }
    scanned++;

    const channels = chRes.body.filter((c) => c.type === 0 || c.type === 5); // text + announcement
    const targets = new Map();
    for (const c of channels) if (RULES_CHANNEL.test(flat(c.name))) targets.set(c.id, c.name);
    for (const k of known.get(g.guild_id) || []) if (!targets.has(k.channelId)) targets.set(k.channelId, '(known panel)');

    for (const [chId, chName] of targets) {
      const mRes = await api(`/channels/${chId}/messages?limit=50`, auth.token);
      if (!mRes.ok) continue;

      for (const m of mRes.body) {
        if (!m.author?.bot) continue;
        const text = messageText(m);
        if (text.length < 120) continue;              // stubs, buttons-only posts
        if (!LOOKS_LIKE_RULES.test(text)) continue;

        findings.push({
          guildId: g.guild_id,
          guildName: g.guild_name,
          channelId: chId,
          channelName: flat(chName),
          messageId: m.id,
          authorId: m.author.id,
          authorName: m.author.username,
          ours: m.author.id === auth.botId,           // only these are editable by us
          embeds: m.embeds.length,
          chars: text.length,
          hasAdPolicy: AD_POLICY.test(text),
          hasCommission: COMMISSION.test(text),
          adSnippet: snippet(text, AD_POLICY),
        });
      }
      await sleep(120);
    }
    await sleep(120);
  }

  // ── report ─────────────────────────────────────────────────────────────────
  const ours = findings.filter((f) => f.ours);
  const foreign = findings.filter((f) => !f.ours);
  const needsWork = ours.filter((f) => !f.hasCommission);
  const covered = ours.filter((f) => f.hasCommission);

  console.log(`\nScanned ${scanned}/${guilds.length} guilds · ${findings.length} rules-like bot messages found\n`);

  console.log(`${'─'.repeat(78)}\nEDITABLE BY US, MISSING COMMISSION WORDING — ${needsWork.length}\n${'─'.repeat(78)}`);
  for (const f of needsWork) {
    console.log(`\n▸ ${f.guildName}  #${f.channelName}`);
    console.log(`  guild ${f.guildId} · msg ${f.messageId} · ${f.embeds} embed(s) · ${f.chars} chars`);
    console.log(`  existing ad/self-promo policy: ${f.hasAdPolicy ? 'YES — tighten it' : 'NONE — add a rule'}`);
    if (f.adSnippet) console.log(`    ↳ «${f.adSnippet}»`);
  }

  if (covered.length) {
    console.log(`\n${'─'.repeat(78)}\nALREADY MENTION COMMISSIONS — ${covered.length}\n${'─'.repeat(78)}`);
    for (const f of covered) console.log(`  ✓ ${f.guildName}  #${f.channelName}  (msg ${f.messageId})`);
  }

  if (foreign.length) {
    console.log(`\n${'─'.repeat(78)}\nRULES POSTED BY A BOT WE DON'T CONTROL — ${foreign.length} (owner must edit)\n${'─'.repeat(78)}`);
    for (const f of foreign) {
      console.log(`  · ${f.guildName}  #${f.channelName}  by @${f.authorName}` +
        `  ${f.hasCommission ? '(covers commissions)' : '(NO commission wording)'}`);
    }
  }

  if (unreachable.length) {
    console.log(`\n${'─'.repeat(78)}\nNOT SCANNED — ${unreachable.length}\n${'─'.repeat(78)}`);
    const byWhy = {};
    for (const u of unreachable) (byWhy[u.why] ||= []).push(u.guild_name || u.guildName);
    for (const [why, names] of Object.entries(byWhy)) console.log(`  ${why}: ${names.length} (${names.slice(0, 6).join(', ')}${names.length > 6 ? ', …' : ''})`);
  }

  writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), scanned, findings, unreachable }, null, 2));
  console.log(`\nreport → ${OUT}`);
}

function addKnown(map, guildId, channelId, messageId, why) {
  if (!channelId || !messageId) return;
  if (!map.has(guildId)) map.set(guildId, []);
  map.get(guildId).push({ channelId, messageId, why });
}

/** Everything a human would read: content plus every embed title, description and field. */
function messageText(m) {
  const parts = [m.content || ''];
  for (const e of m.embeds || []) {
    parts.push(e.title || '', e.description || '', e.footer?.text || '');
    for (const f of e.fields || []) parts.push(f.name || '', f.value || '');
  }
  return flat(parts.filter(Boolean).join('\n'));
}

function snippet(text, re) {
  const m = text.match(re);
  if (!m) return null;
  const i = Math.max(0, m.index - 60);
  return text.slice(i, m.index + 140).replace(/\s+/g, ' ').trim();
}

const tokenCache = new Map();
let mainBotId; // undefined = not looked up yet, null = lookup failed
async function tokenFor(guildId) {
  if (tokenCache.has(guildId)) return tokenCache.get(guildId);
  let out = null;
  const [[bot]] = await db.execute(
    `SELECT bot_id, bot_token FROM custom_bots
      WHERE bot_id = (SELECT bot_id FROM guild_bot_mapping WHERE guild_id = ? LIMIT 1)`, [guildId]).catch(() => [[]]);
  if (bot?.bot_token) {
    try { out = { token: encryption.decrypt(JSON.parse(bot.bot_token)), botId: bot.bot_id }; } catch { out = null; }
  }
  if (!out) {
    const token = process.env.DISCORD_TOKEN || process.env.BOT_TOKEN;
    // Resolve the main bot's own id from the API rather than trusting an env var to be set —
    // getting this wrong would silently mark every main-bot message as "not ours" and hide it.
    if (token) {
      if (mainBotId === undefined) {
        const me = await api('/users/@me', token);
        mainBotId = me.ok ? me.body.id : null;
      }
      out = { token, botId: mainBotId };
    }
  }
  tokenCache.set(guildId, out);
  return out;
}

async function api(path, token) {
  for (;;) {
    const r = await fetch(`https://discord.com/api/v10${path}`, { headers: { Authorization: `Bot ${token}` } });
    if (r.status === 429) {
      const j = await r.json().catch(() => ({}));
      await sleep((j.retry_after ?? 1) * 1000 + 250);
      continue;
    }
    return { ok: r.ok, status: r.status, body: r.ok ? await r.json() : null };
  }
}

try { await main(); } catch (e) { console.error('FATAL', e); process.exitCode = 1; }
finally { await db.end(); }
