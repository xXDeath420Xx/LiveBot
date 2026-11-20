/*
 * The natural `owo` prefix: `owoh`, `owo h`, `owo   hunt`, `OWO ZOO`, typed with no symbol. Called from
 * events/messageCreate.js for every guild message.
 *
 * Rules:
 *   - a message containing "owo" or "uwu" anywhere earns an owo point (critters points counter, its own cooldown)
 *   - it is a command only when it STARTS with "owo" and the next word is a known alias
 *     (handlers/critters-prefix.js ALIASES); an unknown word is silent, so "owo that's cute" never gets a reply
 *   - `owo owo <text>` owoifies the text; bare `owo` / `owo owo` only earn the point
 *   - bots, DMs and empty messages are ignored; with the game switched off nothing happens at all
 * Returns true only when a command ran (the message is consumed). Never throws.
 */
import * as critters from './critters/index.js';
import { MessageContextAdapter } from './message-context-adapter.js';
import { recordCommandUse } from './command-usage.js';
import { ALIASES, routeWord, chatArgs, usagePathFor } from '../handlers/critters-prefix.js';
import { runAction } from '../handlers/critters-actions.js';
import logger from '../utils/logger.js';

export const PREFIX = 'owo';

/**
 * Pure parse of a message text.
 * @returns {{ point: boolean, command: null | { word: string, tokens: string[] } }}
 */
export function parseNatural(text) {
    const raw = String(text ?? '');
    const point = critters.earnsPoint(raw);
    const trimmed = raw.trim();
    if (!trimmed.toLowerCase().startsWith(PREFIX)) return { point, command: null };
    const rest = trimmed.slice(PREFIX.length).trim();
    const tokens = rest ? rest.split(/\s+/) : [];
    if (!tokens.length) return { point, command: null };
    const first = tokens[0].toLowerCase();
    if (first === PREFIX) {
        const words = tokens.slice(1);
        return { point, command: words.length ? { word: 'owoify', tokens: words } : null };
    }
    const word = ALIASES.get(first);
    if (!word) return { point, command: null };
    if (word === 'owoify' && tokens.length < 2) return { point, command: null };
    return { point, command: { word, tokens: tokens.slice(1) } };
}

/** The action a message would run, or null: [action, args]. */
export function resolveNatural(text) {
    const { command } = parseNatural(text);
    return command ? routeWord(command.word, command.tokens) : null;
}

export async function handleOwoNaturalPrefix(message) {
    try {
        if (!message?.guild || !message.author || message.author.bot) return false;
        const text = message.content;
        if (!text) return false;
        const parsed = parseNatural(text);
        if (!parsed.point && !parsed.command) return false;
        const guildId = message.guild.id;
        if (!(await critters.isEnabled(guildId))) return false;
        if (parsed.point) {
            critters.recordPoint(guildId, message.author.id, text).catch((e) => logger.debug('[critters] point not recorded', { error: e.message }));
        }
        if (!parsed.command) return false;
        const [action, args] = routeWord(parsed.command.word, parsed.command.tokens);
        const ctx = new MessageContextAdapter(message, 'owo', {});
        const started = Date.now();
        const outcome = await runAction(ctx, action, args, { natural: true });
        if (outcome !== 'refused') {
            recordCommandUse({
                guildId, channelId: message.channelId, userId: message.author.id, appId: message.client?.user?.id,
                path: usagePathFor(action, args), kind: 'prefix', prefix: PREFIX, success: outcome !== 'failed',
                errorCode: outcome === 'failed' ? 'critters' : null, latencyMs: Date.now() - started,
            });
        }
        return true;
    } catch (err) {
        logger.warn('[critters] natural prefix failed', { error: err.message, guildId: message?.guild?.id });
        return false;
    }
}

/** For core/command-catalog.js (natural forms on the /owo entry) and tests. */
export const _internals = { ALIASES, PREFIX, buildArgs: chatArgs, parseNatural, resolveNatural };
