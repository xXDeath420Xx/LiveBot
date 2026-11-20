// Checked against: dashboard/views/partials/manage/stat-displays.ejs, dashboard/routes/api/features/core.js
// (stat-displays), core/stat-display-manager.js, jobs/stat-display-scheduler.js, dashboard/server.js
// (statDisplayChannels, serverStats), dashboard/views/partials/manage/serverstats.ejs,
// dashboard/routes/features/statistics.js, dashboard/views/partials/manage/analytics.ejs,
// dashboard/views/partials/manage/emojistats.ejs, dashboard/views/partials/manage/activity-audit.ejs,
// dashboard/routes/api/features/activity-audit.js, core/activity-audit.js, core/activity-audit-actions.js,
// core/activity-audit-filter.js, commands/info/server.js, commands/info/stats.js, commands/info/user.js,
// commands/admin/activity.js, core/command-mounts.js, core/universal-commands.js (describePath), core/manage-nav.js.
export default {
    slug: 'server-stats',
    title: 'Server stats and stat channels',
    area: 'tools',
    summary: 'Show live counts, the time or the date in voice channel names, and see who posts, where and when.',
    result: {
        image: 'server-stats-page',
        caption: 'Server stats for the last 7 days: messages, members who posted, joins, leaves and time in voice, each against the week before.',
    },
    before: [
        'You need **Manage Server**. The pages are on the dashboard under **Logs & stats**: **Stat display channels**, **Server stats**, **Analytics**, **Emoji stats** and **Activity audit**.',
    ],
    steps: [
        {
            title: 'Add a stat display channel',
            text: [
                'Open **Stat display channels**. Under **Add a display**, pick a **Voice channel**, or **Create a new channel** for one that members cannot join. The bot needs **Manage Channels** to rename it.',
                'Choose **What it shows**: Total members, Human members, Bots, Online members, Channel count, Role count, Server boosts, Members with a role, Twitch followers, Local time or Local date. For a role or a Twitch channel, pick which one.',
                'Write the **Channel name** with `{value}` where the number goes, for example `Members: {value}`, at most 100 characters. The **Preview** shows it with a sample value. Select **Add display**.',
            ],
            image: 'server-stats-displays',
        },
        {
            title: 'Know when the names change',
            text: [
                'Discord lets a bot rename a channel about twice every 10 minutes, so counts are updated every 10 minutes and the time and date every 5. A new display gets its first name at the next update.',
                'The time reads like 7:36pm and the date like Sunday, Mar 22nd, in the timezone set on **General settings**. **Edit** changes the name, and **Remove** stops the renaming but leaves the channel.',
            ],
        },
        {
            title: 'See who posts, where and when',
            text: [
                'Open **Server stats** and pick the last 7, 30 or 90 days. The top row shows **Messages**, **Members who posted**, **Joined**, **Left**, **Time in voice** and **Commands**, each against the same number of days before.',
                'Below are messages per day, the 10 **Top message senders** and **Most active channels**, **Busiest hours** by weekday and hour (in UTC) and the five most used emoji. **Download CSV** saves the totals, each day and both top-10 lists.',
            ],
            command: '/server stats topusers days:30',
        },
        {
            title: 'Follow growth over time',
            text: [
                '**Analytics** charts members, joins and leaves, and messages per day over 7, 14 or 30 days. With **Compare with the previous period** on, the message chart also shows the period before as a dashed line. It has its own **Download CSV**.',
                '**Emoji stats** counts emoji typed in messages (reactions are not counted): the 20 most used, the 10 members who use the most, use by day, and your server\'s own emoji that nobody used in the period.',
            ],
        },
        {
            title: 'Find members who have gone quiet',
            text: [
                'Open **Activity audit**, choose a **Window** from 30 days to 1 year and select **Run new audit**. Each audit is a snapshot of messages and time in voice for every member, sorted into groups such as **Text only**, **Voice only**, **Quiet 30+ days** and **No activity at all**. Pick a group to narrow the table, and **Post to Discord** posts the report in a channel.',
                '**Advanced filters and bulk actions** can kick the members who match, or add or remove a role. A preview checks every member again first and lists who is protected. To kick, you type the number of members who will be kicked.',
            ],
            command: '/moderation activity run days:90',
        },
    ],
    notes: [
        '`/server stats overview`, `growth`, `activity`, `topusers`, `topchannels` and `peakhours` are typed as a message, not picked from the / menu, and need **Manage Server**. See [the server commands](/commands#server).',
        '`/stats chart` posts a picture of messages per day and `/stats export` a CSV, for 7, 14 or 30 days. Both are typed as a message.',
        '`/user emojistats top` and `/user emojistats user` show emoji use in Discord. They are typed as a message.',
        '`/moderation activity run`, `view`, `post`, `list` and `action` are in the / menu and need **Manage Server**. `action` only previews unless you add `confirm:true`.',
        'Online members counts members whose status is anything but offline.',
    ],
    related: ['levels', 'verification', 'moderation'],
};
