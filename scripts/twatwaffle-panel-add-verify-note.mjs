// Patch message 1496387932561473586 in Twatwaffle's signup channel to add a
// "/socials streamer list" verification note. Buttons are unchanged.

import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';

const TWAT_BOT    = '1496352090950467595';
const TWAT_SIGNUP = '1496351044567961620';
const TWAT_MSG    = '1496387932561473586';
const TWAT_OUTPUT = '1496351043372716053';
const TWAT_MIN_LEVEL = 3;
const STREAMER_ROLE = '1503901082642813060';
const AUTO_ADD_ROLE = '1503901083632799874';

const [rows] = await pool.execute('SELECT bot_token FROM custom_bots WHERE bot_id=?', [TWAT_BOT]);
const token = encryption.decrypt(JSON.parse(rows[0].bot_token));

async function api(method, path, body) {
  const r = await fetch(`https://discord.com/api/v10${path}`, {
    method, headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status}: ${await r.text()}`);
  return r.status === 204 ? null : r.json();
}

const newEmbed = {
  type: 'rich',
  title: '📡 Streaming Opt-In',
  description: [
    `**How this works** — two buttons below.\n`,
    `**📣 Streamer (Ping Me)** — open self-assign. Grab the **Streamer** role any time you want to be pingable as a streamer. No level required, no auto-announcements.`,
    ``,
    `**🎙️ Auto-Add (Level 3+)** — opt into automatic live announcements in <#${TWAT_OUTPUT}>.`,
    `Reach **level ${TWAT_MIN_LEVEL}** first; you'll automatically get the **Shoutout Eligible** role at that threshold. Then click the button to receive the **Auto-Add** role and join the auto-announce rotation.`,
    `(Twitch streams only for now.)`,
    ``,
    `**Verify you're being tracked**`,
    `After opting in, run \`/socials streamer list\` anywhere in the server to see every account the bot is watching for you (grouped by platform). If your stream isn't listed, you're not in the rotation yet.`,
    ``,
    `**Notes**`,
    `• If your level drops below ${TWAT_MIN_LEVEL} after an XP reset, the gate blocks new opt-ins but your existing Auto-Add role isn't auto-revoked.`,
    `• Click the same button again to remove the role at any time.`,
    `• No URL-drop flow here anymore — buttons only.`,
  ].join('\n'),
  color: 0x9146FF,
};

const buttons = [{
  type: 1,
  components: [
    { type: 2, style: 2, label: 'Streamer (Ping Me)',  emoji: { name: '📣' }, custom_id: `rr_${STREAMER_ROLE}` },
    { type: 2, style: 1, label: 'Auto-Add (Level 3+)', emoji: { name: '🎙️' }, custom_id: `rr_${AUTO_ADD_ROLE}` },
  ],
}];

await api('PATCH', `/channels/${TWAT_SIGNUP}/messages/${TWAT_MSG}`, {
  content: '',
  embeds: [newEmbed],
  components: buttons,
});
console.log('Panel message patched with /socials streamer list verification note.');

await pool.end();
