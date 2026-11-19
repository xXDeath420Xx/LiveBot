/*
 * Discord rejects a whole command payload past 100 slash commands, so one new command would freeze a bot on
 * its last good set. fitCustomBotCommands keeps a custom bot's guild payload under the limit, and
 * fitSlashLimit does the same for the default bot's global payload (it reached exactly 100 on 2026-11-05).
 */
export const MAX_SLASH_COMMANDS = 100;

// Off on custom bots: these servers have never shown them, and their commands are visible to every member.
const CANNABIS_COMMANDS = new Set([
    'cannabis', 'grow', 'cheers', 'dailyjoint', 'endcircle', 'join', 'pass', 'puff', 'smokecircle',
]);

// Left out first to last, only as far as needed. The first two are aliases: /watch and /user profile info
// run the same code. Anything added here should be a command a server can lose without losing a feature.
const OVERFLOW_ORDER = ['movie', 'lookup', 'owoify', 'windrose', 'sprites', 'channel-archive-default', 'luck'];

const isSlash = cmd => (cmd.type ?? 1) === 1;

/**
 * Drop OVERFLOW_ORDER commands until the payload fits. `reserve` holds slots for guild-only commands added
 * to this payload. `overBy` above 0 means OVERFLOW_ORDER ran out.
 */
export function fitSlashLimit(commands, reserve = 0) {
    const dropped = new Set();
    let excess = commands.filter(isSlash).length + reserve - MAX_SLASH_COMMANDS;
    for (const name of OVERFLOW_ORDER) {
        if (excess <= 0) break;
        if (!commands.some(cmd => cmd.name === name && isSlash(cmd))) continue;
        dropped.add(name);
        excess--;
    }
    return {
        commands: commands.filter(cmd => !dropped.has(cmd.name)),
        dropped: [...dropped],
        overBy: Math.max(0, excess),
    };
}

/** The command JSON a custom bot deploys: no cannabis commands, then fitted to the limit. */
export function fitCustomBotCommands(commands, reserve = 0) {
    return fitSlashLimit(commands.filter(cmd => !CANNABIS_COMMANDS.has(cmd.name)), reserve);
}
