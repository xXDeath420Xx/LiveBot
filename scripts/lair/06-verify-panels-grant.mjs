// Phase C — verify button, reaction-role panels, stream-signup embed, music panel, bulk Verified grant.
// Preserves existing MEE6-posted rules content in #welcome-and-rules-channel; we add OUR button beneath.
import 'dotenv/config';
import fs from 'fs';
import mysql from 'mysql2/promise';

const GUILD = '1216126780767731722';
const state = JSON.parse(fs.readFileSync('/home/death/CertiFriedUtility/scripts/lair/state.json', 'utf8'));
const CH = state.channels;
const R = state.roles;
const token = process.env.DISCORD_TOKEN;
const H = { Authorization: 'Bot ' + token, 'Content-Type': 'application/json' };
const COLOR = 0xCDC3FF;

const pool = mysql.createPool({ host: process.env.DB_HOST, user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME });

async function rest(method, url, body) {
    const r = await fetch(url, { method, headers: H, body: body && JSON.stringify(body) });
    if (!r.ok) throw new Error(`${method} ${url}: ${r.status} ${await r.text()}`);
    return r.status === 204 ? null : r.json();
}

// ─────────── 1. Verify button in #welcome-and-rules-channel ───────────
console.log('== verify button ==');
const verifyEmbed = {
    title: '✅ Ready to enter the Lair?',
    description:
        "Read Mama Bear's rules above, then click the button below to accept them and unlock the rest of the server.\n\n" +
        "*You have 7 days after joining to verify. Unverified members get auto-removed after that to keep the member list real.*",
    color: COLOR,
};
const verifyMsg = await rest('POST', `https://discord.com/api/v10/channels/${CH.rules}/messages`, {
    embeds: [verifyEmbed],
    components: [{ type: 1, components: [{ type: 2, style: 3, label: 'I accept the rules', emoji: { name: '✅' }, custom_id: 'verify_accept' }] }],
});
await pool.execute('UPDATE verify_config SET gate_message_id = ? WHERE guild_id = ?', [verifyMsg.id, GUILD]);
console.log(`  verify button posted: ${verifyMsg.id}`);

// ─────────── 2. Reaction role panels in #roles ───────────
console.log('\n== reaction role panels ==');
// Clear existing bot-posted content (should be empty — new channel — but just in case)
try {
    const msgs = await rest('GET', `https://discord.com/api/v10/channels/${CH.rolesCh}/messages?limit=50`);
    for (const m of msgs) await rest('DELETE', `https://discord.com/api/v10/channels/${CH.rolesCh}/messages/${m.id}`);
} catch {}
await pool.execute('DELETE FROM reaction_role_panels WHERE guild_id = ? AND channel_id = ?', [GUILD, CH.rolesCh]);

// COLORS
const colors = [
    { emoji: '🟣', roleId: R['Purple'] }, { emoji: '🟠', roleId: R['Orange'] },
    { emoji: '🟢', roleId: R['Green']  }, { emoji: '🔴', roleId: R['Red']    },
    { emoji: '🟡', roleId: R['Yellow'] }, { emoji: '🔵', roleId: R['Blue']   },
];
const colorEmbed = { color: COLOR, title: '🎨 Color Roles', description: "Pick the color you want next to your name.\n_One color at a time — selecting a new one replaces the old._" };
const colorMenu = { type: 3, custom_id: 'rr_select_colors', placeholder: 'Choose a color…', min_values: 0, max_values: 1,
    options: colors.map(c => ({ label: 'Color ' + c.emoji, value: c.roleId, emoji: { name: c.emoji } })) };
const colorMsg = await rest('POST', `https://discord.com/api/v10/channels/${CH.rolesCh}/messages`, { embeds: [colorEmbed], components: [{ type: 1, components: [colorMenu] }] });
const [{ insertId: colorPanelId }] = await pool.execute(
    `INSERT INTO reaction_role_panels (guild_id, channel_id, message_id, panel_name, description, embed_color, interaction_type, panel_mode) VALUES (?, ?, ?, 'Color Roles', 'Pick one color', '#CDC3FF', 'select_menu', 'unique')`,
    [GUILD, CH.rolesCh, colorMsg.id]);
for (const c of colors) await pool.execute('INSERT INTO reaction_role_mappings (panel_id, role_id, emoji_id, label) VALUES (?, ?, ?, ?)', [colorPanelId, c.roleId, c.emoji, 'Color ' + c.emoji]);
console.log(`  colors panel: ${colorMsg.id}`);

// NOTIFICATIONS (Announcements + Music + NSFW Access)
const notifEmbed = { color: COLOR, title: '🔔 Notifications & Extras', description:
    "Toggle opt-in access and pings:\n\n" +
    "📢 **Announcements** — get pinged for important server news\n" +
    "🎵 **Music** — unlocks **#music** so you can queue songs\n" +
    "🔞 **NSFW Access** — unlocks age-restricted channels. **By toggling this on, you confirm you are of legal age in your jurisdiction.**",
};
const notifButtons = {
    type: 1, components: [
        { type: 2, style: 1, label: 'Announcements', emoji: { name: '📢' }, custom_id: 'rr_' + R['Announcements'] },
        { type: 2, style: 2, label: 'Music',         emoji: { name: '🎵' }, custom_id: 'rr_' + R['Music'] },
        { type: 2, style: 4, label: 'NSFW Access',   emoji: { name: '🔞' }, custom_id: 'rr_' + R['NSFW Access'] },
    ],
};
const notifMsg = await rest('POST', `https://discord.com/api/v10/channels/${CH.rolesCh}/messages`, { embeds: [notifEmbed], components: [notifButtons] });
const [{ insertId: notifPanelId }] = await pool.execute(
    `INSERT INTO reaction_role_panels (guild_id, channel_id, message_id, panel_name, description, embed_color, interaction_type, panel_mode) VALUES (?, ?, ?, 'Notifications', 'Toggle opt-in roles', '#CDC3FF', 'button', 'multiple')`,
    [GUILD, CH.rolesCh, notifMsg.id]);
for (const [rid, emoji, label] of [[R['Announcements'],'📢','Announcements'],[R['Music'],'🎵','Music'],[R['NSFW Access'],'🔞','NSFW Access']]) {
    await pool.execute('INSERT INTO reaction_role_mappings (panel_id, role_id, emoji_id, label) VALUES (?, ?, ?, ?)', [notifPanelId, rid, emoji, label]);
}
console.log(`  notifications panel: ${notifMsg.id}`);

// ─────────── 3. Stream-signup embed ───────────
console.log('\n== #stream-signup ==');
const signupEmbed = {
    color: 0x9B59B6, title: '📡 Post your stream link to join the auto-shoutout rotation',
    description: [
        `**How this works:** Paste your stream URL in this channel and the bot auto-signs you up. When you go live, the shoutout drops in <#${CH.whosLiveNow}> automatically.`,
        '',
        '**Requirements**',
        "• Reach **level 3** in the server — you'll get the **Shoutout Eligible** role automatically",
        '• Post a single supported link per message',
        '',
        '**Supported platforms:** Twitch, Kick, YouTube, TikTok, Trovo, Facebook.',
        '',
        '**Rules**',
        '• Non-link messages are removed automatically',
        "• Below level 3? Your post is removed + you get a DM explaining why",
        "• XP resets monthly; if you drop below level 3, your shoutouts pause until you re-earn it",
    ].join('\n'),
};
const signupMsg = await rest('POST', `https://discord.com/api/v10/channels/${CH.streamSignup}/messages`, { embeds: [signupEmbed] });
await pool.execute('UPDATE stream_signup_config SET stream_signup_message_id = ? WHERE guild_id = ?', [signupMsg.id, GUILD]);
console.log(`  signup embed: ${signupMsg.id}`);

// ─────────── 4. Music panel ───────────
console.log('\n== music panel ==');
const musicEmbed = {
    color: 0x2B2D31, title: 'The queue is empty',
    description: 'Add a song using the dropdown menu below to get started.',
    footer: { text: 'Use the controls below to manage the music.' },
    author: { name: 'Live Music Player' },
};
const musicComponents = [
    { type: 1, components: [
        { type: 2, style: 1, label: '⏸️', custom_id: 'music-play-pause', disabled: true },
        { type: 2, style: 2, label: '⏭️', custom_id: 'music-skip',       disabled: true },
        { type: 2, style: 4, label: '⏹️', custom_id: 'music-stop',       disabled: true },
        { type: 2, style: 2, label: '🔀', custom_id: 'music-shuffle',    disabled: true },
        { type: 2, style: 2, label: '🔁', custom_id: 'music-loop',       disabled: true },
    ]},
    { type: 1, components: [
        { type: 2, style: 2, label: '🔉', custom_id: 'music-vol-down',  disabled: true },
        { type: 2, style: 2, label: '🔊', custom_id: 'music-vol-up',    disabled: true },
        { type: 2, style: 1, label: '📋 Queue', custom_id: 'music-queue', disabled: true },
        { type: 2, style: 2, label: '🗑️', custom_id: 'music-clear',    disabled: true },
    ]},
    { type: 1, components: [{ type: 3, custom_id: 'music-add-song', placeholder: 'Add a song or start a DJ', options: [
        { label: 'Add song/playlist by name or URL', description: 'Add a song, YouTube playlist, or Spotify playlist', value: 'add_song_modal' },
        { label: 'Start an AI DJ session', description: 'AI-generated playlist or play from a playlist link', value: 'start_dj_modal' },
    ] }] },
];
const musicMsg = await rest('POST', `https://discord.com/api/v10/channels/${CH.music}/messages`, { embeds: [musicEmbed], components: musicComponents });
await pool.execute('INSERT INTO music_panels (guild_id, channel_id, message_id) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE channel_id=VALUES(channel_id), message_id=VALUES(message_id)', [GUILD, CH.music, musicMsg.id]);
console.log(`  music panel: ${musicMsg.id}`);

// ─────────── 5. Bulk-grant Verified to all non-bot current members ───────────
console.log('\n== bulk Verified grant ==');
const recon = JSON.parse(fs.readFileSync('/home/death/CertiFriedUtility/scripts/lair/recon.json', 'utf8'));
let granted = 0, skipped = 0, failed = 0;
for (const m of recon.members) {
    if (m.user.bot) { skipped++; continue; }
    if (m.roles.includes(R['Verified'])) { skipped++; continue; }
    try {
        const r = await fetch(`https://discord.com/api/v10/guilds/${GUILD}/members/${m.user.id}/roles/${R['Verified']}`, { method: 'PUT', headers: H });
        if (r.ok) granted++;
        else failed++;
        if ((granted + failed) % 50 === 0) console.log(`  progress: granted=${granted}, failed=${failed}`);
    } catch { failed++; }
}
console.log(`  granted Verified to ${granted} members (skipped ${skipped}, failed ${failed})`);

await pool.end();
console.log('\nDONE');
