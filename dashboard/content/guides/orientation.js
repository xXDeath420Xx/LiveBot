// Checked against: core/orientation-manager.js (FEATURE_CHECKS, SETUP_GROUPS, ALWAYS_AVAILABLE, buildOrientationEmbed,
// postOrientationMessage, updateOrientationMessage, removeOrientationMessage, moveOrientationMessage, findSuitableChannel),
// commands/admin/orientation.js, core/command-mounts.js (orientation under /systems), events/guildCreate.js (posted on join),
// core/feature-config-spec.js and core/manage-nav.js (the Orientation page under Verification & joining),
// dashboard/routes/api/features/feature-config.js (a new channel moves the message), core/guild-theme.js (embed colour).
export default {
    slug: 'orientation',
    title: 'The server guide message',
    area: 'community',
    summary: 'One message that tells your members and staff what the bot does in your server, what is not set up yet, and which commands anyone can use.',
    result: {
        image: 'orientation-discord',
        caption: 'The guide in Maple Hollow: the features that are on, what is left to set up with the command for each, and the commands everyone can use.',
    },
    before: [
        'The command needs **Administrator**; the dashboard needs **Manage Server**. On the dashboard the page is under **Verification & joining**, then **Orientation**.',
    ],
    steps: [
        {
            title: 'Post it in a channel',
            text: [
                'On the **Orientation** page, pick the **Guide channel** and save. The bot posts the guide there. Saving a different channel later moves it: the bot posts it in the new channel and deletes it from the old one.',
                'Or run `/systems orientation post` and pick a `channel:`. Without one, it posts in the channel you run it in.',
            ],
            command: '/systems orientation post channel:#bot-info',
            image: 'orientation-page',
        },
        {
            title: 'Check what it says',
            text: [
                '**Active Features** lists what this server has set up. **Safety and Logs to Set Up** and **More to Set Up** list the rest, each with the slash command that turns it on, or the dashboard page when there is no command. The first ones in each list are the steps most new servers take first.',
                '**Always Available** is for everyone: games, the RPG, the economy, music and the utility commands, and whether each is picked from the / menu or typed as a message that starts with `/`. Below that are links to these guides and to your server on the dashboard.',
            ],
        },
        {
            title: 'Refresh it after you change features',
            text: [
                'The guide does not update by itself. After you turn something on or off, run `/systems orientation update` and the bot edits the message in place, so it keeps its spot in the channel.',
                '`/systems orientation post` refreshes it too. With `fresh:True` the bot deletes the old message and posts a new one at the bottom of the channel instead.',
            ],
            command: '/systems orientation update',
        },
        {
            title: 'Remove it',
            text: [
                'Run `/systems orientation remove`, or clear the **Guide channel** on the dashboard and save. Both delete the message.',
            ],
        },
    ],
    notes: [
        'When the bot joins a server it posts the guide on its own, but only in a channel whose name contains orientation, bot-info, bot-commands, bot-spam, dev-test, admin, moderator-only, mod-chat or commands, and only if it can send messages there. It never picks a general channel. If no channel matches, nothing is posted until you do it.',
        'The embed colour follows the server\'s embed theme (**Bot & server setup**, then **Embed theme**).',
        'Each list holds up to 1,024 characters, Discord\'s limit for one embed field. A longer list is cut at a line break and ends with "use `/help` for the rest".',
        'The guide also has a short note inviting streamers to apply to the Against_The_Tide stream team, with a link to the sign-up page.',
    ],
    related: ['getting-started', 'commands', 'welcome', 'verification'],
};
