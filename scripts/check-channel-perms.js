import 'dotenv/config';
import encryption from '../utils/encryption.js';
import pool from '../utils/db.js';

const BOT_ID = '1476040458680406214';
const GUILD_ID = '902393911958470717';
const CHANNEL_ID = '1318141825009319936';
const MESSAGE_ID = '1493172452677652541';

const [rows] = await pool.execute('SELECT bot_token FROM custom_bots WHERE bot_id = ?', [BOT_ID]);
const token = encryption.decrypt(JSON.parse(rows[0].bot_token));
const auth = { Authorization: `Bot ${token}` };

// Fetch channel
const chRes = await fetch(`https://discord.com/api/v10/channels/${CHANNEL_ID}`, { headers: auth });
const ch = await chRes.json();
console.log('=== Channel ===');
console.log(`Name: ${ch.name}, type: ${ch.type}, parent: ${ch.parent_id}`);
console.log(`Overwrites: ${ch.permission_overwrites?.length || 0}`);

// Fetch bot's member object in guild
const meRes = await fetch(`https://discord.com/api/v10/users/@me`, { headers: auth });
const me = await meRes.json();
console.log(`\n=== Bot ===\n${me.username} (${me.id})`);

const memRes = await fetch(`https://discord.com/api/v10/guilds/${GUILD_ID}/members/${me.id}`, { headers: auth });
const mem = await memRes.json();
console.log(`Roles: ${mem.roles.join(', ')}`);

// Fetch all guild roles to compute permissions
const rolesRes = await fetch(`https://discord.com/api/v10/guilds/${GUILD_ID}/roles`, { headers: auth });
const allRoles = await rolesRes.json();

// Compute base permissions from roles
const everyoneRole = allRoles.find(r => r.id === GUILD_ID);
let basePerms = BigInt(everyoneRole?.permissions || '0');
for (const roleId of mem.roles) {
    const role = allRoles.find(r => r.id === roleId);
    if (role) basePerms |= BigInt(role.permissions);
}

// Apply channel overwrites
let perms = basePerms;
const everyoneOw = ch.permission_overwrites?.find(o => o.id === GUILD_ID);
if (everyoneOw) {
    perms &= ~BigInt(everyoneOw.deny);
    perms |= BigInt(everyoneOw.allow);
}
let allow = 0n, deny = 0n;
for (const ow of ch.permission_overwrites || []) {
    if (ow.type === 0 && mem.roles.includes(ow.id)) {
        allow |= BigInt(ow.allow);
        deny |= BigInt(ow.deny);
    }
}
perms &= ~deny;
perms |= allow;
const memberOw = ch.permission_overwrites?.find(o => o.type === 1 && o.id === me.id);
if (memberOw) {
    perms &= ~BigInt(memberOw.deny);
    perms |= BigInt(memberOw.allow);
}

const PERMS = {
    SEND_MESSAGES: 1n << 11n,
    EMBED_LINKS: 1n << 14n,
    ADD_REACTIONS: 1n << 6n,
    READ_MESSAGE_HISTORY: 1n << 16n,
    VIEW_CHANNEL: 1n << 10n,
    USE_EXTERNAL_EMOJIS: 1n << 18n,
    ADMINISTRATOR: 1n << 3n,
};

console.log('\n=== Effective channel perms ===');
for (const [name, bit] of Object.entries(PERMS)) {
    console.log(`${(perms & bit) ? '✅' : '❌'} ${name}`);
}

// Try to react and reply RIGHT NOW (will fail with duplicate reaction if already there)
console.log('\n=== Attempting reaction ===');
const reactRes = await fetch(
    `https://discord.com/api/v10/channels/${CHANNEL_ID}/messages/${MESSAGE_ID}/reactions/%E2%9C%85/@me`,
    { method: 'PUT', headers: auth }
);
console.log(`React status: ${reactRes.status} ${reactRes.statusText}`);
if (!reactRes.ok) console.log('Body:', await reactRes.text());

// Check existing reactions on the message
const msgRes = await fetch(`https://discord.com/api/v10/channels/${CHANNEL_ID}/messages/${MESSAGE_ID}`, { headers: auth });
const msg = await msgRes.json();
console.log(`\n=== Existing reactions on message ===`);
console.log(JSON.stringify(msg.reactions || [], null, 2));

process.exit(0);
