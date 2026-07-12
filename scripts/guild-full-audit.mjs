/*
 * Full guild audit — everything Discord will tell us about a server, read-only.
 *
 *   node scripts/guild-full-audit.mjs <guildId> [--json out.json]
 *
 * Every call is a REST GET. It never posts, edits, deletes or reacts, so it is safe to run against
 * a live production guild while the gateway is connected (see the "competing sessions" rule — that
 * applies to *gateway* logins, not REST).
 *
 * Uses the CUSTOM BOT mapped to the guild, because the main bot generally is not in it.
 *
 * Covers, from the day the guild was created to now:
 *   guild settings + security · roles + who holds them · categories, channels and every permission
 *   overwrite · members and bots · emoji, stickers, soundboard · integrations · AutoMod · invites ·
 *   webhooks · and a full message history scan attributing every bot template to its trigger.
 */
import 'dotenv/config';
import mysql from 'mysql2/promise';
import { writeFileSync } from 'node:fs';
import { PermissionsBitField } from 'discord.js';
import encryption from '../utils/encryption.js';
import { templateOf, triggerOf, hash16 } from '../core/guild-analyzer.js';

const GUILD = process.argv[2];
const jsonAt = process.argv.includes('--json') ? process.argv[process.argv.indexOf('--json') + 1] : null;
if (!GUILD) { console.error('usage: node scripts/guild-full-audit.mjs <guildId> [--json out.json]'); process.exit(1); }

const DISCORD_EPOCH = 1420070400000n;
const snowflakeDate = (id) => new Date(Number((BigInt(id) >> 22n) + DISCORD_EPOCH));
const day = (d) => d.toISOString().slice(0, 10);

// ── auth ─────────────────────────────────────────────────────────────────────

const db = await mysql.createConnection({
  host: process.env.DB_HOST, user: process.env.DB_USER,
  password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
});
const [[bot]] = await db.execute(
  'SELECT bot_id, bot_token FROM custom_bots WHERE bot_id = (SELECT bot_id FROM guild_bot_mapping WHERE guild_id = ? LIMIT 1)',
  [GUILD]);
await db.end();
if (!bot) { console.error('No custom bot mapped to that guild.'); process.exit(1); }
const token = encryption.decrypt(JSON.parse(bot.bot_token));

/** GET with rate-limit obedience. Returns null on 403/404 so a missing scope degrades, not crashes. */
async function api(path) {
  for (;;) {
    const r = await fetch(`https://discord.com/api/v10${path}`, { headers: { Authorization: `Bot ${token}` } });
    if (r.status === 429) {
      const j = await r.json().catch(() => ({}));
      await new Promise(s => setTimeout(s, (j.retry_after ?? 1) * 1000 + 250));
      continue;
    }
    if (r.status === 403 || r.status === 404) return null;
    if (!r.ok) throw new Error(`${r.status} on ${path}: ${await r.text()}`);
    return r.json();
  }
}

const perms = (bits) => new PermissionsBitField(BigInt(bits ?? 0)).toArray();
/** Permissions that let a holder damage the server. */
const DANGEROUS = ['Administrator', 'ManageGuild', 'ManageRoles', 'ManageChannels', 'ManageWebhooks',
  'BanMembers', 'KickMembers', 'ManageMessages', 'MentionEveryone', 'ModerateMembers'];

const out = {};
const say = (s) => process.stdout.write(s + '\n');

// ── 1. the guild itself ──────────────────────────────────────────────────────

const guild = await api(`/guilds/${GUILD}?with_counts=true`);
const created = snowflakeDate(GUILD);
out.guild = {
  id: guild.id, name: guild.name, ownerId: guild.owner_id,
  created: created.toISOString(), ageDays: Math.floor((Date.now() - created) / 86400000),
  members: guild.approximate_member_count, online: guild.approximate_presence_count,
  verificationLevel: ['None', 'Low', 'Medium', 'High', 'Highest'][guild.verification_level],
  explicitContentFilter: ['Disabled', 'MembersWithoutRoles', 'AllMembers'][guild.explicit_content_filter],
  mfaLevel: guild.mfa_level === 1 ? 'Elevated (2FA required for moderation)' : 'None',
  defaultNotifications: guild.default_message_notifications === 0 ? 'All messages' : 'Only mentions',
  nsfwLevel: guild.nsfw_level, premiumTier: guild.premium_tier, boosts: guild.premium_subscription_count,
  vanityUrl: guild.vanity_url_code, features: guild.features,
  systemChannelId: guild.system_channel_id, rulesChannelId: guild.rules_channel_id,
  publicUpdatesChannelId: guild.public_updates_channel_id,
  afkChannelId: guild.afk_channel_id, afkTimeout: guild.afk_timeout,
  locale: guild.preferred_locale,
};

say(`\n${'═'.repeat(78)}`);
say(`  ${guild.name}   (${GUILD})`);
say(`  created ${day(created)} — ${out.guild.ageDays} days ago · ${guild.approximate_member_count} members`);
say(`${'═'.repeat(78)}\n`);

say('── SECURITY ' + '─'.repeat(66));
say(`  verification        ${out.guild.verificationLevel}`);
say(`  explicit filter     ${out.guild.explicitContentFilter}`);
say(`  2FA for moderation  ${out.guild.mfaLevel}`);
say(`  default notify      ${out.guild.defaultNotifications}`);
say(`  boosts              tier ${guild.premium_tier} (${guild.premium_subscription_count ?? 0})`);
say(`  features            ${(guild.features ?? []).join(', ') || 'none'}`);

// ── 2. roles ─────────────────────────────────────────────────────────────────

const roles = (await api(`/guilds/${GUILD}/roles`)).sort((a, b) => b.position - a.position);
out.roles = roles.map(r => ({
  id: r.id, name: r.name, position: r.position, color: r.color, hoist: r.hoist,
  mentionable: r.mentionable, managed: r.managed, botId: r.tags?.bot_id ?? null,
  permissions: perms(r.permissions),
  dangerous: perms(r.permissions).filter(p => DANGEROUS.includes(p)),
}));

// ── 3. members ───────────────────────────────────────────────────────────────

const members = [];
{
  let after = '0';
  for (;;) {
    const page = await api(`/guilds/${GUILD}/members?limit=1000&after=${after}`);
    if (!page?.length) break;
    members.push(...page);
    if (page.length < 1000) break;
    after = page[page.length - 1].user.id;
  }
}
const bots = members.filter(m => m.user.bot);
const humans = members.filter(m => !m.user.bot);
const roleById = new Map(roles.map(r => [r.id, r]));
const permsOf = (m) => {
  const set = new Set();
  for (const rid of [...m.roles, GUILD]) for (const p of perms(roleById.get(rid)?.permissions ?? 0)) set.add(p);
  return set;
};
out.members = {
  total: members.length, humans: humans.length, bots: bots.length,
  admins: members.filter(m => permsOf(m).has('Administrator')).map(m => ({
    id: m.user.id, name: m.user.username, bot: !!m.user.bot,
    via: m.roles.map(r => roleById.get(r)?.name).filter(n => n && perms(roles.find(x => x.name === n)?.permissions ?? 0).includes('Administrator')),
  })),
  owner: guild.owner_id,
};

// ── 4. channels ──────────────────────────────────────────────────────────────

const channels = await api(`/guilds/${GUILD}/channels`);
const TYPE = { 0: 'text', 2: 'voice', 4: 'category', 5: 'announcement', 13: 'stage', 15: 'forum', 16: 'media' };
const cats = channels.filter(c => c.type === 4).sort((a, b) => a.position - b.position);
const kids = (id) => channels.filter(c => c.parent_id === id).sort((a, b) => a.position - b.position);
const named = (id) => id === GUILD ? '@everyone' : (roleById.get(id)?.name ?? members.find(m => m.user.id === id)?.user.username ?? id);

const describeOverwrites = (c) => (c.permission_overwrites ?? []).map(o => ({
  on: named(o.id), kind: o.type === 0 ? 'role' : 'member',
  allow: perms(o.allow), deny: perms(o.deny),
})).filter(o => o.allow.length || o.deny.length);

out.channels = channels.map(c => ({
  id: c.id, name: c.name, type: TYPE[c.type] ?? c.type, parentId: c.parent_id,
  position: c.position, topic: c.topic ?? null, nsfw: !!c.nsfw, slowmode: c.rate_limit_per_user ?? 0,
  created: snowflakeDate(c.id).toISOString(),
  overwrites: describeOverwrites(c),
  locked: (c.permission_overwrites ?? []).some(o => o.id === GUILD && perms(o.deny).includes('ViewChannel')),
}));

// ── 5. emoji, stickers, soundboard, automod, integrations, invites, webhooks ──

const [emojis, stickers, soundboard, automod, integrations, invites] = await Promise.all([
  api(`/guilds/${GUILD}/emojis`), api(`/guilds/${GUILD}/stickers`),
  api(`/guilds/${GUILD}/soundboard-sounds`), api(`/guilds/${GUILD}/auto-moderation/rules`),
  api(`/guilds/${GUILD}/integrations`), api(`/guilds/${GUILD}/invites`),
]);
out.emojis = { count: emojis?.length ?? 0, animated: emojis?.filter(e => e.animated).length ?? 0, names: emojis?.map(e => e.name) ?? [] };
out.stickers = stickers?.map(s => s.name) ?? [];
out.soundboard = soundboard?.items?.map(s => s.name) ?? [];
out.automod = (automod ?? []).map(r => ({ name: r.name, enabled: r.enabled, trigger: r.trigger_type, actions: r.actions?.length }));
out.integrations = (integrations ?? []).map(i => ({
  id: i.id, name: i.name, type: i.type,
  appId: i.application?.id ?? null, botId: i.application?.bot?.id ?? null,
  addedBy: i.user?.username ?? null,
}));
out.invites = (invites ?? []).map(i => ({ code: i.code, channel: i.channel?.name, uses: i.uses, inviter: i.inviter?.username, expires: i.expires_at }));

const webhooks = [];
for (const c of channels.filter(c => [0, 5, 15].includes(c.type))) {
  const w = await api(`/channels/${c.id}/webhooks`);
  for (const h of w ?? []) webhooks.push({ name: h.name, channel: c.name, appId: h.application_id, owner: h.user?.username });
}
out.webhooks = webhooks;

// ── 6. full message history ──────────────────────────────────────────────────

const PAGE = 100, TRIGGER_WINDOW_MS = 30_000;
const botAgg = new Map();      // id -> { name, kind, messages, first, last, channels, templates }
const channelAgg = new Map();  // id -> { name, messages, humans, bots, first, last }
let scanned = 0;

const scannable = channels.filter(c => [0, 5, 15].includes(c.type));
for (const c of scannable) {
  // Forum posts live in threads, not the channel itself.
  const targets = [c];
  if (c.type === 15) {
    const act = await api(`/guilds/${GUILD}/threads/active`);
    for (const t of (act?.threads ?? []).filter(t => t.parent_id === c.id)) targets.push({ ...t, name: `${c.name}/${t.name}` });
    const arch = await api(`/channels/${c.id}/threads/archived/public?limit=100`);
    for (const t of arch?.threads ?? []) targets.push({ ...t, name: `${c.name}/${t.name}` });
  }

  for (const t of targets) {
    let before = null;
    const window = [];
    for (;;) {
      const page = await api(`/channels/${t.id}/messages?limit=${PAGE}${before ? `&before=${before}` : ''}`);
      if (!page?.length) break;
      window.push(...page);
      if (page.length < PAGE) break;
      before = page[page.length - 1].id;
    }
    scanned += window.length;

    const ch = channelAgg.get(t.id) ?? { name: t.name, messages: 0, humans: 0, bots: 0, first: Infinity, last: 0 };
    for (let i = 0; i < window.length; i++) {
      const m = window[i];
      const ts = Date.parse(m.timestamp);
      ch.messages++; ch.first = Math.min(ch.first, ts); ch.last = Math.max(ch.last, ts);

      const isBot = !!m.author?.bot || !!m.webhook_id;
      if (!isBot) { ch.humans++; continue; }
      ch.bots++;

      const isWebhook = !!m.webhook_id && !m.interaction_metadata && !m.interaction;
      const id = isWebhook ? `wh:${m.author.username}` : m.author.id;
      const agg = botAgg.get(id) ?? {
        id, name: m.author.username, kind: isWebhook ? 'webhook' : 'bot',
        messages: 0, first: Infinity, last: 0, channels: new Set(), templates: new Map(),
      };
      agg.messages++; agg.first = Math.min(agg.first, ts); agg.last = Math.max(agg.last, ts);
      agg.channels.add(t.name);

      const shape = templateOf(m);
      if (shape) {
        const h = hash16(shape);
        const tpl = agg.templates.get(h) ?? { sample: shape, count: 0, triggers: new Set() };
        tpl.count++;
        const cmd = m.interaction_metadata?.name ?? m.interaction?.name;
        if (cmd) tpl.triggers.add(`/${cmd}`);
        else {
          // messages come back newest-first, so the trigger is the NEXT index
          for (let j = i + 1; j < Math.min(i + 7, window.length); j++) {
            const cand = window[j];
            if (cand.author?.bot || cand.webhook_id) continue;
            if (ts - Date.parse(cand.timestamp) > TRIGGER_WINDOW_MS) break;
            const trig = triggerOf(cand.content);
            if (trig) tpl.triggers.add(trig);
            break;
          }
        }
        agg.templates.set(h, tpl);
      }
      botAgg.set(id, agg);
    }
    channelAgg.set(t.id, ch);
  }
  process.stderr.write(`  scanned #${c.name} (${scanned} total)\r`);
}
process.stderr.write('\n');

out.scan = {
  messages: scanned,
  channels: [...channelAgg.values()].sort((a, b) => b.messages - a.messages),
  bots: [...botAgg.values()].sort((a, b) => b.messages - a.messages).map(b => ({
    id: b.id, name: b.name, kind: b.kind, messages: b.messages,
    first: new Date(b.first).toISOString(), last: new Date(b.last).toISOString(),
    channels: [...b.channels],
    inGuild: b.kind === 'bot' ? members.some(m => m.user.id === b.id) : null,
    templates: [...b.templates.values()].sort((a, c) => c.count - a.count)
      .map(t => ({ count: t.count, sample: t.sample, triggers: [...t.triggers] })),
  })),
};

// ── report ───────────────────────────────────────────────────────────────────

say('\n── ROLES ' + '─'.repeat(69));
for (const r of out.roles) {
  if (r.name === '@everyone' && !r.dangerous.length) continue;
  const who = members.filter(m => m.roles.includes(r.id)).length;
  const tag = r.managed ? ' [bot]' : '';
  const danger = r.dangerous.length ? `  ⚠ ${r.dangerous.join(', ')}` : '';
  say(`  ${String(r.position).padStart(3)}  ${r.name.padEnd(26)}${tag.padEnd(6)} ${String(who).padStart(3)} holders${danger}`);
}

say('\n── CHANNELS ' + '─'.repeat(66));
const render = (c) => {
  const ow = out.channels.find(x => x.id === c.id);
  const flags = [ow.nsfw && 'nsfw', ow.locked && 'locked', ow.slowmode && `slow:${ow.slowmode}s`].filter(Boolean);
  const act = channelAgg.get(c.id);
  const msgs = act ? `${act.messages} msgs` : '';
  say(`    ${(TYPE[c.type] ?? c.type).padEnd(12)} ${c.name.padEnd(30)} ${msgs.padEnd(11)} ${flags.join(' ')}`);
};
for (const cat of cats) {
  say(`\n  ▸ ${cat.name}`);
  for (const c of kids(cat.id)) render(c);
}
const orphans = channels.filter(c => !c.parent_id && c.type !== 4);
if (orphans.length) { say('\n  ▸ (no category)'); for (const c of orphans) render(c); }

say('\n\n── BOTS ' + '─'.repeat(70));
say(`  ${bots.length} bot members · ${out.scan.bots.length} distinct speakers found in history\n`);
for (const b of out.scan.bots) {
  const gone = b.inGuild === false ? '  ⚠ NOT IN GUILD (left)' : '';
  say(`  ${b.name.padEnd(24)} ${String(b.messages).padStart(5)} msgs  ${String(b.templates.length).padStart(3)} templates  ` +
      `${day(new Date(b.first))} → ${day(new Date(b.last))}${gone}`);
  say(`      channels: ${b.channels.join(', ').slice(0, 100)}`);
}
const silent = bots.filter(m => !out.scan.bots.some(b => b.id === m.user.id));
if (silent.length) {
  say(`\n  SILENT bots (in guild, zero messages — a text scan cannot see what they do):`);
  for (const m of silent) say(`      ${m.user.username}`);
}

say('\n── OTHER ' + '─'.repeat(69));
say(`  emoji ${out.emojis.count} · stickers ${out.stickers.length} · soundboard ${out.soundboard.length}`);
say(`  automod rules ${out.automod.length}${out.automod.length ? ': ' + out.automod.map(r => r.name).join(', ') : ' — NONE'}`);
say(`  integrations ${out.integrations.length} · invites ${out.invites.length} · webhooks ${webhooks.length}`);
for (const w of webhooks) say(`      webhook "${w.name}" in #${w.channel} (app ${w.appId ?? '—'})`);
say(`\n  scanned ${scanned} messages across ${scannable.length} channels\n`);

if (jsonAt) { writeFileSync(jsonAt, JSON.stringify(out, null, 2)); say(`  → ${jsonAt}`); }
process.exit(0);
