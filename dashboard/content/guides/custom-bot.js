// Checked against: dashboard/views/partials/manage/appearance.ejs, dashboard/server.js (/manage loader:
// customBotInfo; POST /manage/:guildId/update-bot-appearance), dashboard/routes/api/features/custom-bot.js,
// dashboard/routes/api/index.js, dashboard/middleware/auth.js (apiCheckGuildAdmin, checkGuildAdmin),
// utils/bot-validator.js, utils/custom-bot-check.js, core/bot-manager.js (createClient, addCustomBot,
// deployCommandsForBot, hideDefaultBotCommandsInGuilds, getClientForGuild), events/interactionCreate.js,
// events/messageCreate.js, core/manage-nav.js.
export default {
    slug: 'custom-bot',
    title: 'Your own branded bot',
    area: 'tools',
    summary: 'Run the bot in your server under your own bot application, with its own name and avatar, instead of the shared CertiFried Utility bot.',
    result: {
        image: 'custom-bot-status',
        caption: 'The Custom bot panel once your bot is connected: its name and ID, Online, Active, who set it up and when.',
    },
    before: [
        'You need **Manage Server**. It is on the dashboard under **Bot & server setup**, then **Bot appearance**, at the bottom of the page.',
        'You also need a bot application of your own, made in the Discord Developer Portal at `discord.com/developers/applications`. The steps below cover it.',
    ],
    steps: [
        {
            title: 'Create the bot in the Developer Portal',
            text: [
                'Create an application and give it the name and avatar you want members to see. On its **Bot** page, turn on the three privileged intents: **Server Members**, **Message Content** and **Presence**. The bot asks Discord for all three when it logs in, and Discord refuses the connection if one is off.',
                'Copy the **Application ID** from **General Information**, and the token from the **Bot** page. If you did not save the token, use **Reset Token** there to get a new one.',
            ],
        },
        {
            title: 'Invite it to your server',
            text: [
                'Invite your bot with the **bot** and **applications.commands** scopes. It registers its commands only in servers it is a member of, so do this first.',
            ],
        },
        {
            title: 'Connect it on the dashboard',
            text: [
                'On **Bot appearance**, under **Custom bot**, enter the **Application ID** and **Bot token**, then select **Set up custom bot**. The dashboard logs in with the token before it changes anything, which can take up to 30 seconds. An ID that is not 17 to 20 digits, or a token Discord rejects, is refused with a message.',
                'The token is stored encrypted. When the page reloads it shows your bot, whether it is online, and who set it up.',
            ],
            image: 'custom-bot-setup',
        },
        {
            title: 'Know what changes in the server',
            text: [
                'Your bot now runs the features here: commands, alerts, logs and music. Your settings do not change, because they belong to the server, not to the bot. The **Nickname** on the same page is applied to your bot.',
                'The shared bot\'s slash commands are hidden in this server, so members only see yours. If the shared bot is still a member, it ignores messages and events here, and anyone who runs one of its commands is told "This server uses a custom bot. Please use that bot\'s commands instead."',
            ],
        },
        {
            title: 'Replace or remove it',
            text: [
                '**Replace with a different bot** takes another **Application ID** and **Bot token** and switches the server to that bot. **Remove custom bot** moves the server back to the shared CertiFried Utility bot.',
                'Both ask you to confirm. Go-live posts that are up at that moment are deleted, and the page says stream announcements are recreated by the bot now in charge.',
            ],
        },
    ],
    notes: [
        'Any member with **Manage Server** can set up, replace or remove the custom bot from this page.',
        'A bot application can be connected to one server from this page. A bot that is already registered is refused with "This bot is already registered in the system."',
        'Setup and replace log the bot in first, with the three privileged intents, and stop with the reason if that fails, so nothing changes. If the bot is saved but does not start, the page says so. To give the current bot a new token, use **Replace with a different bot** with its own Application ID and the new token: the server keeps the bot and it restarts.',
        'If you kicked the shared bot, invite it again after removing your custom bot. While it is not in the server, the dashboard sends you to its invite page instead of the settings.',
        'Commands work the same with your bot, including the commands typed as a message. See [Commands, prefixes and who can use them](/docs/guides/commands).',
    ],
    related: ['commands', 'getting-started', 'go-live-alerts', 'replace-bots'],
};
