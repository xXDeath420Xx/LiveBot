// Replace the placeholder music message with the REAL interactive panel —
// the exact structure produced by core/music-panel.js#buildComponents() for
// an idle queue. Buttons start disabled; on first /play, MusicPanel.updatePanel()
// will enable + restyle them. The "How to use" embed in #music stays pinned alongside.
//
// Doesn't move the music_panels row — patches the existing message in place
// so the bot's startup loader (index.js:637-660) picks it up unchanged.

import 'dotenv/config';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';

const GUILD_ID = '1414753158999179286';
const BOT_ID   = '1507873568095076425';

const [botRows] = await pool.execute('SELECT bot_token FROM custom_bots WHERE bot_id = ?', [BOT_ID]);
const TOKEN = encryption.decrypt(JSON.parse(botRows[0].bot_token));

async function api(method, path, body) {
    await new Promise(r => setTimeout(r, 150));
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
    if (!res.ok) return { __err: { status: res.status, body: (await res.text()).slice(0, 400) } };
    return res.status === 204 ? null : res.json();
}

// Fetch bot's own user object → use displayAvatarURL equivalent
const me = await api('GET', '/users/@me');
const botAvatarUrl = me.avatar
    ? `https://cdn.discordapp.com/avatars/${me.id}/${me.avatar}.png?size=256`
    : null;
console.log(`Bot: ${me.username}  avatar: ${botAvatarUrl?.slice(0,80)}…`);

// Find the music_panels row
const [panels] = await pool.execute('SELECT channel_id, message_id FROM music_panels WHERE guild_id=?', [GUILD_ID]);
if (!panels.length) { console.error('No music_panels row for this guild'); process.exit(1); }
const { channel_id: CHANNEL_ID, message_id: MSG_ID } = panels[0];
console.log(`Existing panel: channel=${CHANNEL_ID}  message=${MSG_ID}`);

// Match MusicPanel.buildEmbed() idle-state output
const embed = {
    type: 'rich',
    author: { name: 'Live Music Player' },
    title: 'The queue is empty',
    description: 'Add a song using the dropdown menu below to get started.',
    color: 0x2B2D31,
    thumbnail: botAvatarUrl ? { url: botAvatarUrl } : undefined,
    footer: { text: 'Use the controls below to manage the music.' },
};

// Match MusicPanel.buildComponents() — 3 action rows, all idle-disabled except the select
// Button styles: 1=Primary, 2=Secondary, 3=Success, 4=Danger
// Component types: 1=ActionRow, 2=Button, 3=StringSelect
const components = [
    // playbackRow: 5 buttons, all disabled when no queue
    {
        type: 1,
        components: [
            { type: 2, custom_id: 'music-play-pause', label: '⏸️',       style: 1, disabled: true },
            { type: 2, custom_id: 'music-skip',       label: '⏭️',       style: 2, disabled: true },
            { type: 2, custom_id: 'music-stop',       label: '⏹️',       style: 4, disabled: true },
            { type: 2, custom_id: 'music-shuffle',    label: '🔀',       style: 2, disabled: true },
            { type: 2, custom_id: 'music-loop',       label: '🔁',       style: 2, disabled: true },
        ],
    },
    // extrasRow: 4 buttons, all disabled when no queue
    {
        type: 1,
        components: [
            { type: 2, custom_id: 'music-vol-down', label: '🔉',       style: 2, disabled: true },
            { type: 2, custom_id: 'music-vol-up',   label: '🔊',       style: 2, disabled: true },
            { type: 2, custom_id: 'music-queue',    label: '📋 Queue', style: 1, disabled: true },
            { type: 2, custom_id: 'music-clear',    label: '🗑️',       style: 2, disabled: true },
        ],
    },
    // songRequestRow: select menu — ALWAYS enabled, this is how members add songs
    {
        type: 1,
        components: [
            {
                type: 3,
                custom_id: 'music-add-song',
                placeholder: 'Add a song or start a DJ',
                options: [
                    { label: 'Add song/playlist by name or URL', description: 'Add a song, YouTube playlist, or Spotify playlist', value: 'add_song_modal' },
                    { label: 'Start an AI DJ session',           description: 'AI-generated playlist or play from a playlist link', value: 'start_dj_modal' },
                ],
            },
        ],
    },
];

const r = await api('PATCH', `/channels/${CHANNEL_ID}/messages/${MSG_ID}`, {
    embeds: [embed],
    components,
});
if (r?.__err) {
    console.error(`PATCH failed: ${r.__err.status} ${r.__err.body}`);
    // If the message was deleted, post a fresh one and update the music_panels row
    if (r.__err.status === 404) {
        const fresh = await api('POST', `/channels/${CHANNEL_ID}/messages`, { embeds: [embed], components });
        if (fresh?.__err) { console.error(`Re-post failed: ${fresh.__err.body}`); process.exit(1); }
        await pool.execute('UPDATE music_panels SET message_id=? WHERE guild_id=?', [fresh.id, GUILD_ID]);
        console.log(`Re-posted: new message_id=${fresh.id}`);
    } else {
        process.exit(1);
    }
} else {
    console.log(`✓ Patched panel message ${MSG_ID} with real components`);
    console.log(`  • 5 playback buttons (disabled while no queue)`);
    console.log(`  • 4 extras buttons (disabled while no queue)`);
    console.log(`  • 1 song-request select menu (always enabled)`);
    console.log(`  • Bot avatar thumbnail`);
}

console.log('\nRestart the bot so it loads this as the active panel reference:');
console.log('  pm2 restart CertiFriedUtility');

await pool.end();
