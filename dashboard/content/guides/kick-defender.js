// Checked against: dashboard/routes/kick-defender.js, dashboard/views/kick/panel.ejs,
// services/certifried-bot/defender/channel-settings.js, defender/commands/*.js, command-handler.js.
export default {
    slug: 'kick-defender',
    title: 'Kick Defender',
    area: 'kick',
    summary: 'Protect a Kick channel with a ban list shared by every connected channel, and remove known scam links from chat.',
    result: {
        image: 'kick-defender-panel',
        caption: 'The Kick Defender page for a connected channel.',
    },
    before: [
        'You need to own the Kick channel. Nothing is set up in Discord: the Kick Defender runs in Kick chat.',
    ],
    steps: [
        {
            title: 'Log in with Kick',
            text: [
                'Go to [certifriedmultitool.com/kick](/kick) and log in with your Kick account. Your channel is registered and the **Defender** switch is on from the start: accounts on the shared ban list are banned in your chat, and known scam links are removed.',
            ],
        },
        {
            title: 'Give the bot its permissions and connect chat',
            text: [
                'The bot needs Kick\'s permissions to ban and to delete messages. If either is missing, the page asks you to re-authorize with Kick.',
                'Check that **Chat connection** says Connected. If it does not, select **Connect chat**: until chat is connected the defender cannot see messages.',
            ],
        },
        {
            title: 'Choose how strict to be',
            text: [
                '**Ban length** is Permanent (the default) or Timed, in minutes. **Scam-link strikes before a ban** is 2 by default: the first link is deleted with a warning, the second gets a ban. **Scam-link warning** is the message shown; `{{username}}` mentions the sender.',
                'Add up to 50 **Allowed domains** that are never treated as scam links, then select **Save protection settings**.',
            ],
        },
        {
            title: 'Use the chat commands',
            text: [
                'Anyone in chat can use `!kbd-info`, `!check-ban <username>` and `!ping`. Managers chosen by the owner also have commands such as `!add-ban`, `!remove-ban`, `!add-sublist`, `!add-unban` and `!mod-check`, and look after the shared lists at [the managers page](/kick/managers).',
            ],
        },
    ],
    notes: [
        'You can switch the defender off and on for each channel at any time.',
        'The page shows how many accounts were banned and messages removed in your channel.',
    ],
    related: ['moderation', 'raid-protection', 'getting-started'],
};
