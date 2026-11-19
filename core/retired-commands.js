/*
 * Commands that were retired and removed from the command definitions (register H-650; the owner approved
 * removing them on 2026-11-19): the Reddit feed subcommands of /socials feed and /community automeme
 * (Reddit closed its API to new apps, H-201), and the six /arcade cfx subcommands (CertiFried Tycoon,
 * replaced by Greenhouse Tycoon).
 *
 * Typed as a text command (`/arcade cfx stats`, `!automeme setup`, `/feed reddit-add`) they answer with the
 * reason instead of a list of other subcommands (core/universal-commands.js). A slash command Discord still
 * shows until the next command deploy answers the same way (the parent command's fallback).
 */
import { MessageFlags } from 'discord.js';
import { isGreenhouseLive, oldGameMovedMessage } from '../services/cfx/integrations/cutover.js';
import { FROZEN_MESSAGE } from '../services/certifried-extension/freeze.js';

const REDDIT_FEEDS = 'Reddit feeds are not available: Reddit closed its API to new apps.';
const AUTOMEME = 'Auto-memes are not available: they came from Reddit, which closed its API to new apps.';
const oldGame = () => (isGreenhouseLive() ? oldGameMovedMessage() : FROZEN_MESSAGE);

// Each path also matches what the chat bridge accepts in its place: a bare group name (`feed …`, `cfx …`).
export const RETIRED = Object.freeze([
    { paths: ['socials feed reddit-add', 'feed reddit-add'], message: () => REDDIT_FEEDS },
    { paths: ['socials feed reddit-remove', 'feed reddit-remove'], message: () => REDDIT_FEEDS },
    { paths: ['socials feed reddit-list', 'feed reddit-list'], message: () => REDDIT_FEEDS },
    { paths: ['community automeme', 'automeme'], message: () => AUTOMEME },
    { paths: ['arcade cfx', 'cfx'], message: oldGame },
]);

/**
 * The reason a retired command is gone, or null. `words` is the typed command as words or one string,
 * with or without its prefix (`/arcade cfx stats`, ['arcade', 'cfx', 'stats']).
 */
export function retiredMessage(words) {
    const list = (Array.isArray(words) ? words : String(words ?? '').split(/\s+/))
        .map(w => String(w).trim().toLowerCase()).filter(Boolean);
    if (list.length) list[0] = list[0].replace(/^[!?$./]+/, '');
    const typed = list.join(' ');
    if (!typed) return null;
    for (const r of RETIRED) {
        if (r.paths.some(p => typed === p || typed.startsWith(`${p} `))) return r.message();
    }
    return null;
}

/** Answer an interaction for a retired path (used by the parent commands until the next deploy). */
export async function replyRetired(interaction, path) {
    const content = retiredMessage(path) || 'That command is no longer available.';
    if (interaction.deferred || interaction.replied) return interaction.editReply({ content, embeds: [], components: [] });
    return interaction.reply({ content, flags: MessageFlags.Ephemeral });
}
