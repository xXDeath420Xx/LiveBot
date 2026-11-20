// Checked against: dashboard/routes/discord-native-page.js, dashboard/views/discord-native.ejs,
// dashboard/views/partials/manage/discord-native.ejs, dashboard/routes/api/features/welcome-screen.js,
// dashboard/routes/api/features/onboarding.js, dashboard/routes/api/features/discord-soundboard.js,
// dashboard/routes/api/features/scheduled-events.js, core/manage-nav.js, core/feature-config-spec.js (event-reminders),
// core/event-reminder-manager.js, core/event-reminder-helpers.js, commands/community/schedule.js (discord group),
// core/command-registration.js, core/universal-commands.js (describePath), docs/command-split-2026-11-18.md.
export default {
    slug: 'discord-events',
    title: 'Server events, welcome screen and onboarding',
    area: 'tools',
    summary: 'Edit Discord\'s own welcome screen, onboarding, soundboard and server events from the dashboard, and remind members before an event starts.',
    result: {
        image: 'discord-events-discord',
        caption: 'The post the bot makes in your channel when a server event starts, with a ping for the role you chose.',
    },
    before: [
        'You need **Manage Server**. The editors are on the dashboard under **Bot & server setup**, then **Discord native features**; reminders are under **Events, polls & giveaways**, then **Event Reminders**.',
        'What you change in the editors is saved in Discord itself, so it shows in Server Settings as well.',
    ],
    steps: [
        {
            title: 'Set up the welcome screen and onboarding',
            text: [
                'On **Discord native features**, select **Open** next to **Welcome screen**. It needs a Community server and the bot needs **Manage Server**. Turn on **Show the welcome screen**, write a **Description** (up to 384 characters) and add up to five **Featured channels**, each with a description of up to 50 characters.',
                'The **Onboarding** tab has the on switch, the **Mode** and the **Default channels** new members can see straight away (up to 50). Discord needs at least 7 default channels, 5 of which members can talk in, before onboarding turns on. The questions themselves are edited in Discord, under Server Settings, Onboarding.',
            ],
        },
        {
            title: 'Add sounds to the server soundboard',
            text: [
                'The **Soundboard** tab uploads sounds to Discord\'s own soundboard: MP3 or OGG, up to 512 KB and 5.2 seconds, with a name of 2 to 32 characters. The bot needs **Create Expressions** or **Manage Expressions**.',
                'This is not the bot\'s own voice-channel soundboard, which has its own **Soundboard** page under **Music & voice**.',
            ],
        },
        {
            title: 'Create a server event',
            text: [
                'On the **Scheduled events** tab, select **New event**. Give it a **Name** and choose **Where**: a voice channel, a stage channel, or somewhere else. Pick the **Channel**, or type a **Location** (a link or an address) for an event outside Discord.',
                '**Starts** is in your local time and must be in the future. **Ends** is optional for voice and stage events but required for one outside Discord. Select **Create event**; the bot needs **Manage Events**. Each event in the list has a **Delete** button. To edit an event or make it repeat, use Discord.',
            ],
        },
        {
            title: 'Remind members and announce the start',
            text: [
                'On **Event Reminders**, turn on **DM reminders to members who clicked Interested** and set **Remind this many minutes before the start** (5 to 1440, 30 by default). Both reminders and announcements are off until you turn them on.',
                'Turn on **Post in a channel when an event starts**, then choose the **Start announcement channel** and, if you like, a **Role to ping in start announcements**. The post goes out once per event, when Discord marks it as started or when its start time passes.',
            ],
            command: '/schedule discord settings dm_reminders:True minutes_before:30 announce:True announce_channel:#announcements',
            image: 'discord-events-reminders',
        },
        {
            title: 'Make an event repeat',
            text: [
                'Pick `/schedule discord recurring-add` from the / menu. Give the **name**, the first **start** as `YYYY-MM-DD HH:MM` (24-hour), how often it **repeat**s (daily, weekly, every 2 weeks or monthly) and a **timezone** (UTC if you leave it out). Choose a voice or stage **channel**, or a **location** for an event outside Discord. **duration** is 15 to 1440 minutes, 60 by default.',
                'The bot creates the first event straight away and the next one when the last one ends. You need **Manage Events**, and the bot needs **Create Events** or **Manage Events**.',
            ],
            command: '/schedule discord recurring-add name:Game night start:2026-12-04 20:00 repeat:Weekly timezone:Europe/London channel:Campfire',
        },
    ],
    notes: [
        'Reminder DMs go only to members who clicked **Interested** on the event, and a member gets at most 6 of them an hour. Each DM has a **Stop reminders from this server** button; `/schedule discord reminders enabled:False` does the same.',
        'Moving an event to a new start time sends its reminder and start announcement again for the new time. A start announcement is skipped if the bot was offline for the first 15 minutes after the start.',
        '`/schedule discord recurring-list` shows your repeating events and their ids. `/schedule discord recurring-pause id: paused:True` pauses one and `recurring-remove id:` deletes it; add `cancel_upcoming:True` to cancel the event it already created.',
        'A repeating event that fails to create its next event 10 times in a row pauses itself; your server log says so when that log category is switched on. Fix the cause, then resume it with `paused:False`.',
        '`/schedule discord settings` needs **Manage Server**; the dashboard page has the same settings.',
    ],
    related: ['schedules', 'announcements', 'welcome', 'reminders-utilities'],
};
