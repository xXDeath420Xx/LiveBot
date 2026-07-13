// Updates the rules+verify panel message to mention self-assignable roles
// in #roles after a user agrees. References #roles by plain text (not a
// channel mention) so it stays readable for un-verified users who can't yet
// see the channel.
//
// REST-only — safe to run while PM2 is up.

import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';

const BOT_ID     = '1502798840124670133';
const RULES_CH   = '1502814397939187884';
const RULES_MSG  = '1502814742249603154';

const [rows] = await pool.execute('SELECT bot_token FROM custom_bots WHERE bot_id=?', [BOT_ID]);
const token  = encryption.decrypt(JSON.parse(rows[0].bot_token));

async function api(method, path, body) {
  const r = await fetch(`https://discord.com/api/v10${path}`, {
    method,
    headers: {
      Authorization: `Bot ${token}`,
      'Content-Type': 'application/json',
      'X-Audit-Log-Reason': 'Add post-verify roles announcement to rules panel',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${await r.text()}`);
  return r.status === 204 ? null : r.json();
}

const current = await api('GET', `/channels/${RULES_CH}/messages/${RULES_MSG}`);
console.log('[rules-update] current author:', current.author?.username, 'embed_count:', current.embeds?.length);
console.log('[rules-update] current components rows:', current.components?.length);

// Preserve the existing rules embed verbatim, then add a SECOND embed for the
// roles announcement so it stands out as its own highlighted block.
const existingEmbeds = current.embeds || [];

const rolesEmbed = {
  title: '🎭 One more thing — grab your roles!',
  description:
    'After you click **✅ I Agree** above, head over to the **#roles** channel.\n\n' +
    'You can self-assign:\n' +
    '• 🎮 **Game roles** — unlock private channels for the games you play (Arc Raiders, Call of Duty, Counterstrike, and more)\n' +
    '• 🔔 **Notification roles** — get pinged for announcements, giveaways, and streams\n\n' +
    'Pick what you want, skip what you don\'t. You can change them anytime.',
  color: 0xF1C40F, // amber/highlight — distinct from the green rules embed
};

await api('PATCH', `/channels/${RULES_CH}/messages/${RULES_MSG}`, {
  embeds: [...existingEmbeds, rolesEmbed],
  // Keep components untouched — the verify button stays.
});

console.log('[rules-update] ✓ patched rules message with roles announcement embed');
await pool.end();
