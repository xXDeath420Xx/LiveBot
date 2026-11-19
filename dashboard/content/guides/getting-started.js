// Checked against: dashboard/server.js (/invite, /dashboard), commands/admin/setup.js, core/setup-wizard.js,
// dashboard/views/servers-tailwind.ejs, manage-tailwind.ejs overview, core/setup-checklist.js,
// core/command-registration.js (slash and text commands).
export default {
    slug: 'getting-started',
    title: 'Get started with CertiFried',
    area: 'start',
    summary: 'Add the bot to your server, run /setup, and finish setting it up on the dashboard.',
    result: {
        image: 'getting-started-setup',
        caption: 'The reply to /setup. Only the person who ran it can see it.',
    },
    before: [
        'You need the **Manage Server** permission on the Discord server.',
    ],
    steps: [
        {
            title: 'Add the bot to your server',
            text: [
                'Open [Add to Discord](/invite), pick your server and select **Authorize**. This link asks only for the permissions the current features use.',
                'If you would rather manage a single permission, [add it with Administrator](/invite?admin=1) instead.',
            ],
        },
        {
            title: 'Run /setup',
            text: [
                'In any channel, type `/setup` and pick it from the list. The reply shows how many features are already running, which ones are one click away, and two menus.',
                '**Start from a preset…** offers Streaming community, Gaming server, General community, Support / business and Just the safety net. A preset lists what **Apply** turns on now, what needs a channel or role from you first, and what to finish on the dashboard. **Or jump to a category…** lets you choose feature by feature.',
            ],
            command: '/setup',
        },
        {
            title: 'Open the dashboard',
            text: [
                'Go to [the dashboard](/dashboard) and log in with Discord. **Your servers** lists every server where you have Manage Server and the bot is a member. Select your server to open its settings.',
            ],
            image: 'getting-started-servers',
        },
        {
            title: 'Work through the setup checklist',
            text: [
                'The server overview shows your member and stream counts, then a **Setup checklist**: a mod log channel, a server log channel, welcome messages, an AutoMod rule, verification, raid detection, anti-nuke, Discord\'s spammer check, phishing links and the global ban network.',
                'Each **Set up** link opens the exact setting. **Hide** removes the checklist; it also disappears once every step is done.',
            ],
            image: 'getting-started-overview',
        },
    ],
    notes: [
        'Admin, setup, moderation and private commands are in Discord\'s `/` menu. Game, fun and lookup commands, such as `/economy` and `/arcade`, are typed as an ordinary message that starts with `/`. Every command also works with `!`, `?`, `$` or `.` in front, or by mentioning the bot.',
        'The **Setup wizard** page (under Bot & server setup) lists the permissions the bot has and is missing, and the essential, recommended and optional steps.',
        'Nothing is permanent: every setting can be changed or turned off later.',
        'The [command list](/commands) has every command with its options.',
    ],
    related: ['moderation', 'welcome', 'go-live-alerts'],
};
