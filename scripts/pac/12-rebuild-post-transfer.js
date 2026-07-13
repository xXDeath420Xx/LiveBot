// After transferring guild 1099732505243959407 from CertiFried → TwatWaffle Patrol,
// re-post channel content under the new bot's identity so panels/embeds don't look
// orphaned. TwatWaffle deletes the old CertiFried-authored messages (ManageMessages)
// and re-creates equivalents, updating DB refs so handlers still work.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createPool } from './shared.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const state = JSON.parse(fs.readFileSync(path.join(__dirname, 'pac-state.json'), 'utf8'));

const GUILD = '1099732505243959407';
const NEW_BOT_ID = '1496352090950467595';  // Twatwaffle Patrol
const OLD_BOT_ID = '1409904443125665875';  // CertiFried Utility (no longer in guild)

const RULES_CH       = '1496351042017824859';
const ROLES_CH       = '1456056474097680394';
const SIGNUP_CH      = '1496351044567961620';
const STAFF_CH       = '1439738949462392902';
const NEW_FAMILY_CH  = state.channels.newFaces || '1496363559314128926';
const LIVE_STREAMS   = state.channels.liveStreams;
const TICKETS_PANEL  = state.channels.ticketsPanel;

const COLOR = 0xCDC3FF;

async function getToken(pool) {
    const enc = (await import('../../utils/encryption.js')).default;
    const [r] = await pool.execute('SELECT bot_token FROM custom_bots WHERE bot_id = ?', [NEW_BOT_ID]);
    if (!r.length) throw new Error('TwatWaffle Patrol bot not found in custom_bots');
    return enc.decrypt(JSON.parse(r[0].bot_token));
}

function H(token, extra = {}) {
    return { Authorization: 'Bot ' + token, 'Content-Type': 'application/json', ...extra };
}

async function deleteOldBotMessages(token, channelId) {
    let deleted = 0;
    const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages?limit=50`, { headers: H(token) });
    if (!res.ok) { console.log(`  ✗ fetch ${channelId}: ${res.status}`); return 0; }
    const msgs = await res.json();
    for (const m of msgs) {
        if (m.author?.id !== OLD_BOT_ID) continue;
        const d = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages/${m.id}`, { method: 'DELETE', headers: H(token) });
        if (d.ok) deleted++;
    }
    return deleted;
}

async function postMessage(token, channelId, body) {
    const r = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
        method: 'POST', headers: H(token), body: JSON.stringify(body)
    });
    if (!r.ok) {
        console.log(`  ✗ post to ${channelId}: ${r.status} ${await r.text()}`);
        return null;
    }
    return r.json();
}

// ───── Rules channel — 7 embeds + verify button ─────
async function rebuildRules(token, pool) {
    console.log('\n== #rules ==');
    const deleted = await deleteOldBotMessages(token, RULES_CH);
    console.log(`  deleted ${deleted} old CertiFried messages`);

    const embeds = [
        {
            title: '🐺 WELCOME TO THE PAC',
            description: "**Where Family Fuels the Grind**\n\n" +
                "You've just stepped into a community built on support, loyalty, and real growth.\n" +
                "Here, you're not just a username — **you're Pac**.\n\n" +
                "This server won't magically grow your stream. But if you show up, support others, and move with the Pac mentality, you **will** grow — and you'll never grow alone.",
            color: COLOR,
        },
        {
            title: '🌟 What The Pac Is About',
            description: "• A streamer-support system built on **give first, receive second**\n" +
                "• A community where **everyone eats**, not just the loudest voices\n" +
                "• A safe, welcoming space where you can be yourself\n" +
                "• A place to build **real connections**, not empty follow-for-follow nonsense\n" +
                "• A family that hypes your wins and has your back on the rough days",
            color: COLOR,
        },
        {
            title: '📜 Community Values',
            color: COLOR,
            fields: [
                { name: '🐺 Family First', value: "We treat each other with respect, kindness, and loyalty.\nNo drama. No ego. No tearing others down. We support organic growth — the grind." },
                { name: '🔥 Support Over Self-Promotion', value: "You grow by lifting others.\nYou get out what you put in — always." },
                { name: '🌙 Safe Space Energy', value: "No hate, harassment, or toxicity.\nEveryone deserves to feel welcome and safe here." },
                { name: '💬 Real Engagement', value: "We don't do ghost support.\nIf you're here, be present, be genuine, be part of the Pac." },
            ],
        },
        {
            title: '📌 Expectations',
            description: "**✔️ Support Others Before Asking for Support**\n" +
                "Watch their streams, chat, lurk, share, hype — the same way you want them to support you.\n\n" +
                "**✔️ Be Active in the Community**\n" +
                "Say hello. Join conversations. Show up for events. This is a family, not a billboard.\n\n" +
                "**✔️ Respect Everyone**\n" +
                "Mods, streamers, lurkers, newcomers — everyone matters.\n\n" +
                "**✔️ Keep It Real**\n" +
                "No fake engagement, no begging, no spam. We grow through authenticity.",
            color: COLOR,
        },
        {
            title: '🚫 Not Allowed',
            description: "• Hate speech, harassment, or discrimination\n" +
                "• Self-promo outside designated channels\n" +
                "• Drama, instigating, or stirring negativity\n" +
                "• Follow-for-follow or view-for-view schemes\n" +
                "• Posting NSFW content outside the NSFW channel\n" +
                "• Using the Pac for clout without giving back",
            color: COLOR,
        },
        {
            title: '🎉 How to Get Started',
            description: "**1.** Read the rules and hit the **I accept the rules** button below to verify.\n" +
                "**2.** Introduce yourself in the **introductions** channel.\n" +
                "**3.** Check out the support channels and start showing love.\n" +
                "**4.** Add your stream info in **stream-signup** once you hit **level 3**.\n" +
                "**5.** Join events, raids, and community nights.\n" +
                "**6.** Become part of the family — not just a visitor.",
            color: COLOR,
        },
        {
            title: '🐺 Final Word',
            description: "This community is built on showing up with **love, kindness, and respect**.\n\n" +
                "If you give to the Pac, the Pac gives back tenfold.\n" +
                "**We rise together. We win together.**\n\n" +
                "_Welcome home._",
            color: COLOR,
        },
    ];

    const intro = await postMessage(token, RULES_CH, { embeds });
    console.log(`  intro posted: ${intro?.id}`);

    const verifyEmbed = {
        title: '✅ Ready to join the Pac?',
        description: "Click the button below to accept everything above and unlock the rest of the server.\n\n*You have 7 days after joining to verify before being auto-removed.*",
        color: COLOR,
    };
    const verify = await postMessage(token, RULES_CH, {
        embeds: [verifyEmbed],
        components: [{ type: 1, components: [{ type: 2, style: 3, label: 'I accept the rules', emoji: { name: '✅' }, custom_id: 'verify_accept' }] }],
    });
    console.log(`  verify button posted: ${verify?.id}`);

    if (verify?.id) {
        await pool.execute('UPDATE verify_config SET gate_message_id = ? WHERE guild_id = ?', [verify.id, GUILD]);
        console.log(`  verify_config.gate_message_id updated`);
    }
}

// ───── Roles channel — 3 reaction role panels ─────
async function rebuildRoles(token, pool) {
    console.log('\n== #roles ==');
    const deleted = await deleteOldBotMessages(token, ROLES_CH);
    console.log(`  deleted ${deleted} old CertiFried messages`);

    // Load the existing panel configs from DB — mappings already in reaction_role_mappings
    const [panels] = await pool.execute(
        "SELECT * FROM reaction_role_panels WHERE guild_id = ? AND channel_id = ? ORDER BY id ASC",
        [GUILD, ROLES_CH]
    );
    console.log(`  found ${panels.length} panels in DB`);

    for (const panel of panels) {
        const [mappings] = await pool.execute(
            'SELECT role_id, emoji_id, label FROM reaction_role_mappings WHERE panel_id = ? ORDER BY id ASC',
            [panel.id]
        );
        if (!mappings.length) { console.log(`  panel #${panel.id} (${panel.panel_name}): no mappings, skip`); continue; }

        const embed = {
            title: panel.panel_name,
            description: panel.description,
            color: parseInt((panel.embed_color || '#5865F2').replace('#', ''), 16),
        };
        let components;
        if (panel.interaction_type === 'button') {
            // Build buttons using customId = `rr_<roleId>` so reaction-role-manager resolves it
            components = [{
                type: 1,
                components: mappings.map((m, i) => ({
                    type: 2,
                    style: i === 0 ? 1 : 2, // Primary + Secondary
                    label: m.label || '(role)',
                    emoji: m.emoji_id ? { name: m.emoji_id } : undefined,
                    custom_id: `rr_${m.role_id}`,
                })),
            }];
        } else {
            // Select menu. customId = rr_select for the manager's prefix matcher.
            components = [{
                type: 1,
                components: [{
                    type: 3,
                    custom_id: `rr_select_${panel.panel_name.toLowerCase().replace(/[^a-z]+/g, '_')}`,
                    placeholder: panel.panel_mode === 'unique' ? 'Choose one…' : 'Choose one or more…',
                    min_values: 0,
                    max_values: panel.panel_mode === 'unique' ? 1 : mappings.length,
                    options: mappings.map(m => ({
                        label: m.label || '(role)',
                        value: m.role_id,
                        emoji: m.emoji_id ? { name: m.emoji_id } : undefined,
                    })),
                }],
            }];
        }

        const sent = await postMessage(token, ROLES_CH, { embeds: [embed], components });
        if (sent?.id) {
            await pool.execute('UPDATE reaction_role_panels SET message_id = ? WHERE id = ?', [sent.id, panel.id]);
            console.log(`  panel #${panel.id} (${panel.panel_name}): re-posted msg ${sent.id} with ${mappings.length} mappings`);
        }
    }
}

// ───── Stream signup — instructional embed ─────
async function rebuildStreamSignup(token, pool) {
    console.log('\n== #stream-signup ==');
    const deleted = await deleteOldBotMessages(token, SIGNUP_CH);
    console.log(`  deleted ${deleted} old CertiFried messages`);

    const embed = {
        color: 0x9B59B6,
        title: '📡 Post your stream link to join the auto-shoutout rotation',
        description: [
            `**How this works:** Paste your stream URL in this channel and the bot will auto-sign you up. When you go live, the shoutout drops in <#${LIVE_STREAMS}> automatically.`,
            '',
            '**Requirements**',
            "• Reach **level 3** in the server — you'll get the **Shoutout Eligible** role automatically at lvl 3",
            '• Post a single supported link per message',
            '',
            '**Supported platforms:** Twitch, Kick, YouTube, TikTok, Trovo, Facebook.',
            '',
            '**Rules**',
            '• Non-link messages are removed automatically',
            "• If you're below level 3, your post will be removed and you'll get a DM",
            '• If XP resets on the 1st of the month and you drop below level 3, your shoutouts pause until you re-earn the role',
        ].join('\n'),
    };
    const sent = await postMessage(token, SIGNUP_CH, { embeds: [embed] });
    if (sent?.id) {
        await pool.execute('UPDATE stream_signup_config SET stream_signup_message_id = ? WHERE guild_id = ?', [sent.id, GUILD]);
        console.log(`  instructional embed: ${sent.id}`);
    }
}

// ───── Staff chat + new-family header ─────
async function rebuildMiscHeaders(token) {
    console.log('\n== #staff-chat + #new-family ==');
    for (const [label, chId] of [['staff-chat', STAFF_CH], ['new-family', NEW_FAMILY_CH]]) {
        const deleted = await deleteOldBotMessages(token, chId);
        console.log(`  ${label}: deleted ${deleted} old CertiFried messages`);
    }

    // New-family header
    const sent = await postMessage(token, NEW_FAMILY_CH, {
        embeds: [{
            color: 0x43B581,
            title: '👋 New Faces',
            description: 'This is where we welcome new members to The Pac. When someone verifies, their welcome drops here — say hi!',
        }],
    });
    console.log(`  new-family header: ${sent?.id}`);

    // Staff-chat gets no bot-authored intro — it's a live chat channel, not a bulletin
}

async function main() {
    const pool = createPool();
    try {
        const token = await getToken(pool);
        console.log('acting as Twatwaffle Patrol (' + NEW_BOT_ID + ')');

        await rebuildRules(token, pool);
        await rebuildRoles(token, pool);
        await rebuildStreamSignup(token, pool);
        await rebuildMiscHeaders(token);
        console.log('\nDONE');
    } finally {
        await pool.end();
    }
}

main().catch(err => { console.error('FATAL', err?.stack || err); process.exit(1); });
