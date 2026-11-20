// Checked against: dashboard/views/partials/manage/giveaways.ejs, dashboard/routes/api/features/giveaways.js,
// core/giveaway-manager.js, core/giveaway-panel.js, interactions/buttons/giveaway_create.js, jobs/giveaway-scheduler.js,
// commands/community/manage.js (giveaway and poll groups), commands/community/manage-giveaway-handler.js,
// commands/context/reroll-giveaway.js, dashboard/views/partials/manage/polls.ejs, core/polls-manager.js,
// commands/community/manage-poll-handler.js, commands/discord/native-poll.js, core/guild-shortcuts.js,
// core/feature-flags.js, core/manage-nav.js, core/universal-commands.js (describePath), docs/command-split-2026-11-18.md.
export default {
    slug: 'giveaways-polls',
    title: 'Giveaways and polls',
    area: 'community',
    summary: 'Run timed prize draws that members enter with a reaction, and polls with a button for each answer.',
    result: {
        image: 'giveaways-polls-discord',
        caption: 'A running giveaway with its party popper entries, and a poll with a bar for each answer.',
    },
    before: [
        'You need **Manage Server**. Both pages are on the dashboard under **Events, polls & giveaways**: **Giveaways** and **Polls**. The `/manage giveaway` and `/manage poll` commands are in Discord\'s `/` menu.',
    ],
    steps: [
        {
            title: 'Start a giveaway',
            text: [
                'Open **Giveaways** and select **Create giveaway**. Fill in the **Prize**, the **Number of winners** (1 to 100), how long it runs (from 10 seconds to 6 months), optional **Details**, and the **Channel**, then select **Start giveaway**.',
                'The bot posts the giveaway and adds a party popper reaction to it. Members enter by adding the same reaction, and leave by removing it.',
                'From Discord, run `/manage giveaway start` in the channel it belongs in, with up to 20 winners.',
            ],
            command: '/manage giveaway start prize:Maple Hollow hoodie winners:1 days:3',
            image: 'giveaways-polls-page',
        },
        {
            title: 'Let staff start giveaways',
            text: [
                'Under **Who can start giveaways**, choose the **Host roles** and select **Save host roles**. Then pick the **Panel channel** and select **Post panel**: the bot posts a panel with a **Create Giveaway** button that opens a short form, and the giveaway is posted in that channel.',
                'With no host roles saved, anyone with Manage Messages can use the button. Members with Manage Server always can.',
            ],
        },
        {
            title: 'Draw the winners',
            text: [
                'When time runs out, the bot draws the winners at random from the party popper reactions, leaving out bots, and pings them in a reply to the giveaway. The post changes to say who won.',
                'On the page, **End now** draws early and **Reroll** draws new winners for one that has ended. In Discord, right-click the giveaway message, then **Apps**, then **Reroll Giveaway** (needs Manage Messages), or use `/manage giveaway reroll message-id:`.',
            ],
            command: '/manage giveaway reroll message-id:100700000000000044',
        },
        {
            title: 'Run a poll',
            text: [
                'Open **Polls** and select **Create poll**. Write the **Question** and two to ten **Options**, separated by commas (each one becomes a button, up to 80 characters). **Duration (optional)** takes values such as 30m, 2h or 1d; leave it empty for no time limit. Choose the **Channel** and select **Start poll**.',
                'Tick **Allow more than one choice**, **Anonymous voting**, **Hide results until the poll ends** or **Allow write-in answers** as you need. The poll shows a bar and a percentage for each answer, and **Edit** on the page changes an open poll in place.',
                '`/manage poll create` does the same from Discord; there the options are separated by semicolons.',
            ],
            command: '/manage poll create question:Movie night on Friday? options:Yes;No;Saturday instead',
        },
        {
            title: 'Or use a Discord poll',
            text: [
                '`/native-poll` posts one of Discord\'s own polls: up to 10 answers of 55 characters, running 1 to 168 hours (24 by default), with `multi_select:` for more than one answer. Discord counts the votes. It needs Manage Messages.',
            ],
            command: '/native-poll question:Best snack for movie night? option1:Popcorn option2:Nachos',
        },
    ],
    notes: [
        'A vote on a bot poll cannot be changed or taken back: the bot refuses a second vote on a single-choice poll.',
        '`/manage poll results message-id:` shows a poll\'s results. On a poll with hidden results, `/manage poll peek message-id:` shows the live count privately to its creator or anyone with Manage Server.',
        'Every reroll draws from the party popper reactions only, and only for a giveaway that has ended: `/manage giveaway reroll` on a running one says so instead of ending it.',
        '`/manage giveaway cancel` stops a giveaway without drawing, and `/manage giveaway delete` also removes its message. Servers that use giveaways or polls get `/giveaway` and `/poll` as short forms of `/manage giveaway` and `/manage poll`.',
    ],
    related: ['community', 'announcements', 'discord-events', 'economy'],
};
