// Checked against: commands/tools/privacy.js, core/privacy-manager.js, core/privacy-tables.js,
// dashboard/server.js (/privacy), data_retention_policy.
export default {
    slug: 'privacy',
    title: 'Your data and /privacy',
    area: 'privacy',
    summary: 'See, export or delete what the bot holds about you, and opt out of message logging or leaderboards.',
    result: {
        image: 'privacy-discord',
        caption: 'The reply to /privacy status. Every /privacy reply is visible only to you.',
    },
    before: [
        '`/privacy` works for anyone, in any server the bot is in or in a DM with the bot. Its settings apply in every server.',
    ],
    steps: [
        {
            title: 'Check your settings',
            text: [
                '`/privacy status` shows whether message logging and leaderboards are on for you, and when you last exported or deleted your data.',
            ],
            command: '/privacy status',
        },
        {
            title: 'Export your data',
            text: [
                '`/privacy export` sends you a JSON file by DM, or attaches it to the private reply if your DMs are closed. You can export once every 24 hours.',
                'Moderation records about you are counted but not included, and the names of staff who acted are hidden.',
            ],
            command: '/privacy export',
        },
        {
            title: 'Opt out',
            text: [
                '`what:message-logging` stops servers\' delete and edit logs from keeping copies of your messages, and removes the copies kept so far. `what:leaderboards` hides you from level, economy and emoji leaderboards; your progress is still counted. `what:all` does both. `/privacy opt-in` undoes it.',
            ],
            command: '/privacy opt-out what:message-logging',
        },
        {
            title: 'Delete your data',
            text: [
                '`/privacy delete` asks you to confirm (the button works for 10 minutes), then deletes your data in every server: activity, levels, economy, game progress and linked accounts. You can do this once an hour.',
                'Some records are kept because servers need them: moderation records, logged evidence of deleted messages, tickets, forms, modmail and suggestions, Ko-fi payments, things other members made for you (such as birthday cards), and the record of your privacy choices. Songs you requested are kept without your name.',
            ],
            command: '/privacy delete',
        },
    ],
    notes: [
        'Copies of messages kept for delete and edit logs are removed after 90 days at most. Moderation records are deleted after two years (warnings after one), and closed tickets and modmail conversations a year after they closed.',
        'Voice transcription and the chat reader have their own switch: type `/voice privacy opt-out` as a message.',
        'The [Privacy Policy](/privacy) lists what is kept and for how long.',
    ],
    related: ['moderation', 'support-tickets', 'getting-started'],
};
