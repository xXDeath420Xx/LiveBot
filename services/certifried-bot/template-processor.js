/**
 * Template Processor for CertiFriedUtility Bot
 * Processes {{variable}} placeholders in custom command responses
 */

/**
 * Available template variables and their descriptions
 */
export const templateVariables = {
    // User info
    'username': 'Display name of the user',
    'user_id': 'Platform user ID',

    // Profile stats
    'lifetime_tokes': 'Total lifetime tokes',
    'today_tokes': 'Tokes for today',
    'level': 'Current level',
    'xp': 'Current XP',
    'current_streak': 'Current daily streak',
    'best_streak': 'Best streak ever',

    // Channel stats
    'channel_tokes': 'Tokes in this channel',
    'channel_sessions': 'Sessions joined in this channel',
    'channel_trivia_wins': 'Trivia wins in this channel',

    // Channel info
    'channel_name': 'Name of the channel',
    'platform': 'Platform (twitch/kick)',

    // Dynamic values
    'random_number': 'Random number 1-100',
    'random_emote': 'Random stoner emote',
    'time': 'Current time (HH:MM)',
    'date': 'Current date (MM/DD)',

    // Command info
    'command': 'The command that was used',
    'args': 'Arguments passed to the command'
};

/**
 * Random emotes for the random_emote variable
 */
const randomEmotes = [
    'LUL', 'PogChamp', 'Kappa', 'catJAM', 'KEKW',
    'pepeMeltdown', 'pepeD', 'monkaS', 'Sadge', 'peepoHappy'
];

/**
 * Process a template string with context variables
 * @param {string} template - Template string with {{variable}} placeholders
 * @param {object} context - Context object with values
 * @returns {string} Processed string with variables replaced
 */
export function processTemplate(template, context) {
    if (!template) return '';

    const {
        username = '',
        userId = '',
        profile = {},
        channelStats = {},
        channel = {},
        platform = '',
        commandName = '',
        args = []
    } = context;

    // Build variable map
    const variables = {
        // User info
        username: username,
        user_id: userId,

        // Profile stats
        lifetime_tokes: formatNumber(profile.lifetime_tokes || 0),
        today_tokes: formatNumber(profile.today_tokes || 0),
        level: profile.level || 1,
        xp: formatNumber(profile.xp || 0),
        current_streak: profile.current_streak || 0,
        best_streak: profile.best_streak || 0,

        // Channel stats
        channel_tokes: formatNumber(channelStats.tokes || 0),
        channel_sessions: channelStats.sessions_joined || 0,
        channel_trivia_wins: channelStats.trivia_wins || 0,

        // Channel info
        channel_name: channel.channel_name || '',
        platform: platform,

        // Dynamic values
        random_number: Math.floor(Math.random() * 100) + 1,
        random_emote: randomEmotes[Math.floor(Math.random() * randomEmotes.length)],
        time: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true }),
        date: new Date().toLocaleDateString('en-US', { month: '2-digit', day: '2-digit' }),

        // Command info
        command: commandName,
        args: args.join(' ')
    };

    // Replace all {{variable}} patterns
    return template.replace(/\{\{(\w+)\}\}/g, (match, varName) => {
        const value = variables[varName.toLowerCase()];
        return value !== undefined ? String(value) : match;
    });
}

/**
 * Format a number with commas
 */
function formatNumber(num) {
    return num.toLocaleString();
}

/**
 * Validate a template string (check for unknown variables)
 * @param {string} template - Template to validate
 * @returns {object} { valid: boolean, unknownVars: string[] }
 */
export function validateTemplate(template) {
    if (!template) return { valid: true, unknownVars: [] };

    const unknownVars = [];
    const validVars = Object.keys(templateVariables);

    template.replace(/\{\{(\w+)\}\}/g, (match, varName) => {
        if (!validVars.includes(varName.toLowerCase())) {
            unknownVars.push(varName);
        }
        return match;
    });

    return {
        valid: unknownVars.length === 0,
        unknownVars
    };
}

/**
 * Get a description of all available template variables
 * @returns {string} Formatted description
 */
export function getTemplateHelp() {
    const lines = ['Available template variables:'];
    for (const [name, desc] of Object.entries(templateVariables)) {
        lines.push(`  {{${name}}} - ${desc}`);
    }
    return lines.join('\n');
}
