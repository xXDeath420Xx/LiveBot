/*
 * Rebuild the Forsaken Warriors Code of Conduct as ONE bot-owned message.
 *
 *   node scripts/post-forsaken-code-of-conduct.mjs [--apply]
 *
 * Without --apply it prints the payload and its size checks and changes nothing.
 *
 * Why: the rules were a plain-text message posted by a MEMBER (mike_da_wckd), sitting above a
 * separate bot message that carried the verify button. A member-posted message cannot be edited by
 * the bot, cannot carry the button, and does not read as an official document. This puts the rules,
 * the Twitch chat rules and the acknowledgement button in a single message the bot owns — so it can
 * be edited in place forever after.
 *
 * The button keeps its EXISTING custom_id (`rr_<VerifiedRoleId>`), so the reaction-role handler
 * (core/reaction-role-manager.js) grants the same Verified role with no other change. Panel 126
 * "Rules Verify" is repointed to the new message id.
 */
import 'dotenv/config';
import mysql from 'mysql2/promise';
import encryption from '../utils/encryption.js';

const GUILD = '1469931133981687873';
const CHANNEL = '1469931510088859730';          // #📒Code-of-Conduct
const VERIFIED_ROLE = '1498502484912635906';
const PANEL_ID = 126;                            // reaction_role_panels "Rules Verify"
const OLD_RULES_MSG = '1470659978124595297';     // member-posted rules
const OLD_VERIFY_MSG = '1498512768599457925';    // bot verify button
const APPLY = process.argv.includes('--apply');

const COC = [
  ['Names & Branding', 'Adopting the FORSAKEN tag is optional. If you leave tFW, remove all tFW/FORSAKEN names, tags and logos within 72 hours.'],
  ['No Poaching', 'Recruiting from other clans is strictly prohibited and results in an automatic ban.'],
  ['Relationships & Drama', 'Keep romantic relationships and personal drama outside the community. Leads do not mediate relationship issues — we are here to game and build friendships.'],
  ['Posting Content', 'Post responsibly and in the correct channels. Minors are present. Selfies are optional and shared at your own discretion.'],
  ['No Bullying', 'Friendly banter is fine; bullying is not. This carries a two-strike rule unless Leadership decides otherwise. Report issues when you see them.'],
  ['Real Life Comes First', 'If you will be inactive, let a Lead know. No personal details required — communication is what matters.'],
  ['Sexual Harassment', 'Zero tolerance. Reports are reviewed by Leads and may result in suspension or ban. Knowingly false accusations carry the same penalty.'],
  ['Report Issues Properly', 'Bring problems to Leads. Do not handle conflicts yourself, especially with other clans.'],
  ['Drama-Free Community', 'We keep things positive and focused on gaming and community.'],
  ['Streamers Only Room', 'That space is reserved for streamers, to keep it safe and controlled.'],
  ['Respect Boundaries', 'If someone asks you to stop, stop immediately. Streamers and Mods may remove disruptive members.'],
  ['Fair Competition', "Cheating, hacking, or using unapproved bots or services that violate Twitch's Terms of Service results in immediate removal from tFW."],
  ['Attendance', 'Be active at least once a week in chat or voice — Leads included. Planned absences will be announced.'],
  ['Privacy', 'What happens in tFW stays in tFW.'],
  ['Respect Everyone', 'Treat others with respect at all times.'],
  ['No Dual Clanning', 'You cannot belong to another ranked clan. If discovered, you must choose one.'],
  ['Ranking Up', 'Earn roles through activity, supporting Ohana/Kapwa and community involvement. Maintain them through continued participation and communication with Leads.'],
];

// From the streamer's Twitch "Chat Rules" panel. Two entries were cut off in the source screenshot
// and are marked below — they are the only lines not quoted verbatim.
const TWITCH = [
  '**This is an 18+ channel.**',
  'Treat others how you want to be treated.',
  "No self-promotion — do not advertise your own channel or socials. Ask, and we'll help promote you instead.", // ⚠ truncated in source
  'We treat everyone as **Ohana**. No racism, and no hate of any kind, will be tolerated.',
  'Do not hate on other streamers — no drama.',
  'Be positive and helpful to other viewers; we were all new once.',
  'Be respectful to Moderators.',
  'Be yourself, and have fun.',
  'Positive and fun vibes only — no negative remarks, and nothing that bashes anyone.', // ⚠ truncated in source
  'No trauma dumping.',
  "Don't be a dick.",
];

const embeds = [
  {
    title: '📒 Forsaken Warriors — Code of Conduct',
    color: 0x8e44ad,
    description:
      'Welcome to **the Forsaken Warriors (tFW)**. These rules keep this a place people actually want to be. '
      + 'By taking part in this server you agree to follow them.\n\n'
      + COC.map(([t, d], i) => `**${i + 1} · ${t}**\n${d}`).join('\n\n'),
  },
  {
    title: '📺 Twitch Chat Rules',
    color: 0x9146ff,
    description:
      'These apply in our streamers’ Twitch chats, alongside everything above.\n\n'
      + TWITCH.map((r, i) => `**${i + 1}.** ${r}`).join('\n'),
  },
  {
    // Accurate to the ACTUAL permission model: @everyone has VIEW_CHANNEL denied server-wide and
    // 90 of 91 channels are hidden — this Code of Conduct channel is the only one an unverified
    // member can see. Verified is what opens the other 78. (The previous copy claimed the opposite.)
    title: '✅ Acknowledge the Code of Conduct',
    color: 0x2ecc71,
    description:
      'Right now this is the **only channel you can see**.\n\n'
      + 'Press the button below to confirm you have read and agree to the **Code of Conduct** and the '
      + `**Twitch Chat Rules**. You will receive the <@&${VERIFIED_ROLE}> role, which unlocks the rest of the server.`,
    footer: { text: 'Questions about any of this? Speak to a Lead or Moderator before accepting.' },
  },
];

const components = [{
  type: 1,
  components: [{
    type: 2, style: 3, label: "I've read and agree to the rules",
    emoji: { name: '✅' }, custom_id: `rr_${VERIFIED_ROLE}`,
  }],
}];

// ── Discord limits: 4096 per description, 6000 across all embeds, 10 embeds, 25 fields ──
let total = 0;
for (const [i, e] of embeds.entries()) {
  const len = (e.title?.length || 0) + (e.description?.length || 0) + (e.footer?.text?.length || 0);
  total += len;
  console.log(`embed ${i}: ${e.description.length} desc chars (limit 4096) — ${e.description.length > 4096 ? 'TOO LONG' : 'ok'}`);
  if (e.description.length > 4096) process.exit(1);
}
console.log(`total across embeds: ${total} (limit 6000) — ${total > 6000 ? 'TOO LONG' : 'ok'}`);
if (total > 6000) process.exit(1);

if (!APPLY) {
  console.log('\n--- DRY RUN (pass --apply to post) ---');
  console.log(embeds.map(e => `\n### ${e.title}\n${e.description}`).join('\n'));
  process.exit(0);
}

const db = await mysql.createConnection({
  host: process.env.DB_HOST, user: process.env.DB_USER,
  password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
});
const [[bot]] = await db.query(
  'SELECT bot_token FROM custom_bots WHERE bot_id = (SELECT bot_id FROM guild_bot_mapping WHERE guild_id = ? LIMIT 1)', [GUILD]);
const H = { Authorization: `Bot ${encryption.decrypt(JSON.parse(bot.bot_token))}`, 'Content-Type': 'application/json' };

// 1) Prefer editing the message we already own — a re-post would change the message id, orphan the
//    panel pointer and re-notify the channel for what is only a copy change.
const [[panel]] = await db.query('SELECT message_id FROM reaction_role_panels WHERE id = ?', [PANEL_ID]);
let msg = null;
if (panel?.message_id) {
  const patch = await fetch(`https://discord.com/api/v10/channels/${CHANNEL}/messages/${panel.message_id}`, {
    method: 'PATCH', headers: H, body: JSON.stringify({ embeds, components }),
  });
  if (patch.status === 200) {
    msg = await patch.json();
    console.log(`edited existing Code of Conduct in place: ${msg.id}`);
  } else {
    console.log(`could not edit ${panel.message_id} (HTTP ${patch.status}) — posting a fresh message`);
  }
}

if (!msg) {
  const res = await fetch(`https://discord.com/api/v10/channels/${CHANNEL}/messages`, {
    method: 'POST', headers: H, body: JSON.stringify({ embeds, components }),
  });
  msg = await res.json();
  if (res.status !== 200) { console.error('POST failed:', res.status, JSON.stringify(msg).slice(0, 400)); await db.end(); process.exit(1); }
  console.log(`posted new Code of Conduct: ${msg.id}`);
}

// 2) keep the reaction-role panel pointed at whatever message is live
await db.query('UPDATE reaction_role_panels SET message_id = ?, channel_id = ? WHERE id = ?', [msg.id, CHANNEL, PANEL_ID]);
console.log(`panel ${PANEL_ID} → ${msg.id}`);

// 3) remove the two superseded messages (backed up in docs/backups/)
for (const [label, id] of [['old member-posted rules', OLD_RULES_MSG], ['old bot verify button', OLD_VERIFY_MSG]]) {
  const d = await fetch(`https://discord.com/api/v10/channels/${CHANNEL}/messages/${id}`, {
    method: 'DELETE', headers: { ...H, 'X-Audit-Log-Reason': 'Code of Conduct consolidated into one bot-owned message' },
  });
  console.log(`deleted ${label} (${id}) -> ${d.status}`);
  await new Promise(r => setTimeout(r, 400));
}

await db.end();
process.exit(0);
