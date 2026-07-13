// Replace a user-authored hierarchy message in #Leaders with a bot-posted,
// properly-formatted version. Posts new first; deletes old only on success.
import 'dotenv/config';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';

const BOT_ID    = '1498486251576229958';
const CHANNEL   = '1469932427647516856';            // #Leaders (text)
const OLD_MSG   = '1505449689640865913';

const CONTENT = [
  '# 🏛️ Kitsune Server — Role Hierarchy & Chain of Command',
  '> Roles listed top-down by authority. Each block lists current holders, what the role can do, and who that role reports to.',
  '',
  '━━━━━━━━━━━━━━━━━━━━━━━',
  '',
  '**Owner** — <@&1470260643998208101>',
  '👤 <@533297810309906444>',
  '✦ All Access · Full control · Final oversight',
  '✦ Reports to: *Top of hierarchy*',
  '',
  '**Founder(s)** — <@&1469932798638035197>',
  '👤 <@316037348733353984>',
  '✦ All Access · Full control · 2nd in command / final oversight',
  '✦ Reports to: <@&1470260643998208101>',
  '',
  '**Head Admin** *(single seat)* — <@&1470108472325570690>',
  '👤 <@365905620060340224>',
  '✦ All Access · Full control',
  '✦ Oversight of admin/mod roles + permissions · bot management & control',
  '✦ Reports to: <@&1469932798638035197> · <@&1470260643998208101>',
  '',
  '**Co-Head** *(single seat)* — <@&1470860854009401366>',
  '👤 *Open*',
  '✦ All Access · Full control',
  '✦ Oversight on all administrative actions',
  '✦ Reports to: <@&1470108472325570690>',
  '',
  '**Co-Owners** — <@&1469932629003468917>',
  '👤 <@1089432531641831474> · <@1326803672679579669>',
  '✦ Nearly full access:',
  '   • Invites · Bans',
  '   • Create / delete channels',
  '   • Move users',
  '   • Delete messages in chats',
  '   • Access to all rooms',
  '✦ Reports to: <@&1469932798638035197> · <@&1470260643998208101>',
  '',
  '**Mods** — <@&1470666282280943740>',
  '👤 <@817782486507454504> · <@477972657384718336> · <@684441860747427872>',
  '✦ Permissions:',
  '   • Invites · Bans',
  '   • Message deletion',
  '   • Enter locked rooms',
  '✦ Reports to: <@&1469932798638035197> · <@&1470260643998208101> · <@&1470860854009401366> · <@&1470108472325570690>',
  '',
  '**Jr. Mods** — <@&1470665850112446546>',
  '👤 <@1339054976663818333>',
  '✦ Permissions:',
  '   • Invites · Bans',
  '   • Message deletion',
  '✦ Reports to: <@&1469932798638035197> · <@&1470260643998208101> · <@&1470860854009401366> · <@&1470108472325570690> · <@&1470666282280943740>',
].join('\n');

console.log('Content length:', CONTENT.length, '/ 2000');
if (CONTENT.length > 2000) { console.error('TOO LONG'); process.exit(1); }

const [rows] = await pool.execute('SELECT bot_token FROM custom_bots WHERE bot_id = ?', [BOT_ID]);
const token = encryption.decrypt(JSON.parse(rows[0].bot_token));

async function api(method, path, body) {
  const init = {
    method,
    headers: { Authorization: 'Bot ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  };
  const r = await fetch(`https://discord.com/api/v10${path}`, init);
  if (!r.ok) throw new Error(`${r.status} ${method} ${path}: ${(await r.text()).slice(0, 250)}`);
  return r.status === 204 ? null : r.json();
}

// Post new — suppress all mention notifications (chips still render).
const posted = await api('POST', `/channels/${CHANNEL}/messages`, {
  content: CONTENT,
  allowed_mentions: { parse: [] },
});
console.log(`✓ Posted new hierarchy message (${posted.id})`);

// Delete old only after successful post
await api('DELETE', `/channels/${CHANNEL}/messages/${OLD_MSG}`);
console.log(`✓ Deleted original message (${OLD_MSG})`);

await pool.end();
console.log('\nDone.');
