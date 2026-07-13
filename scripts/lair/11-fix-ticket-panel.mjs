// Replace MEE6's orphaned ticket button in #mod-help with CertiFried's proper ticket panel.
import 'dotenv/config';
import fs from 'fs';
import mysql from 'mysql2/promise';

const GUILD = '1216126780727731722'.slice(0, -1) + '2'; // safe typo-proof set
const GUILD_ID = '1216126780767731722';
const state = JSON.parse(fs.readFileSync('/home/death/CertiFriedUtility/scripts/lair/state.json', 'utf8'));
const CH = state.channels;
const R = state.roles;
const token = process.env.DISCORD_TOKEN;
const H = { Authorization: 'Bot ' + token, 'Content-Type': 'application/json' };
const pool = mysql.createPool({ host: process.env.DB_HOST, user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME });

async function rest(method, url, body) {
    for (let i = 0; i < 5; i++) {
        const r = await fetch(url, { method, headers: H, body: body && JSON.stringify(body) });
        if (r.status === 429) {
            const b = await r.json().catch(() => ({ retry_after: 1 }));
            await new Promise(res => setTimeout(res, Math.ceil((b.retry_after || 1) * 1000) + 150));
            continue;
        }
        if (r.status === 404) return null;
        if (!r.ok) { console.log(`  ${method} ${url}: ${r.status} ${await r.text()}`); return null; }
        return r.status === 204 ? null : r.json();
    }
}

// 1. Delete MEE6's orphaned ticket panel (and any other bot messages in #mod-help)
const MOD_HELP = '1367984616035713065';
const msgs = await rest('GET', `https://discord.com/api/v10/channels/${MOD_HELP}/messages?limit=50`);
let deleted = 0;
for (const m of msgs || []) {
    if (m.author?.bot || m.webhook_id) {
        await rest('DELETE', `https://discord.com/api/v10/channels/${MOD_HELP}/messages/${m.id}`);
        deleted++;
    }
}
console.log(`deleted ${deleted} orphaned bot messages in #mod-help`);

// 2. Upsert ticket_panels row so ticket_create_panel_<panel_id> works
const [existing] = await pool.execute('SELECT panel_id FROM ticket_panels WHERE guild_id = ? AND panel_channel_id = ?', [GUILD_ID, MOD_HELP]);
let panelId;
if (existing.length) {
    panelId = existing[0].panel_id;
    await pool.execute(`UPDATE ticket_panels SET embed_title = ?, embed_description = ?, button_text = ?, button_emoji = ?,
         ticket_category_id = ?, support_role_id = ?, log_channel_id = ?, alert_channel_id = ?, is_active = 1 WHERE panel_id = ?`,
        ['Support Tickets',
         "Got an issue in the Lair ya can't solve? Got something for just Mama Bear and her ModBears? Click below and we'll open a private ticket for ya. 🐻",
         'Open a ticket', '🎫',
         '1368013867203952743',  // Created Tickets category
         R['ModBears'],
         state.channels.modLog, state.channels.modLog, panelId]);
} else {
    const [ins] = await pool.execute(`INSERT INTO ticket_panels (guild_id, panel_name, panel_channel_id, embed_title, embed_description, embed_color,
             button_text, button_emoji, ticket_category_id, support_role_id, ticket_name_format, save_transcripts, log_channel_id, alert_channel_id, is_active)
         VALUES (?, 'Lair Support', ?, ?, ?, '#CDC3FF', ?, '🎫', ?, ?, 'ticket-{user}', 1, ?, ?, 1)`,
        [GUILD_ID, MOD_HELP, 'Support Tickets',
         "Got an issue in the Lair ya can't solve? Got something for just Mama Bear and her ModBears? Click below and we'll open a private ticket for ya. 🐻",
         'Open a ticket', '1368013867203952743', R['ModBears'], state.channels.modLog, state.channels.modLog]);
    panelId = ins.insertId;
}
console.log(`ticket_panels ready, panel_id=${panelId}`);

// 3. Post CertiFried's panel message
const panelMsg = await rest('POST', `https://discord.com/api/v10/channels/${MOD_HELP}/messages`, {
    embeds: [{
        color: 0xCDC3FF, title: '🎫 Support Tickets',
        description: "Got an issue in the Lair ya can't solve? Need to talk to Mama Bear or one of the ModBears privately?\n\n" +
            "Click **Open a ticket** below and a private channel opens for you and the mod team. Don't DM staff or ping them — tickets are the way.",
    }],
    components: [{ type: 1, components: [{ type: 2, style: 1, label: 'Open a ticket', emoji: { name: '🎫' }, custom_id: `ticket_create_panel_${panelId}` }] }],
});
await pool.execute('UPDATE ticket_panels SET panel_message_id = ? WHERE panel_id = ?', [panelMsg.id, panelId]);
console.log(`CertiFried ticket panel posted: ${panelMsg.id}`);

await pool.end();
