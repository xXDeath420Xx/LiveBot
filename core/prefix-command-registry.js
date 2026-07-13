/**
 * Prefix Command Registry
 *
 * Maps prefix commands to handler functions.
 * Each command defines its arg parsing rules so the adapter
 * can build the correct parsedArgs object.
 *
 * Arg types: 'string' | 'integer' | 'user' | 'channel' | 'role' | 'boolean'
 * Set `rest: true` on the last arg to capture all remaining text.
 *
 * Handler formats:
 *   { file, method }        — lazy import from file, call method
 *   'builtin:name'          — built-in command in prefix-command-manager
 *   { file, method, wrap }  — lazy import + wrapper fn that adds extra args
 */

const registry = new Map();

function register(name, definition) {
    registry.set(name, definition);
    if (definition.aliases) {
        for (const alias of definition.aliases) {
            registry.set(alias, { ...definition, isAlias: true, canonicalName: name });
        }
    }
}

// ═══════════════════════════════════════════════════════════
// MUSIC COMMANDS
// ═══════════════════════════════════════════════════════════

register('play', {
    description: 'Play a song or playlist',
    category: 'music',
    args: [{ name: 'query', type: 'string', required: true, rest: true }],
    handler: { file: '../handlers/music/player.js', method: 'handlePlay' },
    aliases: ['p']
});

register('skip', {
    description: 'Skip the current song',
    category: 'music',
    args: [],
    handler: { file: '../handlers/music/player.js', method: 'handleSkip' },
    aliases: ['s', 'next']
});

register('pause', {
    description: 'Pause the music',
    category: 'music',
    args: [],
    handler: { file: '../handlers/music/player.js', method: 'handlePause' },
    aliases: []
});

register('resume', {
    description: 'Resume the music',
    category: 'music',
    args: [],
    handler: { file: '../handlers/music/player.js', method: 'handleResume' },
    aliases: ['unpause']
});

register('stop', {
    description: 'Stop music and clear the queue',
    category: 'music',
    args: [],
    handler: { file: '../handlers/music/player.js', method: 'handleStop' },
    aliases: ['dc', 'disconnect', 'leave']
});

register('nowplaying', {
    description: 'Show the currently playing song',
    category: 'music',
    args: [],
    handler: { file: '../handlers/music/player.js', method: 'handleNowPlaying' },
    aliases: ['np', 'playing']
});

register('queue', {
    description: 'Show the music queue',
    category: 'music',
    args: [{ name: 'page', type: 'integer', required: false }],
    handler: { file: '../handlers/music/queue.js', method: 'handleQueue' },
    aliases: ['q']
});

register('shuffle', {
    description: 'Shuffle the queue',
    category: 'music',
    args: [],
    handler: { file: '../handlers/music/queue.js', method: 'handleShuffle' },
    aliases: []
});

register('clear', {
    description: 'Clear the music queue',
    category: 'music',
    args: [],
    handler: { file: '../handlers/music/queue.js', method: 'handleClear' },
    aliases: ['clearqueue']
});

register('remove', {
    description: 'Remove a track from the queue',
    category: 'music',
    args: [{ name: 'track', type: 'integer', required: true }],
    handler: { file: '../handlers/music/queue.js', method: 'handleRemove' },
    aliases: []
});

register('volume', {
    description: 'Set the volume (0-100)',
    category: 'music',
    args: [{ name: 'level', type: 'integer', required: true }],
    handler: { file: '../handlers/music/controls.js', method: 'handleVolume' },
    aliases: ['vol']
});

register('loop', {
    description: 'Toggle loop mode (off/track/queue)',
    category: 'music',
    args: [{ name: 'mode', type: 'string', required: false }],
    handler: { file: '../handlers/music/controls.js', method: 'handleLoop' },
    aliases: ['repeat']
});

register('seek', {
    description: 'Seek to a position in the current song',
    category: 'music',
    args: [{ name: 'time', type: 'string', required: true }],
    handler: { file: '../handlers/music/controls.js', method: 'handleSeek' },
    aliases: []
});

register('autoplay', {
    description: 'Toggle autoplay mode',
    category: 'music',
    args: [{ name: 'mode', type: 'string', required: false }],
    handler: { file: '../handlers/music/controls.js', method: 'handleAutoplay' },
    aliases: []
});

register('voteskip', {
    description: 'Vote to skip the current song',
    category: 'music',
    args: [],
    handler: { file: '../handlers/music/controls.js', method: 'handleVoteSkip' },
    aliases: ['vs']
});

register('forceskip', {
    description: 'Force skip the current song',
    category: 'music',
    args: [],
    handler: { file: '../handlers/music/controls.js', method: 'handleForceSkip' },
    aliases: ['fs']
});

register('equalizer', {
    description: 'Set the equalizer preset',
    category: 'music',
    args: [{ name: 'preset', type: 'string', required: true }],
    handler: { file: '../handlers/music/controls.js', method: 'handleEqualizer' },
    aliases: ['eq']
});

register('lyrics', {
    description: 'Show lyrics for the current or specified song',
    category: 'music',
    args: [{ name: 'query', type: 'string', required: false, rest: true }],
    handler: { file: '../handlers/music/features.js', method: 'handleLyrics' },
    aliases: []
});

register('search', {
    description: 'Search for a song',
    category: 'music',
    args: [{ name: 'query', type: 'string', required: true, rest: true }],
    handler: { file: '../handlers/music/features.js', method: 'handleSearch' },
    aliases: []
});

// ═══════════════════════════════════════════════════════════
// MODERATION COMMANDS
// ═══════════════════════════════════════════════════════════

register('ban', {
    description: 'Ban a user from the server',
    category: 'moderation',
    args: [
        { name: 'user', type: 'user', required: true },
        { name: 'reason', type: 'string', required: false, rest: true }
    ],
    handler: { file: '../commands/admin/admin-mod-handler.js', method: 'handleBan' },
    aliases: []
});

register('unban', {
    description: 'Unban a user',
    category: 'moderation',
    args: [
        { name: 'user-id', type: 'string', required: true },
        { name: 'reason', type: 'string', required: false, rest: true }
    ],
    handler: { file: '../commands/admin/admin-mod-handler.js', method: 'handleUnban' },
    aliases: []
});

register('kick', {
    description: 'Kick a user from the server',
    category: 'moderation',
    args: [
        { name: 'user', type: 'user', required: true },
        { name: 'reason', type: 'string', required: false, rest: true }
    ],
    handler: { file: '../commands/admin/admin-mod-handler.js', method: 'handleKick' },
    aliases: []
});

register('mute', {
    description: 'Mute (timeout) a user',
    category: 'moderation',
    args: [
        { name: 'user', type: 'user', required: true },
        { name: 'duration', type: 'string', required: true },
        { name: 'reason', type: 'string', required: false, rest: true }
    ],
    handler: { file: '../commands/admin/admin-mod-handler.js', method: 'handleMute' },
    aliases: ['timeout']
});

register('unmute', {
    description: 'Unmute a user',
    category: 'moderation',
    args: [
        { name: 'user', type: 'user', required: true },
        { name: 'reason', type: 'string', required: false, rest: true }
    ],
    handler: { file: '../commands/admin/admin-mod-handler.js', method: 'handleUnmute' },
    aliases: ['untimeout']
});

register('warn', {
    description: 'Warn a user',
    category: 'moderation',
    args: [
        { name: 'user', type: 'user', required: true },
        { name: 'reason', type: 'string', required: false, rest: true }
    ],
    handler: { file: '../commands/admin/admin-mod-handler.js', method: 'handleWarn' },
    aliases: []
});

register('purge', {
    description: 'Delete messages in bulk',
    category: 'moderation',
    args: [
        { name: 'amount', type: 'integer', required: true },
        { name: 'user', type: 'user', required: false }
    ],
    handler: { file: '../commands/admin/admin-mod-handler.js', method: 'handlePurge' },
    aliases: ['prune', 'bulkdelete']
});

register('slowmode', {
    description: 'Set channel slowmode',
    category: 'moderation',
    args: [
        { name: 'duration', type: 'string', required: true },
        { name: 'reason', type: 'string', required: false, rest: true }
    ],
    handler: { file: '../commands/admin/admin-mod-handler.js', method: 'handleSlowmode' },
    aliases: ['slow']
});

register('lock', {
    description: 'Lock the current channel',
    category: 'moderation',
    args: [{ name: 'reason', type: 'string', required: false, rest: true }],
    handler: { file: '../commands/admin/admin-mod-handler.js', method: 'handleLock' },
    aliases: []
});

register('unlock', {
    description: 'Unlock the current channel',
    category: 'moderation',
    args: [],
    handler: { file: '../commands/admin/admin-mod-handler.js', method: 'handleUnlock' },
    aliases: []
});

register('history', {
    description: 'View moderation history for a user',
    category: 'moderation',
    args: [{ name: 'user', type: 'user', required: true }],
    handler: { file: '../commands/admin/admin-mod-handler.js', method: 'handleHistory' },
    aliases: ['infractions', 'modlog']
});

register('clearinfractions', {
    description: 'Clear infractions for a user',
    category: 'moderation',
    args: [
        { name: 'user', type: 'user', required: true },
        { name: 'reason', type: 'string', required: false, rest: true }
    ],
    handler: { file: '../commands/admin/admin-mod-handler.js', method: 'handleClearInfractions' },
    aliases: ['clearwarn']
});

register('announce', {
    description: 'Send an announcement embed',
    category: 'moderation',
    args: [
        { name: 'channel', type: 'channel', required: true },
        { name: 'message', type: 'string', required: true, rest: true }
    ],
    handler: { file: '../commands/admin/admin-mod-handler.js', method: 'handleAnnounce' },
    aliases: []
});

// ═══════════════════════════════════════════════════════════
// ECONOMY COMMANDS
// ═══════════════════════════════════════════════════════════

register('daily', {
    description: 'Collect your daily reward',
    category: 'economy',
    args: [],
    handler: { file: '../commands/economy/economy-earn-handler.js', method: 'handleDaily' },
    aliases: []
});

register('weekly', {
    description: 'Collect your weekly reward',
    category: 'economy',
    args: [],
    handler: { file: '../commands/economy/economy-earn-handler.js', method: 'handleWeekly' },
    aliases: []
});

register('work', {
    description: 'Work for coins',
    category: 'economy',
    args: [],
    handler: { file: '../commands/economy/economy-earn-handler.js', method: 'handleWork' },
    aliases: []
});

register('crime', {
    description: 'Attempt a crime for coins',
    category: 'economy',
    args: [],
    handler: { file: '../commands/economy/economy-earn-handler.js', method: 'handleCrime' },
    aliases: []
});

register('balance', {
    description: 'Check your or another user\'s balance',
    category: 'economy',
    args: [{ name: 'user', type: 'user', required: false }],
    handler: { file: '../commands/economy/economy-bank-handler.js', method: 'handleBalance' },
    aliases: ['bal', 'money']
});

register('deposit', {
    description: 'Deposit coins into the bank',
    category: 'economy',
    args: [{ name: 'amount', type: 'integer', required: true }],
    handler: { file: '../commands/economy/economy-bank-handler.js', method: 'handleDeposit' },
    aliases: ['dep']
});

register('withdraw', {
    description: 'Withdraw coins from the bank',
    category: 'economy',
    args: [{ name: 'amount', type: 'integer', required: true }],
    handler: { file: '../commands/economy/economy-bank-handler.js', method: 'handleWithdraw' },
    aliases: ['with']
});

register('transfer', {
    description: 'Transfer coins to another user',
    category: 'economy',
    args: [
        { name: 'user', type: 'user', required: true },
        { name: 'amount', type: 'integer', required: true }
    ],
    handler: { file: '../commands/economy/economy-bank-handler.js', method: 'handleTransfer' },
    aliases: ['pay', 'send']
});

register('rob', {
    description: 'Attempt to rob another user',
    category: 'economy',
    args: [{ name: 'user', type: 'user', required: true }],
    handler: { file: '../commands/economy/economy-social-handler.js', method: 'handleRob' },
    aliases: ['steal']
});

register('leaderboard', {
    description: 'View the economy leaderboard',
    category: 'economy',
    args: [],
    handler: { file: '../commands/economy/economy-social-handler.js', method: 'handleLeaderboard' },
    aliases: ['lb', 'top', 'rich']
});

register('transactions', {
    description: 'View your transaction history',
    category: 'economy',
    args: [{ name: 'limit', type: 'integer', required: false }],
    handler: { file: '../commands/economy/economy-social-handler.js', method: 'handleTransactions' },
    aliases: ['txn']
});

register('give', {
    description: 'Give coins to a user (admin)',
    category: 'economy',
    args: [
        { name: 'user', type: 'user', required: true },
        { name: 'amount', type: 'integer', required: true }
    ],
    handler: { file: '../commands/economy/economy-social-handler.js', method: 'handleGive' },
    aliases: []
});

// Gambling
register('coinflip', {
    description: 'Flip a coin and bet',
    category: 'economy',
    args: [
        { name: 'amount', type: 'integer', required: true },
        { name: 'choice', type: 'string', required: false }
    ],
    handler: { file: '../commands/economy/economy-gamble-handler.js', method: 'handleCoinflip' },
    aliases: ['cf', 'flip']
});

register('dice', {
    description: 'Roll dice and bet',
    category: 'economy',
    args: [
        { name: 'amount', type: 'integer', required: true },
        { name: 'prediction', type: 'integer', required: false }
    ],
    handler: { file: '../commands/economy/economy-gamble-handler.js', method: 'handleDice' },
    aliases: ['roll']
});

register('slots', {
    description: 'Play the slot machine',
    category: 'economy',
    args: [{ name: 'amount', type: 'integer', required: true }],
    handler: { file: '../commands/economy/economy-gamble-handler.js', method: 'handleSlots' },
    aliases: ['slot']
});

register('blackjack', {
    description: 'Play blackjack',
    category: 'economy',
    args: [{ name: 'amount', type: 'integer', required: true }],
    handler: { file: '../commands/economy/economy-gamble-handler.js', method: 'handleBlackjack' },
    aliases: ['bj']
});

register('roulette', {
    description: 'Play roulette',
    category: 'economy',
    args: [
        { name: 'amount', type: 'integer', required: true },
        { name: 'bet', type: 'string', required: true }
    ],
    handler: { file: '../commands/economy/economy-gamble-handler.js', method: 'handleRoulette' },
    aliases: []
});

register('highlow', {
    description: 'Play high/low card game',
    category: 'economy',
    args: [
        { name: 'amount', type: 'integer', required: true },
        { name: 'guess', type: 'string', required: true }
    ],
    handler: { file: '../commands/economy/economy-gamble-handler.js', method: 'handleHighLow' },
    aliases: ['hl']
});

// Shop
register('shop', {
    description: 'Browse the server shop',
    category: 'economy',
    args: [{ name: 'category', type: 'string', required: false }],
    handler: { file: '../commands/economy/economy-shop-handler.js', method: 'handleBrowse' },
    aliases: ['store']
});

register('buy', {
    description: 'Buy an item from the shop',
    category: 'economy',
    args: [
        { name: 'item_id', type: 'integer', required: true },
        { name: 'quantity', type: 'integer', required: false }
    ],
    handler: { file: '../commands/economy/economy-shop-handler.js', method: 'handleBuy' },
    aliases: ['purchase']
});

register('sell', {
    description: 'Sell an item',
    category: 'economy',
    args: [
        { name: 'item_id', type: 'integer', required: true },
        { name: 'quantity', type: 'integer', required: false }
    ],
    handler: { file: '../commands/economy/economy-shop-handler.js', method: 'handleSell' },
    aliases: []
});

register('inventory', {
    description: 'View your inventory',
    category: 'economy',
    args: [{ name: 'user', type: 'user', required: false }],
    handler: { file: '../commands/economy/economy-shop-handler.js', method: 'handleInventory' },
    aliases: ['inv', 'items']
});

register('use', {
    description: 'Use an item from your inventory',
    category: 'economy',
    args: [{ name: 'item_id', type: 'integer', required: true }],
    handler: { file: '../commands/economy/economy-shop-handler.js', method: 'handleUse' },
    aliases: []
});

// Pets
register('adopt', {
    description: 'Adopt a pet',
    category: 'economy',
    args: [
        { name: 'type', type: 'string', required: true },
        { name: 'name', type: 'string', required: true, rest: true }
    ],
    handler: { file: '../commands/economy/economy-pet-handler.js', method: 'handleAdopt' },
    aliases: []
});

register('pet', {
    description: 'View your pet',
    category: 'economy',
    args: [],
    handler: { file: '../commands/economy/economy-pet-handler.js', method: 'handleView' },
    aliases: ['mypet']
});

register('feed', {
    description: 'Feed your pet',
    category: 'economy',
    args: [],
    handler: { file: '../commands/economy/economy-pet-handler.js', method: 'handleFeed' },
    aliases: []
});

// ═══════════════════════════════════════════════════════════
// LEVELING COMMANDS
// ═══════════════════════════════════════════════════════════

register('rank', {
    description: 'View your or another user\'s rank',
    category: 'leveling',
    args: [{ name: 'user', type: 'user', required: false }],
    handler: { file: '../commands/community/level.js', method: 'default.handleRank',
        wrap: (fn) => (ctx) => {
            const mgr = ctx.client.levelingManager;
            if (!mgr) return ctx.reply({ content: 'The leveling system is not available.' });
            return fn(ctx, mgr);
        }},
    aliases: ['level', 'xp']
});

register('xpleaderboard', {
    description: 'View the XP leaderboard',
    category: 'leveling',
    args: [{ name: 'page', type: 'integer', required: false }],
    handler: { file: '../commands/community/level.js', method: 'default.handleLeaderboard',
        wrap: (fn) => (ctx) => {
            const mgr = ctx.client.levelingManager;
            if (!mgr) return ctx.reply({ content: 'The leveling system is not available.' });
            return fn(ctx, mgr);
        }},
    aliases: ['xplb', 'levels']
});

// ═══════════════════════════════════════════════════════════
// FUN COMMANDS
// ═══════════════════════════════════════════════════════════

register('meme', {
    description: 'Create a meme from a template',
    category: 'fun',
    args: [
        { name: 'template', type: 'string', required: true },
        { name: 'text1', type: 'string', required: true, rest: true }
    ],
    handler: { file: '../commands/fun/fun-creative-handler.js', method: 'handleMeme' },
    aliases: []
});

register('story', {
    description: 'Generate a short story',
    category: 'fun',
    args: [{ name: 'prompt', type: 'string', required: true, rest: true }],
    handler: { file: '../commands/fun/fun-creative-handler.js', method: 'handleStory' },
    aliases: []
});

register('writingprompt', {
    description: 'Get a random writing prompt',
    category: 'fun',
    args: [{ name: 'type', type: 'string', required: false }],
    handler: { file: '../commands/fun/fun-creative-handler.js', method: 'handlePrompt' },
    aliases: ['wp']
});

register('color', {
    description: 'Get a random color palette',
    category: 'fun',
    args: [{ name: 'mood', type: 'string', required: false }],
    handler: { file: '../commands/fun/fun-creative-handler.js', method: 'handleColor' },
    aliases: []
});

register('horoscope', {
    description: 'Get your horoscope',
    category: 'fun',
    args: [
        { name: 'sign', type: 'string', required: true },
        { name: 'period', type: 'string', required: false }
    ],
    handler: { file: '../commands/fun/fun-astrology-handler.js', method: 'handleHoroscope' },
    aliases: []
});

register('tarot', {
    description: 'Get a tarot reading',
    category: 'fun',
    args: [{ name: 'spread', type: 'string', required: false }],
    handler: { file: '../commands/fun/fun-astrology-handler.js', method: 'handleTarot' },
    aliases: []
});

register('numerology', {
    description: 'Get your numerology reading',
    category: 'fun',
    args: [{ name: 'birthdate', type: 'string', required: true }],
    handler: { file: '../commands/fun/fun-astrology-handler.js', method: 'handleNumerology' },
    aliases: []
});

register('compatibility', {
    description: 'Check zodiac sign compatibility',
    category: 'fun',
    args: [
        { name: 'sign1', type: 'string', required: true },
        { name: 'sign2', type: 'string', required: true }
    ],
    handler: { file: '../commands/fun/fun-astrology-handler.js', method: 'handleCompatibility' },
    aliases: ['compat']
});

register('animal', {
    description: 'Search for animal pictures',
    category: 'fun',
    args: [{ name: 'name', type: 'string', required: true, rest: true }],
    handler: { file: '../commands/fun/fun-animals-handler.js', method: 'handleSearch' },
    aliases: []
});

register('battle', {
    description: 'Start a battle royale',
    category: 'fun',
    args: [{ name: 'players', type: 'integer', required: false }],
    handler: { file: '../commands/fun/entertainment-handlers.js', method: 'handleBattle' },
    aliases: ['br']
});

register('cardpull', {
    description: 'Pull a collectible card',
    category: 'fun',
    args: [{ name: 'rarity', type: 'string', required: false }],
    handler: { file: '../commands/fun/entertainment-handlers.js', method: 'handleCardPull' },
    aliases: ['pull', 'gacha']
});

register('collection', {
    description: 'View your card collection',
    category: 'fun',
    args: [],
    handler: { file: '../commands/fun/entertainment-handlers.js', method: 'handleCollection' },
    aliases: ['cards']
});

register('trade', {
    description: 'Trade a card with another user',
    category: 'fun',
    args: [
        { name: 'user', type: 'user', required: true },
        { name: 'cardid', type: 'integer', required: true }
    ],
    handler: { file: '../commands/fun/entertainment-handlers.js', method: 'handleTrade' },
    aliases: []
});

register('trivia', {
    description: 'Start a trivia game',
    category: 'fun',
    args: [{ name: 'category', type: 'string', required: false }],
    handler: { file: '../commands/fun/entertainment-handlers.js', method: 'handleTrivia' },
    aliases: []
});

// ═══════════════════════════════════════════════════════════
// GAMES COMMANDS
// ═══════════════════════════════════════════════════════════

register('hangman', {
    description: 'Start a hangman game',
    category: 'games',
    args: [],
    handler: { file: '../commands/games/arcade-hangman-handler.js', method: 'handleStart' },
    aliases: ['hm']
});

register('guess', {
    description: 'Guess a letter in hangman',
    category: 'games',
    args: [{ name: 'letter', type: 'string', required: true }],
    handler: { file: '../commands/games/arcade-hangman-handler.js', method: 'handleGuess' },
    aliases: []
});

register('lfg', {
    description: 'Create a looking-for-group post',
    category: 'games',
    args: [
        { name: 'game', type: 'string', required: true },
        { name: 'activity', type: 'string', required: false },
        { name: 'players', type: 'integer', required: false }
    ],
    handler: { file: '../commands/games/arcade-lfg-handler.js', method: 'handleCreate' },
    aliases: []
});

register('musicquiz', {
    description: 'Start a music quiz',
    category: 'games',
    args: [{ name: 'rounds', type: 'integer', required: false }],
    handler: { file: '../commands/games/arcade-musicquiz-handler.js', method: 'handleStart' },
    aliases: ['mq']
});

register('minecraft', {
    description: 'Check a Minecraft server status',
    category: 'games',
    args: [{ name: 'ip', type: 'string', required: true }],
    handler: { file: '../commands/games/arcade-servers-handler.js', method: 'handleMinecraft' },
    aliases: ['mc']
});

// ═══════════════════════════════════════════════════════════
// CANNABIS / GROW COMMANDS
// ═══════════════════════════════════════════════════════════

// Toke commands use wrapper functions because the original handlers take extra params
register('toke', {
    description: 'Log a toke',
    category: 'cannabis',
    args: [{ name: 'method', type: 'string', required: false }],
    handler: { file: '../commands/community/cannabis-toke-handler.js', method: 'handleToke',
        wrap: (fn) => (ctx) => fn(ctx, ctx.guildId, ctx.user.id, ctx.options.getString('method') || 'joint') },
    aliases: ['smoke', 'sesh']
});

register('tokestats', {
    description: 'View toke statistics',
    category: 'cannabis',
    args: [{ name: 'user', type: 'user', required: false }],
    handler: { file: '../commands/community/cannabis-toke-handler.js', method: 'handleTokeStats',
        wrap: (fn) => (ctx) => fn(ctx, ctx.guildId) },
    aliases: []
});

register('tokeleaderboard', {
    description: 'View the toke leaderboard',
    category: 'cannabis',
    args: [],
    handler: { file: '../commands/community/cannabis-toke-handler.js', method: 'handleTokeLeaderboard',
        wrap: (fn) => (ctx) => fn(ctx, ctx.guildId) },
    aliases: ['tokelb']
});

register('tokeachievements', {
    description: 'View toke achievements',
    category: 'cannabis',
    args: [{ name: 'user', type: 'user', required: false }],
    handler: { file: '../commands/community/cannabis-toke-handler.js', method: 'handleTokeAchievements',
        wrap: (fn) => (ctx) => fn(ctx, ctx.guildId) },
    aliases: []
});

register('startsesh', {
    description: 'Start a smoke session',
    category: 'cannabis',
    args: [],
    handler: { file: '../commands/community/cannabis-toke-handler.js', method: 'handleTokeStartSesh',
        wrap: (fn) => (ctx) => fn(ctx, ctx.guildId, ctx.user.id) },
    aliases: []
});

register('joinsesh', {
    description: 'Join a smoke session',
    category: 'cannabis',
    args: [],
    handler: { file: '../commands/community/cannabis-toke-handler.js', method: 'handleTokeJoinSesh',
        wrap: (fn) => (ctx) => fn(ctx, ctx.guildId, ctx.user.id) },
    aliases: []
});

register('endsesh', {
    description: 'End a smoke session',
    category: 'cannabis',
    args: [],
    handler: { file: '../commands/community/cannabis-toke-handler.js', method: 'handleTokeEndSesh',
        wrap: (fn) => (ctx) => fn(ctx, ctx.guildId, ctx.user.id) },
    aliases: []
});

// Strain database
register('strain', {
    description: 'Search for a cannabis strain',
    category: 'cannabis',
    args: [{ name: 'query', type: 'string', required: true, rest: true }],
    handler: { file: '../commands/community/grow-handlers.js', method: 'handleStrainSearch' },
    aliases: ['strains']
});

register('straininfo', {
    description: 'Get detailed strain info',
    category: 'cannabis',
    args: [{ name: 'id', type: 'integer', required: true }],
    handler: { file: '../commands/community/grow-handlers.js', method: 'handleStrainInfo' },
    aliases: []
});

register('randomstrain', {
    description: 'Get a random strain',
    category: 'cannabis',
    args: [],
    handler: { file: '../commands/community/grow-handlers.js', method: 'handleStrainRandom' },
    aliases: ['rs']
});

register('topstrains', {
    description: 'View top-rated strains',
    category: 'cannabis',
    args: [],
    handler: { file: '../commands/community/grow-handlers.js', method: 'handleStrainTop' },
    aliases: []
});

// Grow timer
register('startgrow', {
    description: 'Start a grow timer',
    category: 'cannabis',
    args: [
        { name: 'strain', type: 'string', required: true },
        { name: 'stage', type: 'string', required: false }
    ],
    handler: { file: '../commands/community/grow-handlers.js', method: 'handleTimerStart' },
    aliases: []
});

register('growstatus', {
    description: 'Check your grow timer status',
    category: 'cannabis',
    args: [],
    handler: { file: '../commands/community/grow-handlers.js', method: 'handleTimerStatus' },
    aliases: ['gs']
});

// Grow journal
register('journal', {
    description: 'View your grow journals',
    category: 'cannabis',
    args: [{ name: 'user', type: 'user', required: false }],
    handler: { file: '../commands/community/grow-journal-handler.js', method: 'handleList' },
    aliases: ['journals']
});

register('journalview', {
    description: 'View a specific grow journal',
    category: 'cannabis',
    args: [{ name: 'journal_id', type: 'integer', required: true }],
    handler: { file: '../commands/community/grow-journal-handler.js', method: 'handleView' },
    aliases: ['jv']
});

// Grow calculators
register('calctent', {
    description: 'Calculate grow tent requirements',
    category: 'cannabis',
    args: [{ name: 'size', type: 'string', required: true }],
    handler: { file: '../commands/community/grow-handlers.js', method: 'handleCalcTent' },
    aliases: []
});

// Grow stats
register('growstats', {
    description: 'View community grow statistics',
    category: 'cannabis',
    args: [],
    handler: { file: '../commands/community/grow-stats-handler.js', method: 'handleStatsCommunity' },
    aliases: []
});

register('growleaderboard', {
    description: 'View the grower leaderboard',
    category: 'cannabis',
    args: [],
    handler: { file: '../commands/community/grow-stats-handler.js', method: 'handleStatsLeaderboard' },
    aliases: ['growlb']
});

// Reminders
register('remind', {
    description: 'Set a grow reminder',
    category: 'cannabis',
    args: [
        { name: 'type', type: 'string', required: true },
        { name: 'time', type: 'string', required: true, rest: true }
    ],
    handler: { file: '../commands/community/grow-reminder-handler.js', method: 'handleReminderSet' },
    aliases: ['reminder']
});

register('reminders', {
    description: 'List your reminders',
    category: 'cannabis',
    args: [],
    handler: { file: '../commands/community/grow-reminder-handler.js', method: 'handleReminderList' },
    aliases: []
});

// ═══════════════════════════════════════════════════════════
// SOCIAL / COMMUNITY COMMANDS
// ═══════════════════════════════════════════════════════════

register('birthday', {
    description: 'Set your birthday',
    category: 'social',
    args: [{ name: 'date', type: 'string', required: true }],
    handler: { file: '../commands/community/engage-birthday-handler.js', method: 'handleSet' },
    aliases: ['bday']
});

register('birthdays', {
    description: 'View upcoming birthdays',
    category: 'social',
    args: [{ name: 'days', type: 'integer', required: false }],
    handler: { file: '../commands/community/engage-birthday-handler.js', method: 'handleList' },
    aliases: []
});

register('suggest', {
    description: 'Submit a suggestion',
    category: 'social',
    args: [{ name: 'suggestion', type: 'string', required: true, rest: true }],
    handler: { file: '../commands/community/engage-suggest-handler.js', method: 'handleSubmit' },
    aliases: ['suggestion']
});

register('voicestats', {
    description: 'View voice channel stats',
    category: 'social',
    args: [{ name: 'user', type: 'user', required: false }],
    handler: { file: '../commands/community/engage-voice-handler.js', method: 'handleStats' },
    aliases: ['vc']
});

register('voiceleaderboard', {
    description: 'View voice activity leaderboard',
    category: 'social',
    args: [{ name: 'period', type: 'string', required: false }],
    handler: { file: '../commands/community/engage-voice-handler.js', method: 'handleLeaderboard' },
    aliases: ['vclb']
});

register('achievements', {
    description: 'View your achievements',
    category: 'social',
    args: [{ name: 'user', type: 'user', required: false }],
    handler: { file: '../commands/community/engage-achievement-handler.js', method: 'handleList' },
    aliases: ['ach']
});

register('achievementprogress', {
    description: 'View achievement progress',
    category: 'social',
    args: [],
    handler: { file: '../commands/community/engage-achievement-handler.js', method: 'handleProgress' },
    aliases: ['achprog']
});

register('tag', {
    description: 'Show a tag',
    category: 'social',
    args: [{ name: 'name', type: 'string', required: true }],
    handler: { file: '../commands/community/engage-tags-handler.js', method: 'handleGet' },
    aliases: ['t']
});

register('tags', {
    description: 'List all tags',
    category: 'social',
    args: [{ name: 'page', type: 'integer', required: false }],
    handler: { file: '../commands/community/engage-tags-handler.js', method: 'handleListTags' },
    aliases: []
});

register('tagsearch', {
    description: 'Search for a tag',
    category: 'social',
    args: [{ name: 'query', type: 'string', required: true, rest: true }],
    handler: { file: '../commands/community/engage-tags-handler.js', method: 'handleSearch' },
    aliases: []
});

register('poll', {
    description: 'Create a poll',
    category: 'social',
    args: [
        { name: 'question', type: 'string', required: true },
        { name: 'options', type: 'string', required: true, rest: true }
    ],
    handler: { file: '../commands/community/manage-poll-handler.js', method: 'handleCreate' },
    aliases: []
});

register('giveaway', {
    description: 'Start a giveaway',
    category: 'social',
    args: [
        { name: 'prize', type: 'string', required: true, rest: true }
    ],
    handler: { file: '../commands/community/manage-giveaway-handler.js', method: 'handleStart' },
    aliases: ['gstart']
});

register('gend', {
    description: 'End a giveaway',
    category: 'social',
    args: [{ name: 'message-id', type: 'string', required: true }],
    handler: { file: '../commands/community/manage-giveaway-handler.js', method: 'handleEnd' },
    aliases: []
});

register('greroll', {
    description: 'Reroll a giveaway winner',
    category: 'social',
    args: [{ name: 'message-id', type: 'string', required: true }],
    handler: { file: '../commands/community/manage-giveaway-handler.js', method: 'handleReroll' },
    aliases: []
});

// ═══════════════════════════════════════════════════════════
// TOOLS COMMANDS
// ═══════════════════════════════════════════════════════════

register('translate', {
    description: 'Translate text',
    category: 'tools',
    args: [{ name: 'text', type: 'string', required: true, rest: true }],
    handler: { file: '../commands/tools/tools-translate-handler.js', method: 'handleTranslateText' },
    aliases: ['tr']
});

register('password', {
    description: 'Generate a secure password',
    category: 'tools',
    args: [{ name: 'length', type: 'integer', required: false }],
    handler: { file: '../commands/tools/tools-generate-handler.js', method: 'handlePassword' },
    aliases: ['genpass']
});

register('uuid', {
    description: 'Generate a UUID',
    category: 'tools',
    args: [{ name: 'count', type: 'integer', required: false }],
    handler: { file: '../commands/tools/tools-generate-handler.js', method: 'handleUUID' },
    aliases: []
});

register('hash', {
    description: 'Hash a string',
    category: 'tools',
    args: [{ name: 'text', type: 'string', required: true, rest: true }],
    handler: { file: '../commands/tools/tools-generate-handler.js', method: 'handleHash' },
    aliases: []
});

register('base64', {
    description: 'Encode or decode base64',
    category: 'tools',
    args: [
        { name: 'action', type: 'string', required: true },
        { name: 'text', type: 'string', required: true, rest: true }
    ],
    handler: { file: '../commands/tools/tools-generate-handler.js', method: 'handleBase64' },
    aliases: ['b64']
});

register('qr', {
    description: 'Generate a QR code',
    category: 'tools',
    args: [{ name: 'content', type: 'string', required: true, rest: true }],
    handler: { file: '../commands/tools/tools-qr-handler.js', method: 'handleQrGenerate' },
    aliases: ['qrcode']
});

register('tts', {
    description: 'Convert text to speech',
    category: 'tools',
    args: [{ name: 'text', type: 'string', required: true, rest: true }],
    handler: { file: '../commands/tools/tools-tts-handler.js', method: 'handleSpeak' },
    aliases: ['speak']
});

register('run', {
    description: 'Run code in a language',
    category: 'tools',
    args: [
        { name: 'language', type: 'string', required: true },
        { name: 'code', type: 'string', required: true, rest: true }
    ],
    handler: { file: '../commands/tools/tools-code-handler.js', method: 'handleRun' },
    aliases: ['exec', 'code']
});

register('colorinfo', {
    description: 'Get info about a color',
    category: 'tools',
    args: [{ name: 'mood', type: 'string', required: false, rest: true }],
    handler: { file: '../commands/tools/tools-color-handler.js', method: 'handleColorRandom' },
    aliases: ['randcolor']
});

register('convert', {
    description: 'Convert units',
    category: 'tools',
    args: [
        { name: 'type', type: 'string', required: true },
        { name: 'from', type: 'string', required: true },
        { name: 'to', type: 'string', required: true }
    ],
    handler: { file: '../commands/tools/tools-convert-handler.js', method: 'handleUnitConversion' },
    aliases: []
});

register('currency', {
    description: 'Convert currencies',
    category: 'tools',
    args: [
        { name: 'from', type: 'string', required: true },
        { name: 'to', type: 'string', required: true }
    ],
    handler: { file: '../commands/tools/tools-convert-handler.js', method: 'handleCurrencyConversion' },
    aliases: ['forex']
});

register('timezone', {
    description: 'Convert between timezones',
    category: 'tools',
    args: [
        { name: 'time', type: 'string', required: true },
        { name: 'from', type: 'string', required: true },
        { name: 'to', type: 'string', required: true }
    ],
    handler: { file: '../commands/tools/tools-convert-handler.js', method: 'handleTimezoneConversion' },
    aliases: ['tz']
});

// ═══════════════════════════════════════════════════════════
// INFO / KNOWLEDGE COMMANDS
// ═══════════════════════════════════════════════════════════

register('crypto', {
    description: 'Get cryptocurrency price',
    category: 'info',
    args: [{ name: 'coin', type: 'string', required: true }],
    handler: { file: '../commands/info/knowledge-crypto-handler.js', method: 'handlePrice' },
    aliases: ['btc', 'eth']
});

register('cryptotrending', {
    description: 'View trending cryptocurrencies',
    category: 'info',
    args: [],
    handler: { file: '../commands/info/knowledge-crypto-handler.js', method: 'handleTrending' },
    aliases: []
});

register('github', {
    description: 'Look up a GitHub repo',
    category: 'info',
    args: [{ name: 'repository', type: 'string', required: true }],
    handler: { file: '../commands/info/knowledge-github-handler.js', method: 'handleRepo' },
    aliases: ['gh']
});

register('ghuser', {
    description: 'Look up a GitHub user',
    category: 'info',
    args: [{ name: 'username', type: 'string', required: true }],
    handler: { file: '../commands/info/knowledge-github-handler.js', method: 'handleUser' },
    aliases: []
});

register('recipe', {
    description: 'Search for a recipe',
    category: 'info',
    args: [{ name: 'query', type: 'string', required: true, rest: true }],
    handler: { file: '../commands/info/knowledge-recipe-handler.js', method: 'handleSearch' },
    aliases: []
});

register('cocktail', {
    description: 'Search for a cocktail recipe',
    category: 'info',
    args: [{ name: 'name', type: 'string', required: true, rest: true }],
    handler: { file: '../commands/info/knowledge-recipe-handler.js', method: 'handleCocktail' },
    aliases: ['drink']
});

register('userinfo', {
    description: 'Show info about a user',
    category: 'info',
    args: [{ name: 'user', type: 'user', required: false }],
    handler: { file: '../commands/info/user.js', method: 'handleUserInfo' },
    aliases: ['whois', 'ui', 'lookup']
});

register('serverinfo', {
    description: 'Show server info',
    category: 'info',
    args: [],
    handler: { file: '../commands/info/server.js', method: 'default.execute' },
    aliases: ['si']
});

register('avatar', {
    description: "Show a user's avatar",
    category: 'info',
    args: [{ name: 'user', type: 'user', required: false }],
    handler: { file: '../commands/info/user.js', method: 'handleUserInfo' },
    aliases: ['av', 'pfp']
});

// ═══════════════════════════════════════════════════════════
// UTILITY / ADMIN COMMANDS
// ═══════════════════════════════════════════════════════════

register('ping', {
    description: 'Check bot latency',
    category: 'utility',
    args: [],
    handler: { file: '../commands/tools/ping.js', method: 'default.execute' },
    aliases: []
});

register('prefix', {
    description: 'Show or change the prefix for this server',
    category: 'utility',
    args: [{ name: 'new_prefix', type: 'string', required: false }],
    handler: 'builtin:prefix',
    aliases: []
});

register('prefixhelp', {
    description: 'Show all available prefix commands',
    category: 'utility',
    args: [{ name: 'category', type: 'string', required: false }],
    handler: 'builtin:help',
    aliases: ['pcmds', 'phelp']
});

register('alias', {
    description: 'Manage custom command aliases for this server',
    category: 'utility',
    args: [
        { name: 'action', type: 'string', required: true },
        { name: 'alias_name', type: 'string', required: false },
        { name: 'target_command', type: 'string', required: false, rest: true }
    ],
    handler: 'builtin:alias',
    aliases: ['aliases']
});

register('disable', {
    description: 'Disable a prefix command in this server',
    category: 'utility',
    args: [{ name: 'command', type: 'string', required: true }],
    handler: 'builtin:disable',
    aliases: []
});

register('enable', {
    description: 'Enable a previously disabled prefix command',
    category: 'utility',
    args: [{ name: 'command', type: 'string', required: true }],
    handler: 'builtin:enable',
    aliases: []
});

register('cleanup', {
    description: 'Configure auto-cleanup for prefix commands',
    category: 'utility',
    args: [
        { name: 'setting', type: 'string', required: true },
        { name: 'value', type: 'string', required: false, rest: true }
    ],
    handler: 'builtin:cleanup',
    aliases: []
});

// Embed builder (only quick — create/edit use modals which don't work with prefix)
register('quickembed', {
    description: 'Quickly send an embed',
    category: 'utility',
    args: [
        { name: 'title', type: 'string', required: false },
        { name: 'description', type: 'string', required: false, rest: true }
    ],
    handler: { file: '../commands/admin/admin-embed-handler.js', method: 'handleQuick' },
    aliases: ['qe']
});

// ═══════════════════════════════════════════════════════════
// OwO — hunt & zoo mini-game (CC-BY-NC-SA module, see /LICENSE-OWO-NOTICE.md)
// ═══════════════════════════════════════════════════════════

register('owo', {
    description: 'OwO hunt & zoo mini-game. Try `owo hunt`, `owo zoo`, `owo daily`.',
    category: 'owo',
    args: [
        { name: 'subcommand', type: 'string', required: false },
        { name: 'rank',       type: 'string', required: false },
        { name: 'user',       type: 'user',   required: false },
        { name: 'amount',     type: 'string', required: false },
        { name: 'text',       type: 'string', required: false, rest: true },
    ],
    handler: { file: '../handlers/owo-prefix.js', method: 'handleOwoRouter' },
    aliases: [],
});

register('hunt', {
    description: 'Hunt for an animal (OwO).',
    category: 'owo',
    args: [],
    handler: { file: '../handlers/owo-prefix.js', method: 'handleHunt' },
    aliases: ['catch', 'h'],
});

register('zoo', {
    description: 'View your zoo (OwO).',
    category: 'owo',
    args: [{ name: 'user', type: 'user', required: false }],
    handler: { file: '../handlers/owo-prefix.js', method: 'handleZoo' },
    aliases: [],
});

register('owoify', {
    description: 'OwOify some text.',
    category: 'owo',
    args: [{ name: 'text', type: 'string', required: true, rest: true }],
    handler: { file: '../handlers/owo-prefix.js', method: 'handleOwoify' },
    aliases: ['uwuify'],
});

// ═══════════════════════════════════════════════════════════

export function getCommand(name) {
    return registry.get(name.toLowerCase());
}

export function getAllCommands() {
    // Return only canonical entries (not aliases)
    return [...registry.entries()]
        .filter(([, def]) => !def.isAlias)
        .map(([name, def]) => ({ name, ...def }));
}

export function getCommandsByCategory(category) {
    return getAllCommands().filter(cmd => cmd.category === category);
}

export function getCategories() {
    return [...new Set(getAllCommands().map(cmd => cmd.category))];
}

export default registry;
