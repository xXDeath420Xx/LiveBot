// Lessen the level gating in "Welcome to The Pac!" (1099732505243959407).
//
// The owner wants ONLY the streaming channels level-gated. Everything else —
// #events included — should be open to anyone who has verified.
//
// An audit of every channel overwrite found that the Pups (level 1) and
// Pac Member (level 5) overwrites are redundant almost everywhere: the Verified
// role already grants the same or more on those channels, so they were never a
// real gate. Only three gates actually bite:
//
//   KEEP  #📡┃stream-signup   stream_signup_config.level_gate = 3 (the signup button)
//   KEEP  #🎬┃live-streams    Verified is denied SEND; Pups (L1) grants it
//   FIX   #🎵┃music           Verified is denied VIEW; only Pups (L1) or the
//                             self-assignable Music role could see the channel
//   FIX   #🎉┃events          channel_post_rules.min_level = 2
//
// #events keeps require_image — the poster rule stays, only the level gate goes,
// so a bare twitch link is still removed but any verified member can advertise.
//
// Idempotent: re-running reports "already open" and changes nothing.
// DB write + REST-only Discord call — safe while PM2 is running.

import 'dotenv/config';
import mysql from 'mysql2/promise';

const GUILD_ID  = '1099732505243959407';
// The acting bot comes from guild_bot_mapping — never pinned here.
const EVENTS_CH = '1456057618542887058';
const MUSIC_CH  = '1496351045566206002';
const VERIFIED  = '1457183768186982485';

const VIEW = 1024n;
const SEND = 2048n;

let conn;
try {
  const { resolveBotForGuild } = await import('../../utils/bot-resolver.js');

  conn = await mysql.createConnection({
    host: process.env.DB_HOST, user: process.env.DB_USER,
    password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
    port: process.env.DB_PORT || 3306,
  });

  // ── 1. #events: drop the level gate, keep the poster requirement ───────────
  const [[before]] = await conn.execute(
    'SELECT min_level, require_image FROM channel_post_rules WHERE guild_id = ? AND channel_id = ?',
    [GUILD_ID, EVENTS_CH]
  );

  if (!before) {
    console.log('#events : no posting rule row — nothing to relax');
  } else if (before.min_level === 0) {
    console.log(`#events : already ungated (image required: ${before.require_image ? 'yes' : 'no'})`);
  } else {
    await conn.execute(
      'UPDATE channel_post_rules SET min_level = 0 WHERE guild_id = ? AND channel_id = ?',
      [GUILD_ID, EVENTS_CH]
    );
    console.log(`#events : min_level ${before.min_level} -> 0 (image still required: ${before.require_image ? 'yes' : 'no'})`);
  }

  // ── 2. #music: let Verified see it, not just level 1+ ──────────────────────
  const bot = await resolveBotForGuild(GUILD_ID, { db: conn });
  const auth = bot.auth;

  const res = await fetch(`https://discord.com/api/v10/channels/${MUSIC_CH}`, { headers: { Authorization: auth } });
  const channel = await res.json();
  if (!channel?.id) throw new Error(`could not read #music: ${JSON.stringify(channel)}`);

  const ow = (channel.permission_overwrites || []).find(o => o.id === VERIFIED);
  const allow = (BigInt(ow?.allow ?? 0) | VIEW | SEND);
  const deny  = (BigInt(ow?.deny  ?? 0) & ~VIEW & ~SEND);

  if (ow && BigInt(ow.allow) === allow && BigInt(ow.deny) === deny) {
    console.log('#music  : Verified can already see and post — unchanged');
  } else {
    const put = await fetch(`https://discord.com/api/v10/channels/${MUSIC_CH}/permissions/${VERIFIED}`, {
      method: 'PUT',
      headers: {
        Authorization: auth,
        'Content-Type': 'application/json',
        'X-Audit-Log-Reason': 'Open #music to all verified members (level gate removed by owner request)',
      },
      body: JSON.stringify({ type: 0, allow: allow.toString(), deny: deny.toString() }),
    });
    if (!put.ok) throw new Error(`#music overwrite failed: ${put.status} ${await put.text()}`);
    console.log(`#music  : Verified allow ${ow?.allow ?? 0} -> ${allow}, deny ${ow?.deny ?? 0} -> ${deny}`);
  }

  // ── 3. Report the gates that stay ─────────────────────────────────────────
  const [[signup]] = await conn.execute(
    'SELECT level_gate FROM stream_signup_config WHERE guild_id = ?', [GUILD_ID]
  );
  console.log('\nStill gated, as asked:');
  console.log(`  #📡┃stream-signup : signup requires level ${signup?.level_gate ?? '(no config)'}`);
  console.log('  #🎬┃live-streams  : posting requires level 1 (Pups); Verified can read only');
} catch (e) {
  console.error('ERR', e.message);
  process.exitCode = 1;
} finally {
  await conn?.end().catch(() => {});
}
