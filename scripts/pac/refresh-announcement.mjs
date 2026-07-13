import 'dotenv/config';
import mysql from 'mysql2/promise';
import enc from '/home/death/CertiFriedUtility/utils/encryption.js';

const GUILD = '1099732505243959407';
const ANNOUNCE_CH = '1439738183645401268';
const ANNOUNCE_MSG = '1496391378819747932';
const NEW_BOT_ID = '1496352090950467595';
const COLOR = 0xCDC3FF;

const pool = mysql.createPool({ host: process.env.DB_HOST, user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME });
const [r] = await pool.execute('SELECT bot_token FROM custom_bots WHERE bot_id = ?', [NEW_BOT_ID]);
const token = enc.decrypt(JSON.parse(r[0].bot_token));
await pool.end();
const H = { Authorization: 'Bot ' + token, 'Content-Type': 'application/json' };

const embeds = [
    {
        title: '🐺 THE PAC — FULL SERVER REBUILD',
        description:
            "We've rebuilt the whole house. New structure, new bot, new systems, cleaner hierarchy top-to-bottom.\n\n" +
            "Take a lap through everything below so you know what's here, how to use it, and how to level up inside the Pac.",
        color: COLOR,
    },
    {
        title: '🐺 The Pack Hierarchy',
        color: COLOR,
        description:
            "**Staff tiers**\n" +
            "🥇 **Alpha** — admin / server owner\n" +
            "🥈 **Beta** — moderators (handles day-to-day)\n\n" +
            "**Pack progression** — earn roles by chatting in the server:\n" +
            "• **Level 1 → Pups** — first step in\n" +
            "• **Level 3 → Shoutout Eligible** — unlocks auto-shoutouts\n" +
            "• **Level 5 → Pac Member**\n" +
            "• **Level 10 → Pack Hunter**\n" +
            "• **Level 15 → Pack Warrior**\n" +
            "• **Level 20 → Pack Elder**\n" +
            "• **Level 25 → Pack Legend**\n" +
            "• **Level 30 → Pack Legacy**\n\n" +
            "**Heads up:** XP resets on the 1st of each month. If you drop below level 3, your auto-shoutouts pause until you re-earn it.",
    },
    {
        title: '📜 Get Started',
        color: COLOR,
        fields: [
            { name: '1. #rules', value: "Read the welcome + rules, click **I accept the rules**. You're in. If you don't verify within **7 days**, you're auto-removed — keeps the member list real." },
            { name: '2. #new-family', value: "When you verify, a welcome card drops here with a random line and a fresh member count. Say hi to new faces." },
            { name: '3. #roles', value: "Pick the roles you want. Colors, games, notifications, NSFW access, music — all self-assign." },
            { name: '4. #introductions', value: "Drop an intro so the Pac knows who you are." },
        ],
    },
    {
        title: '🎭 Self-Assignable Roles',
        color: COLOR,
        description:
            "Pick any of these in **#roles**:\n\n" +
            "**🎨 Colors** — one at a time (selecting a new one replaces the old): Purple, Orange, Green, Red, Yellow, Blue\n\n" +
            "**🎮 Games** — multi-select, each unlocks the matching channel: Arc Raiders, Call of Duty, Fortnite, Horror Games, Marvel, World of Warcraft\n\n" +
            "**🔔 Notifications & Extras**\n" +
            "• **📢 Announcements** — get pinged for important server news\n" +
            "• **🎵 Music** — unlocks **#music** so you can queue songs\n" +
            "• **🔞 NSFW Access** — unlocks age-restricted channels. **By toggling this on, you confirm you are of legal age in your jurisdiction.**",
    },
    {
        title: '🎬 Auto-Shoutouts for Streamers',
        color: COLOR,
        description:
            "Hit **level 3** by chatting in the server and you automatically get the **Shoutout Eligible** role.\n\n" +
            "Once you're eligible, paste your stream URL in **#stream-signup** and the bot auto-signs you up. When you go live, the shoutout drops in **#live-streams** automatically.\n\n" +
            "**Supported:** Twitch, Kick, YouTube, TikTok, Trovo, Facebook.\n\n" +
            "**Rules**\n" +
            "• Non-link messages in #stream-signup are deleted automatically\n" +
            "• Post below level 3 → removed + DM explaining why\n" +
            "• If XP resets and you drop below level 3, shoutouts pause until you earn it again\n" +
            "• **#self-promo** is the only place to drop stream/social links outside of signup — anywhere else they're removed",
    },
    {
        title: '💡 Community Features',
        color: COLOR,
        fields: [
            { name: '🎂 Birthdays', value: "Run `/birthday set` to get announced in **#birthdays** on your day. 12 birthdays are already imported from the old system." },
            { name: '💡 Suggestions', value: "**#suggestions** is now a forum channel — each suggestion gets its own thread with upvote 👍 and status tags: **New / Discussing / Accepted / Rejected / Implemented**." },
            { name: '🎵 Music Panel', value: "Grab the **Music** role, head to **#music**. Persistent playback panel with play / pause / skip / loop / queue controls. Use `/play song name or URL` to start a queue." },
            { name: '🛠️ Support Tickets', value: "Open **#open-a-ticket** → a private channel gets created for you and the mod team. Don't DM staff or ping them — tickets are the way." },
            { name: '📊 Leveling', value: "XP per message, level-up notifications in **#levels**, role rewards at 8 thresholds (L1 → L30), monthly reset on the 1st." },
        ],
    },
    {
        title: '🛡️ Safety & Security',
        color: COLOR,
        description:
            "Behind-the-scenes protection running 24/7:\n\n" +
            "• **Anti-nuke** — catches mass-channel / mass-role deletes and strips the attacker\n" +
            "• **Anti-raid** — detects coordinated joins (especially new accounts) and auto-mutes\n" +
            "• **Adaptive anti-spam** — cross-channel spam detection with baseline learning\n" +
            "• **Self-bot detection** — catches automated chat tools\n" +
            "• **Phishing filter** — malicious links auto-deleted\n" +
            "• **Discord-invite filter** — no poaching our members\n" +
            "• **Global ban network** — known bad actors blocked on join, across all servers using the bot\n" +
            "• **Native Discord AutoMod** — mass-mention + flagged-word protection\n" +
            "• **7-day unverified auto-kick** — members who don't verify get cleaned up\n" +
            "• **NSFW content gated** by an opt-in age-confirmation role\n\n" +
            "**Staff see all of this** in a dedicated staff-only log category, split by event type — no noise, real signal.",
    },
    {
        title: '📝 Logging',
        color: COLOR,
        description:
            "Everything staff needs to know gets logged in its own channel:\n\n" +
            "• **#member-log** — joins, leaves, role changes\n" +
            "• **#message-log** — deletes, edits, pins\n" +
            "• **#mod-log** — bans, unbans, kicks, timeouts, automod actions, invite activity\n" +
            "• **#voice-log** — voice channel activity\n" +
            "• **#channel-log** — channel/thread/stage/event create-update-delete\n" +
            "• **#role-log** — role create/update/delete\n\n" +
            "Hierarchy/placement churn is intentionally suppressed (moving channels doesn't spam the log). **32 event types** tracked in total.",
    },
    {
        title: '🌐 Social Feeds (admin-managed)',
        color: COLOR,
        description:
            "Admins can wire any channel to auto-receive posts from:\n\n" +
            "• **Twitter / X** — new tweets from tracked accounts\n" +
            "• **Bluesky** — posts from tracked handles (public AppView, no auth needed)\n" +
            "• **YouTube** — new uploads\n" +
            "• **Reddit** — new posts from tracked subs\n" +
            "• **Instagram** — via Meta Graph API (token setup pending)\n" +
            "• **Facebook Pages** — live and ready\n\n" +
            "Configure at certifriedmultitool.com → your server → Feeds.",
    },
    {
        title: '🐺 Final Word',
        color: COLOR,
        description:
            "The server runs on **Twatwaffle Patrol** — same codebase as the rest of the Pac's ecosystem, just our own branded instance.\n\n" +
            "**If anything looks off** — panels broken, role rewards not firing, log channel spamming, a feature you remember not working — open a ticket in **#open-a-ticket** and we'll sort it.\n\n" +
            "**We rise together. We win together.** Welcome home, Pac.",
    },
];

const res = await fetch(`https://discord.com/api/v10/channels/${ANNOUNCE_CH}/messages/${ANNOUNCE_MSG}`, {
    method: 'PATCH', headers: H, body: JSON.stringify({ embeds })
});
console.log('patch status:', res.status);
if (!res.ok) { console.log(await res.text()); process.exit(1); }
const m = await res.json();
console.log('message now has', m.embeds?.length, 'embeds');
for (const e of m.embeds || []) console.log('  •', e.title);
