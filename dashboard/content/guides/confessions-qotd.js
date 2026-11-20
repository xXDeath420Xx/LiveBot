// Checked against: dashboard/views/partials/manage/confessions.ejs, dashboard/routes/features/confessions.js,
// commands/fun/fun.js (confess), commands/fun/fun-confess-handler.js, core/command-registration.js (the /fun confess
// slash exception), core/guild-shortcuts.js (/confess), core/feature-config-spec.js (qotd),
// dashboard/views/partials/manage/feature-config.ejs, dashboard/views/partials/manage/_qotd-review.ejs,
// dashboard/routes/api/features/qotd.js, commands/community/qotd.js, core/qotd-poster.js, core/qotd-selector.js,
// jobs/qotd-scheduler.js, core/manage-nav.js, core/universal-commands.js (describePath), docs/command-split-2026-11-18.md.
export default {
    slug: 'confessions-qotd',
    title: 'Confessions and question of the day',
    area: 'community',
    summary: 'Let members post anonymously, and post a discussion question on a schedule, at a time in the timezone you choose.',
    result: {
        image: 'confessions-qotd-discord',
        caption: 'An anonymous confession as it is posted in the confession channel.',
    },
    before: [
        'You need **Manage Server**. Both pages are on the dashboard under **Levels & engagement**: **Confessions** and **Question of the Day**. `/fun confess` and `/qotd` are in Discord\'s `/` menu.',
    ],
    steps: [
        {
            title: 'Set up confessions',
            text: [
                'Open **Confessions**. Turn on **Confessions**, choose the **Confession channel**, and select **Save**.',
                '**Length** sets the shortest and longest confession (10 to 1,000 characters unless you change it), and **Wait between confessions** how long a member waits before the next one (5 minutes by default, 0 for no wait).',
                'To check each one first, turn on **Require approval** and pick a **Review channel**. The bot tells that channel when a confession is waiting; approve or reject it under **Waiting for review** on the page.',
            ],
        },
        {
            title: 'How members confess',
            text: [
                'Members pick `/fun confess` from the `/` menu, or `/confess` where your server has it, and type into the form that opens. It stays a slash command so nobody sees who typed it.',
                'The confession is posted as **Confession #** and its number, marked Anonymous. Members never see who sent it. The server owner and members with Administrator can select **Show sender** on the page for 30 days, to deal with abuse; each look is written to the audit log.',
            ],
            command: '/fun confess',
        },
        {
            title: 'Add a question of the day channel',
            text: [
                'Open **Question of the Day** and select **Add a channel** under **Channels**. Pick the **Schedule** (every day, on chosen days, or every set number of minutes), the **Time** and the **Timezone**, then the **Title**, roles to **Ping**, and whether to **Open a thread per question**.',
                'The time is in the channel\'s own timezone, so 09:00 in Europe/London posts at nine in the morning London time all year. Daily and weekly channels post once per local day, up to 5 minutes after the time you set.',
            ],
            command: '/qotd setup channel channel:#general schedule:Daily time:09:00 timezone:Europe/London',
            image: 'confessions-qotd-qotd-discord',
        },
        {
            title: 'Choose the questions',
            text: [
                'A channel takes questions from the shared library unless you change it with `/qotd library source`: your own decks only, or your decks first and then the library. A library question is not repeated in your server for 90 days; `window:` sets another number of days.',
                'Make your own with `/qotd deck create` and `/qotd card add`. Suggestions sent with `/qotd suggest` wait under **Member suggestions** on the page; **Approve** adds one to a deck. `/qotd post` posts the next question now.',
            ],
            command: '/qotd post channel:#general',
        },
    ],
    notes: [
        'Turning **Enabled** off on the Question of the Day page stops every scheduled post. `/qotd post` still works.',
        'A new channel starts with the page\'s defaults: every day at 09:00 UTC unless you change **Default time of day** and **Default timezone**.',
        'Every `/qotd` command needs Manage Server except `/qotd suggest`, which any member can use.',
        'Confessions are off until you save the page with **Confessions** on.',
    ],
    related: ['community', 'levels', 'giveaways-polls', 'privacy'],
};
