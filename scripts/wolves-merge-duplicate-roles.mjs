// Merge duplicate Streamers/Supporters roles in guild 1428091358522114090
// and post a Self-Roles reaction panel so members can self-assign.
//
// REST-only via DarkWolf's token. Idempotent — every step checks current
// state before acting.

import 'dotenv/config';
import {
    EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
    Client, GatewayIntentBits,
} from 'discord.js';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';

const GUILD_ID = '1428091358522114090';
const BOT_ID   = '1506374126594691092';
const ROLES_CHANNEL_ID = '1506378069022212188';  // #roles (now under 𝚆𝚎𝚕𝚌𝚘𝚖𝚎 𝙸𝚗)

// Canonical role id → duplicate role id (to delete)
const MERGES = [
    { name: 'Streamers',  canonical: '1428139684290232392', duplicate: '1428139754964258886' },
    { name: 'Supporters', canonical: '1428139836031762513', duplicate: '1428139929015292054' },
];

// Self-roles panel mappings: role_id → button config
const SELF_ROLES = [
    { id: '1428139684290232392', label: 'Streamer',  emoji: '🎥', style: ButtonStyle.Primary,   desc: 'I create stream content in this community.' },
    { id: '1428139836031762513', label: 'Supporter', emoji: '💜', style: ButtonStyle.Secondary, desc: 'I support this community.' },
];

const [rows] = await pool.execute('SELECT bot_token FROM custom_bots WHERE bot_id = ?', [BOT_ID]);
if (!rows.length) { console.error('Bot row missing'); process.exit(1); }
const TOKEN = encryption.decrypt(JSON.parse(rows[0].bot_token));

async function api(method, path, body) {
    await new Promise(r => setTimeout(r, 100));
    const res = await fetch(`https://discord.com/api/v10${path}`, {
        method,
        headers: { Authorization: `Bot ${TOKEN}`, 'Content-Type': 'application/json' },
        body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429) {
        const j = await res.json().catch(() => ({}));
        await new Promise(rs => setTimeout(rs, (j.retry_after || 1) * 1000 + 300));
        return api(method, path, body);
    }
    if (!res.ok) return { __err: { status: res.status, body: (await res.text()).slice(0, 300) } };
    return res.status === 204 ? null : res.json();
}

console.log('=== Wolves: merge duplicate roles + self-roles panel ===\n');

// Step 1: fetch all members (need them to find who holds the dup roles)
console.log('[1] Fetching members…');
const members = [];
let after = '0';
while (true) {
    const page = await api('GET', `/guilds/${GUILD_ID}/members?limit=1000&after=${after}`);
    if (page?.__err || !page.length) break;
    members.push(...page);
    if (page.length < 1000) break;
    after = page[page.length - 1].user.id;
}
console.log(`    ✓ ${members.length} members\n`);

// Step 2: merge each duplicate pair
for (const { name, canonical, duplicate } of MERGES) {
    console.log(`[2] Merge ${name}: ${duplicate} → ${canonical}`);
    const holders = members.filter(m => (m.roles || []).includes(duplicate));
    if (!holders.length) {
        console.log(`    = no members hold the duplicate (already merged?)`);
    }
    for (const m of holders) {
        const uid = m.user.id;
        const hasCanon = (m.roles || []).includes(canonical);
        // Grant canonical first (PUT is idempotent — no-op if already assigned)
        if (!hasCanon) {
            const g = await api('PUT', `/guilds/${GUILD_ID}/members/${uid}/roles/${canonical}`);
            if (g?.__err) { console.log(`    ✗ grant ${name} to ${m.user.username}: ${g.__err.status}`); continue; }
        }
        // Remove duplicate
        const r = await api('DELETE', `/guilds/${GUILD_ID}/members/${uid}/roles/${duplicate}`);
        if (r?.__err) console.log(`    ✗ remove dup from ${m.user.username}: ${r.__err.status}`);
        else          console.log(`    ✓ ${m.user.username}: granted ${name}, removed dup`);
    }
    // Delete the duplicate role itself
    const del = await api('DELETE', `/guilds/${GUILD_ID}/roles/${duplicate}`);
    if (del?.__err) {
        // If role already gone from a previous run, that's fine
        if (del.__err.status === 404) console.log(`    = duplicate role already deleted`);
        else                          console.log(`    ✗ delete duplicate role: ${del.__err.status} ${del.__err.body}`);
    } else {
        console.log(`    ✓ deleted duplicate role ${duplicate}`);
    }
    console.log('');
}

// Step 3: post / refresh Self-Roles panel in #roles
console.log('[3] Posting Self-Roles panel in #roles…');

// Use Discord.js for embed/button building (small, throwaway)
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
await client.login(TOKEN);
await new Promise(resolve => client.once('clientReady', resolve));
const guild = await client.guilds.fetch(GUILD_ID);
const channel = await guild.channels.fetch(ROLES_CHANNEL_ID);
if (!channel) { console.error('roles channel not accessible'); client.destroy(); await pool.end(); process.exit(1); }

// Find existing self-roles panel by panel_name in DB; if exists, edit; else post new.
const [existing] = await pool.execute(
    `SELECT id, message_id FROM reaction_role_panels WHERE guild_id = ? AND panel_name = ? ORDER BY id DESC LIMIT 1`,
    [GUILD_ID, 'self-roles']
);

const embed = new EmbedBuilder()
    .setColor(0xE91E63)
    .setTitle('🎭 Self Roles')
    .setDescription('Click a button below to toggle a community-identity role.')
    .addFields(
        ...SELF_ROLES.map(r => ({ name: `${r.emoji} ${r.label}`, value: r.desc, inline: true }))
    );

const row = new ActionRowBuilder().addComponents(
    ...SELF_ROLES.map(r => new ButtonBuilder()
        .setCustomId(`rr_${r.id}`)
        .setLabel(r.label)
        .setStyle(r.style)
        .setEmoji(r.emoji))
);

let msg = null;
if (existing.length && existing[0].message_id) {
    msg = await channel.messages.fetch(existing[0].message_id).catch(() => null);
}
if (msg) {
    await msg.edit({ embeds: [embed], components: [row] });
    console.log(`    ✓ updated existing self-roles message ${msg.id}`);
} else {
    msg = await channel.send({ embeds: [embed], components: [row] });
    console.log(`    ✓ posted new self-roles message ${msg.id}`);
}

await pool.execute(
    `INSERT INTO reaction_role_panels (guild_id, channel_id, message_id, panel_name, description, embed_color, interaction_type, panel_mode)
     VALUES (?, ?, ?, 'self-roles', 'Community identity roles', '#E91E63', 'button', 'standard')
     ON DUPLICATE KEY UPDATE message_id = VALUES(message_id), channel_id = VALUES(channel_id), embed_color = VALUES(embed_color)`,
    [GUILD_ID, ROLES_CHANNEL_ID, msg.id]
);
const [[panel]] = await pool.execute(
    `SELECT id FROM reaction_role_panels WHERE guild_id = ? AND panel_name = 'self-roles' ORDER BY id DESC LIMIT 1`,
    [GUILD_ID]
);
await pool.execute('DELETE FROM reaction_role_mappings WHERE panel_id = ?', [panel.id]);

const styleName = (s) => ({
    [ButtonStyle.Primary]:   'primary',
    [ButtonStyle.Secondary]: 'secondary',
    [ButtonStyle.Success]:   'success',
    [ButtonStyle.Danger]:    'danger',
}[s] || 'primary');

for (const r of SELF_ROLES) {
    await pool.execute(
        `INSERT INTO reaction_role_mappings (panel_id, role_id, emoji_id, label, button_style) VALUES (?, ?, ?, ?, ?)`,
        [panel.id, r.id, r.emoji, r.label, styleName(r.style)]
    );
}
console.log(`    ✓ reaction_role_mappings reseeded for panel ${panel.id} (${SELF_ROLES.length} buttons)`);

client.destroy();
await pool.end();
console.log('\nDone.');
