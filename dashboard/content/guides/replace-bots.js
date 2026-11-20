// Checked against: core/takeover-bots.js (the bot catalogue and coverage), core/takeover-manager.js (detectBots,
// plan, apply), core/guild-analyzer.js (scan depths), core/bot-retirement.js (removal checks, DATA_HOLDERS, 24h soak,
// integration delete or kick), dashboard/routes/api/features/takeover.js (owner-only routes, typed confirmations),
// dashboard/views/partials/manage/takeover.ejs, commands/admin/takeover.js, core/command-mounts.js (takeover under
// /utilities), commands/admin/utilities.js, core/manage-nav.js.
export default {
    slug: 'replace-bots',
    title: 'Replace other bots',
    area: 'tools',
    summary: 'Find the bots in your server that CertiFried can stand in for, set up the replacements, and remove the old bots without losing anything.',
    result: {
        image: 'replace-bots-discord',
        caption: 'The reply to /utilities takeover bots: which bots CertiFried covers, and one to keep.',
    },
    before: [
        'The page is on the dashboard under **Bot & server setup**, then **Replace other bots**. Anyone with **Manage Server** can scan and preview. Only the server owner can approve the profile, send the owner\'s questions, post panels and remove a bot, and only the owner can use `/utilities takeover`.',
    ],
    steps: [
        {
            title: 'Scan the server',
            text: [
                'Pick how far back to read: **Full history**, **Last 90 days** or **Quick (1k / channel)**, which reads the last 1,000 messages in each channel. Press **Start scan**. The scan posts, edits and deletes nothing, and you can cancel it and **Resume** later.',
                'The bot knows about 50 other bots by name, MEE6, Dyno, Carl-bot, Arcane, YAGPDB and Streamcord among them, and says for each whether it covers all of that bot\'s job, part of it, or nothing (keep those).',
            ],
        },
        {
            title: 'Account for every bot\'s messages',
            text: [
                '**What we found** lists every bot and webhook that has ever posted. Open one to see each kind of message it posts. **Read every bot\'s messages and classify them** sorts them for you; anything it is unsure of is left for you to explain.',
                'Under **This server\'s profile**, **Read the history** finds which streamer the old bot announces, where its role panels are and which `!commands` people type. The owner checks it and presses **Approve**.',
            ],
        },
        {
            title: 'Set up the replacements',
            text: [
                '**Get the link** under **What the server owner wants** makes a private questionnaire for the server owner, who often has no dashboard login. Treat the link like a key; **Revoke link** turns it off.',
                'Under **Apply feature parity**, press **Preview plan**, tick the steps you want and press **Apply selected**. This writes settings only, carrying live values across: a counting channel carries on from the old bot\'s last number. It never posts, edits or deletes a message and never removes a bot.',
            ],
            command: '/utilities takeover plan',
        },
        {
            title: 'Remove the old bots',
            text: [
                'Under **Take over**, **Post the role panels** puts up CertiFried\'s own panels, and **Preview the full takeover** runs the same checks as the real run without changing anything.',
                'A bot can only be removed when every check passes at that moment: CertiFried replaces everything it does here, every kind of message it posts is accounted for, our highest role is above its highest role, any data it holds was exported, and the replacement has been running for 24 hours. The owner may skip the 24-hour wait by typing `SKIP SOAK`, but never the other checks.',
                'Type the server name and press **Remove this bot**, or **Run the takeover** to do them all.',
            ],
        },
    ],
    notes: [
        'Some bots keep data that leaves with them: levels in MEE6 and Arcane, levels and currency in Tatsu, balances in UnbelievaBoat, reaction-role panels and tags in Carl-bot, and custom command scripts in YAGPDB. Removal stays blocked until the owner confirms the export with the **I exported** button.',
        'Jobs that need a person to choose a channel or a role, such as welcome messages and auto-roles, cannot be checked automatically. Set them up, then press **I set these up myself**.',
        'A removed bot\'s integration is deleted, which also clears its slash commands. If that fails, the bot is kicked.',
        '`/utilities takeover plan` shows the plan in Discord with an **Apply** button that works for 10 minutes. `/utilities takeover execute` is a dry run unless you add `confirm:` with the server name, and a real run needs a finished dashboard scan. As on the dashboard, the 24-hour wait is kept unless you add `waive-soak:True`.',
        'Bots with nothing to replace, such as DISBOARD or Xenon, can never be removed from here.',
    ],
    related: ['backups', 'getting-started', 'custom-bot'],
};
