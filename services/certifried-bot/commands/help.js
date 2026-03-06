/**
 * !tokes / !help / !commands
 * Display available commands
 */

import logger from '../../../utils/logger.js';

const COMMAND_CATEGORIES = {
    tokes: {
        name: 'Toke Tracking',
        commands: [
            { cmd: '!lit', aliases: ['!blaze', '!burn', '!toke'], desc: 'Track a toke' },
            { cmd: '!spark', aliases: ['!daily', '!ignite'], desc: 'Daily claim with streaks' },
            { cmd: '!fireboard', aliases: ['!fb', '!top'], desc: 'Leaderboard (add: global, streaks, level)' },
            { cmd: '!embers', aliases: ['!globallit'], desc: 'Global stats' }
        ]
    },
    sessions: {
        name: 'Smoke Sessions',
        commands: [
            { cmd: '!sesh', aliases: ['!circle'], desc: 'Start a smoke session (add: joint/blunt/bong/pipe/dab/vape)' },
            { cmd: '!hit', aliases: ['!puff'], desc: 'Take a hit / join session' },
            { cmd: '!pass', aliases: ['!next'], desc: 'Pass to next person' },
            { cmd: '!doused', aliases: ['!endsesh'], desc: 'End the session' }
        ]
    },
    strains: {
        name: 'Strain Info',
        commands: [
            { cmd: '!strain', aliases: ['!lookup'], desc: 'Look up a strain (or: random)' },
            { cmd: '!lineage', aliases: ['!genetics'], desc: 'Strain genetics/lineage' }
        ]
    },
    fun: {
        name: 'Fun',
        commands: [
            { cmd: '!trivia', aliases: ['!ct'], desc: 'Start trivia' },
            { cmd: '!a/!b/!c/!d', aliases: [], desc: 'Answer trivia' },
            { cmd: '!elevated', aliases: ['!thoughts', '!stoned'], desc: 'Random stoned thought' }
        ]
    }
};

export async function tokesHelpCommand(ctx) {
    const { username, reply, args } = ctx;

    try {
        // Check if asking for specific category
        const category = args[0]?.toLowerCase();

        if (category && COMMAND_CATEGORIES[category]) {
            const cat = COMMAND_CATEGORIES[category];
            const cmds = cat.commands.map(c => {
                const aliases = c.aliases.length > 0 ? ` (${c.aliases.join(', ')})` : '';
                return `${c.cmd}${aliases}: ${c.desc}`;
            }).join(' | ');

            reply(`${cat.name}: ${cmds}`);
            return;
        }

        // Show overview
        const overview = Object.entries(COMMAND_CATEGORIES).map(([key, cat]) => {
            const mainCmds = cat.commands.slice(0, 2).map(c => c.cmd).join(', ');
            return `${cat.name}: ${mainCmds}...`;
        }).join(' | ');

        reply(`CertiFriedUtility Commands: ${overview} | More: !tokes <category> (tokes, sessions, strains, fun)`);

    } catch (error) {
        logger.error('[TokesHelpCommand] Error', { error: error.message });
        reply(`${username}, couldn't load commands. Try again!`);
    }
}
