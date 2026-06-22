// SINGLE SOURCE OF TRUTH for the in-Discord "About CertiFried" info embed.
//
// Every script that posts or refreshes the embed imports buildAboutEmbed() from here
// (create-about-certifried.mjs, update-about-certifried.mjs, kitsune-authoritative-
// structure.mjs). Do NOT inline a second copy — divergent copies are exactly why the
// embed kept going stale/incomplete. Update the feature list HERE and re-run
// `node scripts/update-about-certifried.mjs --apply` to push it to every live embed.

export const ABOUT_LINKS = {
    SITE_URL: 'https://certifriedmultitool.com',
    THUMB_URL: 'https://certifriedmultitool.com/images/CertiFried.png',
    INVITE_URL: 'https://discord.com/api/oauth2/authorize?client_id=1409904443125665875&permissions=8&scope=bot+applications.commands',
    DASHBOARD_URL: 'https://certifriedmultitool.com/dashboard',
};

export function buildAboutEmbed() {
    const { SITE_URL, THUMB_URL, INVITE_URL, DASHBOARD_URL } = ABOUT_LINKS;
    return {
        title: 'About CertiFried',
        color: 0xF0A500,
        thumbnail: { url: THUMB_URL },
        description:
            'CertiFried is an all-in-one Discord utility suite — go-live stream alerts, moderation, ' +
            'leveling, music, free-game giveaways, giveaways, tickets, economy, a full D&D 5e RPG, ' +
            'games, and 50+ more features in a single bot backed by a full web dashboard.',
        fields: [
            {
                name: '🛡️ Moderation & Protection',
                value: 'Anti-nuke • phishing shield with image/OCR scam detection • global ban network • automod • raid & self-bot detection • full audit logging',
            },
            {
                name: '📢 Go-Live Stream Alerts',
                value: 'Twitch • Kick • YouTube • Trovo • TikTok • Facebook — auto-tracked streamer roles, cancel-aware Twitch schedule images, per-guild live roster & auto-shoutouts',
            },
            {
                name: '🌊 Against The Tide — the official CertiFried Twitch Team',
                value:
                    'CertiFried runs its own **Twitch team, Against_The_Tide**. Any CertiFried user who ' +
                    'streams on **Twitch, Kick, or YouTube** is welcome to apply — get featured, ' +
                    'cross-promoted, and raided by the whole community.\n' +
                    `→ Apply on the [dashboard](${SITE_URL}/stream-team) (no Discord login needed) or in your server's **#stream-team-signup** channel.\n` +
                    '🔗 [twitch.tv/team/against_the_tide](https://www.twitch.tv/team/against_the_tide)',
            },
            {
                name: '📰 Social Feeds',
                value: 'New-post alerts from Reddit • YouTube • Twitter/X • Bluesky • Facebook, plus TikTok VOD notifications',
            },
            {
                name: '🎫 Community Tools',
                value: 'Verification gates • leveling + rank cards • reaction roles & autoroles • ticketing • suggestions • starboard • welcome/goodbye cards • group greeting cards • birthdays • confessions • QOTD • weekly event schedules',
            },
            {
                name: '🎮 Games & Engagement',
                value: 'Full D&D 5e RPG (`/rpg`) • Cards Against Humanity (`/cah`) • word games (`/wordgame`) • Pokémon • trivia, hangman, music quiz, counting, LFG • economy, pets & gambling • giveaways & polls',
            },
            {
                name: '🎁 Free Game Alerts',
                value: 'Automatic free-game giveaway announcements from **Epic Games, Steam, GOG & Prime Gaming**, with direct claim links (`/deals`)',
            },
            {
                name: '🎵 Music & Voice',
                value: 'Full music player + AI DJ (YouTube + local files) • VC sound drops • text-to-speech',
            },
            {
                name: '🧰 Utility',
                value: 'Notes, reminders, weather, crypto, recipes, translation, color & QR tools, NASA APOD, strain lookup — plus a `/setup` guided walkthrough and a `/help` explorer',
            },
            {
                name: '🤝 Creator Integrations',
                value: 'Buy Me a Coffee supporter alerts • Throne wishlists • Fourthwall shop • Steam game watcher',
            },
            {
                name: '🌐 Dashboard',
                value: `Full web UI at ${SITE_URL} — per-guild configs, stream rosters, log routing, ticket analytics, and more.`,
            },
            {
                name: '🤖 Option 1 — Invite the default CertiFried bot',
                value: `Easiest route. Hit the link, pick your server, done.\n→ [add CertiFried to your server](${INVITE_URL})`,
            },
            {
                name: '🎨 Option 2 — Run your OWN branded bot on our backend',
                value:
                    `Same features, your custom name / avatar / presence. Steps:\n\n` +
                    `**1.** Create a bot at [Discord Developer Portal](https://discord.com/developers/applications) → **New Application** → **Bot** → **Reset Token** (copy it, you won't see it again).\n` +
                    `**2.** In the Bot tab, enable all three **Privileged Gateway Intents**: Server Members, Message Content, Presence.\n` +
                    `**3.** Invite your bot: **OAuth2 → URL Generator** → scopes \`bot\` + \`applications.commands\` → permission **Administrator** → open the URL → add to your server.\n` +
                    `**4.** Sign in at ${DASHBOARD_URL} and open your server.\n` +
                    `**5.** Click **Appearance** in the sidebar (or visit \`/manage/{your-guild-id}?page=appearance\`).\n` +
                    `**6.** Paste your bot's **Application/Client ID** and **Bot Token** into the form → **Set Up Custom Bot**.\n\n` +
                    `That's it. Your bot boots on our backend with every CertiFried feature, encrypted token storage, and per-guild slash-command deploys.`,
            },
        ],
        footer: { text: 'certifriedmultitool.com  •  made by CertiFried' },
    };
}
