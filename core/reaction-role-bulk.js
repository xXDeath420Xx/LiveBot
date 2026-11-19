/**
 * Bulk role-mapping parser for reaction role panels.
 *
 * Turns a pasted list into panel mappings so a 20-role panel isn't 20 trips through the
 * one-at-a-time form. One line per role:
 *
 *     Gaming                          → role only, label defaults to the role name
 *     Gaming | 🎮                     → with an emoji
 *     Gaming | Gaming Pings | 🎮 | green
 *     <@&123456789012345678> | 🎮     → role mentions and raw ids work too
 *
 * Tokens after the role are order-independent: anything that looks like an emoji becomes the
 * emoji, anything that names a button colour becomes the style, and whatever is left is the
 * label. That way `Gaming | 🎮 | Gaming Pings` and `Gaming | Gaming Pings | 🎮` agree.
 */

/** Discord's ceiling per panel type — 5 button rows of 5, 25 select options, 20 reactions. */
export const PANEL_CAPACITY = { button: 25, select_menu: 25, select: 25, reaction: 20 };

export const MAX_LABEL_LENGTH = 80;

const STYLE_WORDS = {
    primary: 'primary', blue: 'primary', blurple: 'primary',
    secondary: 'secondary', grey: 'secondary', gray: 'secondary',
    success: 'success', green: 'success',
    danger: 'danger', red: 'danger',
};

const CUSTOM_EMOJI = /^<a?:[a-zA-Z0-9_]+:\d{15,25}>$/;
const ROLE_MENTION = /^<@&(\d{15,25})>$/;
const SNOWFLAKE = /^\d{15,25}$/;

/** Unicode emoji, including sequences like flags, keycaps, and ZWJ families. */
function isUnicodeEmoji(token) {
    if (!token || token.length > 16) return false;
    return /^(\p{Extended_Pictographic}|\p{Regional_Indicator}{2}|[0-9#*]️?⃣)[\p{Extended_Pictographic}\p{Emoji_Modifier}️‍⃣]*$/u.test(token);
}

export function capacityFor(interactionType) {
    return PANEL_CAPACITY[interactionType] ?? PANEL_CAPACITY.reaction;
}

/**
 * @param {string} text                Pasted lines.
 * @param {object} opts
 * @param {Array<{id:string,name:string}>} opts.guildRoles   Roles that may be mapped.
 * @param {string} opts.interactionType  'reaction' | 'button' | 'select_menu'
 * @param {Set<string>} [opts.existingRoleIds]  Roles already on this panel.
 * @returns {{ entries: Array, errors: Array<{line:number, text:string, error:string}> }}
 */
export function parseMappingList(text, { guildRoles = [], interactionType = 'reaction', existingRoleIds = new Set() } = {}) {
    const byId = new Map();
    const byName = new Map();
    for (const role of guildRoles) {
        byId.set(String(role.id), role);
        const key = role.name.toLowerCase();
        // A duplicated role name can't be resolved by name — record the clash rather than
        // silently binding to whichever one the iteration happened to reach first.
        if (byName.has(key)) byName.set(key, 'ambiguous');
        else byName.set(key, role);
    }

    const entries = [];
    const errors = [];
    const seen = new Map();

    const lines = String(text ?? '').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
        const lineNo = i + 1;
        const raw = lines[i].trim();
        if (!raw || raw.startsWith('//')) continue;

        const [rolePart, ...tokens] = raw.split('|').map(p => p.trim());
        if (!rolePart) {
            errors.push({ line: lineNo, text: raw, error: 'No role before the first "|"' });
            continue;
        }

        const mention = ROLE_MENTION.exec(rolePart);
        const lookupId = mention ? mention[1] : (SNOWFLAKE.test(rolePart) ? rolePart : null);
        const found = lookupId ? byId.get(lookupId) : byName.get(rolePart.toLowerCase());

        if (found === 'ambiguous') {
            errors.push({ line: lineNo, text: raw, error: `More than one role is named "${rolePart}" — use its id instead` });
            continue;
        }
        if (!found) {
            errors.push({
                line: lineNo, text: raw,
                error: lookupId ? `No role with id ${lookupId}` : `No role named "${rolePart}"`,
            });
            continue;
        }

        const entry = {
            line: lineNo,
            role_id: String(found.id),
            role_name: found.name,
            emoji_id: null,
            label: null,
            button_style: 'primary',
        };

        let bad = null;
        for (const token of tokens) {
            if (!token) continue;
            if (!entry.emoji_id && (isUnicodeEmoji(token) || CUSTOM_EMOJI.test(token))) { entry.emoji_id = token; continue; }
            const style = STYLE_WORDS[token.toLowerCase()];
            if (style) { entry.button_style = style; continue; }
            if (token.length > MAX_LABEL_LENGTH) {
                bad = `Label is ${token.length} characters — Discord allows ${MAX_LABEL_LENGTH}`;
                break;
            }
            entry.label = token;
        }
        if (bad) { errors.push({ line: lineNo, text: raw, error: bad }); continue; }

        if (interactionType === 'reaction' && !entry.emoji_id) {
            errors.push({ line: lineNo, text: raw, error: 'Reaction panels need an emoji on every line' });
            continue;
        }

        if (seen.has(entry.role_id)) {
            errors.push({ line: lineNo, text: raw, error: `Same role as line ${seen.get(entry.role_id)}` });
            continue;
        }
        if (existingRoleIds.has(entry.role_id)) {
            errors.push({ line: lineNo, text: raw, error: `${found.name} is already on this panel` });
            continue;
        }
        seen.set(entry.role_id, lineNo);
        entries.push(entry);
    }

    return { entries, errors };
}
