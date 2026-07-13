// Replace every MEE6 message in #welcome-and-rules-channel with a consolidated rules message
// owned by Twatwaffle/CertiFried. Migrate the 2 sensible MEE6 reaction-role panels into
// #roles (followers/subscribers + gaming opt-ins). Skip the "family adoption" reaction
// role — those role grants need Mama's explicit confirmation per MEE6's original note.
import 'dotenv/config';
import fs from 'fs';
import mysql from 'mysql2/promise';

const GUILD = '1216126780767731722';
const state = JSON.parse(fs.readFileSync('/home/death/CertiFriedUtility/scripts/lair/state.json', 'utf8'));
const CH = state.channels;
const R = state.roles;
const COLOR = 0xCDC3FF;
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
        if (!r.ok) throw new Error(`${method} ${url}: ${r.status} ${await r.text()}`);
        return r.status === 204 ? null : r.json();
    }
    throw new Error(`${method} ${url}: exhausted 429 retries`);
}

// ─────────── 1. Delete every message in #welcome-and-rules-channel ───────────
console.log('== nuking existing content in #welcome-and-rules-channel ==');
let deleted = 0;
while (true) {
    const msgs = await rest('GET', `https://discord.com/api/v10/channels/${CH.rules}/messages?limit=100`);
    if (!msgs || !msgs.length) break;
    // bulk-delete recent (<14d), single-delete rest
    const recent = msgs.filter(m => Date.now() - new Date(m.timestamp).getTime() < 14 * 24 * 60 * 60 * 1000);
    const old = msgs.filter(m => Date.now() - new Date(m.timestamp).getTime() >= 14 * 24 * 60 * 60 * 1000);
    if (recent.length >= 2) {
        const bd = await fetch(`https://discord.com/api/v10/channels/${CH.rules}/messages/bulk-delete`, {
            method: 'POST', headers: H, body: JSON.stringify({ messages: recent.map(m => m.id) })
        });
        if (bd.ok) deleted += recent.length;
    } else if (recent.length === 1) {
        await rest('DELETE', `https://discord.com/api/v10/channels/${CH.rules}/messages/${recent[0].id}`);
        deleted++;
    }
    for (const m of old) {
        await rest('DELETE', `https://discord.com/api/v10/channels/${CH.rules}/messages/${m.id}`);
        deleted++;
    }
    if (msgs.length < 100) break;
}
console.log(`  deleted ${deleted} messages`);

// ─────────── 2. Post consolidated rules (content sourced from MEE6 archive, re-issued as Lair Bear) ───────────
const embeds = [
    {
        title: "🐻 Welcome to Mama Bear's Lair",
        description:
            "Hello and a warm welcome to all of my New MemBEARS! 👋\n" +
            "I'm thrilled to have you join my **Sleuth** here on Discord! ❤️\n\n" +
            "🤝 Please, take some time to introduce yourself to The Sleuth — share a bit about yourself, your interests, and what brings you here.\n\n" +
            "📜 Before you dive in, **read through everything below.** Itty Bitty Bear and I want everyone to have a great time here, and following the guidelines helps create a positive, fun environment for everyone.\n\n" +
            "🐻 🍯 🧡",
        color: COLOR,
    },
    {
        title: "⚠️ 14+ / Adult Content Notice",
        description:
            "Like Mama Bear's Twitch, this Discord is **14+** — but it *also* contains **adult content, adult language, and adult humor**.\n\n" +
            "By clicking **I accept the rules** below, you are agreeing that you have parental consent (if applicable) to be in a space with adult themes. You are removing any and all liability from Mama Bear's hands, as you have been warned of the content of this Discord and still chose to enter.\n\n" +
            "**YOU HAVE BEEN WARNED.**",
        color: COLOR,
    },
    {
        title: "📜 Guidelines",
        color: COLOR,
        fields: [
            { name: "Guideline #1 — English-only chat", value: "Mama Bear only speaks English fluently. She is also fluent in Typonese. While we love learning about other languages, please keep The Sleuth's chat in English as much as *BEARILY* possible." },
            { name: "Guideline #2 — Respect each other", value: "We're all human (er, bears). We all have identities (some of us multiple). We all deserve respect — both here and on Twitch. *Except spiders. Spiders can die in a fiery inferno.* If anything or anyone makes you uncomfortable, tell Mama or a ModBear. We can't help if we don't know." },
            { name: "Guideline #3 — Post in the right channel", value: "Mostly 18+ content throughout the Sleuth. NSFW channels are strictly 18+, no exceptions. Check the channel before posting. Repeated violations = warning → further action." },
            { name: "Guideline #6 — No drama", value: "Take disagreements to DMs. If you can't work it out, bring it to the ModBears or Mama. Do not post screenshots to/from other servers for gossip and drama." },
            { name: "Guideline #8 — Triggers & private info", value: "Use `||spoilers||` around potentially triggering content. Do **not** post other people's private information without consent." },
        ],
    },
    {
        title: "🛡️ Gender Respect — Safe Space Policy",
        description:
            "**This is a safe space for ALL.** Gender identity and preferred pronouns *will* be respected for all people at all times. Period.\n\n" +
            "Just as Mama has a name that you call her out of respect, she also has preferred pronouns (she/her). This is no different for *anyone* in this Family. Occasional slip-ups happen — **repeated** misgendering is intentional and hurtful.\n\n" +
            "**Enforcement ladder:**\n" +
            "• **1st Warning** — spoken to and given the correct pronouns\n" +
            "• **2nd Warning** — spoken to again + **7-day mute**\n" +
            "• **FINAL Warning** — booted and banned",
        color: COLOR,
    },
    {
        title: "⚖️ General Warning Scale",
        description:
            "All warnings and bans are applied by ModBears or Mama on this scale:\n\n" +
            "• **1st Warning** — spoken to\n" +
            "• **2nd Warning** — spoken to + muted for 1 day\n" +
            "• **3rd Warning** — spoken to + muted for 7 days\n" +
            "• **FINAL Warning** — booted and banned\n\n" +
            "_**All rules are subject to common sense and may change as needed.**_",
        color: COLOR,
    },
    {
        title: "🚫 No Unsolicited Services",
        description:
            "Unsolicited offers of art services, graphic design, stream management, or similar services are **NOT** welcome here.\n\n" +
            "The Lair has family members who — when asked — perform these services for other family members for free. We do not need anyone soliciting for money.\n\n" +
            "• **1st offense in-server** — message deleted, booted + banned.\n" +
            "• **Unsolicited DM offense** — auto-booted + banned.\n\n" +
            "Harassment is not tolerated.",
        color: COLOR,
    },
    {
        title: "🐻 Your ModBears (as of this posting)",
        description:
            "The ModBears keep this cozy corner of Discord warm and safe for everyone. 🍵\n\n" +
            "Open a ticket in **#mama-and-the-modbears-help** (or use any ping-channel) to report issues. ModBears **do not handle issues via DMs** — if someone is harassing you in DMs, report to Discord Trust & Safety and block them.\n\n" +
            "**Team:** @HamstaXCass (Lead), @nonbinarycatdad, @WildWolf944, @jamie_bat, @knifelady01 & @drock052422 (co-mods), @spazoid420, @Bubbamike77, @Rustynail (+ FerociousMango via Twitch proxy), @Mousey, @demarco9000",
        color: COLOR,
    },
];
const mainMsg = await rest('POST', `https://discord.com/api/v10/channels/${CH.rules}/messages`, { embeds });
console.log(`\nposted consolidated rules: ${mainMsg.id}`);

// ─────────── 3. Verify button on its own final message ───────────
const verifyMsg = await rest('POST', `https://discord.com/api/v10/channels/${CH.rules}/messages`, {
    embeds: [{
        title: '✅ Ready to enter the Lair?',
        description: "Click the button below to accept everything above and unlock the rest of the server.\n\n*You have 7 days after joining to verify before being auto-removed.*",
        color: COLOR,
    }],
    components: [{ type: 1, components: [{ type: 2, style: 3, label: 'I accept the rules', emoji: { name: '✅' }, custom_id: 'verify_accept' }] }],
});
await pool.execute('UPDATE verify_config SET gate_message_id = ? WHERE guild_id = ?', [verifyMsg.id, GUILD]);
console.log(`posted verify button: ${verifyMsg.id}`);

// ─────────── 4. Migrate the 2 sensible reaction-role panels into #roles ───────────
console.log('\n== reaction-role migration ==');

// Panel: Follower/Subscriber tier (existing Lair Bear + Honeyed Lair Bear roles)
const LAIR_BEAR = R['Lair Bear'];
// Find Honeyed Lair Bear id directly from recon since it wasn't exported to role-ids.json
const recon = JSON.parse(fs.readFileSync('/home/death/CertiFriedUtility/scripts/lair/recon.json', 'utf8'));
const honeyed = recon.roles.find(r => r.name === 'Honeyed Lair Bear');
const HONEYED = honeyed?.id;

if (LAIR_BEAR && HONEYED) {
    const followEmbed = { color: COLOR, title: "🐻 Follower & Subscriber Tiers",
        description: "Show Mama you're watching.\n\n" +
            "• Clicked **Follow** on Mama Bear's Twitch? Grab **Lair Bear**.\n" +
            "• Subscribed (or got a gifted sub) too? Grab **Honeyed Lair Bear** as well." };
    const followButtons = { type: 1, components: [
        { type: 2, style: 1, label: 'Lair Bear',         emoji: { name: '🐻' }, custom_id: 'rr_' + LAIR_BEAR },
        { type: 2, style: 3, label: 'Honeyed Lair Bear', emoji: { name: '🍯' }, custom_id: 'rr_' + HONEYED },
    ]};
    const fMsg = await rest('POST', `https://discord.com/api/v10/channels/${CH.rolesCh}/messages`, { embeds: [followEmbed], components: [followButtons] });
    const [{ insertId: fPanelId }] = await pool.execute(
        `INSERT INTO reaction_role_panels (guild_id, channel_id, message_id, panel_name, description, embed_color, interaction_type, panel_mode) VALUES (?, ?, ?, 'Follower Tiers', 'Follower + subscriber self-assign', '#CDC3FF', 'button', 'multiple')`,
        [GUILD, CH.rolesCh, fMsg.id]);
    for (const [rid, emoji, label] of [[LAIR_BEAR,'🐻','Lair Bear'],[HONEYED,'🍯','Honeyed Lair Bear']]) {
        await pool.execute('INSERT INTO reaction_role_mappings (panel_id, role_id, emoji_id, label) VALUES (?, ?, ?, ?)', [fPanelId, rid, emoji, label]);
    }
    console.log(`  Follower Tiers panel: ${fMsg.id}`);
}

// Panel: Gaming opt-ins (Twitch Streamer + Palia Community)
const TWITCH_STREAMER = R['Twitch Streamer'];
const PALIA = R['Palia Community'];
if (TWITCH_STREAMER || PALIA) {
    const gameEmbed = { color: COLOR, title: "🎮 Gaming Opt-ins",
        description: "Let the Sleuth know how you play:\n\n" +
            "• **Twitch Streamer** — you stream on Twitch\n" +
            "• **Palia Community** — you play Palia" };
    const gameBtns = [];
    if (TWITCH_STREAMER) gameBtns.push({ type: 2, style: 1, label: 'Twitch Streamer', emoji: { name: '🎥' }, custom_id: 'rr_' + TWITCH_STREAMER });
    if (PALIA) gameBtns.push({ type: 2, style: 2, label: 'Palia Community', emoji: { name: '🌸' }, custom_id: 'rr_' + PALIA });
    const gMsg = await rest('POST', `https://discord.com/api/v10/channels/${CH.rolesCh}/messages`, { embeds: [gameEmbed], components: [{ type: 1, components: gameBtns }] });
    const [{ insertId: gPanelId }] = await pool.execute(
        `INSERT INTO reaction_role_panels (guild_id, channel_id, message_id, panel_name, description, embed_color, interaction_type, panel_mode) VALUES (?, ?, ?, 'Gaming Opt-ins', 'Self-assign streamer/gamer roles', '#CDC3FF', 'button', 'multiple')`,
        [GUILD, CH.rolesCh, gMsg.id]);
    if (TWITCH_STREAMER) await pool.execute('INSERT INTO reaction_role_mappings (panel_id, role_id, emoji_id, label) VALUES (?, ?, ?, ?)', [gPanelId, TWITCH_STREAMER, '🎥', 'Twitch Streamer']);
    if (PALIA) await pool.execute('INSERT INTO reaction_role_mappings (panel_id, role_id, emoji_id, label) VALUES (?, ?, ?, ?)', [gPanelId, PALIA, '🌸', 'Palia Community']);
    console.log(`  Gaming Opt-ins panel: ${gMsg.id}`);
}

// Family-adoption panel — NOT migrated. Left for Mama Bear's manual assignment per the
// original MEE6 message's intent ("don't lie, I know who I've adopted").

console.log('\nDONE');
await pool.end();
