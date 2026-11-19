/*
 * /digimon — raise a team of partner Digimon from Digi-Eggs, tame wild ones that appear in chat, battle one on
 * one or team against team, digivolve, de-digivolve and DNA Digivolve, and take the daily "Which Digital Monster
 * are you today?" quiz. Every "which partner" option takes a Digimon number and autocompletes from the team; left
 * out, it means the team leader.
 *
 * Off until a server turns it on: COMMAND_FEATURE_MAP gates the command on digimon_settings.enabled, and
 * events/messageCreate.js only calls spawnDigimon when the server has it on. The rules (care, evolution,
 * battles, the quiz) are pure functions in core/digimon-logic.js and core/digimon-quiz.js. No AI.
 */
import { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, AttachmentBuilder, MessageFlags, ChannelType, PermissionFlagsBits, StringSelectMenuBuilder, ComponentType } from 'discord.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';
import { displayNameFor } from '../../utils/display-name.js';
import { themeColor } from '../../core/guild-theme.js';
import { getConfig, setConfig } from '../../core/feature-config.js';
import {
    STAGES, HEARTS_MAX, applyDecay, careLeaning, evolveBlockers, chooseEvolution, nextStage, addXp,
    nameMatches, stageReset, marketPayout, cannotMove, stableHash,
    RARITY, rollRarity, rarityOfStage, STARTERS, starterForm,
    TEAM_SIZE, DAY_MS, DEFAULT_LIFESPAN_DAYS, lifespanMs, lifeOver, rebirthIvs, formsOf, previousForm, wornOutRevert,
    formsBelow, dnaBlockers, CARD_KEYWORDS, CARD_LEVEL, SECURITY_SIZE, levelLabel, canBattle, dpOf, wildDp, battleLoser, runMatch,
} from '../../core/digimon-logic.js';
import {
    quizDay, questionsForDay, scoreAnswers, pickDigimon, QUESTIONS_PER_DAY, POWER_LEVELS, CATEGORIES, CRESTS,
    familyOf, familyWord, signatureMove, weightsFor,
} from '../../core/digimon-quiz.js';
import { loadQuizBank } from '../../core/digimon-quiz-bank.js';

const CREDIT = 'Digimon data: digi-api.com and Wikimon (CC BY-SA)';
const PER_PAGE = 15;
const TRAIN_COOLDOWN = 30 * 60 * 1000;
const EXPLORE_COOLDOWN = 30 * 60 * 1000;
const DAILY_COOLDOWN = 24 * 60 * 60 * 1000;
const SPAWN_COOLDOWN = 2 * 60 * 1000;
const MEAT_PRICE = 30;
const TRADE_TTL_MS = 10 * 60 * 1000;
const MAX_LISTINGS = 5;
const MAX_PRICE = 1_000_000;
const WHY_NOT = {
    'not-owned': 'that Digimon isn\'t theirs any more',
    partner: 'it\'s on the team (move it to the DigiBank first with `/digimon team remove`)',
    dna: 'it is DNA-fused with another partner',
    locked: 'it is listed on the market',
};
const XP = { feed: 5, train: 25, tame: 40, battleWin: 60, battleLose: 20, wildWin: 40, wildLose: 10 };
const IMAGE_DIR = path.join(process.cwd(), 'data', 'digimon-images');

const lastSpawn = new Map(); // channelId → ms

const json = v => (Array.isArray(v) ? v : typeof v === 'string' ? (() => { try { return JSON.parse(v); } catch { return []; } })() : []);
const ephemeral = { flags: MessageFlags.Ephemeral };
const randInt = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));
const hearts = n => '♥'.repeat(n) + '♡'.repeat(Math.max(0, HEARTS_MAX - n));
const displayName = row => row.nickname ? `${row.nickname} (${row.name})` : row.name;
// About 8% of Digimon have no English description in the data; say so rather than leave a blank.
/** Battle numbers as members see them: stage, level, strength hearts and the Digimon's own spread. */
const about = (d, max) => (d.description || 'No description recorded for this Digimon yet.').slice(0, max);

function species(row) {
    return { ...row, levels: json(row.levels), attributes: json(row.attributes), fields: json(row.fields), types: json(row.types), skills: json(row.skills),
        card_keywords: json(row.card_keywords), card_inherited: json(row.card_inherited), card_dps: json(row.card_dps) };
}

/**
 * The Digimon's picture as an attachment. Sent as a file named wild.png rather than a link, because the
 * source URL is the Digimon's name and would give away every spawn. Cached on disk after the first fetch.
 */
async function imageFile(d, name = 'digimon.png') {
    if (!d.image_url) return null;
    const file = path.join(IMAGE_DIR, `${d.id}.png`);
    let buf = await fs.readFile(file).catch(() => null);
    if (!buf) {
        try {
            const res = await fetch(d.image_url, { signal: AbortSignal.timeout(15000) });
            if (!res.ok) return null;
            buf = Buffer.from(await res.arrayBuffer());
            await fs.mkdir(IMAGE_DIR, { recursive: true });
            await fs.writeFile(file, buf);
        } catch (err) {
            logger.warn(`[Digimon] Image fetch failed for ${d.id}: ${err.message}`);
            return null;
        }
    }
    return new AttachmentBuilder(buf, { name });
}

async function withImage(embed, d, name = 'digimon.png') {
    const file = await imageFile(d, name);
    if (file) embed.setImage(`attachment://${name}`);
    return { embeds: [embed], files: file ? [file] : [] };
}

async function randomSpecies(stage) {
    const [[row]] = await pool.execute('SELECT * FROM digimon_data WHERE level = ? ORDER BY RAND() LIMIT 1', [stage]);
    return row ? species(row) : null;
}

/**
 * A Baby I for a new egg. Only ones with a Baby II form in the data: three Baby I (Pipimon, Torikara
 * Ballmon, Bombmon) have none, and a player who hatched one could never evolve it.
 */
async function eggSpecies() {
    const [[row]] = await pool.execute(
        `SELECT d.* FROM digimon_data d
          WHERE d.level = 'Baby I'
            AND EXISTS (SELECT 1 FROM digimon_evolutions e JOIN digimon_data n ON n.id = e.to_id
                         WHERE e.from_id = d.id AND JSON_CONTAINS(n.levels, '"Baby II"'))
          ORDER BY RAND() LIMIT 1`);
    return row ? species(row) : null;
}

/** The Baby I egg of a starter line, by its exact name. */
async function starterEgg(starter) {
    const [[row]] = await pool.execute(`SELECT * FROM digimon_data WHERE name = ? AND level = 'Baby I' LIMIT 1`, [starter.line[0]]);
    return row ? species(row) : null;
}

function rollIvs() {
    return { iv_hp: randInt(0, 15), iv_atk: randInt(0, 15), iv_def: randInt(0, 15), iv_spd: randInt(0, 15) };
}

async function ensureInventory(guildId, userId) {
    await pool.execute('INSERT IGNORE INTO digimon_inventory (guild_id, user_id) VALUES (?, ?)', [guildId, userId]);
    const [[inv]] = await pool.execute('SELECT * FROM digimon_inventory WHERE guild_id = ? AND user_id = ?', [guildId, userId]);
    return inv;
}

async function addToDex(guildId, userId, digimonId) {
    await pool.execute(
        `INSERT INTO user_digimon_dex (guild_id, user_id, digimon_id) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE times = times + 1`, [guildId, userId, digimonId]);
}

/** A new Digimon for a member: on the team in the first free slot if there is one, else in the DigiBank. */
async function giveDigimon(guildId, userId, d, level, { starter = null } = {}) {
    const now = Date.now();
    const iv = rollIvs();
    const slot = await freeSlot(guildId, userId);
    const [res] = await pool.execute(
        `INSERT INTO user_digimon (guild_id, user_id, digimon_id, level, iv_hp, iv_atk, iv_def, iv_spd, is_partner, team_slot, hunger_at, strength_at, aged_at, starter, forms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [guildId, userId, d.id, level, iv.iv_hp, iv.iv_atk, iv.iv_def, iv.iv_spd, slot ? 1 : 0, slot, now, now, slot ? now : null, starter,
         JSON.stringify({ [d.level]: d.id })]);
    await addToDex(guildId, userId, d.id);
    return { id: res.insertId, slot };
}

// The species columns are aliased: d.level and d.id would otherwise overwrite u.level and u.id.
const MEMBER_SQL = `SELECT u.*, d.name, d.level AS stage, d.levels, d.attributes, d.fields, d.skills, d.image_url, d.description,
                           d.card_dp, d.card_level, d.card_color, d.card_keywords, d.card_inherited, d.card_dps
                      FROM user_digimon u JOIN digimon_data d ON d.id = u.digimon_id`;

const lifespanDays = async guildId => {
    const v = Number((await getConfig('digimon', guildId)).lifespan_days);
    return Number.isFinite(v) ? v : DEFAULT_LIFESPAN_DAYS;
};

/** A team partner with care and age brought up to date (and saved). */
async function settle(row) {
    const p = species(row);
    const cared = applyDecay(p, Date.now());
    const keys = ['hunger', 'strength', 'care_mistakes', 'total_mistakes', 'hunger_at', 'strength_at', 'age_ms', 'aged_at'];
    if (keys.some(k => cared[k] !== p[k])) {
        await pool.execute(
            `UPDATE user_digimon SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`, [...keys.map(k => cared[k]), p.id]);
    }
    return { ...cared, image_url: p.image_url, attribute: cared.attributes[0] ?? 'Unknown' };
}

/**
 * The Baby I a Digimon is reborn as: the egg it hatched from if it remembers one, its starter egg, else a Baby I
 * of its own line found by walking the evolution data backwards (picked by a hash, so it is always the same).
 */
async function rebirthEgg(p) {
    const forms = formsOf(p);
    const ids = forms['Baby I'] ? [forms['Baby I']] : [];
    const starter = STARTERS.find(s => s.key === p.starter);
    if (!ids.length && starter) { const egg = await starterEgg(starter); if (egg) return egg; }
    if (!ids.length) {
        let frontier = [p.digimon_id];
        const seen = new Set(frontier);
        for (let step = 0; step < 6 && frontier.length && !ids.length; step++) {
            const [rows] = await pool.query(
                `SELECT DISTINCT d.id, d.level FROM digimon_evolutions e JOIN digimon_data d ON d.id = e.from_id WHERE e.to_id IN (?)`, [frontier.slice(0, 300)]);
            frontier = [];
            for (const r of rows) {
                if (seen.has(r.id)) continue;
                seen.add(r.id);
                if (r.level === 'Baby I') ids.push(r.id); else frontier.push(r.id);
            }
        }
        ids.sort((a, b) => stableHash(`${p.id}:${a}`) - stableHash(`${p.id}:${b}`));
    }
    for (const id of ids) {
        // Only an egg that can hatch on: three Baby I have no Baby II form (see eggSpecies).
        const [[row]] = await pool.execute(
            `SELECT d.* FROM digimon_data d WHERE d.id = ? AND EXISTS (SELECT 1 FROM digimon_evolutions e JOIN digimon_data n ON n.id = e.to_id
              WHERE e.from_id = d.id AND JSON_CONTAINS(n.levels, '"Baby II"'))`, [id]);
        if (row) return species(row);
    }
    return eggSpecies();
}

/** Undo a DNA fusion: the other Digimon comes back (to the team if there is room) as it was before. */
async function splitDna(p, conn = pool) {
    if (!p.dna_partner_id) return null;
    const slot = await freeSlot(p.guild_id, p.user_id, conn);
    const now = Date.now();
    await conn.execute(
        `UPDATE user_digimon SET locked = NULL, team_slot = ?, is_partner = ?, hunger_at = ?, strength_at = ?, aged_at = ?
          WHERE id = ? AND locked = 'dna'`, [slot, slot ? 1 : 0, now, now, slot ? now : null, p.dna_partner_id]);
    await conn.execute('UPDATE user_digimon SET dna_partner_id = NULL, dna_stage = NULL WHERE id = ?', [p.id]);
    const [[back]] = await conn.execute(`${MEMBER_SQL} WHERE u.id = ?`, [p.dna_partner_id]);
    return back ? { ...back, onTeam: Boolean(slot) } : null;
}

/** V-Pet rebirth: the partner returns to a Digi-Egg of its line as the next generation and keeps its slot. */
async function rebirth(p) {
    await splitDna(p);
    const egg = await rebirthEgg(p);
    if (!egg) return null;
    const now = Date.now();
    const iv = rebirthIvs(p);
    await pool.execute(
        `UPDATE user_digimon SET digimon_id = ?, level = 1, xp = 0, iv_hp = ?, iv_atk = ?, iv_def = ?, iv_spd = ?,
                hunger = ?, strength = 2, care_mistakes = 0, total_mistakes = 0, trainings = 0, battles = 0, wins = 0,
                stage_battles = 0, hunger_at = ?, strength_at = ?, last_trained_at = NULL, age_ms = 0, aged_at = ?,
                forms = ?, generation = generation + 1, dna_partner_id = NULL, dna_stage = NULL
          WHERE id = ?`,
        [egg.id, iv.iv_hp, iv.iv_atk, iv.iv_def, iv.iv_spd, HEARTS_MAX, now, now, now, JSON.stringify({ 'Baby I': egg.id }), p.id]);
    await addToDex(p.guild_id, p.user_id, egg.id);
    return egg;
}

function rebirthEmbed(guildId, p, egg) {
    return new EmbedBuilder()
        .setColor(themeColor(guildId, 'secondary'))
        .setTitle(`${displayName(p)} reached the end of its life`)
        .setDescription(`After ${Math.floor((p.age_ms ?? 0) / DAY_MS)} days together, ${p.nickname || p.name} returned to the Digital World as a Digi-Egg.\n\n`
            + `It's a **${egg.name}**, generation ${(p.generation ?? 1) + 1}. It keeps its place on the team and was reborn a little stronger.`)
        .setFooter({ text: 'Fewer care mistakes mean a longer life. ' + CREDIT });
}

/**
 * The member's team in slot order, each settled. Partners whose lives ended are reborn here and returned in
 * `reborn` ([{ p, egg }]) so the command can show it; their rows in `team` are the new eggs.
 */
async function loadTeam(guildId, userId) {
    const days = await lifespanDays(guildId);
    const read = async () => (await pool.execute(`${MEMBER_SQL} WHERE u.guild_id = ? AND u.user_id = ? AND u.team_slot IS NOT NULL ORDER BY u.team_slot`, [guildId, userId]))[0];
    const reborn = [];
    for (const row of await read()) {
        const p = await settle(row);
        if (lifeOver(p, days)) { const egg = await rebirth(p); if (egg) reborn.push({ p, egg }); }
    }
    // Read again: a rebirth (or a DNA split during one) changes rows.
    const team = await Promise.all((await read()).map(settle));
    return { team, reborn };
}

/**
 * The team partner a command acts on: the `partner` option (a Digimon number; autocomplete offers the team),
 * else the team leader. Replies and returns null when there is none, or when a life ended just now (the
 * rebirth is the reply, and the member runs the command again).
 */
async function pickPartner(interaction, option = 'partner') {
    const { guildId, user } = interaction;
    const { team, reborn } = await loadTeam(guildId, user.id);
    if (reborn.length) {
        await interaction.reply({ embeds: reborn.map(r => rebirthEmbed(guildId, r.p, r.egg)) });
        return null;
    }
    if (!team.length) {
        await interaction.reply({ content: NO_PARTNER, ...ephemeral });
        return null;
    }
    const raw = interaction.options.getString(option);
    if (!raw) return team[0];
    const id = parseNumber(raw);
    const p = team.find(t => t.id === id);
    if (!p) await interaction.reply({ content: 'That Digimon isn\'t on your team. See your team with `/digimon team`.', ...ephemeral });
    return p ?? null;
}

const parseNumber = raw => Number(String(raw ?? '').replace(/[^0-9]/g, '')) || null;

/** The lowest free team slot, or null when the team is full. */
async function freeSlot(guildId, userId, conn = pool) {
    const [rows] = await conn.execute('SELECT team_slot FROM user_digimon WHERE guild_id = ? AND user_id = ? AND team_slot IS NOT NULL', [guildId, userId]);
    const used = new Set(rows.map(r => r.team_slot));
    for (let s = 1; s <= TEAM_SIZE; s++) if (!used.has(s)) return s;
    return null;
}

/** Move a Digimon to another of its forms (de-digivolving or digivolving back); counts as meeting it. */
async function setForm(p, id) {
    await pool.execute('UPDATE user_digimon SET digimon_id = ? WHERE id = ?', [id, p.id]);
    const [[d]] = await pool.execute('SELECT * FROM digimon_data WHERE id = ?', [id]);
    return d ? species(d) : null;
}

/**
 * After a fight: the challenger's partners each spend a strength heart, and any Champion or higher left worn out
 * de-digivolves to its Rookie form (splitting a DNA fusion it falls below). Returns lines for the battle post.
 * The member who was challenged spends nothing, so nobody can wear out someone else's team.
 */
async function afterBattle(partners) {
    const notes = [];
    for (const p of partners) {
        const strength = Math.max(0, p.strength - 1);
        await pool.execute('UPDATE user_digimon SET strength = ? WHERE id = ?', [strength, p.id]);
        const back = wornOutRevert({ ...p, strength });
        if (!back) continue;
        let split = null;
        if (p.dna_stage && STAGES.indexOf(back.stage) < STAGES.indexOf(p.dna_stage)) {
            split = await splitDna(p);
            await pool.execute('UPDATE user_digimon SET forms = ? WHERE id = ?', [JSON.stringify(formsBelow(formsOf(p), p.dna_stage)), p.id]);
        }
        const d = await setForm(p, back.id);
        notes.push(`${p.nickname || p.name} is worn out and de-digivolved to **${d?.name ?? 'its Rookie form'}**.`
            + (split ? ` The DNA fusion came apart: ${split.name} is back${split.onTeam ? ' on the team' : ' in the DigiBank'}.` : ''));
    }
    return notes;
}

async function gainXp(row, amount) {
    const r = addXp(row.level, row.xp, amount);
    await pool.execute('UPDATE user_digimon SET level = ?, xp = ? WHERE id = ?', [r.level, r.xp, row.id]);
    return r;
}

const teamTag = r => (r.team_slot === 1 ? ' · team leader' : r.team_slot ? ' · on the team' : '')
    + (r.locked === 'dna' ? ' · DNA-fused' : r.locked ? ' · for sale' : '') + (r.dna_partner_id ? ' · DNA form' : '');
// One starter egg per place on a team.
const STARTER_EGGS = TEAM_SIZE;
const NO_PARTNER ='You have no partners on your team. Use `/digimon start` to get a Digi-Egg, or `/digimon team add` to bring one from the DigiBank.';
const partnerOpt = (o, what) => o.setName('partner').setDescription(`Which team partner ${what} (leave out for your team leader)`).setAutocomplete(true);

export default {
    category: 'games',
    data: new SlashCommandBuilder()
        .setName('digimon')
        .setDescription('Raise a team of partner Digimon, tame wild ones and battle')
        .addSubcommand(s => s.setName('start').setDescription(`Choose your ${TEAM_SIZE} starter Digi-Eggs, or the ones you have left`))
        .addSubcommand(s => s.setName('partner').setDescription('Check on a partner: hunger, strength, age and evolution')
            .addStringOption(o => partnerOpt(o, 'to check on')))
        .addSubcommand(s => s.setName('feed').setDescription('Feed a partner one meat')
            .addStringOption(o => partnerOpt(o, 'to feed')))
        .addSubcommand(s => s.setName('train').setDescription('Train a partner (each one every 30 minutes)')
            .addStringOption(o => partnerOpt(o, 'to train')))
        .addSubcommand(s => s.setName('evolve').setDescription('Digivolve, de-digivolve or DNA Digivolve a partner')
            .addStringOption(o => partnerOpt(o, 'to change'))
            .addStringOption(o => o.setName('action').setDescription('What to do (leave out to digivolve)')
                .addChoices({ name: 'Digivolve', value: 'up' }, { name: 'De-digivolve', value: 'down' }, { name: 'DNA Digivolve', value: 'dna' }))
            .addStringOption(o => o.setName('with').setDescription('DNA Digivolve: the other team partner').setAutocomplete(true))
            .addStringOption(o => o.setName('into').setDescription('DNA Digivolve: which form, when the pair has more than one').setAutocomplete(true)))
        .addSubcommand(s => s.setName('battle').setDescription('Battle another tamer: one partner, or your whole team')
            .addUserOption(o => o.setName('user').setDescription('Who to battle').setRequired(true))
            .addStringOption(o => o.setName('partner').setDescription('Send one partner against their leader (leave out for team against team)').setAutocomplete(true)))
        .addSubcommand(s => s.setName('explore').setDescription('Explore the Digital World (every 30 minutes)')
            .addStringOption(o => partnerOpt(o, 'comes along')))
        .addSubcommand(s => s.setName('tame').setDescription('Tame the wild Digimon in this channel by naming it')
            .addStringOption(o => o.setName('name').setDescription('Its name').setRequired(true).setMaxLength(60)))
        .addSubcommand(s => s.setName('list').setDescription('Your Digimon'))
        .addSubcommand(s => s.setName('info').setDescription('One of your Digimon')
            .addIntegerOption(o => o.setName('number').setDescription('Its number from /digimon list').setRequired(true)))
        .addSubcommand(s => s.setName('team').setDescription(`Your team of up to ${TEAM_SIZE} partners: add, remove or pick the leader`)
            .addStringOption(o => o.setName('add').setDescription('Bring a Digimon from the DigiBank onto the team').setAutocomplete(true))
            .addStringOption(o => o.setName('remove').setDescription('Send a partner to the DigiBank (it stops ageing there)').setAutocomplete(true))
            .addStringOption(o => o.setName('lead').setDescription('Make a partner the team leader').setAutocomplete(true)))
        .addSubcommand(s => s.setName('nickname').setDescription('Give one of your Digimon a nickname')
            .addIntegerOption(o => o.setName('number').setDescription('Its number from /digimon list').setRequired(true))
            .addStringOption(o => o.setName('name').setDescription('Nickname (leave out to clear)').setMaxLength(32)))
        .addSubcommand(s => s.setName('release').setDescription('Release one of your Digimon back to the Digital World')
            .addIntegerOption(o => o.setName('number').setDescription('Its number from /digimon list').setRequired(true)))
        .addSubcommand(s => s.setName('dex').setDescription('How many Digimon you have met'))
        .addSubcommand(s => s.setName('rarity').setDescription('How rare each kind of wild Digimon is'))
        .addSubcommand(s => s.setName('lookup').setDescription('Look up any Digimon')
            .addStringOption(o => o.setName('name').setDescription('Name to search for').setRequired(true).setMaxLength(60)))
        .addSubcommand(s => s.setName('daily').setDescription('Claim daily bits and meat'))
        .addSubcommand(s => s.setName('inventory').setDescription('Your bits and meat'))
        .addSubcommand(s => s.setName('buy').setDescription(`Buy meat (${MEAT_PRICE} bits each)`)
            .addIntegerOption(o => o.setName('amount').setDescription('How many').setMinValue(1).setMaxValue(50)))
        .addSubcommand(s => s.setName('today').setDescription('Which Digital Monster are you today? A five-question quiz'))
        .addSubcommand(s => s.setName('trade').setDescription('Offer one of your Digimon to another tamer')
            .addUserOption(o => o.setName('user').setDescription('Who to trade with').setRequired(true))
            .addIntegerOption(o => o.setName('give').setDescription('Your Digimon number from /digimon list').setRequired(true))
            .addIntegerOption(o => o.setName('want').setDescription('Their Digimon number you want back (leave out for a gift or a sale)'))
            .addIntegerOption(o => o.setName('bits').setDescription('Bits they pay you').setMinValue(0).setMaxValue(MAX_PRICE)))
        .addSubcommand(s => s.setName('top').setDescription('This server\'s strongest partners'))
        .addSubcommand(s => s.setName('setup').setDescription('Turn Digimon on or off and change its settings (Manage Server)')
            .addBooleanOption(o => o.setName('enabled').setDescription('Digimon on or off in this server'))
            .addBooleanOption(o => o.setName('spawns').setDescription('Wild Digimon appear in chat'))
            .addChannelOption(o => o.setName('spawn_channel').setDescription('Where wild Digimon appear (leave out to keep it as is)').addChannelTypes(ChannelType.GuildText))
            .addBooleanOption(o => o.setName('spawn_anywhere').setDescription('Clear the spawn channel so they appear wherever people talk'))
            .addIntegerOption(o => o.setName('spawn_chance').setDescription('Chance per message, in percent').setMinValue(1).setMaxValue(50))
            .addBooleanOption(o => o.setName('trades').setDescription('Members can trade Digimon'))
            .addBooleanOption(o => o.setName('market').setDescription('Members can buy and sell Digimon for bits'))
            .addIntegerOption(o => o.setName('market_fee').setDescription('Market fee in percent, taken from the seller').setMinValue(0).setMaxValue(50))
            .addIntegerOption(o => o.setName('lifespan_days').setDescription('Days on the team before a partner is reborn as an egg (0 = never)').setMinValue(0).setMaxValue(365)))
        .addSubcommandGroup(g => g.setName('market').setDescription('Buy and sell Digimon for bits')
            .addSubcommand(s => s.setName('list').setDescription('Digimon for sale here')
                .addStringOption(o => o.setName('search').setDescription('Only names containing this').setMaxLength(60)))
            .addSubcommand(s => s.setName('sell').setDescription('Put one of your Digimon up for sale')
                .addIntegerOption(o => o.setName('number').setDescription('Its number from /digimon list').setRequired(true))
                .addIntegerOption(o => o.setName('price').setDescription('Price in bits').setRequired(true).setMinValue(1).setMaxValue(MAX_PRICE)))
            .addSubcommand(s => s.setName('buy').setDescription('Buy a Digimon from the market')
                .addIntegerOption(o => o.setName('listing').setDescription('Listing number from /digimon market list').setRequired(true)))
            .addSubcommand(s => s.setName('cancel').setDescription('Take your Digimon off the market')
                .addIntegerOption(o => o.setName('listing').setDescription('Listing number').setRequired(true)))),

    /**
     * Suggestions for every "which Digimon" option: team partners for partner/with/remove/lead, DigiBank Digimon
     * for team add. The value is the Digimon's number, so typing a number by hand works too. Only the member's
     * own Digimon in this server are offered.
     */
    async autocomplete(interaction) {
        try {
            const focused = interaction.options.getFocused(true);
            if (focused.name === 'into') return void await interaction.respond(await dnaChoices(interaction, String(focused.value ?? '')));
            const bank = focused.name === 'add';
            const [rows] = await pool.execute(
                `SELECT u.id, u.nickname, u.level, u.team_slot, d.name, d.level AS stage
                   FROM user_digimon u JOIN digimon_data d ON d.id = u.digimon_id
                  WHERE u.guild_id = ? AND u.user_id = ? AND ${bank ? 'u.team_slot IS NULL AND u.locked IS NULL' : 'u.team_slot IS NOT NULL'}
                  ORDER BY ${bank ? 'u.level DESC, u.id' : 'u.team_slot'} LIMIT 200`, [interaction.guildId, interaction.user.id]);
            const q = String(focused.value ?? '').toLowerCase().trim();
            const choices = rows
                .map(r => ({ name: `#${r.id} ${displayName(r)} · ${r.stage} · Lv ${r.level}${r.team_slot === 1 ? ' · leader' : ''}`.slice(0, 100), value: String(r.id) }))
                .filter(c => !q || c.name.toLowerCase().includes(q))
                .slice(0, 25);
            await interaction.respond(choices);
        } catch {
            await interaction.respond([]).catch(() => {});
        }
    },

    async execute(interaction) {
        const sub = interaction.options.getSubcommand();
        const group = interaction.options.getSubcommandGroup(false);
        const handler = group === 'market' ? MARKET[sub] : HANDLERS[sub];
        try {
            if (!handler) return await interaction.reply({ content: 'Unknown subcommand.', ...ephemeral });
            await handler(interaction);
        } catch (err) {
            logger.error(`[Digimon] /digimon ${sub} failed: ${err.message}`, { guildId: interaction.guildId, stack: err.stack });
            const reply = { content: 'Something went wrong. Please try again.', ...ephemeral };
            if (interaction.deferred || interaction.replied) await interaction.followUp(reply).catch(() => {});
            else await interaction.reply(reply).catch(() => {});
        }
    },
};

const HANDLERS = {
    /*
     * Pick starter Digi-Eggs from a menu everyone can see; the same message turns into the hatching. Every member
     * gets STARTER_EGGS of them, chosen all at once or over several runs, so anyone who started under the old
     * one-egg rule comes back here for the rest. Starter lines they already have aren't offered again.
     * Only the member who ran it can choose (others get a private note). The menu lives 3 minutes in this
     * process, like the quiz buttons; a restart just means running it again.
     */
    async start(interaction) {
        const { guildId, user } = interaction;
        const name = displayNameFor(user, interaction.guild);
        const before = (await ensureInventory(guildId, user.id)).starters_claimed;
        const left = STARTER_EGGS - before;
        if (left <= 0) return interaction.reply({ content: `You have hatched all ${STARTER_EGGS} of your starter Digi-Eggs. See them with \`/digimon team\`.`, ...ephemeral });
        const [owned] = await pool.execute(
            'SELECT DISTINCT starter FROM user_digimon WHERE guild_id = ? AND user_id = ? AND starter IS NOT NULL', [guildId, user.id]);
        const have = new Set(owned.map(r => r.starter));
        const options = [
            ...STARTERS.filter(s => !have.has(s.key))
                .map(s => ({ label: s.also ? `${s.name} (${s.also})` : s.name, value: s.key, description: s.line.join(' → ') })),
            { label: 'Surprise me', value: 'random', description: 'Any Digi-Egg. How you raise it decides everything.' },
        ];
        const customId = `dgs:${interaction.id}`;
        const menu = new StringSelectMenuBuilder()
            .setCustomId(customId)
            .setPlaceholder(left === 1 ? 'Choose your last Digi-Egg' : `Choose up to ${left} Digi-Eggs`)
            .setMinValues(1)
            .setMaxValues(Math.min(left, options.length))
            .addOptions(...options);
        const embed = new EmbedBuilder()
            .setColor(themeColor(guildId, 'primary'))
            .setTitle(before ? `${name} is choosing ${left === 1 ? 'one more Digi-Egg' : `${left} more Digi-Eggs`}` : `${name} is choosing ${STARTER_EGGS} Digi-Eggs`)
            .setDescription(`Everyone gets ${STARTER_EGGS} starter eggs, one for each place on a team. Pick them all now or some now and the rest later.\n\n`
                + 'Each egg grows along its classic line until it reaches Child. From then on, how you feed, train and battle it decides what it digivolves into.')
            .setFooter({ text: 'This menu closes in 3 minutes.' });
        const msg = await interaction.reply({ embeds: [embed], components: [new ActionRowBuilder().addComponents(menu)], withResponse: true })
            .then(r => r.resource?.message);
        if (!msg) return;
        const collector = msg.createMessageComponentCollector({ componentType: ComponentType.StringSelect, filter: i => i.customId === customId, time: 180000 });
        collector.on('collect', async i => {
            if (i.user.id !== user.id) return void await i.reply({ content: 'This egg menu is someone else\'s. Run `/digimon start` to choose your own.', ...ephemeral }).catch(() => {});
            collector.stop('picked');
            try {
                const picks = [];
                for (const v of i.values) {
                    const starter = STARTERS.find(s => s.key === v) ?? null;
                    const baby = starter ? await starterEgg(starter) : await eggSpecies();
                    if (!baby) return void await i.update({ content: 'The Digimon list is still loading. Try again in a few minutes.', embeds: [], components: [] });
                    picks.push({ starter, baby });
                }
                // Claim the eggs in one statement so two open menus can't hand out more than STARTER_EGGS. The
                // starting gifts come with the first claim; MySQL applies SET left to right, so they see the old count.
                const [claim] = await pool.execute(
                    `UPDATE digimon_inventory
                        SET bits = bits + IF(starters_claimed = 0, 100, 0), meat = meat + IF(starters_claimed = 0, 5, 0),
                            starters_claimed = starters_claimed + ?
                      WHERE guild_id = ? AND user_id = ? AND starters_claimed + ? <= ?`,
                    [picks.length, guildId, user.id, picks.length, STARTER_EGGS]);
                if (!claim.affectedRows) return void await i.update({ content: 'Those eggs were already taken from another menu. Run `/digimon start` to see what is left.', embeds: [], components: [] });
                const lines = [];
                for (const { starter, baby } of picks) {
                    const { slot } = await giveDigimon(guildId, user.id, baby, 1, { starter: starter?.key ?? null });
                    const where = slot === 1 ? 'leads the team' : slot ? 'joined the team' : 'went to the DigiBank, as the team is full';
                    const growth = starter ? `Grows into ${starter.line.slice(1).join(', then ')}.` : 'A surprise egg: how it is raised decides everything.';
                    lines.push(`**${baby.name}** ${where}. ${growth}`);
                }
                const rest = left - picks.length;
                const hatched = new EmbedBuilder()
                    .setColor(themeColor(guildId, 'success'))
                    .setTitle(`${name}'s Digi-Egg${picks.length > 1 ? 's' : ''} hatched!`)
                    .setDescription(`${lines.join('\n')}\n\n`
                        + 'Past Child, how a partner is raised decides what it becomes. Keep them fed (`/digimon feed`), train them (`/digimon train`) and battle to raise them. '
                        + `Up to ${TEAM_SIZE} partners can be on a team; \`/digimon team\` swaps them with the DigiBank.`
                        + (before ? '' : ' Starting gifts: **5 meat** and **100 bits**.')
                        + (rest ? `\n\n${rest === 1 ? 'One starter egg is' : `${rest} starter eggs are`} still waiting: run \`/digimon start\` again for ${rest === 1 ? 'it' : 'them'}.` : ''))
                    .setFooter({ text: CREDIT });
                // The menu message becomes the hatching, so the whole channel sees it. It shows the first egg.
                await i.update({ content: null, components: [], ...(await withImage(hatched, picks[0].baby)) });
            } catch (err) {
                logger.error(`[Digimon] Starter pick failed: ${err.message}`, { guildId, stack: err.stack });
                const reply = { content: 'Something went wrong. Please try again.', ...ephemeral };
                await (i.replied || i.deferred ? i.followUp(reply) : i.reply(reply)).catch(() => {});
            }
        });
        collector.on('end', (got, reason) => {
            if (reason === 'time') interaction.editReply({ content: 'No egg chosen. Run `/digimon start` again when you are ready.', embeds: [], components: [] }).catch(() => {});
        });
    },

    async partner(interaction) {
        const p = await pickPartner(interaction);
        if (!p) return;
        const forms = formsOf(p);
        const next = nextStage(p.stage);
        // A form it already reached comes straight back, so only the first time has gates.
        const blockers = next && forms[next] ? [] : evolveBlockers(p);
        const days = await lifespanDays(interaction.guildId);
        const life = lifespanMs(p, days);
        const daysLeft = Math.max(0, Math.ceil((life - p.age_ms) / DAY_MS));
        const [[dna]] = p.dna_partner_id ? await pool.execute(`${MEMBER_SQL} WHERE u.id = ?`, [p.dna_partner_id]) : [[null]];
        const [named] = await pool.query('SELECT id, name FROM digimon_data WHERE id IN (?)', [Object.values(forms)]);
        const nameOf = Object.fromEntries(named.map(r => [r.id, r.name]));
        const history = STAGES.filter(s => forms[s]).map(s => nameOf[forms[s]] ?? '?').join(' → ');
        const embed = new EmbedBuilder()
            .setColor(themeColor(interaction.guildId, 'primary'))
            .setTitle(`${displayName(p)}${p.team_slot === 1 ? ' · team leader' : ''}`)
            .setDescription(`${p.stage} · ${p.attributes.join('/') || 'Unknown'}${p.fields.length ? ` · ${p.fields.slice(0, 3).join(', ')}` : ''}`
                + `\nGeneration ${p.generation ?? 1} · ${Math.floor(p.age_ms / DAY_MS)} days old`
                + (life === Infinity ? '' : ` · ${daysLeft === 1 ? '1 day' : `${daysLeft} days`} of life left`)
                + `\nDigivolution history: ${history}`
                + (dna ? `\nDNA-fused with ${displayName(dna)}. De-digivolving below ${p.dna_stage} splits them.` : ''))
            .addFields(
                { name: 'Level', value: `${p.level} (${p.xp}/100 XP)`, inline: true },
                { name: 'Hunger', value: hearts(p.hunger), inline: true },
                { name: 'Strength', value: hearts(p.strength), inline: true },
                { name: 'Care mistakes', value: String(p.care_mistakes), inline: true },
                { name: 'Trainings', value: String(p.trainings), inline: true },
                { name: 'Battles', value: `${p.wins} won of ${p.battles}`, inline: true },
                { name: 'Card', value: cardLine(p) },
                { name: 'Raising it toward', value: next && forms[next] ? `${nameOf[forms[next]]}, the form it reached before`
                    : next && starterForm(p.starter, next) ? `${starterForm(p.starter, next)}, its starter line` : careLeaning(p).text },
                { name: next ? `Next: ${next}` : 'Final stage',
                  value: !next ? 'This is as far as it goes.'
                      : forms[next] ? (p.hunger && p.strength ? 'It can digivolve back any time with `/digimon evolve`.' : 'Feed and train it, then it can digivolve back.')
                      : blockers.length ? blockers.join('\n') : 'Ready! Use `/digimon evolve`.' },
            )
            .setFooter({ text: CREDIT });
        await interaction.reply(await withImage(embed, { ...p, id: p.digimon_id }));
    },

    async feed(interaction) {
        const { guildId, user } = interaction;
        const p = await pickPartner(interaction);
        if (!p) return;
        if (p.hunger >= HEARTS_MAX) return interaction.reply({ content: `${displayName(p)} is full.`, ...ephemeral });
        const [res] = await pool.execute(
            'UPDATE digimon_inventory SET meat = meat - 1 WHERE guild_id = ? AND user_id = ? AND meat > 0', [guildId, user.id]);
        if (!res.affectedRows) return interaction.reply({ content: `You have no meat. Get some with \`/digimon daily\`, \`/digimon explore\` or \`/digimon buy\`.`, ...ephemeral });
        await pool.execute('UPDATE user_digimon SET hunger = hunger + 1 WHERE id = ?', [p.id]);
        const xp = await gainXp(p, XP.feed);
        await interaction.reply(`${displayName(p)} ate the meat. Hunger ${hearts(p.hunger + 1)}${xp.leveled ? ` · Level ${xp.level}!` : ''}`);
    },

    async train(interaction) {
        const p = await pickPartner(interaction);
        if (!p) return;
        const wait = (p.last_trained_at ?? 0) + TRAIN_COOLDOWN - Date.now();
        if (wait > 0) return interaction.reply({ content: `${displayName(p)} is still resting. Train again <t:${Math.ceil((Date.now() + wait) / 1000)}:R>.`, ...ephemeral });
        if (p.hunger === 0) return interaction.reply({ content: `${displayName(p)} is too hungry to train. Feed it first.`, ...ephemeral });
        const strength = Math.min(HEARTS_MAX, p.strength + 1);
        await pool.execute('UPDATE user_digimon SET strength = ?, trainings = trainings + 1, last_trained_at = ? WHERE id = ?', [strength, Date.now(), p.id]);
        const xp = await gainXp(p, XP.train);
        await interaction.reply(`${displayName(p)} trained hard. Strength ${hearts(strength)} · +${XP.train} XP${xp.leveled ? ` · Level ${xp.level}!` : ''}`);
    },

    async evolve(interaction) {
        const { guildId, user } = interaction;
        const p = await pickPartner(interaction);
        if (!p) return;
        const action = interaction.options.getString('action') ?? 'up';
        if (action === 'down') return deDigivolve(interaction, p);
        if (action === 'dna') return dnaDigivolve(interaction, p);
        const forms = formsOf(p);
        const stage = nextStage(p.stage);
        // A form it reached before comes straight back once it is fed and has strength, as in the anime.
        if (stage && forms[stage]) {
            if (!p.hunger || !p.strength) return interaction.reply({ content: `${displayName(p)} is too worn out to digivolve. Feed it and train it first.`, ...ephemeral });
            const d = await setForm(p, forms[stage]);
            const embed = new EmbedBuilder()
                .setColor(themeColor(guildId, 'accent'))
                .setTitle(`${p.nickname || p.name} digivolved into ${d.name}!`)
                .setDescription(`${stage} · ${d.attributes.join('/') || 'Unknown'}\nBack to the form it reached before.\n\n${about(d, 300)}`)
                .setFooter({ text: CREDIT });
            return interaction.reply(await withImage(embed, d));
        }
        const blockers = evolveBlockers(p);
        if (blockers.length) return interaction.reply({ content: `${displayName(p)} isn't ready to evolve:\n${blockers.join('\n')}`, ...ephemeral });
        const [rows] = await pool.execute(
            `SELECT d.* FROM digimon_evolutions e JOIN digimon_data d ON d.id = e.to_id WHERE e.from_id = ?`, [p.digimon_id]);
        // A form counts for the next stage when that is any of its levels, not just its main one.
        const candidates = rows.map(species).filter(c => c.levels.includes(stage)).map(c => ({ ...c, level: stage }));
        // A chosen starter keeps to its classic line up to Child; past that (or off the line) care decides.
        const lineForm = candidates.find(c => c.name === starterForm(p.starter, stage)) ?? null;
        const form = lineForm ?? chooseEvolution({ ...p, stage: p.stage }, candidates);
        if (!form) return interaction.reply({ content: `${displayName(p)} has no known ${stage} form, so its line ends here. You can raise another one: \`/digimon team\` swaps partners in and out.`, ...ephemeral });
        // The new stage starts with a clean care record; total battles and wins carry over for the gates.
        const reset = stageReset();
        await pool.execute(
            'UPDATE user_digimon SET digimon_id = ?, care_mistakes = ?, trainings = ?, stage_battles = ?, forms = ? WHERE id = ?',
            [form.id, reset.care_mistakes, reset.trainings, reset.stage_battles, JSON.stringify({ ...forms, [stage]: form.id }), p.id]);
        await addToDex(guildId, user.id, form.id);
        const embed = new EmbedBuilder()
            .setColor(themeColor(guildId, 'accent'))
            .setTitle(`${p.nickname || p.name} digivolved into ${form.name}!`)
            .setDescription(`${stage} · ${form.attributes.join('/') || 'Unknown'}\n${lineForm ? 'It grew along its starter line.' : `${careLeaning(p).text}.`}\n\n${about(form, 300)}`)
            .setFooter({ text: `${lineForm ? 'Starter line' : `${candidates.length} possible ${stage} forms`} · ${CREDIT}` });
        await interaction.reply(await withImage(embed, form));
    },

    /*
     * A Digimon Card Game match (runMatch in core/digimon-logic.js). With `partner`, that one partner against the
     * other tamer's leader; without it, the whole team against theirs. Babies (Lv.1-2) and starving partners sit
     * it out. Each tamer's security stack comes from their own DigiBank. Only the challenger's partners spend
     * strength, so a Champion worn out by fighting de-digivolves (afterBattle).
     */
    async battle(interaction) {
        const { guildId, user, guild } = interaction;
        const opponent = interaction.options.getUser('user');
        if (opponent.bot || opponent.id === user.id) return interaction.reply({ content: 'Pick another tamer to battle.', ...ephemeral });
        const own = await loadTeam(guildId, user.id);
        if (own.reborn.length) return interaction.reply({ embeds: own.reborn.map(r => rebirthEmbed(guildId, r.p, r.egg)) });
        if (!own.team.length) return interaction.reply({ content: NO_PARTNER, ...ephemeral });
        const theirs = await loadTeam(guildId, opponent.id);
        const them = displayNameFor(opponent, guild), me = displayNameFor(user, guild);
        const ready = t => t.filter(p => p.hunger > 0 && canBattle(p));
        const single = interaction.options.getString('partner');
        let a, b;
        if (single) {
            const p = own.team.find(t => t.id === parseNumber(single));
            if (!p) return interaction.reply({ content: 'That Digimon isn\'t on your team. See your team with `/digimon team`.', ...ephemeral });
            if (!canBattle(p)) return interaction.reply({ content: `${displayName(p)} is still a baby (${levelLabel(p)}). In the card game babies stay in the breeding area until they reach Lv.3 Rookie.`, ...ephemeral });
            if (p.hunger === 0) return interaction.reply({ content: `${displayName(p)} is too hungry to fight. Feed it first.`, ...ephemeral });
            a = [p];
            b = ready(theirs.team).slice(0, 1);
        } else {
            a = ready(own.team);
            b = ready(theirs.team);
            if (!a.length) return interaction.reply({ content: 'None of your partners can battle: they need to be Lv.3 Rookie or higher and not starving.', ...ephemeral });
        }
        if (!theirs.team.length) return interaction.reply({ content: `${them} has no partner Digimon yet.`, ...ephemeral });
        if (!b.length) return interaction.reply({ content: `${them} has no partner ready to battle (Lv.3 Rookie or higher and fed).`, ...ephemeral });

        const sideA = { name: me, partners: await fighters(a), security: await securityStack(guildId, user.id) };
        const sideB = { name: them, partners: await fighters(b), security: await securityStack(guildId, opponent.id) };
        const r = runMatch(sideA, sideB);
        const won = side => r.winner === side;
        const levelled = [];
        for (const [side, list] of [['a', a], ['b', b]]) {
            for (const p of list) {
                await pool.execute(`UPDATE user_digimon SET battles = battles + 1, stage_battles = stage_battles + 1${won(side) ? ', wins = wins + 1' : ''} WHERE id = ?`, [p.id]);
                const xp = await gainXp(p, won(side) ? XP.battleWin : XP.battleLose);
                if (xp.leveled) levelled.push(`${displayName(p)} reached level ${xp.level}.`);
            }
        }
        const log = r.log.length > 16 ? [...r.log.slice(0, 7), '…', ...r.log.slice(-8)] : r.log;
        const lineup = s => s.partners.map(p => `${p.name} ${p.dp} DP${p.keywords.length ? ` (${p.keywords.join(', ')})` : ''}`).join(', ');
        const result = r.winner === 'draw' ? '**A draw.**' : `**${r.winner === 'a' ? me : them} wins!**`;
        const embed = new EmbedBuilder()
            .setTitle(a.length === 1 && b.length === 1 ? `${sideA.partners[0].name} vs ${sideB.partners[0].name}` : `${me}'s team vs ${them}'s team`)
            .setDescription(`${me}: ${lineup(sideA)}\n${them}: ${lineup(sideB)}\n${r.first === 'a' ? me : them} goes first. Security: ${SECURITY_SIZE} each.\n\n${log.join('\n')}\n\n${result}`.slice(0, 4000));
        const notes = [
            ...levelled,
            ...theirs.reborn.map(x => `${them}'s ${displayName(x.p)} reached the end of its life and was reborn as a ${x.egg.name} egg.`),
            ...await afterBattle(a),
        ];
        if (notes.length) embed.addFields({ name: 'After the battle', value: notes.join('\n').slice(0, 1024) });
        const footer = `Digimon Card Game rules: higher DP wins, a tie deletes both · winners +${XP.battleWin} XP, others +${XP.battleLose} XP`;
        await interaction.reply({ embeds: [embed.setColor(themeColor(guildId, 'danger')).setFooter({ text: footer })] });
    },

    async explore(interaction) {
        const { guildId, user } = interaction;
        // Pick the partner first, so a rebirth or a wrong pick does not use up the trip.
        const p = await pickPartner(interaction);
        if (!p) return;
        const inv = await ensureInventory(guildId, user.id);
        const wait = (inv.last_explore_at ?? 0) + EXPLORE_COOLDOWN - Date.now();
        if (wait > 0) return interaction.reply({ content: `You're back from exploring. Head out again <t:${Math.ceil((Date.now() + wait) / 1000)}:R>.`, ...ephemeral });
        await pool.execute('UPDATE digimon_inventory SET last_explore_at = ? WHERE guild_id = ? AND user_id = ?', [Date.now(), guildId, user.id]);
        const roll = Math.random();
        if (roll < 0.35) {
            const bits = randInt(50, 200);
            await pool.execute('UPDATE digimon_inventory SET bits = bits + ? WHERE guild_id = ? AND user_id = ?', [bits, guildId, user.id]);
            return interaction.reply(`You found **${bits} bits** lying in the data stream.`);
        }
        if (roll < 0.65) {
            const meat = randInt(1, 3);
            await pool.execute('UPDATE digimon_inventory SET meat = meat + ? WHERE guild_id = ? AND user_id = ?', [meat, guildId, user.id]);
            return interaction.reply(`You found a meat farm and picked up **${meat} meat**.`);
        }
        // Babies stay in the breeding area (rule 4-17-2), so only a Rookie or higher meets wild Digimon.
        if (roll < 0.9 && p.hunger > 0 && canBattle(p)) {
            const wild = await randomSpecies(p.stage);
            if (wild) {
                // An attack on a Digimon is one battle (rule 11-5-1-3). The wild one fights with any of its printings.
                const [mine] = await fighters([p]);
                const foeDp = wildDp(wild);
                const lost = battleLoser(mine.dp, foeDp);
                const won = lost === 'b';
                await pool.execute(`UPDATE user_digimon SET battles = battles + 1, stage_battles = stage_battles + 1${won ? ', wins = wins + 1' : ''} WHERE id = ?`, [p.id]);
                const xp = await gainXp(p, won ? XP.wildWin : XP.wildLose);
                await addToDex(guildId, user.id, wild.id);
                const notes = await afterBattle([p]);
                const outcome = won ? `**${mine.name} deleted it!**`
                    : lost === 'both' ? '**Same DP: both were deleted.** Your partner pulled through, but it counts as a loss.'
                    : `**${mine.name} was deleted.** It pulled back to your team; train up and try again.`;
                const embed = new EmbedBuilder()
                    .setColor(themeColor(guildId, won ? 'success' : 'danger'))
                    .setTitle(`A wild ${wild.name} appeared!`)
                    .setDescription(`${mine.name} (${mine.dp} DP) attacks ${wild.name} (${levelLabel({ ...wild, stage: wild.level })}, ${foeDp} DP).\n\n${outcome}`
                        + ` +${won ? XP.wildWin : XP.wildLose} XP${xp.leveled ? ` · Level ${xp.level}!` : ''}${notes.length ? `\n\n${notes.join('\n')}` : ''}`)
                    .setFooter({ text: `Higher DP wins, a tie deletes both · ${CREDIT}` });
                return interaction.reply(await withImage(embed, wild));
            }
        }
        await interaction.reply(canBattle(p) ? 'You wandered the Digital World but found nothing this time.'
            : `You wandered the Digital World. ${displayName(p)} is still a baby, so you kept away from wild Digimon.`);
    },

    async tame(interaction) {
        const { guildId, user, channelId } = interaction;
        const guess = interaction.options.getString('name');
        const [[spawn]] = await pool.execute(
            `SELECT s.*, d.* FROM digimon_spawns s JOIN digimon_data d ON d.id = s.digimon_id WHERE s.guild_id = ? AND s.channel_id = ?`,
            [guildId, channelId]);
        if (!spawn) return interaction.reply({ content: 'There is no wild Digimon here right now.', ...ephemeral });
        if (!nameMatches(guess, spawn.name)) return interaction.reply({ content: 'That isn\'t its name. Look again!', ...ephemeral });
        // Only the first right answer wins: whoever deletes the spawn row owns it.
        const [del] = await pool.execute('DELETE FROM digimon_spawns WHERE guild_id = ? AND channel_id = ? AND digimon_id = ?', [guildId, channelId, spawn.id]);
        if (!del.affectedRows) return interaction.reply({ content: 'Someone else tamed it first!', ...ephemeral });
        const d = species(spawn);
        const tier = rarityOfStage(d.level) ?? RARITY[0];
        const level = randInt(...tier.tame);
        const { id, slot } = await giveDigimon(guildId, user.id, d, level);
        await ensureInventory(guildId, user.id);
        const where = slot === 1 ? 'It leads your team now.' : slot ? 'It joined your team.' : `Your team is full, so it went to the DigiBank. Swap it in with \`/digimon team\`.`;
        const embed = new EmbedBuilder()
            .setColor(themeColor(guildId, 'success'))
            .setTitle(`${displayNameFor(user, interaction.guild)} tamed ${d.name}!`)
            .setDescription(`${tier.name} · ${d.level} · ${d.attributes.join('/') || 'Unknown'} · Level ${level}\n${where}`)
            .setFooter({ text: `Added as #${id} · ${CREDIT}` });
        await interaction.reply({ embeds: [embed] });
    },

    async list(interaction) {
        const { guildId, user } = interaction;
        const [rows] = await pool.execute(
            `SELECT u.id, u.nickname, u.level, u.team_slot, u.locked, u.dna_partner_id, d.name, d.level AS stage
               FROM user_digimon u JOIN digimon_data d ON d.id = u.digimon_id
              WHERE u.guild_id = ? AND u.user_id = ? ORDER BY u.team_slot IS NULL, u.team_slot, u.id`, [guildId, user.id]);
        if (!rows.length) return interaction.reply({ content: NO_PARTNER, ...ephemeral });
        const pages = Math.ceil(rows.length / PER_PAGE);
        const page = n => new EmbedBuilder()
            .setColor(themeColor(guildId, 'primary'))
            .setTitle(`${displayNameFor(user, interaction.guild)}'s Digimon`)
            .setDescription(rows.slice(n * PER_PAGE, (n + 1) * PER_PAGE)
                .map(r => `**#${r.id}** ${displayName(r)} · ${r.stage} · Lv ${r.level}${teamTag(r)}`).join('\n'))
            .setFooter({ text: `Page ${n + 1}/${pages} · ${rows.length} Digimon` });
        await paginate(interaction, pages, page);
    },

    async info(interaction) {
        const row = await ownRow(interaction);
        if (!row) return;
        const d = species(row);
        const embed = new EmbedBuilder()
            .setColor(themeColor(interaction.guildId, 'primary'))
            .setTitle(`#${row.id} ${displayName(row)}`)
            .setDescription(`${row.stage} · ${d.attributes.join('/') || 'Unknown'} · Level ${row.level} · generation ${row.generation ?? 1}${teamTag(row)}\n\n${about(d, 350)}`)
            .addFields(
                { name: 'Card', value: cardLine({ ...row, card_keywords: json(row.card_keywords) }) },
                { name: 'Battles', value: `${row.wins} won of ${row.battles}`, inline: true },
                { name: 'Skills', value: d.skills.slice(0, 4).join(', ') || 'None recorded', inline: true })
            .setFooter({ text: CREDIT });
        // Images are cached by species id, not by this Digimon's list number.
        await interaction.reply(await withImage(embed, { ...d, id: row.digimon_id }));
    },

    /*
     * The team: up to TEAM_SIZE partners, slot 1 leads. Care and age only run on the team, so a partner's care is
     * settled as it goes to the DigiBank and its clocks start fresh when it comes back.
     */
    async team(interaction) {
        const { guildId, user } = interaction;
        const o = interaction.options;
        const { team, reborn } = await loadTeam(guildId, user.id);
        if (reborn.length) return interaction.reply({ embeds: reborn.map(r => rebirthEmbed(guildId, r.p, r.egg)) });
        const addId = parseNumber(o.getString('add')), removeId = parseNumber(o.getString('remove')), leadId = parseNumber(o.getString('lead'));
        const done = [];
        if (removeId) {
            const p = team.find(t => t.id === removeId);
            if (!p) return interaction.reply({ content: 'That Digimon isn\'t on your team.', ...ephemeral });
            if (team.length === 1 && !addId) return interaction.reply({ content: 'That\'s your only partner. Add another one in the same command to swap them.', ...ephemeral });
            await pool.execute('UPDATE user_digimon SET team_slot = NULL, is_partner = 0, aged_at = NULL WHERE id = ?', [p.id]);
            done.push(`${displayName(p)} went to the DigiBank.`);
        }
        if (addId) {
            const [[row]] = await pool.execute(`${MEMBER_SQL} WHERE u.id = ? AND u.guild_id = ? AND u.user_id = ?`, [addId, guildId, user.id]);
            if (!row) return interaction.reply({ content: 'You don\'t have a Digimon with that number. Check `/digimon list`.', ...ephemeral });
            if (row.team_slot) return interaction.reply({ content: `${displayName(row)} is already on your team.`, ...ephemeral });
            if (row.locked) return interaction.reply({ content: row.locked === 'dna' ? `${displayName(row)} is DNA-fused with another partner.` : `${displayName(row)} is listed on the market. Cancel the listing first with \`/digimon market cancel\`.`, ...ephemeral });
            const slot = await freeSlot(guildId, user.id);
            if (!slot) return interaction.reply({ content: `Your team is full (${TEAM_SIZE}). Send one to the DigiBank in the same command with \`remove\`.`, ...ephemeral });
            const now = Date.now();
            await pool.execute('UPDATE user_digimon SET team_slot = ?, is_partner = 1, hunger_at = ?, strength_at = ?, aged_at = ? WHERE id = ?', [slot, now, now, now, row.id]);
            done.push(`${displayName(row)} joined the team.`);
        }
        if (leadId) {
            const [[row]] = await pool.execute('SELECT id, team_slot FROM user_digimon WHERE id = ? AND guild_id = ? AND user_id = ? AND team_slot IS NOT NULL', [leadId, guildId, user.id]);
            if (!row) return interaction.reply({ content: 'Only a partner on your team can lead it.', ...ephemeral });
            // Swap with whoever leads now (if anyone), so slots stay unique.
            await pool.execute('UPDATE user_digimon SET team_slot = ? WHERE guild_id = ? AND user_id = ? AND team_slot = 1', [row.team_slot, guildId, user.id]);
            await pool.execute('UPDATE user_digimon SET team_slot = 1 WHERE id = ?', [row.id]);
        }
        // A removed leader leaves slot 1 empty: the next partner moves up.
        const [slots] = await pool.execute('SELECT id FROM user_digimon WHERE guild_id = ? AND user_id = ? AND team_slot IS NOT NULL ORDER BY team_slot', [guildId, user.id]);
        for (const [i, r] of slots.entries()) await pool.execute('UPDATE user_digimon SET team_slot = ? WHERE id = ?', [i + 1, r.id]);

        const now = (await loadTeam(guildId, user.id)).team;
        if (leadId) done.push(`${displayName(now[0])} leads the team.`);
        const [[{ banked }]] = await pool.execute('SELECT COUNT(*) AS banked FROM user_digimon WHERE guild_id = ? AND user_id = ? AND team_slot IS NULL AND locked IS NULL', [guildId, user.id]);
        const days = await lifespanDays(guildId);
        const line = (p, i) => {
            const left = lifespanMs(p, days) === Infinity ? '' : ` · ${Math.max(0, Math.ceil((lifespanMs(p, days) - p.age_ms) / DAY_MS))}d left`;
            return `**${i + 1}. ${displayName(p)}**${i === 0 ? ' · leader' : ''}\n#${p.id} · ${p.stage} · Lv ${p.level} · Hunger ${hearts(p.hunger)} · Strength ${hearts(p.strength)}${left}`;
        };
        const embed = new EmbedBuilder()
            .setColor(themeColor(guildId, 'primary'))
            .setTitle(`${displayNameFor(user, interaction.guild)}'s team`)
            .setDescription([...done, done.length ? '' : null, ...(now.length ? now.map(line) : [NO_PARTNER])].filter(x => x !== null).join('\n'))
            .setFooter({ text: `${now.length}/${TEAM_SIZE} on the team · ${banked} in the DigiBank (they don't get hungry or age there)` });
        await interaction.reply({ embeds: [embed] });
    },

    async nickname(interaction) {
        const row = await ownRow(interaction);
        if (!row) return;
        const name = interaction.options.getString('name')?.trim() || null;
        await pool.execute('UPDATE user_digimon SET nickname = ? WHERE id = ?', [name, row.id]);
        await interaction.reply({ content: name ? `#${row.id} ${row.name} is now called **${name}**.` : `Nickname cleared for #${row.id} ${row.name}.` });
    },

    async release(interaction) {
        const row = await ownRow(interaction);
        if (!row) return;
        if (row.team_slot) return interaction.reply({ content: 'That one is on your team. Send it to the DigiBank first with `/digimon team remove`.', ...ephemeral });
        if (row.dna_partner_id || row.locked === 'dna') return interaction.reply({ content: `${displayName(row)} is DNA-fused. De-digivolve the fusion first to split it.`, ...ephemeral });
        if (row.locked) return interaction.reply({ content: `${displayName(row)} is listed on the market. Cancel the listing first with \`/digimon market cancel\`.`, ...ephemeral });
        await pool.execute('DELETE FROM user_digimon WHERE id = ?', [row.id]);
        await interaction.reply({ content: `${displayName(row)} went back to the Digital World.` });
    },

    async dex(interaction) {
        const { guildId, user } = interaction;
        const [[{ met }]] = await pool.execute('SELECT COUNT(*) AS met FROM user_digimon_dex WHERE guild_id = ? AND user_id = ?', [guildId, user.id]);
        const [[{ total }]] = await pool.execute('SELECT COUNT(*) AS total FROM digimon_data');
        const [byStage] = await pool.execute(
            `SELECT d.level, COUNT(*) AS n FROM user_digimon_dex x JOIN digimon_data d ON d.id = x.digimon_id
              WHERE x.guild_id = ? AND x.user_id = ? GROUP BY d.level`, [guildId, user.id]);
        const counts = Object.fromEntries(byStage.map(r => [r.level, r.n]));
        const embed = new EmbedBuilder()
            .setColor(themeColor(guildId, 'primary'))
            .setTitle(`${displayNameFor(user, interaction.guild)}'s Digimon field guide`)
            .setDescription(`Met **${met}** of ${total} Digimon.\n\n${STAGES.map(s => `${s}: ${counts[s] ?? 0}`).join('\n')}`)
            .setFooter({ text: 'Taming, evolving and wild battles all count. ' + CREDIT });
        await interaction.reply({ embeds: [embed] });
    },

    async lookup(interaction) {
        const q = interaction.options.getString('name').trim();
        const [rows] = await pool.execute(
            `SELECT * FROM digimon_data WHERE name LIKE ? ORDER BY (name = ?) DESC, CHAR_LENGTH(name) LIMIT 10`, [`%${q}%`, q]);
        if (!rows.length) return interaction.reply({ content: `No Digimon found matching "${q}".`, ...ephemeral });
        const d = species(rows[0]);
        const [[{ next }]] = await pool.execute('SELECT COUNT(*) AS next FROM digimon_evolutions WHERE from_id = ?', [d.id]);
        // Spawns pick by main level only, so that is the one that decides whether it can appear in the wild.
        const tier = rarityOfStage(d.level);
        const wild = tier ? `${tier.name} in the wild` : 'Never appears in the wild';
        const embed = new EmbedBuilder()
            .setColor(themeColor(interaction.guildId, 'primary'))
            .setTitle(d.name)
            .setDescription(`${d.levels.join(', ') || 'Unknown'} · ${d.attributes.join('/') || 'Unknown'} · ${wild}\n\n${(d.description ?? 'No description recorded.').slice(0, 500)}`)
            .addFields(
                { name: 'Fields', value: d.fields.join(', ') || 'Unknown', inline: true },
                { name: 'Next forms', value: String(next), inline: true },
                { name: 'Card game', value: d.card_dp ? `${cardLine({ ...d, stage: d.level, level: 1 })} (DP of the card, before raising)` : `${levelLabel({ ...d, stage: d.level })} · no card yet, so it battles with the level's usual DP` },
                { name: 'Skills', value: d.skills.slice(0, 4).join(', ') || 'None recorded' })
            .setFooter({ text: (rows.length > 1 ? `Also matching: ${rows.slice(1, 4).map(r => r.name).join(', ')} · ` : '') + CREDIT });
        await interaction.reply(await withImage(embed, d));
    },

    async daily(interaction) {
        const { guildId, user } = interaction;
        const inv = await ensureInventory(guildId, user.id);
        const wait = (inv.last_daily_at ?? 0) + DAILY_COOLDOWN - Date.now();
        if (wait > 0) return interaction.reply({ content: `Already claimed. Come back <t:${Math.ceil((Date.now() + wait) / 1000)}:R>.`, ...ephemeral });
        await pool.execute('UPDATE digimon_inventory SET bits = bits + 150, meat = meat + 3, last_daily_at = ? WHERE guild_id = ? AND user_id = ?', [Date.now(), guildId, user.id]);
        await interaction.reply('Daily claimed: **150 bits** and **3 meat**.');
    },

    async inventory(interaction) {
        const inv = await ensureInventory(interaction.guildId, interaction.user.id);
        await interaction.reply({ content: `${displayNameFor(interaction.user, interaction.guild)} has **${inv.bits} bits** and **${inv.meat} meat**.` });
    },

    async buy(interaction) {
        const { guildId, user } = interaction;
        const amount = interaction.options.getInteger('amount') ?? 1;
        await ensureInventory(guildId, user.id);
        const cost = amount * MEAT_PRICE;
        const [res] = await pool.execute(
            'UPDATE digimon_inventory SET bits = bits - ?, meat = meat + ? WHERE guild_id = ? AND user_id = ? AND bits >= ?',
            [cost, amount, guildId, user.id, cost]);
        if (!res.affectedRows) return interaction.reply({ content: `That costs ${cost} bits and you don't have enough.`, ...ephemeral });
        await interaction.reply({ content: `${displayNameFor(user, interaction.guild)} bought **${amount} meat** for ${cost} bits.` });
    },

    today: runQuiz,
};

// ── Card game pieces: keywords, DP and security stacks ──────────────────────────────────────────────────

/**
 * Partners as match pieces: { id, name, dp, keywords }. Keywords are the Digimon's own card keywords plus the
 * inherited ones of every earlier form it digivolved from (rule 4-3-3: a Digimon gains the inherited effects of
 * the cards under it).
 */
async function fighters(partners) {
    const ids = [...new Set(partners.flatMap(p => Object.values(formsOf(p)).filter(id => id !== p.digimon_id)))];
    const [rows] = ids.length ? await pool.query('SELECT id, card_inherited FROM digimon_data WHERE id IN (?)', [ids]) : [[]];
    const inherited = new Map(rows.map(r => [r.id, json(r.card_inherited)]));
    return partners.map(p => {
        const own = json(p.card_keywords);
        const passed = Object.values(formsOf(p)).filter(id => id !== p.digimon_id).flatMap(id => inherited.get(id) ?? []);
        const keywords = CARD_KEYWORDS.filter(k => own.includes(k) || passed.includes(k));
        return { id: p.id, name: displayName(p), dp: dpOf(p), keywords };
    });
}

/**
 * A tamer's security stack: SECURITY_SIZE of their own DigiBank Digimon (Lv.3+, not for sale or fused), at
 * random, as their deck would give. A short DigiBank is topped up with wild Rookies and Champions.
 */
async function securityStack(guildId, userId) {
    const [bank] = await pool.execute(
        `${MEMBER_SQL} WHERE u.guild_id = ? AND u.user_id = ? AND u.team_slot IS NULL AND u.locked IS NULL AND u.dna_partner_id IS NULL
          AND d.level IN ('Child', 'Adult', 'Perfect', 'Ultimate') ORDER BY RAND() LIMIT ?`, [guildId, userId, String(SECURITY_SIZE)]);
    const stack = bank.map(r => ({ name: displayName(r), dp: dpOf(r) }));
    while (stack.length < SECURITY_SIZE) {
        const d = await randomSpecies(Math.random() < 0.7 ? 'Child' : 'Adult');
        if (!d) break;
        stack.push({ name: `a wild ${d.name}`, dp: wildDp({ ...d, card_dps: json(d.card_dps) }) });
    }
    return stack;
}

/** "Lv.4 Champion · 5,600 DP · Red · Blocker, Jamming": the card game's view of a Digimon. */
function cardLine(row) {
    const keywords = json(row.card_keywords);
    const dp = dpOf(row);
    return [levelLabel(row), dp ? `${dp.toLocaleString('en-US')} DP` : 'no DP (stays in the breeding area)', row.card_color, keywords.join(', ') || null]
        .filter(Boolean).join(' · ');
}

// ── De-digivolving and DNA Digivolution ────────────────────────────────────────────────────────────────

/** Step back to the form it was at the stage below. Going below a DNA fusion's stage splits it. */
async function deDigivolve(interaction, p) {
    const back = previousForm(p);
    if (!back) return interaction.reply({ content: `${displayName(p)} has no earlier form to go back to.`, ...ephemeral });
    // As in the card game, De-Digivolve stops at Lv.3 Rookie (rule 16-12-4).
    if (CARD_LEVEL[back.stage] < 3) return interaction.reply({ content: `${displayName(p)} is a Rookie already. De-digivolving stops at Lv.3, as in the card game.`, ...ephemeral });
    let split = null;
    if (p.dna_stage && STAGES.indexOf(back.stage) < STAGES.indexOf(p.dna_stage)) {
        split = await splitDna(p);
        await pool.execute('UPDATE user_digimon SET forms = ? WHERE id = ?', [JSON.stringify(formsBelow(formsOf(p), p.dna_stage)), p.id]);
    }
    const d = await setForm(p, back.id);
    const embed = new EmbedBuilder()
        .setColor(themeColor(interaction.guildId, 'secondary'))
        .setTitle(`${p.nickname || p.name} de-digivolved into ${d.name}`)
        .setDescription(`${back.stage} · ${d.attributes.join('/') || 'Unknown'}\n`
            + (split ? `The DNA fusion came apart: ${displayName(split)} is back${split.onTeam ? ' on the team' : ' in the DigiBank'}.`
                : `It can digivolve back into ${p.name} with \`/digimon evolve\` once fed and trained.`))
        .setFooter({ text: CREDIT });
    await interaction.reply(await withImage(embed, d));
}

/** The DNA forms the data names for two Digimon species at a stage (digimon_dna, either way round). */
async function dnaForms(aDigimonId, bDigimonId, stage) {
    const [rows] = await pool.execute(
        `SELECT DISTINCT d.* FROM digimon_dna x JOIN digimon_data d ON d.id = x.to_id
          WHERE (x.from_id = ? AND x.with_id = ?) OR (x.from_id = ? AND x.with_id = ?) ORDER BY d.name`,
        [aDigimonId, bDigimonId, bDigimonId, aDigimonId]);
    return rows.map(species).filter(c => c.levels.includes(stage));
}

/** Autocomplete for `into`: the DNA forms of the `partner` (or leader) and `with` picked so far. */
async function dnaChoices(interaction, typed) {
    const o = interaction.options;
    const [team] = await pool.execute(`${MEMBER_SQL} WHERE u.guild_id = ? AND u.user_id = ? AND u.team_slot IS NOT NULL ORDER BY u.team_slot`, [interaction.guildId, interaction.user.id]);
    const a = o.getString('partner') ? team.find(t => t.id === parseNumber(o.getString('partner'))) : team[0];
    const b = team.find(t => t.id === parseNumber(o.getString('with')));
    if (!a || !b || a.stage !== b.stage || !nextStage(a.stage)) return [];
    const q = typed.toLowerCase().trim();
    return (await dnaForms(a.digimon_id, b.digimon_id, nextStage(a.stage)))
        .filter(f => !q || f.name.toLowerCase().includes(q))
        .slice(0, 25)
        .map(f => ({ name: `${f.name} · ${f.attributes.join('/') || 'Unknown'}`.slice(0, 100), value: String(f.id) }));
}

/**
 * Fuse two team partners at the same stage into the form the data names for that pair. When there are several
 * (XV-mon + Stingmon can become Paildramon or Dinobeemon), the member picks one with `into`, as in Digimon Story.
 * The first partner becomes the fused Digimon; the second leaves the team, locked to it (locked = 'dna'), and
 * comes back when the fusion splits.
 */
async function dnaDigivolve(interaction, p) {
    const { guildId, user } = interaction;
    const otherRaw = interaction.options.getString('with');
    if (!otherRaw) return interaction.reply({ content: 'Pick the other team partner in `with`.', ...ephemeral });
    const { team } = await loadTeam(guildId, user.id);
    const other = team.find(t => t.id === parseNumber(otherRaw));
    if (!other) return interaction.reply({ content: 'The partner in `with` isn\'t on your team.', ...ephemeral });
    const a = { ...p, name: displayName(p) }, b = { ...other, name: displayName(other) };
    const blockers = dnaBlockers(a, b);
    if (blockers.length) return interaction.reply({ content: `They can't DNA Digivolve yet:\n${blockers.join('\n')}`, ...ephemeral });
    const stage = nextStage(p.stage);
    // Only the DNA Digivolutions the data names for this pair (digimon_dna, from digi-api's evolution conditions).
    const shared = await dnaForms(p.digimon_id, other.digimon_id, stage);
    const into = parseNumber(interaction.options.getString('into'));
    if (shared.length > 1 && !shared.some(f => f.id === into)) {
        return interaction.reply({
            content: `${p.name} and ${other.name} can DNA Digivolve into ${shared.map(f => `**${f.name}**`).join(', ')}. `
                + 'Run it again and choose one in `into`.',
            ...ephemeral,
        });
    }
    const form = shared.length > 1 ? shared.find(f => f.id === into) : shared[0];
    if (!form) {
        // Say who this partner can fuse with, so the member knows what to raise.
        const [known] = await pool.execute(
            `SELECT w.name AS partner, t.name AS result, t.levels FROM digimon_dna x
               JOIN digimon_data w ON w.id = x.with_id JOIN digimon_data t ON t.id = x.to_id
              WHERE x.from_id = ? ORDER BY w.name LIMIT 60`, [p.digimon_id]);
        const options = known.filter(k => json(k.levels).includes(stage)).slice(0, 8).map(k => `${k.partner} → ${k.result}`);
        return interaction.reply({
            content: `${p.name} and ${other.name} have no DNA Digivolution together.`
                + (options.length ? `\n${p.name} can DNA Digivolve with:\n${options.join('\n')}` : `\n${p.name} has no known DNA partner at this stage.`),
            ...ephemeral,
        });
    }
    const reset = stageReset();
    await inTransaction(async conn => {
        await conn.execute(`UPDATE user_digimon SET locked = 'dna', team_slot = NULL, is_partner = 0, aged_at = NULL WHERE id = ? AND locked IS NULL`, [other.id]);
        await conn.execute(
            `UPDATE user_digimon SET digimon_id = ?, level = GREATEST(level, ?), dna_partner_id = ?, dna_stage = ?, forms = ?,
                    care_mistakes = ?, trainings = ?, stage_battles = ? WHERE id = ?`,
            [form.id, other.level, other.id, stage, JSON.stringify({ ...formsOf(p), [stage]: form.id }),
             reset.care_mistakes, reset.trainings, reset.stage_battles, p.id]);
    });
    await addToDex(guildId, user.id, form.id);
    const embed = new EmbedBuilder()
        .setColor(themeColor(guildId, 'accent'))
        .setTitle(`${a.name} and ${b.name} DNA Digivolved into ${form.name}!`)
        .setDescription(`${stage} · ${form.attributes.join('/') || 'Unknown'}\n`
            + `They fight as one now. De-digivolving below ${stage} splits them again.\n\n${about(form, 300)}`)
        .setFooter({ text: CREDIT });
    await interaction.reply(await withImage(embed, form));
}

// ── Trading, the market and the leaderboard ─────────────────────────────────────────────────────────────
//
// A trade or a sale moves rows between two members, so both run in one transaction that locks every row it
// reads (FOR UPDATE): two people pressing Accept, or two buyers on one listing, cannot both succeed, and a
// Digimon that changed hands in between fails the check instead of being duplicated. A partner can never
// move, and a listed Digimon (locked = 'market') can only move through the market.

const on = v => v === undefined || v === null ? true : Number(v) === 1 || v === true;

/** A Digimon in this server by its number, with its species, for any owner. */
async function rowById(guildId, id, conn = pool, lock = false) {
    if (!Number.isInteger(id)) return null;
    const [[row]] = await conn.execute(
        `SELECT u.id, u.user_id, u.level, u.nickname, u.is_partner, u.locked, u.dna_partner_id, u.digimon_id, d.name, d.level AS stage
           FROM user_digimon u JOIN digimon_data d ON d.id = u.digimon_id
          WHERE u.id = ? AND u.guild_id = ?${lock ? ' FOR UPDATE' : ''}`, [id, guildId]);
    return row ?? null;
}

const label = r => `#${r.id} ${displayName(r)} (${r.stage}, Lv ${r.level})`;

/** Hand a Digimon to a new owner inside a transaction: fresh care clocks, no nickname, onto their team if it has room. */
async function moveTo(conn, guildId, row, userId) {
    const slot = await freeSlot(guildId, userId, conn);
    const now = Date.now();
    await conn.execute(
        'UPDATE user_digimon SET user_id = ?, nickname = NULL, locked = NULL, is_partner = ?, team_slot = ?, hunger_at = ?, strength_at = ?, aged_at = ? WHERE id = ?',
        [userId, slot ? 1 : 0, slot, now, now, slot ? now : null, row.id]);
    const partner = Boolean(slot);
    await conn.execute(
        `INSERT INTO user_digimon_dex (guild_id, user_id, digimon_id) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE times = times + 1`,
        [guildId, userId, row.digimon_id]);
    return partner;
}

async function addBits(conn, guildId, userId, amount) {
    await conn.execute('INSERT IGNORE INTO digimon_inventory (guild_id, user_id) VALUES (?, ?)', [guildId, userId]);
    await conn.execute('UPDATE digimon_inventory SET bits = bits + ? WHERE guild_id = ? AND user_id = ?', [amount, guildId, userId]);
}

/** Take bits if the member has them; false (and nothing changed) if not. */
async function takeBits(conn, guildId, userId, amount) {
    await conn.execute('INSERT IGNORE INTO digimon_inventory (guild_id, user_id) VALUES (?, ?)', [guildId, userId]);
    const [[inv]] = await conn.execute('SELECT bits FROM digimon_inventory WHERE guild_id = ? AND user_id = ? FOR UPDATE', [guildId, userId]);
    if ((inv?.bits ?? 0) < amount) return { ok: false, have: inv?.bits ?? 0 };
    await conn.execute('UPDATE digimon_inventory SET bits = bits - ? WHERE guild_id = ? AND user_id = ?', [amount, guildId, userId]);
    return { ok: true };
}

async function inTransaction(fn) {
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        const out = await fn(conn);
        await conn.commit();
        return out;
    } catch (err) {
        await conn.rollback().catch(() => {});
        throw err;
    } finally {
        conn.release();
    }
}

function tradeEmbed(guild, t, give, want, state = null) {
    const from = `<@${t.from_user}>`, to = `<@${t.to_user}>`;
    const terms = [
        `${from} gives **${label(give)}**`,
        want ? `${to} gives **${label(want)}**` : null,
        t.ask_bits ? `${to} pays **${t.ask_bits} bits**` : null,
    ].filter(Boolean).join('\n');
    const footer = state ?? `Only ${displayNameFor(t.to_user, guild)} can accept. Expires`;
    const embed = new EmbedBuilder()
        .setColor(themeColor(guild.id, state === 'Trade complete' ? 'success' : state ? 'secondary' : 'accent'))
        .setTitle(state ? `${state}` : 'Digimon trade offer')
        .setDescription(terms)
        .setFooter({ text: `Trade #${t.id} · ${footer}` });
    if (!state) embed.setTimestamp(new Date(t.expires_at));
    return embed;
}

function tradeButtons(id) {
    return [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`dgt:accept:${id}`).setLabel('Accept').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`dgt:decline:${id}`).setLabel('Decline').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`dgt:cancel:${id}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary))];
}

HANDLERS.trade = async function trade(interaction) {
    const { guildId, user, guild } = interaction;
    const cfg = await getConfig('digimon', guildId);
    if (!on(cfg.trades_enabled)) return interaction.reply({ content: 'Trading is turned off in this server.', ...ephemeral });
    const target = interaction.options.getUser('user');
    if (target.bot || target.id === user.id) return interaction.reply({ content: 'Pick another tamer to trade with.', ...ephemeral });
    const give = await rowById(guildId, interaction.options.getInteger('give'));
    const whyGive = cannotMove(give, user.id);
    if (whyGive) return interaction.reply({ content: whyGive === 'not-owned' ? 'You don\'t have a Digimon with that number. Check `/digimon list`.' : `You can't trade that one: ${WHY_NOT[whyGive]}.`, ...ephemeral });
    const wantId = interaction.options.getInteger('want');
    let want = null;
    if (wantId !== null) {
        want = await rowById(guildId, wantId);
        const whyWant = cannotMove(want, target.id);
        if (whyWant) return interaction.reply({ content: whyWant === 'not-owned' ? `${displayNameFor(target, guild)} doesn't have a Digimon #${wantId}.` : `You can't ask for that one: ${WHY_NOT[whyWant]}.`, ...ephemeral });
    }
    const bits = interaction.options.getInteger('bits') ?? 0;
    const [[{ open }]] = await pool.execute(
        `SELECT COUNT(*) AS open FROM digimon_trades WHERE guild_id = ? AND from_user = ? AND status = 'open' AND expires_at > NOW()`, [guildId, user.id]);
    if (open >= 3) return interaction.reply({ content: 'You already have 3 open trade offers. Wait for them to finish or cancel one.', ...ephemeral });
    const expires = new Date(Date.now() + TRADE_TTL_MS);
    const [res] = await pool.execute(
        `INSERT INTO digimon_trades (guild_id, from_user, to_user, give_id, want_id, ask_bits, channel_id, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [guildId, user.id, target.id, give.id, want?.id ?? null, bits, interaction.channelId, expires]);
    const t = { id: res.insertId, from_user: user.id, to_user: target.id, ask_bits: bits, expires_at: expires };
    const msg = await interaction.reply({
        content: `<@${target.id}>, you have a trade offer.`,
        embeds: [tradeEmbed(guild, t, give, want)],
        components: tradeButtons(t.id),
        allowedMentions: { users: [target.id] },
        withResponse: true,
    }).then(r => r.resource?.message);
    if (msg) await pool.execute('UPDATE digimon_trades SET message_id = ? WHERE id = ?', [msg.id, t.id]);
};

/** Settle an accepted trade. Returns { ok } or { ok: false, reason, close }; close means the offer is dead. */
async function settleTrade(guildId, tradeId) {
    return inTransaction(async conn => {
        const [[t]] = await conn.execute('SELECT * FROM digimon_trades WHERE id = ? AND guild_id = ? FOR UPDATE', [tradeId, guildId]);
        if (!t || t.status !== 'open') return { ok: false, reason: 'This trade is already closed.', close: true };
        const finish = async status => conn.execute('UPDATE digimon_trades SET status = ?, finished_at = NOW() WHERE id = ?', [status, t.id]);
        if (new Date(t.expires_at) < new Date()) { await finish('expired'); return { ok: false, reason: 'This trade expired.', close: true, status: 'Trade expired' }; }
        const give = await rowById(guildId, t.give_id, conn, true);
        const whyGive = cannotMove(give, t.from_user);
        if (whyGive) { await finish('failed'); return { ok: false, reason: `The offered Digimon can't be traded any more: ${WHY_NOT[whyGive]}.`, close: true, status: 'Trade fell through' }; }
        let want = null;
        if (t.want_id) {
            want = await rowById(guildId, t.want_id, conn, true);
            const whyWant = cannotMove(want, t.to_user);
            if (whyWant) { await finish('failed'); return { ok: false, reason: `Your Digimon can't be traded right now: ${WHY_NOT[whyWant]}.`, close: true, status: 'Trade fell through' }; }
        }
        if (t.ask_bits > 0) {
            const paid = await takeBits(conn, guildId, t.to_user, t.ask_bits);
            // Not enough bits is the accepter's to fix, so the offer stays open.
            if (!paid.ok) return { ok: false, reason: `This trade costs ${t.ask_bits} bits and you have ${paid.have}.`, close: false };
            await addBits(conn, guildId, t.from_user, t.ask_bits);
        }
        await moveTo(conn, guildId, give, t.to_user);
        if (want) await moveTo(conn, guildId, want, t.from_user);
        await finish('done');
        return { ok: true, t, give, want };
    });
}

/** Buttons on a trade offer: `dgt:accept:<id>`, `dgt:decline:<id>`, `dgt:cancel:<id>` (interactions/handlerRegistry.js). */
export async function handleTradeButton(interaction) {
    const [, action, raw] = interaction.customId.split(':');
    const id = Number(raw);
    const { guildId, guild, user } = interaction;
    try {
        const [[t]] = await pool.execute('SELECT * FROM digimon_trades WHERE id = ? AND guild_id = ?', [id, guildId]);
        if (!t) return interaction.reply({ content: 'This trade no longer exists.', ...ephemeral });
        const mine = action === 'cancel' ? t.from_user : t.to_user;
        if (user.id !== mine) {
            return interaction.reply({ content: action === 'cancel' ? 'Only the tamer who made the offer can cancel it.' : 'This offer isn\'t for you.', ...ephemeral });
        }
        const give = await rowById(guildId, t.give_id);
        const want = t.want_id ? await rowById(guildId, t.want_id) : null;
        const close = state => interaction.update({ content: null, embeds: give ? [tradeEmbed(guild, t, give, want, state)] : [], components: [] });
        if (t.status !== 'open') return close(`Trade ${t.status}`);
        if (action === 'decline' || action === 'cancel') {
            const [r] = await pool.execute(`UPDATE digimon_trades SET status = ?, finished_at = NOW() WHERE id = ? AND status = 'open'`, [action === 'decline' ? 'declined' : 'cancelled', id]);
            if (!r.affectedRows) return interaction.reply({ content: 'This trade is already closed.', ...ephemeral });
            return close(action === 'decline' ? 'Trade declined' : 'Trade cancelled');
        }
        const out = await settleTrade(guildId, id);
        if (!out.ok) {
            if (out.close) return close(out.status ?? 'Trade closed').then(() => interaction.followUp({ content: out.reason, ...ephemeral }));
            return interaction.reply({ content: out.reason, ...ephemeral });
        }
        return close('Trade complete');
    } catch (err) {
        logger.error(`[Digimon] Trade button failed: ${err.message}`, { guildId, id, stack: err.stack });
        const reply = { content: 'Something went wrong with this trade. Nothing was moved.', ...ephemeral };
        if (interaction.replied || interaction.deferred) await interaction.followUp(reply).catch(() => {});
        else await interaction.reply(reply).catch(() => {});
    }
}

/**
 * /digimon setup — the dashboard's Digimon settings from Discord. Runs while Digimon is off (COMMAND_FEATURE_MAP
 * exempts digimon:setup), saves through setConfig like the dashboard, and with no options shows the settings.
 */
HANDLERS.setup = async function setup(interaction) {
    const { guildId, member, user } = interaction;
    if (!member?.permissions?.has?.(PermissionFlagsBits.ManageGuild)) {
        return interaction.reply({ content: 'You need the Manage Server permission to change Digimon settings.', ...ephemeral });
    }
    const o = interaction.options;
    const patch = {};
    const bool = (opt, key) => { const v = o.getBoolean(opt); if (v !== null) patch[key] = v ? 1 : 0; };
    bool('enabled', 'enabled');
    bool('spawns', 'spawns_enabled');
    bool('trades', 'trades_enabled');
    bool('market', 'market_enabled');
    const channel = o.getChannel('spawn_channel');
    if (channel) patch.spawn_channel_id = channel.id;
    if (o.getBoolean('spawn_anywhere')) patch.spawn_channel_id = null;
    const chance = o.getInteger('spawn_chance');
    if (chance !== null) patch.spawn_chance = chance;
    const fee = o.getInteger('market_fee');
    if (fee !== null) patch.market_fee_percent = fee;
    const life = o.getInteger('lifespan_days');
    if (life !== null) patch.lifespan_days = life;

    const cfg = Object.keys(patch).length ? await setConfig('digimon', guildId, patch, user.id) : await getConfig('digimon', guildId);
    const yes = v => (on(v) ? 'On' : 'Off');
    const embed = new EmbedBuilder()
        .setColor(themeColor(guildId, on(cfg.enabled) ? 'success' : 'secondary'))
        .setTitle(Object.keys(patch).length ? 'Digimon settings saved' : 'Digimon settings')
        .setDescription(on(cfg.enabled)
            ? 'Members can use `/digimon start` to hatch a partner and `/digimon today` for the daily quiz.'
            : 'Digimon is off here. Turn it on with `/digimon setup enabled:True`.')
        .addFields(
            { name: 'Digimon', value: yes(cfg.enabled), inline: true },
            { name: 'Wild spawns', value: yes(cfg.spawns_enabled), inline: true },
            { name: 'Spawn channel', value: cfg.spawn_channel_id ? `<#${cfg.spawn_channel_id}>` : 'Wherever people talk', inline: true },
            { name: 'Chance per message', value: `${cfg.spawn_chance ?? 4}%`, inline: true },
            { name: 'Trading', value: yes(cfg.trades_enabled), inline: true },
            { name: 'Market', value: `${yes(cfg.market_enabled)} · ${cfg.market_fee_percent ?? 5}% fee`, inline: true },
            { name: 'Lifespan', value: Number(cfg.lifespan_days ?? DEFAULT_LIFESPAN_DAYS) > 0 ? `${cfg.lifespan_days ?? DEFAULT_LIFESPAN_DAYS} days on the team` : 'Off', inline: true })
        .setFooter({ text: 'Also on the dashboard: Games → Digimon' });
    await interaction.reply({ embeds: [embed], ...ephemeral });
};

HANDLERS.top = async function top(interaction) {
    const { guildId, guild } = interaction;
    const [rows] = await pool.execute(
        `SELECT u.user_id, u.nickname, u.level, u.wins, u.battles, d.name, d.level AS stage
           FROM user_digimon u JOIN digimon_data d ON d.id = u.digimon_id
          WHERE u.guild_id = ? AND u.team_slot = 1
          ORDER BY FIELD(d.level, 'Ultimate', 'Perfect', 'Adult', 'Child', 'Baby II', 'Baby I'), u.level DESC, u.wins DESC
          LIMIT 10`, [guildId]);
    if (!rows.length) return interaction.reply({ content: 'Nobody here has a partner yet. Start with `/digimon start`.', ...ephemeral });
    await guild.members.fetch({ user: rows.map(r => r.user_id) }).catch(() => null);
    const embed = new EmbedBuilder()
        .setColor(themeColor(guildId, 'primary'))
        .setTitle('Strongest team leaders here')
        .setDescription(rows.map((r, i) => `**${i + 1}.** ${displayNameFor(r.user_id, guild)}: ${displayName(r)} · ${r.stage} · Lv ${r.level} · ${r.wins} won of ${r.battles}`).join('\n'))
        .setFooter({ text: 'Ranked by stage, then level, then wins' });
    await interaction.reply({ embeds: [embed] });
};

HANDLERS.rarity = async function rarity(interaction) {
    const { guildId } = interaction;
    const [rows] = await pool.execute(
        `SELECT level, COUNT(*) AS n FROM digimon_data WHERE level IN (${RARITY.map(() => '?').join(', ')}) GROUP BY level`,
        RARITY.map(t => t.stage));
    const counts = Object.fromEntries(rows.map(r => [r.level, Number(r.n)]));
    const cfg = await getConfig('digimon', guildId);
    const lines = RARITY.map(t => {
        const n = counts[t.stage] ?? 0;
        const each = n ? `, each one about 1 in ${Math.round(100 / t.chance * n).toLocaleString('en-US')}` : '';
        return `**${t.name}** · ${t.stage} · ${t.chance}% of spawns\n${n} Digimon${each} · tamed at level ${t.tame[0]}-${t.tame[1]}`;
    });
    const where = cfg.spawn_channel_id ? `in <#${cfg.spawn_channel_id}>` : 'wherever people talk';
    const embed = new EmbedBuilder()
        .setColor(themeColor(guildId, 'primary'))
        .setTitle('Wild Digimon rarity')
        .setDescription(`${lines.join('\n\n')}\n\nBaby, Armor and Unknown Digimon never appear in the wild. Raise them from an egg or digivolve into them.`)
        .addFields({
            name: 'Spawns here',
            value: Number(cfg.spawns_enabled)
                ? `${cfg.spawn_chance ?? 4}% chance per message ${where}, at most one every ${SPAWN_COOLDOWN / 60000} minutes per channel`
                : 'Off. A server manager can turn them on with `/digimon setup spawns:True`.',
        })
        .setFooter({ text: CREDIT });
    await interaction.reply({ embeds: [embed] });
};

const MARKET = {
    async list(interaction) {
        const { guildId, guild } = interaction;
        const q = interaction.options.getString('search')?.trim();
        const [rows] = await pool.execute(
            `SELECT m.id, m.seller_id, m.level, m.price, d.name, d.level AS stage
               FROM digimon_market m JOIN digimon_data d ON d.id = m.digimon_id
              WHERE m.guild_id = ? AND m.status = 'open'${q ? ' AND d.name LIKE ?' : ''}
              ORDER BY m.listed_at DESC LIMIT 100`, q ? [guildId, `%${q}%`] : [guildId]);
        if (!rows.length) return interaction.reply({ content: q ? `Nothing for sale matching "${q}".` : 'Nothing for sale yet. List one with `/digimon market sell`.', ...ephemeral });
        await guild.members.fetch({ user: [...new Set(rows.map(r => r.seller_id))].slice(0, 100) }).catch(() => null);
        const pages = Math.ceil(rows.length / 10);
        const page = n => new EmbedBuilder()
            .setColor(themeColor(guildId, 'primary'))
            .setTitle(q ? `For sale: "${q}"` : 'For sale')
            .setDescription(rows.slice(n * 10, n * 10 + 10)
                .map(r => `**Listing ${r.id}** · ${r.name} · ${r.stage} · Lv ${r.level} · **${r.price} bits** · ${displayNameFor(r.seller_id, guild)}`).join('\n'))
            .setFooter({ text: `Page ${n + 1}/${pages} · Buy with /digimon market buy listing:<number>` });
        await paginate(interaction, pages, page);
    },

    async sell(interaction) {
        const { guildId, user } = interaction;
        const cfg = await getConfig('digimon', guildId);
        if (!on(cfg.market_enabled)) return interaction.reply({ content: 'The market is turned off in this server.', ...ephemeral });
        const row = await ownRow(interaction);
        if (!row) return;
        const why = cannotMove(row, user.id);
        if (why) return interaction.reply({ content: `You can't sell that one: ${WHY_NOT[why]}.`, ...ephemeral });
        const [[{ n }]] = await pool.execute(`SELECT COUNT(*) AS n FROM digimon_market WHERE guild_id = ? AND seller_id = ? AND status = 'open'`, [guildId, user.id]);
        if (n >= MAX_LISTINGS) return interaction.reply({ content: `You already have ${MAX_LISTINGS} Digimon for sale.`, ...ephemeral });
        const price = interaction.options.getInteger('price');
        const listing = await inTransaction(async conn => {
            const [lock] = await conn.execute(`UPDATE user_digimon SET locked = 'market' WHERE id = ? AND user_id = ? AND is_partner = 0 AND locked IS NULL AND dna_partner_id IS NULL`, [row.id, user.id]);
            if (!lock.affectedRows) return null;
            const [res] = await conn.execute(
                'INSERT INTO digimon_market (guild_id, seller_id, user_digimon_id, digimon_id, level, price) VALUES (?, ?, ?, ?, ?, ?)',
                [guildId, user.id, row.id, row.digimon_id, row.level, price]);
            return res.insertId;
        });
        if (!listing) return interaction.reply({ content: 'That Digimon changed in the meantime. Try again.', ...ephemeral });
        const { fee, payout } = marketPayout(price, cfg.market_fee_percent ?? 5);
        await interaction.reply(`${displayName(row)} (Lv ${row.level}) is for sale as **listing ${listing}** for **${price} bits**.`
            + (fee ? ` You get ${payout} after the ${cfg.market_fee_percent}% market fee.` : ''));
    },

    async buy(interaction) {
        const { guildId, user, guild } = interaction;
        const cfg = await getConfig('digimon', guildId);
        if (!on(cfg.market_enabled)) return interaction.reply({ content: 'The market is turned off in this server.', ...ephemeral });
        const listingId = interaction.options.getInteger('listing');
        const out = await inTransaction(async conn => {
            const [[l]] = await conn.execute(`SELECT * FROM digimon_market WHERE id = ? AND guild_id = ? FOR UPDATE`, [listingId, guildId]);
            if (!l || l.status !== 'open') return { error: 'That listing isn\'t for sale any more.' };
            if (l.seller_id === user.id) return { error: 'That\'s your own listing. Take it down with `/digimon market cancel`.' };
            const row = await rowById(guildId, l.user_digimon_id, conn, true);
            if (cannotMove(row, l.seller_id, { allowListed: true }) || row.locked !== 'market') {
                await conn.execute(`UPDATE digimon_market SET status = 'cancelled', closed_at = NOW() WHERE id = ?`, [l.id]);
                return { error: 'That Digimon is no longer available, so the listing was taken down.' };
            }
            const paid = await takeBits(conn, guildId, user.id, l.price);
            if (!paid.ok) return { error: `That costs ${l.price} bits and you have ${paid.have}.` };
            const { fee, payout } = marketPayout(l.price, cfg.market_fee_percent ?? 5);
            await addBits(conn, guildId, l.seller_id, payout);
            const partner = await moveTo(conn, guildId, row, user.id);
            await conn.execute(`UPDATE digimon_market SET status = 'sold', buyer_id = ?, fee = ?, closed_at = NOW() WHERE id = ?`, [user.id, fee, l.id]);
            return { l, row, partner };
        });
        if (out.error) return interaction.reply({ content: out.error, ...ephemeral });
        await interaction.reply({
            content: `${displayNameFor(user, guild)} bought **${displayName(out.row)}** (Lv ${out.row.level}) from <@${out.l.seller_id}> for **${out.l.price} bits**.`
                + (out.partner ? ' It joined their team.' : ' It went to their DigiBank.'),
            allowedMentions: { users: [] },
        });
    },

    async cancel(interaction) {
        const { guildId, user, member } = interaction;
        const listingId = interaction.options.getInteger('listing');
        const [[l]] = await pool.execute(`SELECT * FROM digimon_market WHERE id = ? AND guild_id = ?`, [listingId, guildId]);
        if (!l || l.status !== 'open') return interaction.reply({ content: 'That listing isn\'t open.', ...ephemeral });
        // Staff can take down any listing, as on the dashboard.
        const staff = member?.permissions?.has?.('ManageGuild');
        if (l.seller_id !== user.id && !staff) return interaction.reply({ content: 'That isn\'t your listing.', ...ephemeral });
        await cancelListing(l.id);
        await interaction.reply({ content: `Listing ${l.id} was taken down.` });
    },
};

/** Close an open listing and unlock its Digimon. Shared with the dashboard. */
export async function cancelListing(listingId) {
    return inTransaction(async conn => {
        const [[l]] = await conn.execute(`SELECT * FROM digimon_market WHERE id = ? FOR UPDATE`, [listingId]);
        if (!l || l.status !== 'open') return false;
        await conn.execute(`UPDATE digimon_market SET status = 'cancelled', closed_at = NOW() WHERE id = ?`, [l.id]);
        await conn.execute(`UPDATE user_digimon SET locked = NULL WHERE id = ? AND locked = 'market'`, [l.user_digimon_id]);
        return true;
    });
}

/** One of the caller's Digimon by its list number, or null after telling them it is not theirs. */
async function ownRow(interaction) {
    // The species columns are aliased: d.level and d.id would otherwise overwrite u.level and u.id.
    const [[row]] = await pool.execute(
        `SELECT u.*, d.name, d.level AS stage, d.levels, d.attributes, d.fields, d.skills, d.description, d.image_url,
                d.card_dp, d.card_level, d.card_color, d.card_keywords, d.card_inherited, d.card_dps
           FROM user_digimon u JOIN digimon_data d ON d.id = u.digimon_id
          WHERE u.id = ? AND u.guild_id = ? AND u.user_id = ?`,
        [interaction.options.getInteger('number'), interaction.guildId, interaction.user.id]);
    if (!row) await interaction.reply({ content: 'You don\'t have a Digimon with that number. Check `/digimon list`.', ...ephemeral });
    return row ?? null;
}

async function paginate(interaction, pages, render) {
    let n = 0;
    const nonce = interaction.id;
    const buttons = () => new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`dgm:${nonce}:prev`).setLabel('Previous').setStyle(ButtonStyle.Secondary).setDisabled(n === 0),
        new ButtonBuilder().setCustomId(`dgm:${nonce}:next`).setLabel('Next').setStyle(ButtonStyle.Secondary).setDisabled(n === pages - 1));
    const msg = await interaction.reply({ embeds: [render(n)], components: pages > 1 ? [buttons()] : [], withResponse: true })
        .then(r => r.resource?.message);
    if (pages <= 1 || !msg) return;
    const collector = msg.createMessageComponentCollector({ filter: i => i.user.id === interaction.user.id && i.customId.startsWith(`dgm:${nonce}:`), time: 300000 });
    collector.on('collect', async i => {
        n = i.customId.endsWith(':next') ? Math.min(pages - 1, n + 1) : Math.max(0, n - 1);
        await i.update({ embeds: [render(n)], components: [buttons()] }).catch(() => {});
    });
    collector.on('end', () => msg.edit({ components: [] }).catch(() => {}));
}

async function runQuiz(interaction) {
    const { guildId, user } = interaction;
    const day = quizDay();
    const tomorrow = Math.floor(Date.parse(`${day}T00:00:00Z`) / 1000) + 86400;
    const [[done]] = await pool.execute('SELECT * FROM digimon_quiz_results WHERE user_id = ? AND day = ?', [user.id, day]);
    if (done) {
        const [[row]] = await pool.execute('SELECT * FROM digimon_data WHERE id = ?', [done.digimon_id]);
        if (row) {
            const d = species(row);
            // Footers do not render <t:> timestamps, so the reset time goes in the message text.
            return interaction.reply({
                ...(await withImage(resultEmbed(interaction, d, done, day, await sameToday(guildId, day, d.id, user.id), await nextForm(d, user.id, day)), d)),
                content: `You already took today's quiz. New questions <t:${tomorrow}:R>.`,
            });
        }
    }

    // This server's questions (built-in plus its own changes from the dashboard), weighted by its own answers.
    const bank = await loadQuizBank(guildId);
    const questions = questionsForDay(day, bank);
    const nonce = interaction.id;
    const answers = [];
    // In the channel for everyone to follow along; only the member who ran it can answer, and the same message
    // turns into the result.
    const who = displayNameFor(user, interaction.guild);
    const render = i => ({
        embeds: [new EmbedBuilder()
            .setColor(themeColor(guildId, 'accent'))
            .setTitle('Which Digital Monster are you today?')
            .setDescription(`**${i + 1}/${questions.length}** · ${CATEGORIES[questions[i].cat] ?? 'Question'}\n\n${questions[i].q}`)
            .setFooter({ text: `${who}'s quiz · only they can answer` })],
        components: [new ActionRowBuilder().addComponents(questions[i].options.map((o, k) =>
            new ButtonBuilder().setCustomId(`dgq:${nonce}:${i}:${k}`).setLabel(o.label).setStyle(ButtonStyle.Primary)))],
    });
    const msg = await interaction.reply({ ...render(0), withResponse: true }).then(r => r.resource?.message);
    if (!msg) return;
    const collector = msg.createMessageComponentCollector({ filter: i => i.customId.startsWith(`dgq:${nonce}:`), time: 180000 });
    collector.on('collect', async i => {
        if (i.user.id !== user.id) return void await i.reply({ content: `This is ${who}'s quiz. Run \`/digimon today\` to take your own.`, ...ephemeral }).catch(() => {});
        try {
            const [, , qi, oi] = i.customId.split(':');
            if (Number(qi) !== answers.length) return void i.deferUpdate().catch(() => {});
            answers.push(questions[answers.length].options[Number(oi)]);
            if (answers.length < questions.length) return void await i.update(render(answers.length));
            collector.stop('done');
            await i.update({ embeds: [new EmbedBuilder().setColor(themeColor(guildId, 'success')).setTitle('Scanning your data…')], components: [] });
            const result = scoreAnswers(answers, weightsFor(bank));
            const [rows] = await pool.execute(`SELECT * FROM digimon_data WHERE level IN (${POWER_LEVELS.map(() => '?').join(', ')})`, POWER_LEVELS);
            const pick = pickDigimon(result, rows.map(species), user.id, day);
            if (!pick) return void await i.editReply({ content: 'The Digimon list is still loading. Try again in a few minutes.', embeds: [] });
            await pool.execute(
                `INSERT IGNORE INTO digimon_quiz_results (user_id, day, guild_id, digimon_id, attribute, field, level, crest, family) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [user.id, day, guildId, pick.id, result.attribute, result.field, result.level, result.crest, result.family]);
            const [[saved]] = await pool.execute('SELECT * FROM digimon_quiz_results WHERE user_id = ? AND day = ?', [user.id, day]);
            const [[final]] = await pool.execute('SELECT * FROM digimon_data WHERE id = ?', [saved.digimon_id]);
            const d = species(final);
            await i.editReply(await withImage(resultEmbed(interaction, d, saved, day, await sameToday(guildId, day, d.id, user.id), await nextForm(d, user.id, day)), d));
        } catch (err) {
            logger.error(`[Digimon] Quiz failed: ${err.message}`, { guildId, stack: err.stack });
            const reply = { content: 'Something went wrong with the quiz. Please try again.', ...ephemeral };
            await (i.replied || i.deferred ? i.followUp(reply) : i.reply(reply)).catch(() => {});
        }
    });
    collector.on('end', (_, reason) => {
        if (reason !== 'done') interaction.editReply({ content: 'The quiz timed out. Run `/digimon today` to start again.', embeds: [], components: [] }).catch(() => {});
    });
}

/** How many other members of this server got the same Digimon on this day. */
async function sameToday(guildId, day, digimonId, userId) {
    const [[{ n }]] = await pool.execute(
        'SELECT COUNT(*) AS n FROM digimon_quiz_results WHERE guild_id = ? AND day = ? AND digimon_id = ? AND user_id <> ?',
        [guildId, day, digimonId, userId]);
    return Number(n);
}

// The Crest's word for the result line: "Today you are a brave dragon type."
const CREST_WORD = { courage: 'brave', friendship: 'loyal', love: 'caring', knowledge: 'clever', sincerity: 'honest',
    reliability: 'steady', hope: 'hopeful', light: 'radiant', kindness: 'gentle', miracles: 'lucky' };

/** A form today's Digimon could digivolve into, picked by member and day, or null at the final stage. */
async function nextForm(d, userId, day) {
    const stage = nextStage(d.level);
    if (!stage) return null;
    const [rows] = await pool.execute(
        'SELECT d.id, d.name, d.levels FROM digimon_evolutions e JOIN digimon_data d ON d.id = e.to_id WHERE e.from_id = ?', [d.id]);
    const forms = rows.map(species).filter(f => f.levels.includes(stage));
    if (!forms.length) return null;
    return forms.map(f => ({ f, h: stableHash(`${userId}:${day}:next:${f.id}`) })).sort((a, b) => a.h - b.h)[0].f.name;
}

function resultEmbed(interaction, d, result, day, others = 0, next = null) {
    const twins = others ? `\n\n${others === 1 ? '1 other tamer here is' : `${others} other tamers here are`} ${d.name} today too.` : '';
    const crest = CRESTS[result.crest];
    // Results saved before crests and families have neither; the family can be read off the Digimon itself.
    const family = result.family || familyOf(d.types);
    const kind = [crest ? CREST_WORD[result.crest] : null, family ? `${familyWord(family)} type` : null].filter(Boolean).join(' ');
    const move = signatureMove(d, interaction.user.id, day);
    const fields = [];
    if (crest) fields.push({ name: `Crest of ${crest.name}`, value: crest.line });
    fields.push(
        { name: 'Attribute', value: result.attribute, inline: true },
        { name: 'Field', value: result.field, inline: true },
        { name: 'Stage', value: result.level, inline: true });
    if (move) fields.push({ name: 'Signature move', value: move, inline: true });
    fields.push({ name: 'Digivolves into', value: next ?? (nextStage(d.level) ? 'Nobody knows yet' : 'Already its final form'), inline: true });
    return new EmbedBuilder()
        .setColor(themeColor(interaction.guildId, 'accent'))
        .setTitle(`${displayNameFor(interaction.user, interaction.guild)} is ${d.name} today!`)
        .setDescription(`${kind ? `Today you are ${/^(honest|[aeiou])/i.test(kind) ? 'an' : 'a'} ${kind}.\n` : ''}${d.level} · ${d.attributes.join('/') || 'Unknown'} · ${d.fields.slice(0, 2).join(', ') || 'Unknown field'}\n\n${about(d, 300)}${twins}`)
        .addFields(fields)
        .setFooter({ text: `${day} · Take it yourself with /digimon today · ${CREDIT}` });
}

/** Called from events/messageCreate.js for servers with Digimon on. */
export async function spawnDigimon(message) {
    try {
        const cfg = await getConfig('digimon', message.guild.id);
        if (!Number(cfg.enabled) || !Number(cfg.spawns_enabled)) return;
        const chance = Math.min(50, Math.max(1, Number(cfg.spawn_chance) || 4)) / 100;
        const channel = cfg.spawn_channel_id
            ? message.guild.channels.cache.get(cfg.spawn_channel_id) ?? message.channel
            : message.channel;
        if (Date.now() - (lastSpawn.get(channel.id) ?? 0) < SPAWN_COOLDOWN) return;
        if (Math.random() > chance) return;
        lastSpawn.set(channel.id, Date.now());
        const tier = rollRarity();
        const d = await randomSpecies(tier.stage);
        if (!d) return;
        const embed = new EmbedBuilder()
            .setColor(tier.color)
            .setTitle(tier.name === 'Common' ? 'A wild Digimon appeared!' : `A ${tier.name.toLowerCase()} wild Digimon appeared!`)
            .setDescription(`**${tier.name}** · It's a **${d.level}** with the **${d.attributes.join('/') || 'Unknown'}** attribute.\nName it with \`/digimon tame\` to make it yours.`)
            .setFooter({ text: `It stays until someone tames it or another appears · ${CREDIT}` });
        const sent = await channel.send(await withImage(embed, d, 'wild.png'));
        await pool.execute(
            `INSERT INTO digimon_spawns (guild_id, channel_id, digimon_id, message_id) VALUES (?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE digimon_id = VALUES(digimon_id), message_id = VALUES(message_id), spawned_at = CURRENT_TIMESTAMP`,
            [message.guild.id, channel.id, d.id, sent.id]);
    } catch (err) {
        logger.warn(`[Digimon] Spawn failed in ${message.guild?.id}: ${err.message}`);
    }
}
