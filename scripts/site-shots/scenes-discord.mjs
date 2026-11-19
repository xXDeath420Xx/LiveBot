/*
 * The Discord side of the guides: what the bot posts, drawn with the dashboard's message preview.
 * Each message copies the bot's real format; the source of each format is named above it. Names,
 * channels, numbers and pictures are Maple Hollow's (invented).
 */
export async function discordScenes({ discord, image, page, ctx, demo }) {
    const { guild, role, channel, channels, member: M, streamers: S } = demo;
    const BOT = 'CertiFried Utility';
    const ctxNames = {
        channels: channels.map((c) => ({ id: c.id, name: c.name })),
        roles: demo.roles.map((r) => ({ id: r.id, name: r.name, color: r.hexColor })),
        users: demo.members.map((m) => ({ id: m.id, name: m.displayName })),
    };
    const bot = (base, extra) => ({ username: BOT, avatarUrl: `${base()}/images/CertiFried.png`, ...extra });
    const B = () => ctx.av('x').slice(0, -'/__demo/x.png'.length);   // the local server's origin, once it runs
    const used = (k, command) => ({ name: M[k].displayName, command });

    // ── Getting started: /setup (core/setup-wizard.js renderHome) ──
    discord('getting-started-setup', () => ({
        channel: 'bot-commands', ctx: ctxNames,
        messages: [bot(B, {
            usedBy: used('juniper', '/setup'), ephemeral: true,
            embeds: [{
                color: '#5865F2', title: '⚙️ Setup',
                description: `**${guild.name}** has **6 of 41** features running.\n\nJump to a category to fine-tune, or start from a preset if you'd rather not decide one at a time.`,
                fields: [
                    { name: '✅ Already running (6)', value: 'Welcome messages, Leveling, Logging, AutoMod, Phishing protection, Stream alerts' },
                    { name: '⬜ One click away (12)', value: 'Starboard, Suggestions, Birthdays, Question of the day, Counting, Verification, Anti-raid, Anti-nuke, Tickets, Economy, Self-promotion, Word games' },
                ],
                footer: 'Nothing here is permanent — anything can be changed later.',
            }],
            select: 'Start from a preset…',
        })],
    }), { alt: 'The reply to /setup in Discord: Maple Hollow has 6 of 41 features running, a list of what is on and what is one click away, and a menu to start from a preset.', guides: ['getting-started'] });

    // ── Go-live (utils/announcer.js, "card" live style: utils/stream-card.js) ──
    const card = await ctx.file('live-card.png', () => ctx.streamCard(ctx.root, S.rowan, M.rowan, ctx.avatars));
    discord('go-live-discord', () => ({
        channel: 'stream-alerts', ctx: ctxNames,
        messages: [bot(B, {
            content: `**${S.rowan.name}** is live with ${S.rowan.game}. Come say hi!`,
            embeds: [{
                color: '#9146FF', author: `${S.rowan.name} is LIVE on Twitch!`, title: S.rowan.title, url: 'https://example.invalid/',
                fields: [{ name: 'Playing', value: S.rowan.game, inline: true }], image: card(), timestamp: true,
            }],
        })],
    }), { alt: `A go-live post in #stream-alerts: "${S.rowan.name} is LIVE on Twitch!", the stream title, the game, and a card with the streamer's name, title and viewer count.`, guides: ['go-live-alerts'] });

    // ── Feeds: YouTube upload (core/youtube-feed.js) and Bluesky (core/bluesky-feed.js) ──
    const thumb = await ctx.file('yt-thumb.png', () => ctx.artwork({ from: '#3f8f6b', to: '#6c5fc7', caption: 'Painting the Maple Hollow banner' }));
    discord('feeds-discord', () => ({
        channel: 'new-videos', ctx: ctxNames,
        messages: [
            bot(B, {
                content: 'A new video from **Sorrel Quinn Art** is out!',
                embeds: [{ color: '#ED4245', author: 'Sorrel Quinn Art just uploaded a new video!', title: 'Painting the Maple Hollow banner (full process)', url: 'https://example.invalid/',
                    description: 'Two hours of sketching, colour blocking and the final details for our server banner. Brushes and palette in the pinned comment.', image: thumb() }],
            }),
            bot(B, {
                time: 'Today at 8:05 PM',
                embeds: [{ color: '#0085FF', author: 'Maple Hollow (@maplehollow.bsky.social)', description: 'Movie night moves to Fridays from next week. Vote on the first film in #suggestions.', footer: 'Bluesky' }],
            }),
        ],
    }), { alt: 'Two feed posts: a new YouTube upload with its title, description and thumbnail, then a Bluesky post from the Maple Hollow account.', guides: ['social-feeds'] });

    // ── Levels: level-up (core/leveling-manager.js) and /level rank ──
    const rank = await ctx.file('rank.png', () => ctx.rankCard(ctx.root, M.sorrel, ctx.avatars, { rank: 3, level: 15, xp: 120, xpForNextLevel: 1975, totalXP: 18640, totalVoiceMinutes: 0, voiceXP: 0 }));
    discord('levels-discord', () => ({
        channel: 'level-ups', ctx: ctxNames,
        messages: [
            bot(B, {
                embeds: [{ color: '#FFD700', title: 'Level Up!', description: `Congrats <@${M.sorrel.id}>! You reached **Level 15**!`, thumbnail: ctx.av('sorrel'),
                    fields: [{ name: 'Role Reward', value: `You earned the <@&${role.sapling.id}> role!` }], footer: 'You are now level 15!' }],
            }),
            bot(B, { usedBy: used('sorrel', '/level rank'), time: 'Today at 7:44 PM', images: [rank()] }),
        ],
    }), { alt: 'A level-up post for Sorrel Quinn reaching level 15 with the Sapling role as a reward, then the rank card Sorrel gets from /level rank.', guides: ['levels'] });

    // ── Welcome: the real join handler (core/greeting-manager.js) ──
    const post = await ctx.welcomePost(ctx.root, M.wren, ctx.avatars, {
        channel_id: channel.welcome.id, banner_enabled: 1, message_type: 'embed',
        message: `Welcome to {server}, {user.mention}! Start in <#${channel.rules.id}> and pick some roles in <#${channel.roles.id}>.`,
        card_title_text: '{user} just joined the server', card_subtitle_text: 'Member #{memberCount}', embed_color: '#3f8f6b',
    });
    const welcomeCard = await ctx.file('welcome-card.png', () => post.files[0].buffer);
    const wEmbed = post.embeds[0] || {};
    discord('welcome-discord', () => ({
        channel: 'welcome', ctx: ctxNames,
        messages: [bot(B, {
            content: post.content,
            embeds: [{ color: wEmbed.color, title: wEmbed.title, description: wEmbed.description, image: welcomeCard(), footer: wEmbed.footer?.text, timestamp: true }],
        })],
    }), { alt: 'A welcome post for Wren Alder: a greeting with links to #rules and #roles, and a card with their avatar, "Wren Alder just joined the server" and "Member #1284".', guides: ['welcome'] });

    // ── Reaction roles (core/reaction-role-manager.js buildPanelMessage, button panel) ──
    const rr = [['🦉', role.night], ['🎨', role.artists], ['🎮', role.gamers], ['📣', role.stream]];
    discord('reaction-roles-discord', () => ({
        channel: 'roles', ctx: ctxNames,
        messages: [
            bot(B, {
                embeds: [{ color: '#3f8f6b', title: 'Pick your roles', description: 'Choose the roles you want. Click again to remove one.',
                    fields: [{ name: 'Available Roles', value: rr.map(([, r]) => `▪️ <@&${r.id}>`).join('\n') }] }],
                buttons: rr.map(([, r]) => ({ label: r.name, style: 'primary' })), buttonEmoji: rr.map(([e]) => e),
            }),
            bot(B, { ephemeral: true, time: 'Today at 7:43 PM', content: `You now have the **${role.artists.name}** role!` }),
        ],
    }), { alt: 'A role panel called Pick your roles with four buttons (Night owls, Artists, Gamers, Stream pings), and the private reply "You now have the Artists role!".', guides: ['reaction-roles'] });

    // ── Moderation: mod log (core/moderation-manager.js) ──
    discord('moderation-discord', () => ({
        channel: 'mod-log', ctx: ctxNames,
        messages: [bot(B, {
            embeds: [{ color: '#E67E22', author: 'Moderation Log', title: 'Warn Issued', timestamp: true, fields: [
                { name: 'User', value: `${M.fennel.username} (${M.fennel.id})`, inline: true },
                { name: 'Moderator', value: `${M.hazel.username} (${M.hazel.id})`, inline: true },
                { name: 'Reason', value: 'Spoilers outside #spoilers' },
            ] }],
        })],
    }), { alt: 'A mod log entry: Warn Issued, with the member, the moderator and the reason.', guides: ['moderation'] });

    // ── Raid lockdown (core/raid-lockdown.js announceStart) ──
    discord('raid-discord', () => ({
        channel: 'mod-log', ctx: ctxNames,
        messages: [bot(B, {
            embeds: [{ color: '#C0392B', title: '🚨 Server Lockdown Started (#4)', timestamp: true,
                description: 'Every new member is being kicked until it ends. Allowlisted users, bot managers and bots are exempt.',
                fields: [
                    { name: 'Action on every join', value: 'Kick', inline: true },
                    { name: 'Ends', value: 'Today at 9:12 PM (in an hour)', inline: true },
                    { name: 'Started by', value: 'Auto-trigger', inline: true },
                    { name: 'Trigger', value: '22 joins in 10 seconds' },
                ] }],
        })],
    }), { alt: 'A lockdown alert: Server Lockdown Started, every new member is kicked until it ends in an hour, started by the auto-trigger after 22 joins in 10 seconds.', guides: ['raid-protection'] });

    // ── Tickets (dashboard panel; interactions/buttons/ticket_create.js) ──
    discord('tickets-discord', () => ({
        channel: 'support', ctx: ctxNames,
        messages: [
            bot(B, {
                embeds: [{ color: '#3f8f6b', title: 'Need a hand?', description: 'Open a ticket and a moderator will reply here in private.' }],
                buttons: [{ label: 'Open a ticket', style: 'primary' }],
            }),
            bot(B, {
                time: 'Today at 7:51 PM',
                content: `<@${M.wren.id}> - <@&${role.moderators.id}>`,
                embeds: [{ color: '#3f8f6b', title: 'Ticket #12', description: `Welcome <@${M.wren.id}>! A support staff member will be with you shortly. Please describe your issue in detail.` }],
                buttons: [{ label: 'Close Ticket', style: 'danger' }],
            }),
        ],
    }), { alt: 'The Help desk ticket panel with an Open a ticket button, and the first message in a new private ticket channel with a Close Ticket button.', guides: ['support-tickets'] });

    // ── Music (handlers/music/features.js, handlers/music/player.js nowplaying) ──
    const cover = await ctx.file('cover.png', () => ctx.artwork({ width: 400, height: 400, from: '#2f7fa8', to: '#a2475e', seed: 9 }));
    discord('music-discord', () => ({
        channel: 'music-requests', ctx: ctxNames,
        messages: [
            bot(B, { usedBy: used('pip', '/music dj prompt:rainy evening lo-fi'), content: '🎧 **AI DJ session started!**\n\nBased on: "rainy evening lo-fi"\n\nThe DJ will generate playlists and keep the music flowing. Use `/music stop` to end the session.' }),
            bot(B, {
                usedBy: used('pip', '/music nowplaying'), time: 'Today at 7:49 PM',
                embeds: [{ color: '#57F287', author: 'Now Playing', title: 'Lanterns Over the Hollow', url: 'https://example.invalid/', thumbnail: cover(), fields: [
                    { name: 'Artist', value: 'The Quiet Ferns', inline: true }, { name: 'Duration', value: '3:41', inline: true }, { name: 'Requested by', value: M.pip.username, inline: true },
                    { name: 'Progress', value: '1:12 ┃ ▬▬▬▬▬▬🔘▬▬▬▬▬▬▬▬▬▬▬▬▬▬ ┃ 3:41' },
                ] }],
            }),
        ],
    }), { alt: 'The AI DJ starting from the prompt "rainy evening lo-fi", then the Now Playing card for the current track with its artist, length, who asked for it and a progress bar.', guides: ['music'] });

    // ── Economy (commands/economy/economy-bank-handler.js, economy-earn-handler.js) ──
    const money = (n) => `🌰 ${n.toLocaleString('en-US')} acorns`;
    discord('economy-discord', () => ({
        channel: 'bot-commands', ctx: ctxNames,
        messages: [
            bot(B, { usedBy: used('pip', '/economy earn daily'), embeds: [{ color: '#57F287', title: '💵 Daily Reward Claimed!', description: `You received ${money(250)}!`, fields: [
                { name: 'Base Amount', value: money(100), inline: true }, { name: 'Streak Bonus', value: money(150), inline: true }, { name: '🔥 Current Streak', value: '3 days', inline: true }] }] }),
            bot(B, { usedBy: used('pip', '/economy bank balance'), time: 'Today at 7:43 PM', embeds: [{ color: '#FFD700', title: "Pip Calloway's Balance", thumbnail: ctx.av('pip'), fields: [
                { name: '💵 Wallet', value: money(4450), inline: true }, { name: '🏦 Bank', value: `${money(12800)} / ${money(50000)} (25.6%)`, inline: true },
                { name: '💰 Net Worth', value: money(17250), inline: true }, { name: '🔥 Daily Streak', value: '3 days', inline: true }] }] }),
        ],
    }), { alt: 'Two economy replies: Pip claims a daily reward of 250 acorns with a 3-day streak bonus, then checks a balance of 4,450 acorns in the wallet and 12,800 in the bank.', guides: ['economy'] });

    // ── Birthdays, starboard, suggestions ──
    discord('community-discord', () => ({
        channel: 'general', ctx: ctxNames,
        messages: [
            bot(B, { content: `⭐ **5** <#${channel.general.id}>`, embeds: [{ color: '#FFD700', author: { name: M.pip.username, iconUrl: ctx.av('pip') }, description: 'I finally finished the treehouse build. It has a working lift.', fields: [{ name: 'Source', value: `[Jump to message](https://example.invalid/) in <#${channel.general.id}>` }], timestamp: true }] }),
            bot(B, { time: 'Today at 7:46 PM', embeds: [{ color: '#FFA500', title: 'Suggestion #12', description: 'A weekly screenshot contest channel', fields: [
                { name: 'Submitted By', value: `<@${M.wren.id}>`, inline: true }, { name: 'Status', value: 'Pending', inline: true }, { name: 'Date', value: '11/15/2026', inline: true }], footer: 'Suggestion ID: 12' }],
                buttons: [{ label: '14', style: 'success' }, { label: '2', style: 'danger' }], buttonEmoji: ['👍', '👎'] }),
            bot(B, { time: 'Today at 12:00 AM', content: `<@${M.wren.id}>`, embeds: [{ color: '#FF69B4', title: 'Happy Birthday Wren Alder!', thumbnail: ctx.av('wren'), description: `Join us in wishing <@${M.wren.id}> a very happy birthday!`, footer: `${guild.name} • Birthday Celebration`, timestamp: true }] }),
        ],
    }), { alt: 'Three posts: a starboard repost of a message with 5 stars, a suggestion with 14 up votes and 2 down votes, and a birthday announcement for Wren Alder.', guides: ['community'], width: 600 });

    // ── Greenhouse (commands/games/arcade-greenhouse-handler.js status) ──
    discord('greenhouse-discord', () => ({
        channel: 'bot-commands', ctx: ctxNames,
        messages: [bot(B, {
            usedBy: used('thistle', '/arcade greenhouse status'),
            embeds: [{ color: '#3f8f6b', title: "Thistle's greenhouse", fields: [
                { name: 'Level', value: '14', inline: true }, { name: 'Cash', value: '$48,210', inline: true }, { name: 'Benches', value: '3 ready to harvest', inline: true },
                { name: 'Daily reward', value: 'Ready: $1,200 (day 6)', inline: true }, { name: 'Quests', value: '2 of 3 done', inline: true }, { name: 'Season 3', value: '8,940 points, rank 41. Ends in 12 days', inline: true },
                { name: 'Week 2 challenge', value: 'Harvest 40 Frostbells: 26 of 40' }] }],
            buttons: [{ label: 'Open the game' }],
        })],
    }), { alt: "The reply to /arcade greenhouse status: Thistle's level, cash, benches ready to harvest, the daily reward, quests, season points and the weekly challenge, with an Open the game button.", guides: ['greenhouse'] });

    // ── Privacy (commands/tools/privacy.js handleStatus) ──
    discord('privacy-discord', () => ({
        channel: 'bot-commands', ctx: ctxNames,
        messages: [bot(B, {
            usedBy: used('hazel', '/privacy status'), ephemeral: true,
            embeds: [{ color: '#5865F2', title: '🔒 Your privacy settings', description: 'These apply in every server this bot is in.', fields: [
                { name: 'Message logging: ✅ on', value: 'Servers that use delete/edit logs keep a short-lived copy of your recent messages (at most 90 days) so moderators can see what was removed.' },
                { name: 'Leaderboards: 🚫 hidden', value: 'You are left out of public level, economy and emoji leaderboards. Your progress is still counted.' },
                { name: 'Last export', value: '3 weeks ago', inline: true }, { name: 'Last deletion', value: 'Never', inline: true },
                { name: 'Commands', value: '`/privacy export` · `/privacy delete` · `/privacy opt-out` · `/privacy opt-in`\nVoice transcription and the chat reader have their own switch: `/voice privacy opt-out`.' },
            ], footer: 'Full policy: https://certifriedmultitool.com/privacy' }],
        })],
    }), { alt: 'The private reply to /privacy status: message logging is on, leaderboards are hidden, the last export date, and the four /privacy commands.', guides: ['privacy'] });

    // ── Schedules: the Twitch schedule month poster (core/schedule-calendar-art.js) ──
    image('schedules-poster', () => ctx.calendarPoster(ctx.root, {
        year: 2026, month: 11, title: 'Stream Schedule', disclaimer: 'Times are UK time. Schedule can change.',
        streams: {
            2: { title: 'Cozy farming', start: '19:00', end: '22:00' }, 4: { title: 'Speedrun practice', start: '20:00' }, 7: { title: 'Art stream', start: '18:00', end: '21:00' },
            9: { title: 'Cozy farming', start: '19:00', end: '22:00' }, 11: { title: 'Community games', start: '20:00' }, 14: { title: 'Art stream', start: '18:00', end: '21:00' },
            16: { title: 'Cozy farming', start: '19:00', end: '22:00' }, 18: { title: 'Speedrun practice', start: '20:00' }, 19: { title: 'Charity marathon', start: '12:00', note: '12 hours' },
            21: { title: 'Art stream', start: '18:00', end: '21:00' }, 23: { title: 'Cozy farming', start: '19:00', end: '22:00' }, 28: { title: 'Year in review', start: '20:00' },
        },
    }), { alt: 'A December 2026 stream schedule poster: a month grid with a show and start time on stream days and NO STREAM on the others.', guides: ['schedules'], outWidth: 1200 });
}
