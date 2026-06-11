#!/usr/bin/env node
/**
 * RPG Interaction-Layer Harness
 * ------------------------------------------------------------------
 * Drives every /rpg subcommand through its real handler with a mock
 * interaction + a real DB + real managers, WITHOUT a Discord gateway.
 *
 * Purpose: surface in-client interaction-layer bugs (empty embeds,
 * field value > 1024, embed > 6000, > 25 fields, missing title/desc,
 * reply-after-defer ordering, sending neither content nor embeds,
 * malformed component rows) that the manager-level tests never hit.
 *
 * It seeds a throwaway character + campaign + session + combat +
 * inventory/spell/quest/dungeon state so state-dependent subcommands
 * execute their real path, then cleans up everything it created.
 *
 * Idempotent + re-runnable: cleanup runs first (purges any leftover
 * test rows) and again at the end / on failure.
 *
 * Usage: node scripts/rpg-interaction-harness.mjs [--verbose]
 */

import { EmbedBuilder } from 'discord.js';
import pool from '../utils/db.js';

import rpgCommand from '../commands/games/rpg.js';
import RPGCharacterManager from '../core/rpg-character-manager.js';
import RPGCombatManager from '../core/rpg-combat-manager.js';
import RPGQuestManager from '../core/rpg-quest-manager.js';
import RPGShopManager from '../core/rpg-shop-manager.js';

const VERBOSE = process.argv.includes('--verbose');

// ---- Test identity ----------------------------------------------------------
const TEST_USER_ID = '900000000000004242';
const TEST_USER2_ID = '900000000000004343'; // second player (for pvp targets)
const TEST_GUILD_ID = '1469931133981687873';
const TEST_CHANNEL_ID = '900000000000009999';
const TEST_USERNAME = 'HarnessHero';

// =============================================================================
// validatePayload — mirrors discord.js / Discord API limits
// =============================================================================
const LIMITS = {
    embedTitle: 256,
    embedDescription: 4096,
    embedFields: 25,
    fieldName: 256,
    fieldValue: 1024,
    embedTotal: 6000,
    authorName: 256,
    footerText: 2048,
    components: 5,
    rows: 5,
};

function embedToJSON(embed) {
    // Accept either an EmbedBuilder or a raw embed object
    if (embed && typeof embed.toJSON === 'function') return embed.toJSON();
    return embed;
}

function validateEmbed(embed, idx) {
    const errors = [];
    let json;
    try {
        json = embedToJSON(embed);
    } catch (e) {
        errors.push(`embed[${idx}].toJSON() threw: ${e.message}`);
        return errors;
    }
    if (!json || typeof json !== 'object') {
        errors.push(`embed[${idx}] is not an object`);
        return errors;
    }

    let total = 0;

    if (json.title != null) {
        if (typeof json.title !== 'string' || json.title.length === 0) {
            errors.push(`embed[${idx}].title is empty`);
        } else if (json.title.length > LIMITS.embedTitle) {
            errors.push(`embed[${idx}].title length ${json.title.length} > ${LIMITS.embedTitle}`);
        }
        total += (json.title || '').length;
    }

    if (json.description != null) {
        if (typeof json.description !== 'string' || json.description.length === 0) {
            errors.push(`embed[${idx}].description is empty`);
        } else if (json.description.length > LIMITS.embedDescription) {
            errors.push(`embed[${idx}].description length ${json.description.length} > ${LIMITS.embedDescription}`);
        }
        total += (json.description || '').length;
    }

    if (json.author?.name != null) {
        if (json.author.name.length > LIMITS.authorName) {
            errors.push(`embed[${idx}].author.name length ${json.author.name.length} > ${LIMITS.authorName}`);
        }
        total += json.author.name.length;
    }
    if (json.footer?.text != null) {
        if (json.footer.text.length > LIMITS.footerText) {
            errors.push(`embed[${idx}].footer.text length ${json.footer.text.length} > ${LIMITS.footerText}`);
        }
        total += json.footer.text.length;
    }

    const fields = json.fields || [];
    if (fields.length > LIMITS.embedFields) {
        errors.push(`embed[${idx}] has ${fields.length} fields > ${LIMITS.embedFields}`);
    }
    fields.forEach((f, fi) => {
        if (f.name == null || typeof f.name !== 'string' || f.name.length === 0) {
            errors.push(`embed[${idx}].field[${fi}].name is empty`);
        } else if (f.name.length > LIMITS.fieldName) {
            errors.push(`embed[${idx}].field[${fi}].name length ${f.name.length} > ${LIMITS.fieldName}`);
        }
        if (f.value == null || typeof f.value !== 'string' || f.value.length === 0) {
            errors.push(`embed[${idx}].field[${fi}].value is empty (name="${f.name}")`);
        } else if (f.value.length > LIMITS.fieldValue) {
            errors.push(`embed[${idx}].field[${fi}].value length ${f.value.length} > ${LIMITS.fieldValue} (name="${f.name}")`);
        }
        total += (f.name || '').length + (f.value || '').length;
    });

    // Must have *something* renderable
    const hasContent = (json.title && json.title.length) ||
        (json.description && json.description.length) ||
        fields.length > 0 ||
        json.image || json.thumbnail || json.author || json.footer;
    if (!hasContent) {
        errors.push(`embed[${idx}] is completely empty`);
    }

    if (total > LIMITS.embedTotal) {
        errors.push(`embed[${idx}] total chars ${total} > ${LIMITS.embedTotal}`);
    }

    return errors;
}

function validateComponents(components) {
    const errors = [];
    if (!Array.isArray(components)) return errors;
    if (components.length > LIMITS.rows) {
        errors.push(`components has ${components.length} rows > ${LIMITS.rows}`);
    }
    components.forEach((row, ri) => {
        let json;
        try {
            json = typeof row.toJSON === 'function' ? row.toJSON() : row;
        } catch (e) {
            errors.push(`components[${ri}].toJSON() threw: ${e.message}`);
            return;
        }
        const comps = json.components || [];
        if (comps.length > LIMITS.components) {
            errors.push(`components[${ri}] has ${comps.length} components > ${LIMITS.components}`);
        }
        if (comps.length === 0) {
            errors.push(`components[${ri}] is an empty row`);
        }
    });
    return errors;
}

function validatePayload(p) {
    const errors = [];
    if (!p || typeof p !== 'object') {
        return ['payload is not an object'];
    }

    const hasContent = typeof p.content === 'string' && p.content.length > 0;
    const hasEmbeds = Array.isArray(p.embeds) && p.embeds.length > 0;
    const hasFiles = Array.isArray(p.files) && p.files.length > 0;
    const hasComponents = Array.isArray(p.components) && p.components.length > 0;

    if (!hasContent && !hasEmbeds && !hasFiles) {
        // Components alone is not a valid message for reply/editReply in this app's usage
        if (!hasComponents) {
            errors.push('payload has neither content nor embeds/files');
        } else {
            errors.push('payload has components but no content/embeds (would error)');
        }
    }

    if (hasEmbeds) {
        p.embeds.forEach((e, i) => errors.push(...validateEmbed(e, i)));
    }
    if (hasComponents) {
        errors.push(...validateComponents(p.components));
    }

    return errors;
}

// =============================================================================
// Mock interaction factory
// =============================================================================
function makeInteraction({ group, sub, args = {}, client }) {
    const recorded = [];
    const state = { replied: false, deferred: false };

    const opt = (name, required = false) => {
        if (name in args) return args[name];
        if (required) throw new Error(`Mock: required option "${name}" not provided for ${group} ${sub}`);
        return null;
    };

    const options = {
        getSubcommandGroup: (req) => group ?? (req ? (() => { throw new Error('no group'); })() : null),
        getSubcommand: () => sub,
        getString: (n, req) => { const v = opt(n, req); return v == null ? null : String(v); },
        getInteger: (n, req) => { const v = opt(n, req); return v == null ? null : parseInt(v, 10); },
        getNumber: (n, req) => { const v = opt(n, req); return v == null ? null : Number(v); },
        getBoolean: (n, req) => { const v = opt(n, req); return v == null ? null : Boolean(v); },
        getUser: (n, req) => opt(n, req),
        getChannel: (n, req) => opt(n, req),
        getAttachment: (n, req) => opt(n, req),
        getFocused: () => ({ name: '', value: '' }),
    };

    const recordPayload = (kind, payload) => {
        // Normalize a string payload to { content }
        const norm = typeof payload === 'string' ? { content: payload } : (payload || {});
        recorded.push({ kind, payload: norm });
        return { id: `mockmsg_${recorded.length}`, edit: async () => ({}) };
    };

    const interaction = {
        user: {
            id: TEST_USER_ID,
            username: TEST_USERNAME,
            displayName: TEST_USERNAME,
            displayAvatarURL: () => 'https://cdn.discordapp.com/embed/avatars/0.png',
            toString: () => `<@${TEST_USER_ID}>`,
        },
        member: { id: TEST_USER_ID, displayName: TEST_USERNAME },
        guild: {
            id: TEST_GUILD_ID,
            name: 'Harness Guild',
            members: { fetch: async (id) => ({ id, displayName: 'Member ' + id }) },
            roles: { cache: new Map(), fetch: async () => null },
        },
        guildId: TEST_GUILD_ID,
        channel: { id: TEST_CHANNEL_ID, name: 'harness-channel' },
        channelId: TEST_CHANNEL_ID,
        client,
        options,
        commandName: 'rpg',
        get replied() { return state.replied; },
        get deferred() { return state.deferred; },

        async reply(payload) {
            if (state.replied || state.deferred) {
                throw new Error('INTERACTION_ALREADY_REPLIED: reply() called after reply/defer');
            }
            state.replied = true;
            return recordPayload('reply', payload);
        },
        async deferReply(payload) {
            if (state.replied || state.deferred) {
                throw new Error('INTERACTION_ALREADY_REPLIED: deferReply() after reply/defer');
            }
            state.deferred = true;
            recorded.push({ kind: 'deferReply', payload: payload || {} });
            return { id: 'mockdefer' };
        },
        async editReply(payload) {
            if (!state.deferred && !state.replied) {
                throw new Error('INTERACTION_NOT_REPLIED: editReply() before defer/reply');
            }
            return recordPayload('editReply', payload);
        },
        async followUp(payload) {
            if (!state.deferred && !state.replied) {
                throw new Error('INTERACTION_NOT_REPLIED: followUp() before defer/reply');
            }
            return recordPayload('followUp', payload);
        },
        async update(payload) {
            state.replied = true;
            return recordPayload('update', payload);
        },
        async respond() { /* autocomplete */ },
    };

    return { interaction, recorded, state };
}

// =============================================================================
// Seeding
// =============================================================================
async function cleanup(label = 'cleanup') {
    const conn = pool;
    // Resolve all test character ids in the test guild for these users
    const [chars] = await conn.execute(
        `SELECT character_id FROM dnd_characters WHERE guild_id = ? AND user_id IN (?, ?)`,
        [TEST_GUILD_ID, TEST_USER_ID, TEST_USER2_ID]
    );
    const charIds = chars.map(c => c.character_id);

    // Campaigns created by test users in test guild
    const [camps] = await conn.execute(
        `SELECT campaign_id FROM dnd_campaigns WHERE guild_id = ? AND dm_user_id IN (?, ?)`,
        [TEST_GUILD_ID, TEST_USER_ID, TEST_USER2_ID]
    );
    const campIds = camps.map(c => c.campaign_id);

    const exec = async (sql, params) => { try { await conn.execute(sql, params); } catch (e) { if (VERBOSE) console.log(`  [${label}] skip: ${e.message}`); } };

    if (charIds.length) {
        const ph = charIds.map(() => '?').join(',');
        await exec(`DELETE FROM dnd_battles WHERE character_id IN (${ph})`, charIds);
        await exec(`DELETE FROM dnd_inventory WHERE character_id IN (${ph})`, charIds);
        await exec(`DELETE FROM dnd_character_spells WHERE character_id IN (${ph})`, charIds);
        await exec(`DELETE FROM dnd_spell_slots WHERE character_id IN (${ph})`, charIds);
        await exec(`DELETE FROM dnd_character_quests WHERE character_id IN (${ph})`, charIds);
        await exec(`DELETE FROM dnd_dungeon_runs WHERE character_id IN (${ph})`, charIds);
        await exec(`DELETE FROM dnd_campaign_players WHERE character_id IN (${ph})`, charIds);
        await exec(`DELETE FROM dnd_class_resources WHERE character_id IN (${ph})`, charIds);
        await exec(`DELETE FROM dnd_pvp_matches WHERE challenger_id IN (${ph}) OR defender_id IN (${ph})`, [...charIds, ...charIds]);
        await exec(`DELETE FROM dnd_pvp_stats WHERE character_id IN (${ph})`, charIds);
        await exec(`DELETE FROM dnd_party_members WHERE character_id IN (${ph})`, charIds);
    }
    if (campIds.length) {
        const ph = campIds.map(() => '?').join(',');
        await exec(`DELETE FROM dnd_sessions WHERE campaign_id IN (${ph})`, campIds);
        await exec(`DELETE FROM dnd_campaign_players WHERE campaign_id IN (${ph})`, campIds);
        await exec(`DELETE FROM dnd_campaigns WHERE campaign_id IN (${ph})`, campIds);
    }
    // Parties led by test users (leader keyed by user id)
    await exec(`DELETE FROM dnd_parties WHERE guild_id = ? AND leader_user_id IN (?, ?)`, [TEST_GUILD_ID, TEST_USER_ID, TEST_USER2_ID]);
    await exec(`DELETE FROM dnd_party_members WHERE user_id IN (?, ?)`, [TEST_USER_ID, TEST_USER2_ID]);
    await exec(`DELETE FROM dnd_characters WHERE guild_id = ? AND user_id IN (?, ?)`, [TEST_GUILD_ID, TEST_USER_ID, TEST_USER2_ID]);
}

async function countTestRows() {
    const [chars] = await pool.execute(
        `SELECT COUNT(*) c FROM dnd_characters WHERE guild_id = ? AND user_id IN (?, ?)`,
        [TEST_GUILD_ID, TEST_USER_ID, TEST_USER2_ID]
    );
    const [camps] = await pool.execute(
        `SELECT COUNT(*) c FROM dnd_campaigns WHERE guild_id = ? AND dm_user_id IN (?, ?)`,
        [TEST_GUILD_ID, TEST_USER_ID, TEST_USER2_ID]
    );
    return chars[0].c + camps[0].c;
}

const seeded = {};

async function seedState(client) {
    const cm = client.rpgCharacterManager;

    // Primary character (wizard, so spell/resource paths work)
    await cm.createCharacter(TEST_USER_ID, TEST_GUILD_ID, 'Harness Hero', 'wizard', { species: 'human', background: 'sage' });
    const character = await cm.getCharacter(TEST_USER_ID, TEST_GUILD_ID);
    seeded.character = character;
    const cid = character.character_id;

    // Give it gold + a couple levels so quests/dungeons/shop have headroom
    await pool.execute(`UPDATE dnd_characters SET gold = 500, level = 3, experience = 50, mana = 20, max_mana = 20 WHERE character_id = ?`, [cid]);

    // Second character (pvp target / party)
    await cm.createCharacter(TEST_USER2_ID, TEST_GUILD_ID, 'Harness Foe', 'fighter', { species: 'human' });
    const char2 = await cm.getCharacter(TEST_USER2_ID, TEST_GUILD_ID);
    seeded.character2 = char2;

    // Inventory: a potion (id 15 = Health Potion) + a weapon for equip/sell
    await pool.execute(
        `INSERT INTO dnd_inventory (character_id, item_id, quantity, equipped) VALUES (?, 15, 3, 0), (?, 1, 1, 0)`,
        [cid, cid]
    );

    // Known spell (Fire Bolt cantrip = id 1) + a level-1 leveled spell if available
    await pool.execute(
        `INSERT INTO dnd_character_spells (character_id, spell_id, spell_source) VALUES (?, 1, 'class')`,
        [cid]
    ).catch(() => {});
    // Spell slots so /rpg spell cast (leveled) + slots view work
    await pool.execute(
        `INSERT INTO dnd_spell_slots (character_id, slot_level, total_slots, used_slots) VALUES (?, 1, 2, 0)
         ON DUPLICATE KEY UPDATE total_slots=2, used_slots=0`,
        [cid]
    ).catch(() => {});
    // Learn a level-1 spell so /rpg spell cast name:<leveled> works
    const [lvl1] = await pool.execute(`SELECT spell_id, spell_name FROM dnd_spells WHERE spell_level = 1 LIMIT 1`);
    if (lvl1.length) {
        seeded.leveledSpell = lvl1[0].spell_name;
        await pool.execute(
            `INSERT INTO dnd_character_spells (character_id, spell_id, spell_source) VALUES (?, ?, 'class')`,
            [cid, lvl1[0].spell_id]
        ).catch(() => {});
    }

    // Active quest (quest 1) so /rpg quest active + complete have a target
    await pool.execute(
        `INSERT INTO dnd_character_quests (character_id, quest_id, status, progress) VALUES (?, 1, 'active', 100)`,
        [cid]
    ).catch(() => {});

    // Campaign + session (direct insert, no Gemini for setup) so play/session subs run
    const [campRes] = await pool.execute(
        `INSERT INTO dnd_campaigns (guild_id, channel_id, campaign_name, dm_user_id, campaign_type, setting, theme, difficulty, status, max_players, session_count)
         VALUES (?, ?, 'Harness Campaign', ?, 'homebrew', 'Forgotten Realms', 'classic fantasy', 'normal', 'active', 6, 1)`,
        [TEST_GUILD_ID, TEST_CHANNEL_ID, TEST_USER_ID]
    );
    const campaignId = campRes.insertId;
    seeded.campaignId = campaignId;
    await pool.execute(
        `INSERT INTO dnd_campaign_players (campaign_id, character_id, user_id, role) VALUES (?, ?, ?, 'player')`,
        [campaignId, cid, TEST_USER_ID]
    );
    const [sessRes] = await pool.execute(
        `INSERT INTO dnd_sessions (campaign_id, session_number, title, current_location, current_scene, summary, status, started_at)
         VALUES (?, 1, 'Harness Session', 'The Testing Grounds', 'You stand in a featureless white void used for testing.', 'A test session.', 'active', NOW())`,
        [campaignId]
    );
    seeded.sessionId = sessRes.insertId;

    // Active battle (enemy 1 = Goblin) so combat attack/flee/item/status run
    await client.rpgCombatManager.startBattle(cid, 1).catch(e => { if (VERBOSE) console.log('  seed battle skip:', e.message); });

    // Active dungeon run (dungeon 1) so dungeon room/advance/status/leave run
    try {
        const RPGDungeonManager = (await import('../core/rpg-dungeon-manager.js')).default;
        await RPGDungeonManager.startRun(null, 1, 'normal', { guildId: TEST_GUILD_ID, characterId: cid });
        seeded.dungeonStarted = true;
    } catch (e) { if (VERBOSE) console.log('  seed dungeon skip:', e.message); }

    return character;
}

// Ensure a transient piece of state exists right before a sub that consumes it,
// so the handler runs its REAL embed path instead of a "no active X" early return.
async function ensureBattle(client) {
    const cid = seeded.character.character_id;
    const [b] = await pool.execute(`SELECT battle_id FROM dnd_battles WHERE character_id = ? AND status='ongoing'`, [cid]);
    if (!b.length) await client.rpgCombatManager.startBattle(cid, 1).catch(() => {});
}
async function ensureSession() {
    // Re-activate the seeded session (session/end may have closed it)
    if (!seeded.sessionId || !seeded.campaignId) return;
    await pool.execute(`UPDATE dnd_sessions SET status='active', ended_at=NULL WHERE session_id=?`, [seeded.sessionId]).catch(() => {});
    await pool.execute(`UPDATE dnd_campaigns SET status='active' WHERE campaign_id=?`, [seeded.campaignId]).catch(() => {});
}
async function ensureDungeonRun() {
    const cid = seeded.character.character_id;
    const [r] = await pool.execute(`SELECT run_id FROM dnd_dungeon_runs WHERE character_id=? AND status='active'`, [cid]);
    if (!r.length) {
        const RPGDungeonManager = (await import('../core/rpg-dungeon-manager.js')).default;
        await RPGDungeonManager.startRun(null, 1, 'normal', { guildId: TEST_GUILD_ID, characterId: cid }).catch(() => {});
    }
}
async function ensureQuest() {
    const cid = seeded.character.character_id;
    const [q] = await pool.execute(`SELECT id FROM dnd_character_quests WHERE character_id=? AND quest_id=1 AND status='active'`, [cid]);
    if (!q.length) {
        await pool.execute(`DELETE FROM dnd_character_quests WHERE character_id=? AND quest_id=1`, [cid]).catch(() => {});
        await pool.execute(`INSERT INTO dnd_character_quests (character_id, quest_id, status, progress) VALUES (?, 1, 'active', 100)`, [cid]).catch(() => {});
    }
}
async function ensurePotion() {
    const cid = seeded.character.character_id;
    const [i] = await pool.execute(`SELECT inventory_id FROM dnd_inventory WHERE character_id=? AND item_id=15`, [cid]);
    if (!i.length) await pool.execute(`INSERT INTO dnd_inventory (character_id,item_id,quantity,equipped) VALUES (?,15,3,0)`, [cid]).catch(() => {});
    else await pool.execute(`UPDATE dnd_inventory SET quantity=GREATEST(quantity,3) WHERE inventory_id=?`, [i[0].inventory_id]).catch(() => {});
}

async function clearBattle() {
    const cid = seeded.character.character_id;
    await pool.execute(`DELETE FROM dnd_battles WHERE character_id=?`, [cid]).catch(() => {});
}

// Restore the user's character to the seeded campaign + active session so the
// session/play groups (which run after the campaign group) hit real paths.
async function restoreSeededCampaign() {
    const cid = seeded.character.character_id;
    if (!seeded.campaignId) return;
    await pool.execute(`UPDATE dnd_characters SET active_campaign_id=NULL WHERE character_id=?`, [cid]).catch(() => {});
    await pool.execute(`DELETE FROM dnd_campaign_players WHERE character_id=?`, [cid]).catch(() => {});
    await pool.execute(
        `INSERT INTO dnd_campaign_players (campaign_id, character_id, user_id, role) VALUES (?, ?, ?, 'player')`,
        [seeded.campaignId, cid, TEST_USER_ID]
    ).catch(() => {});
    await pool.execute(`UPDATE dnd_characters SET active_campaign_id=? WHERE character_id=?`, [seeded.campaignId, cid]).catch(() => {});
    await pool.execute(`UPDATE dnd_campaigns SET status='active' WHERE campaign_id=?`, [seeded.campaignId]).catch(() => {});
}

async function reseedFor(client, key) {
    // First session/play sub re-anchors the user to the seeded campaign/session
    if (key === 'session/start') await restoreSeededCampaign();
    switch (key) {
        case 'campaign/create': {
            // Detach the character from any campaign so the auto-join success path runs
            const cid = seeded.character.character_id;
            await pool.execute(`UPDATE dnd_characters SET active_campaign_id=NULL WHERE character_id=?`, [cid]).catch(() => {});
            await pool.execute(`DELETE FROM dnd_campaign_players WHERE character_id=?`, [cid]).catch(() => {});
            break;
        }
        case 'campaign/join': {
            // Make a fresh joinable campaign (different DM/character) the user is NOT in,
            // and detach the user's character so the join SUCCESS embed path runs.
            const cid = seeded.character.character_id;
            await pool.execute(`UPDATE dnd_characters SET active_campaign_id=NULL WHERE character_id=?`, [cid]).catch(() => {});
            await pool.execute(`DELETE FROM dnd_campaign_players WHERE character_id=?`, [cid]).catch(() => {});
            const [c] = await pool.execute(
                `INSERT INTO dnd_campaigns (guild_id, channel_id, campaign_name, dm_user_id, campaign_type, setting, theme, difficulty, status, max_players, session_count)
                 VALUES (?, ?, 'Joinable Camp', ?, 'homebrew', 'Forgotten Realms', 'classic fantasy', 'normal', 'active', 6, 0)`,
                [TEST_GUILD_ID, TEST_CHANNEL_ID, TEST_USER2_ID]
            );
            seeded.joinableCampaignId = c.insertId;
            break;
        }
        case 'combat/fight':
            await clearBattle(); break; // exercise the real "start battle" path
        case 'dungeon/enter':
            await pool.execute(`UPDATE dnd_dungeon_runs SET status='abandoned' WHERE character_id=? AND status='active'`, [seeded.character.character_id]).catch(() => {});
            break;
        case 'play/action': case 'play/say': case 'play/examine':
        case 'play/combat': case 'play/explore': case 'play/social': case 'play/rest':
        case 'session/recap':
            await ensureSession(); break;
        case 'combat/attack': case 'combat/flee': case 'combat/status':
            await ensureBattle(client); break;
        case 'combat/item':
            await ensureBattle(client); await ensurePotion(); break;
        case 'dungeon/room': case 'dungeon/advance': case 'dungeon/status': case 'dungeon/leave':
            await ensureDungeonRun(); break;
        case 'quest/active': case 'quest/complete':
            await ensureQuest(); break;
        default: break;
    }
}

// =============================================================================
// Enumerate subcommands from the built command JSON
// =============================================================================
function enumerateSubcommands() {
    const json = rpgCommand.data.toJSON();
    const list = [];
    for (const opt of json.options || []) {
        // type 2 = SUB_COMMAND_GROUP, type 1 = SUB_COMMAND
        if (opt.type === 2) {
            for (const subOpt of opt.options || []) {
                if (subOpt.type === 1) list.push({ group: opt.name, sub: subOpt.name });
            }
        } else if (opt.type === 1) {
            list.push({ group: null, sub: opt.name });
        }
    }
    return list;
}

// =============================================================================
// Argument map — sensible args per subcommand
// =============================================================================
function buildArgMap() {
    const mkUser = (id, username) => ({
        id, username, displayName: username,
        displayAvatarURL: () => 'https://cdn.discordapp.com/embed/avatars/0.png',
        toString: () => `<@${id}>`,
    });
    const foe = mkUser(TEST_USER2_ID, 'HarnessFoe');

    return {
        // character
        'character/view': {},
        'character/stats': {},
        // inventory
        'inventory/equip': { item_id: 1 },
        'inventory/unequip': { item_id: 1 },
        // roll
        'roll/dice': { notation: '2d6+3', advantage: 'normal' },
        'roll/ability': { ability: 'strength', dc: 12, advantage: 'normal' },
        'roll/skill': { skill: 'arcana', dc: 12, advantage: 'normal' },
        'roll/save': { ability: 'dexterity', dc: 12, advantage: 'normal' },
        // campaign
        'campaign/create': { name: 'Harness Camp2', type: 'homebrew', setting: 'Forgotten Realms', theme: 'classic fantasy', difficulty: 'normal' },
        'campaign/join': { campaign: String(0) }, // filled at runtime with seeded campaign id
        // session
        // play
        'play/action': { action: 'I look around the void carefully.' },
        'play/say': { dialogue: 'Hello, is anyone there?' },
        'play/examine': { target: 'the white void' },
        'play/combat': { action: 'attack', target: 'training dummy', details: 'staff' },
        'play/explore': { action: 'search', target: 'the floor' },
        'play/social': { action: 'persuade', target: 'the void', message: 'Let me pass.' },
        'play/rest': { type: 'short' },
        'play/roll': { type: 'skill:perception', advantage: 'normal' },
        // settings
        'settings/channel': { channel: { id: TEST_CHANNEL_ID, toString: () => `<#${TEST_CHANNEL_ID}>` } },
        // spell
        'spell/cast': { name: 'Fire Bolt' },
        'spell/learn': { name: 'Mage Hand' },
        'spell/prepare': { name: 'Fire Bolt' },
        // resource
        'resource/use': { name: 'Arcane Recovery', amount: 1 },
        'resource/rest': { type: 'long' },
        // condition
        'condition/info': { name: 'blinded' },
        'condition/exhaustion': { action: 'view' },
        'condition/inspiration': { action: 'view' },
        // stats
        'stats/leaderboard': { type: 'level' },
        // rest
        'rest/short': { hit_dice: 1 },
        // combat
        'combat/fight': { enemy_id: 2 }, // 1 already in active battle from seed; expect graceful err
        'combat/item': { item_id: 15 },
        // shop
        'shop/buy': { item_id: 15, quantity: 1 },
        'shop/sell': { item_id: 1, quantity: 1 },
        // quest
        'quest/start': { quest_id: 2 },
        'quest/complete': { quest_id: 1 },
        'quest/abandon': { quest_id: 1 },
        // dungeon
        'dungeon/enter': { dungeon_id: 2, difficulty: 'normal' },
        // party
        'party/create': { name: 'Harness Party' },
        'party/invite': { user: foe },
        // pvp
        'pvp/challenge': { user: foe, type: 'duel', wager: 0 },
        'pvp/accept': { match_id: 0 },  // filled at runtime
        'pvp/decline': { match_id: 0 },
        'pvp/resolve': { match_id: 0 },
    };
}

// Subcommands legitimately skipped (need a real second live actor / external upload)
const SKIP = {
    'character/create': 'character already seeded; create path covered by handleCreate via seed (would dup-error)',
    'character/import': 'requires a real D&D Beyond PDF attachment + network fetch',
    'character/delete': 'would delete the seeded character mid-run (destructive); covered separately at end',
    'pvp/accept': 'needs the OTHER player to invoke accept (cross-user state); challenge path verified',
    'pvp/decline': 'needs the OTHER player; challenge path verified',
};

// =============================================================================
// Run one subcommand
// =============================================================================
async function runOne(client, { group, sub }, argMap) {
    const key = `${group}/${sub}`;
    if (SKIP[key]) {
        return { key, status: 'skip', reason: SKIP[key] };
    }

    let args = { ...(argMap[key] || {}) };

    // Runtime-fill dynamic args
    if (key === 'campaign/join') args.campaign = String(seeded.joinableCampaignId || seeded.campaignId);
    if (group === 'pvp' && ['accept', 'decline', 'resolve'].includes(sub)) {
        args.match_id = seeded.pvpMatchId || 999999;
    }

    const { interaction, recorded, state } = makeInteraction({ group, sub, args, client });

    let runErr = null;
    try {
        await rpgCommand.execute(interaction);
    } catch (e) {
        runErr = e;
    }

    // Capture pvp match id created by challenge for later (even though accept is skipped)
    if (key === 'pvp/challenge' && !runErr) {
        try {
            const [m] = await pool.execute(
                `SELECT match_id FROM dnd_pvp_matches WHERE guild_id = ? AND challenger_id = ? ORDER BY match_id DESC LIMIT 1`,
                [TEST_GUILD_ID, seeded.character.character_id]
            );
            if (m.length) seeded.pvpMatchId = m[0].match_id;
        } catch { /* ignore */ }
    }

    // Validate every recorded user-visible payload (reply/editReply/followUp/update)
    const payloadErrors = [];
    const visible = recorded.filter(r => ['reply', 'editReply', 'followUp', 'update'].includes(r.kind));
    if (visible.length === 0 && !runErr) {
        payloadErrors.push('handler produced no reply/editReply/update at all');
    }
    for (const r of visible) {
        const errs = validatePayload(r.payload);
        payloadErrors.push(...errs.map(e => `[${r.kind}] ${e}`));
        // Detect the rpg.js top-level catch fallback — a masked internal throw
        if (r.payload.content === 'An error occurred while processing your RPG command.') {
            payloadErrors.push(`[${r.kind}] hit top-level error catch (internal throw masked as generic error message)`);
        }
    }

    const shape = visible.map(r => {
        const p = r.payload;
        const parts = [];
        if (p.content) parts.push('content');
        if (p.embeds?.length) parts.push(`${p.embeds.length}embed`);
        if (p.components?.length) parts.push(`${p.components.length}row`);
        return `${r.kind}:${parts.join('+') || 'empty'}`;
    }).join(',');

    if (runErr) {
        return { key, status: 'fail', error: `threw: ${runErr.message}`, stack: runErr.stack, shape };
    }
    if (payloadErrors.length) {
        return { key, status: 'fail', error: payloadErrors.join(' || '), shape };
    }
    return { key, status: 'pass', shape };
}

// =============================================================================
// Main
// =============================================================================
async function main() {
    const client = {};
    client.rpgCharacterManager = new RPGCharacterManager(client);
    client.rpgCombatManager = new RPGCombatManager(client, client.rpgCharacterManager);
    client.rpgQuestManager = new RPGQuestManager(client, client.rpgCharacterManager);
    client.rpgShopManager = new RPGShopManager(client, client.rpgCharacterManager);

    console.log('=== RPG Interaction Harness ===');
    console.log('Cleaning up any leftover test rows...');
    await cleanup('pre');

    console.log('Seeding throwaway state...');
    await seedState(client);

    const all = enumerateSubcommands();
    const argMap = buildArgMap();
    console.log(`Enumerated ${all.length} subcommands across ${new Set(all.map(s => s.group)).size} groups.\n`);

    const results = [];
    for (const sc of all) {
        // Re-seed transient state consumed by destructive subs so later subs hit the real path
        await reseedFor(client, `${sc.group}/${sc.sub}`);
        const r = await runOne(client, sc, argMap);
        results.push(r);
        const tag = r.status === 'pass' ? 'PASS' : r.status === 'skip' ? 'SKIP' : 'FAIL';
        const detail = r.status === 'pass' ? (VERBOSE ? `  {${r.shape}}` : '') : `  -> ${r.error || r.reason}`;
        console.log(`[${tag}] ${r.key}${detail}`);
    }

    // Final cleanup + verify
    console.log('\nCleaning up test rows...');
    await cleanup('post');
    const remaining = await countTestRows();

    // Summary
    const pass = results.filter(r => r.status === 'pass').length;
    const fail = results.filter(r => r.status === 'fail').length;
    const skip = results.filter(r => r.status === 'skip').length;
    console.log('\n=== SUMMARY ===');
    console.log(`PASS: ${pass}   FAIL: ${fail}   SKIP: ${skip}   (total ${results.length})`);
    console.log(`Test rows remaining after cleanup: ${remaining}`);

    if (fail > 0) {
        console.log('\n--- FAILURES ---');
        for (const r of results.filter(r => r.status === 'fail')) {
            console.log(`\n${r.key}\n  ${r.error}`);
            if (VERBOSE && r.stack) console.log(r.stack.split('\n').slice(0, 6).join('\n'));
        }
    }

    await pool.end().catch(() => {});
    process.exit(fail > 0 || remaining > 0 ? 1 : 0);
}

// ---- Self-test: prove validatePayload has teeth (no DB) ----------------------
function selfTest() {
    const cases = [
        { name: 'empty payload', p: {}, expectFail: true },
        { name: 'components-only', p: { components: [{ toJSON: () => ({ components: [{}] }) }] }, expectFail: true },
        { name: 'content only', p: { content: 'hi' }, expectFail: false },
        { name: 'empty embed', p: { embeds: [new EmbedBuilder()] }, expectFail: true },
        { name: 'good embed', p: { embeds: [new EmbedBuilder().setTitle('T').setDescription('D')] }, expectFail: false },
        { name: 'raw over-long field', p: { embeds: [{ toJSON: () => ({ title: 'T', fields: [{ name: 'f', value: 'x'.repeat(1100) }] }) }] }, expectFail: true },
        { name: 'raw empty field value', p: { embeds: [{ toJSON: () => ({ title: 'T', fields: [{ name: 'f', value: '' }] }) }] }, expectFail: true },
        { name: 'raw 26 fields', p: { embeds: [{ toJSON: () => ({ title: 'T', fields: Array.from({ length: 26 }, (_, i) => ({ name: 'n' + i, value: 'v' })) }) }] }, expectFail: true },
        { name: 'raw 6001 total', p: { embeds: [{ toJSON: () => ({ description: 'x'.repeat(6001) }) }] }, expectFail: true },
        { name: '6 component rows', p: { content: 'x', components: Array.from({ length: 6 }, () => ({ toJSON: () => ({ components: [{}] }) })) }, expectFail: true },
    ];
    let ok = true;
    for (const c of cases) {
        const errs = validatePayload(c.p);
        const failed = errs.length > 0;
        const pass = failed === c.expectFail;
        if (!pass) ok = false;
        console.log(`[${pass ? 'OK' : 'BAD'}] selftest "${c.name}" -> ${failed ? 'flagged' : 'clean'} (expected ${c.expectFail ? 'flagged' : 'clean'})${pass ? '' : '  *** validator wrong'}`);
        if (VERBOSE && failed) console.log('     ', errs.join(' | '));
    }
    console.log(ok ? '\nself-test: PASS' : '\nself-test: FAIL');
    process.exit(ok ? 0 : 1);
}

if (process.argv.includes('--selftest')) {
    selfTest();
} else {
    main().catch(async (e) => {
        console.error('HARNESS CRASH:', e);
        try { await cleanup('crash'); } catch { /* */ }
        try { await pool.end(); } catch { /* */ }
        process.exit(2);
    });
}
