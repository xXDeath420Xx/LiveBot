#!/usr/bin/env node
/**
 * Seed baseline D&D 5e content into the RPG catalog/reference tables.
 *
 * IMPORTANT: This seeds against the LIVE table schema (verified via SHOW COLUMNS),
 * which differs from migrations/125_dnd_rpg.js in several places (the live tables
 * predate that migration). Columns used here are the real ones, e.g.:
 *   dnd_items:   item_type ENUM(weapon,armor,potion,material,quest,misc),
 *                damage, defense, healing, mana_restore, required_level
 *   dnd_enemies: level, exp_reward, gold_reward (no min_level / reward_* here)
 *   dnd_spells:  casting_time (NOT NULL), range_type ENUM, school lowercase ENUM,
 *                components/damage_dice/healing_dice stored as JSON strings
 *   dnd_dungeon_rooms: room_number (not room_order), room_name, enemies/loot_table JSON
 *   dnd_achievements:  achievement_key, name, tier, requirement_type/value
 *   dnd_shops:   shop_name (required), zone, item_id, price, stock
 *
 * Idempotent: every insert is guarded by the table's UNIQUE key (ON DUPLICATE KEY
 * UPDATE) or by an explicit name-existence check where no UNIQUE key exists
 * (items, quests, dungeon rooms). Safe to run repeatedly.
 *
 * DB only. Does not touch any bot token, PM2 process, or manager/handler code.
 *
 * Usage:  node scripts/seed-dnd-content.mjs
 */
import pool from '../utils/db.js';

const log = (...a) => console.log('[seed-dnd]', ...a);

// ---------------------------------------------------------------------------
// 1. ITEMS  — fix existing empty item_types, then add to reach ~40.
//    item_type ENUM(weapon,armor,potion,material,quest,misc)
//    cols: item_name(UNIQUE), item_type, description, value, rarity,
//          damage, defense, healing, mana_restore, required_level
// ---------------------------------------------------------------------------

// Re-classify items that were inserted with an empty item_type ('').
const ITEM_TYPE_FIXES = {
  'Health Potion': 'potion', 'Greater Health Potion': 'potion',
  'Mana Potion': 'potion', 'Greater Mana Potion': 'potion',
  'Elixir of Strength': 'potion', 'Antidote': 'potion', 'Phoenix Down': 'potion',
  'Ring of Protection': 'misc', 'Amulet of Wisdom': 'misc',
  'Belt of Giant Strength': 'misc', 'Boots of Speed': 'misc',
};

// Extra items to add (guarded by name existence — item_name is UNIQUE so the
// INSERT itself is also safe, but we check first to keep the run quiet/idempotent).
// [name, type, description, value, rarity, damage, defense, healing, mana_restore, required_level]
const NEW_ITEMS = [
  ['Dagger',            'weapon',   'A simple, light blade. Finesse and throwable.',                 2,  'common',    2, 0, 0, 0, 1],
  ['Shortsword',        'weapon',   'A versatile one-handed blade favored by rogues.',              10,  'common',    3, 0, 0, 0, 1],
  ['Greatsword',        'weapon',   'A massive two-handed blade dealing heavy damage.',             50,  'uncommon',  6, 0, 0, 0, 2],
  ['Battleaxe',         'weapon',   'A broad-bladed axe built for cleaving foes.',                  10,  'common',    4, 0, 0, 0, 1],
  ['Mace',              'weapon',   'A blunt weapon effective against armored enemies.',             5,  'common',    3, 0, 0, 0, 1],
  ['Quarterstaff',      'weapon',   'A sturdy wooden staff, the classic adventurer’s tool.',    2,  'common',    2, 0, 0, 0, 1],
  ['Shortbow',          'weapon',   'A compact bow for quick ranged attacks.',                      25,  'common',    3, 0, 0, 0, 1],
  ['Longbow',           'weapon',   'A tall bow with excellent range and power.',                   50,  'uncommon',  5, 0, 0, 0, 2],
  ['Light Crossbow',    'weapon',   'A reliable ranged weapon requiring little training.',          25,  'common',    4, 0, 0, 0, 1],
  ['Flame Tongue',      'weapon',   'A sword wreathed in magical fire on command.',               5000,  'rare',     7, 0, 0, 0, 5],
  ['Wooden Shield',     'armor',    'A basic shield offering modest protection.',                   10,  'common',    0, 2, 0, 0, 1],
  ['Tower Shield',      'armor',    'A heavy shield that turns its bearer into a wall.',           120,  'uncommon',  0, 3, 0, 0, 3],
  ['Studded Leather',   'armor',    'Supple leather reinforced with metal studs.',                  45,  'common',    0, 2, 0, 0, 1],
  ['Half Plate',        'armor',    'Shaped plates over chain, balancing weight and defense.',     750,  'uncommon',  0, 4, 0, 0, 3],
  ['Cloak of Elvenkind','armor',    'A cloak that helps its wearer vanish from sight.',            900,  'rare',      0, 1, 0, 0, 4],
  ['Superior Healing Potion','potion','Restores a large amount of health when quaffed.',           450,  'rare',      0, 0, 70, 0, 1],
  ['Greater Mana Crystal',   'potion','A crystal that floods the drinker with arcane energy.',     400,  'rare',      0, 0, 0, 70, 1],
  ['Potion of Fire Resistance','potion','Wards the drinker against flames for a time.',            300,  'uncommon',  0, 0, 0, 0, 1],
  ['Scroll of Fireball','misc',     'A single-use scroll that unleashes a fireball.',              600,  'rare',      0, 0, 0, 0, 5],
  ['Scroll of Identify','misc',     'Reveals the magical properties of an item.',                  100,  'uncommon',  0, 0, 0, 0, 1],
  ['Torch',             'misc',     'A wooden torch that lights the dark for an hour.',              1,  'common',    0, 0, 0, 0, 1],
  ["Thieves' Tools",    'misc',     'Lockpicks and tools for disabling traps and locks.',           25,  'common',    0, 0, 0, 0, 1],
  ['Rope (50 ft.)',     'misc',     'Fifty feet of sturdy hempen rope.',                             1,  'common',    0, 0, 0, 0, 1],
  ['Dragon Scale',      'material', 'A shimmering scale prized by master smiths.',                 250,  'rare',      0, 0, 0, 0, 1],
  ['Mithral Ore',       'material', 'A lump of legendary lightweight metal.',                      500,  'epic',      0, 0, 0, 0, 1],
  ['Goblin Ear',        'material', 'Proof of a slain goblin; bounty hunters pay for these.',        2,  'common',    0, 0, 0, 0, 1],
  ['Ancient Relic',     'quest',    'A mysterious artifact sought by a powerful patron.',          800,  'legendary', 0, 0, 0, 0, 1],
];

async function seedItems() {
  // Fix empty item_type on existing rows.
  for (const [name, type] of Object.entries(ITEM_TYPE_FIXES)) {
    await pool.execute(
      "UPDATE dnd_items SET item_type = ? WHERE item_name = ? AND (item_type = '' OR item_type IS NULL)",
      [type, name]
    );
  }
  // Catch any other stragglers with empty type -> misc (defensive).
  await pool.execute("UPDATE dnd_items SET item_type = 'misc' WHERE item_type = '' OR item_type IS NULL");

  let added = 0;
  for (const [item_name, item_type, description, value, rarity, damage, defense, healing, mana_restore, required_level] of NEW_ITEMS) {
    const [rows] = await pool.execute('SELECT item_id FROM dnd_items WHERE item_name = ?', [item_name]);
    if (rows.length) continue;
    await pool.execute(
      `INSERT INTO dnd_items
         (item_name, item_type, description, value, rarity, damage, defense, healing, mana_restore, required_level)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [item_name, item_type, description, value, rarity, damage, defense, healing, mana_restore, required_level]
    );
    added++;
  }
  log(`items: fixed empty types, added ${added} new`);
}

// ---------------------------------------------------------------------------
// 2. SPELLS  — UNIQUE(spell_name). school/range_type/save_type/attack_type are
//    lowercase ENUMs. components/damage_dice/healing_dice stored as JSON strings
//    (managers JSON.parse them). casting_time is NOT NULL.
//    [name, level, school, casting_time, range_type, range_distance, components(arr),
//     duration, concentration, ritual, description, damage_dice(obj|null),
//     damage_type, healing_dice(obj|null), save_type, attack_type, classes(arr)]
// ---------------------------------------------------------------------------
const SPELLS = [
  // Cantrips (level 0)
  ['Fire Bolt',     0, 'evocation',    '1 action', 'ranged', 120, ['V','S'],     'Instantaneous', 0, 0, 'You hurl a mote of fire at a creature or object within range.', {dice:'1d10',upcast:{dice:1}}, 'fire', null, null, 'ranged', ['wizard','sorcerer']],
  ['Eldritch Blast',0, 'evocation',    '1 action', 'ranged', 120, ['V','S'],     'Instantaneous', 0, 0, 'A beam of crackling energy streaks toward a creature within range.', {dice:'1d10'}, 'force', null, null, 'ranged', ['warlock']],
  ['Sacred Flame',  0, 'evocation',    '1 action', 'ranged', 60,  ['V','S'],     'Instantaneous', 0, 0, 'Flame-like radiance descends on a creature you can see.', {dice:'1d8',upcast:{dice:1}}, 'radiant', null, 'dex', null, ['cleric']],
  ['Mage Hand',     0, 'conjuration',  '1 action', 'ranged', 30,  ['V','S'],     '1 minute', 0, 0, 'A spectral, floating hand appears and manipulates objects.', null, null, null, null, null, ['wizard','sorcerer','warlock']],
  ['Prestidigitation',0,'transmutation','1 action','ranged', 10,  ['V','S'],     'Up to 1 hour', 0, 0, 'A minor magical trick that novice spellcasters use for practice.', null, null, null, null, null, ['wizard','sorcerer','warlock','bard']],
  ['Minor Illusion',0, 'illusion',     '1 action', 'ranged', 30,  ['S','M'],     '1 minute', 0, 0, 'You create a sound or an image of an object within range.', null, null, null, null, null, ['wizard','sorcerer','warlock','bard']],
  ['Ray of Frost',  0, 'evocation',    '1 action', 'ranged', 60,  ['V','S'],     'Instantaneous', 0, 0, 'A frigid beam of blue-white light streaks toward a creature.', {dice:'1d8',upcast:{dice:1}}, 'cold', null, null, 'ranged', ['wizard','sorcerer']],
  ['Guidance',      0, 'divination',   '1 action', 'touch',  0,   ['V','S'],     '1 minute', 1, 0, 'You touch a willing creature, granting a d4 to one ability check.', null, null, null, null, null, ['cleric','druid']],
  ['Vicious Mockery',0,'enchantment',  '1 action', 'ranged', 60,  ['V'],         'Instantaneous', 0, 0, 'You unleash a string of insults laced with subtle enchantments.', {dice:'1d4',upcast:{dice:1}}, 'psychic', null, 'wis', null, ['bard']],
  ['Shillelagh',    0, 'transmutation','1 bonus action','touch',0,['V','S','M'], '1 minute', 0, 0, 'Imbue a club or quarterstaff with nature’s power.', null, null, null, null, null, ['druid']],

  // Level 1
  ['Magic Missile', 1, 'evocation',    '1 action', 'ranged', 120, ['V','S'],     'Instantaneous', 0, 0, 'Three glowing darts of magical force strike unerringly.', {dice:'3d4+3',upcast:{dice:'1d4+1'}}, 'force', null, null, null, ['wizard','sorcerer']],
  ['Cure Wounds',   1, 'evocation',    '1 action', 'touch',  0,   ['V','S'],     'Instantaneous', 0, 0, 'A creature you touch regains hit points.', null, null, {dice:'1d8',upcast:{dice:'1d8'}}, null, null, ['cleric','druid','bard','paladin','ranger']],
  ['Healing Word',  1, 'evocation',    '1 bonus action','ranged',60,['V'],       'Instantaneous', 0, 0, 'A creature of your choice regains hit points at range.', null, null, {dice:'1d4',upcast:{dice:'1d4'}}, null, null, ['cleric','druid','bard']],
  ['Shield',        1, 'abjuration',   '1 reaction','self',  0,   ['V','S'],     '1 round', 0, 0, 'An invisible barrier of force grants +5 AC until your next turn.', null, null, null, null, null, ['wizard','sorcerer']],
  ['Burning Hands', 1, 'evocation',    '1 action', 'self',   15,  ['V','S'],     'Instantaneous', 0, 0, 'A thin sheet of flames shoots from your fingertips in a cone.', {dice:'3d6',upcast:{dice:'1d6'}}, 'fire', null, 'dex', null, ['wizard','sorcerer']],
  ['Thunderwave',   1, 'evocation',    '1 action', 'self',   15,  ['V','S'],     'Instantaneous', 0, 0, 'A wave of thunderous force sweeps out from you.', {dice:'2d8',upcast:{dice:'1d8'}}, 'thunder', null, 'con', null, ['wizard','sorcerer','bard','druid']],
  ['Bless',         1, 'enchantment',  '1 action', 'ranged', 30,  ['V','S','M'], '1 minute', 1, 0, 'Up to three creatures add a d4 to attack rolls and saving throws.', null, null, null, null, null, ['cleric','paladin']],
  ['Faerie Fire',   1, 'evocation',    '1 action', 'ranged', 60,  ['V'],         '1 minute', 1, 0, 'Objects and creatures in a cube are outlined in light.', null, null, null, 'dex', null, ['druid','bard']],
  ['Detect Magic',  1, 'divination',   '1 action', 'self',   30,  ['V','S'],     '10 minutes', 1, 1, 'You sense the presence of magic within 30 feet.', null, null, null, null, null, ['wizard','sorcerer','cleric','druid','bard','paladin','ranger']],
  ['Charm Person',  1, 'enchantment',  '1 action', 'ranged', 30,  ['V','S'],     '1 hour', 0, 0, 'You attempt to charm a humanoid you can see.', null, null, null, 'wis', null, ['wizard','sorcerer','warlock','bard','druid']],

  // Level 2
  ['Scorching Ray', 2, 'evocation',    '1 action', 'ranged', 120, ['V','S'],     'Instantaneous', 0, 0, 'You create three rays of fire and hurl them at targets.', {dice:'2d6',upcast:{dice:'2d6'}}, 'fire', null, null, 'ranged', ['wizard','sorcerer']],
  ['Misty Step',    2, 'conjuration',  '1 bonus action','self',0, ['V'],         'Instantaneous', 0, 0, 'You teleport up to 30 feet to an unoccupied space you can see.', null, null, null, null, null, ['wizard','sorcerer','warlock']],
  ['Hold Person',   2, 'enchantment',  '1 action', 'ranged', 60,  ['V','S','M'], '1 minute', 1, 0, 'A humanoid you can see must succeed on a save or be paralyzed.', null, null, null, 'wis', null, ['wizard','sorcerer','warlock','cleric','bard','druid']],
  ['Spiritual Weapon',2,'evocation',   '1 bonus action','ranged',60,['V','S'],   '1 minute', 0, 0, 'A floating, spectral weapon strikes at your command.', {dice:'1d8',upcast:{dice:'1d8'}}, 'force', null, null, null, ['cleric']],
  ['Lesser Restoration',2,'abjuration','1 action', 'touch',  0,   ['V','S'],     'Instantaneous', 0, 0, 'End one disease or condition afflicting a creature you touch.', null, null, null, null, null, ['cleric','druid','bard','paladin','ranger']],
  ['Invisibility',  2, 'illusion',     '1 action', 'touch',  0,   ['V','S','M'], '1 hour', 1, 0, 'A creature you touch becomes invisible until it attacks or casts.', null, null, null, null, null, ['wizard','sorcerer','warlock','bard']],

  // Level 3
  ['Fireball',      3, 'evocation',    '1 action', 'ranged', 150, ['V','S','M'], 'Instantaneous', 0, 0, 'A bright streak blossoms into an explosion of flame.', {dice:'8d6',upcast:{dice:'1d6'}}, 'fire', null, 'dex', null, ['wizard','sorcerer']],
  ['Lightning Bolt',3, 'evocation',    '1 action', 'self',   100, ['V','S','M'], 'Instantaneous', 0, 0, 'A stroke of lightning forms a line 100 feet long.', {dice:'8d6',upcast:{dice:'1d6'}}, 'lightning', null, 'dex', null, ['wizard','sorcerer']],
  ['Counterspell',  3, 'abjuration',   '1 reaction','ranged', 60,  ['S'],         'Instantaneous', 0, 0, 'You interrupt a creature in the process of casting a spell.', null, null, null, null, null, ['wizard','sorcerer','warlock']],
  ['Revivify',      3, 'necromancy',   '1 action', 'touch',  0,   ['V','S','M'], 'Instantaneous', 0, 0, 'You return a creature that died within the last minute to life.', null, null, null, null, null, ['cleric','paladin']],
  ['Mass Healing Word',3,'evocation',  '1 bonus action','ranged',60,['V'],       'Instantaneous', 0, 0, 'Up to six creatures of your choice regain hit points.', null, null, {dice:'1d4',upcast:{dice:'1d4'}}, null, null, ['cleric']],
  ['Dispel Magic',  3, 'abjuration',   '1 action', 'ranged', 120, ['V','S'],     'Instantaneous', 0, 0, 'End spells on a target creature, object, or magical effect.', null, null, null, null, null, ['wizard','sorcerer','warlock','cleric','druid','bard','paladin']],
];

async function seedSpells() {
  let n = 0;
  for (const [spell_name, spell_level, school, casting_time, range_type, range_distance, components,
              duration, concentration, ritual, description, damage_dice, damage_type, healing_dice,
              save_type, attack_type, classes] of SPELLS) {
    await pool.execute(
      `INSERT INTO dnd_spells
         (spell_name, spell_level, school, casting_time, range_type, range_distance,
          components, duration, concentration, ritual, description,
          damage_dice, damage_type, healing_dice, save_type, attack_type, class_list)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE
         spell_level=VALUES(spell_level), school=VALUES(school), casting_time=VALUES(casting_time),
         range_type=VALUES(range_type), range_distance=VALUES(range_distance),
         components=VALUES(components), duration=VALUES(duration), concentration=VALUES(concentration),
         ritual=VALUES(ritual), description=VALUES(description), damage_dice=VALUES(damage_dice),
         damage_type=VALUES(damage_type), healing_dice=VALUES(healing_dice),
         save_type=VALUES(save_type), attack_type=VALUES(attack_type), class_list=VALUES(class_list)`,
      [spell_name, spell_level, school, casting_time, range_type, range_distance,
       JSON.stringify(components), duration, concentration, ritual, description,
       damage_dice ? JSON.stringify(damage_dice) : null, damage_type,
       healing_dice ? JSON.stringify(healing_dice) : null, save_type, attack_type,
       JSON.stringify(classes)]
    );
    n++;
  }
  log(`spells: upserted ${n}`);
}

// ---------------------------------------------------------------------------
// 3. CONDITIONS  — UNIQUE(condition_name). The 14 standard 5e conditions + a
//    base Exhaustion entry. (Live table already has the 14 + exhaustion_1..6
//    tiers; this upsert is harmless and guarantees the canonical set exists.)
// ---------------------------------------------------------------------------
const CONDITIONS = [
  ['blinded',      "A blinded creature can't see and automatically fails any check requiring sight. Attacks against it have advantage; its attacks have disadvantage.", {cant_see:true,attacks_against_advantage:true,attacks_disadvantage:true}, '😶‍🌫️'],
  ['charmed',      "A charmed creature can't attack the charmer and the charmer has advantage on social checks against it.", {cant_attack_charmer:true,social_advantage:true}, '😍'],
  ['deafened',     "A deafened creature can't hear and automatically fails any check requiring hearing.", {cant_hear:true}, '🔇'],
  ['frightened',   'A frightened creature has disadvantage on ability checks and attack rolls while the source of fear is in sight, and can’t willingly move closer to it.', {disadvantage_checks:true,disadvantage_attacks:true,cant_approach_source:true}, '😨'],
  ['grappled',     'A grappled creature’s speed becomes 0 and it can’t benefit from any bonus to its speed.', {speed:0}, '🤜'],
  ['incapacitated','An incapacitated creature can’t take actions or reactions.', {no_actions:true,no_reactions:true}, '😵'],
  ['invisible',    'An invisible creature is impossible to see without special senses. Attacks against it have disadvantage; its attacks have advantage.', {hidden:true,attacks_against_disadvantage:true,attacks_advantage:true}, '👻'],
  ['paralyzed',    'A paralyzed creature is incapacitated and can’t move or speak. It fails Str and Dex saves; attacks against it have advantage and crit if within 5 feet.', {incapacitated:true,cant_move:true,fail_str_dex_saves:true,attacks_advantage:true,auto_crit_melee:true}, '⚡'],
  ['petrified',    'A petrified creature is transformed into solid substance, incapacitated, and gains resistance to all damage.', {incapacitated:true,resistance_all:true,immune_poison_disease:true}, '🗿'],
  ['poisoned',     'A poisoned creature has disadvantage on attack rolls and ability checks.', {disadvantage_attacks:true,disadvantage_checks:true}, '🤢'],
  ['prone',        'A prone creature’s only movement option is to crawl. It has disadvantage on attacks; melee attacks against it have advantage, ranged have disadvantage.', {disadvantage_attacks:true,melee_against_advantage:true,ranged_against_disadvantage:true}, '😵‍💫'],
  ['restrained',   'A restrained creature’s speed becomes 0. Attacks against it have advantage; its attacks have disadvantage; it has disadvantage on Dex saves.', {speed:0,attacks_against_advantage:true,attacks_disadvantage:true,disadvantage_dex_saves:true}, '⛓️'],
  ['stunned',      'A stunned creature is incapacitated, can’t move, and can speak only falteringly. It fails Str and Dex saves; attacks against it have advantage.', {incapacitated:true,cant_move:true,fail_str_dex_saves:true,attacks_advantage:true}, '💫'],
  ['unconscious',  'An unconscious creature is incapacitated, drops what it’s holding, and falls prone. It fails Str and Dex saves; attacks have advantage and crit within 5 feet.', {incapacitated:true,prone:true,fail_str_dex_saves:true,attacks_advantage:true,auto_crit_melee:true}, '😴'],
  ['exhaustion',   'Exhaustion is measured in six levels, each imposing a cumulative penalty (disadvantage on checks, reduced speed, disadvantage on attacks/saves, halved HP max, speed 0, and finally death).', {levels:6,cumulative:true}, '😫'],
];

async function seedConditions() {
  let n = 0;
  for (const [condition_name, description, mechanical_effects, icon_emoji] of CONDITIONS) {
    await pool.execute(
      `INSERT INTO dnd_conditions (condition_name, description, mechanical_effects, icon_emoji, is_custom)
       VALUES (?,?,?,?,0)
       ON DUPLICATE KEY UPDATE description=VALUES(description),
         mechanical_effects=VALUES(mechanical_effects), icon_emoji=VALUES(icon_emoji)`,
      [condition_name, description, JSON.stringify(mechanical_effects), icon_emoji]
    );
    n++;
  }
  log(`conditions: upserted ${n}`);
}

// ---------------------------------------------------------------------------
// 4. ENEMIES  — live cols: enemy_name, health, damage, defense, exp_reward,
//    gold_reward, zone, level. No UNIQUE on name -> guard by name-existence.
//    The live table already has 38; this only adds any of these that are missing.
// ---------------------------------------------------------------------------
const ENEMIES = [
  // [name, health, damage, defense, exp_reward, gold_reward, zone, level]
  ['Goblin',           7,  4, 1,  15,  8,  'forest',  1],
  ['Kobold',           5,  3, 0,  12,  5,  'caves',   1],
  ['Giant Rat',        4,  2, 0,   8,  2,  'forest',  1],
  ['Wolf',            11,  5, 1,  20, 10,  'forest',  2],
  ['Bandit',          11,  5, 1,  25, 15,  'meadows', 2],
  ['Skeleton',        13,  5, 2,  30, 12,  'ruins',   2],
  ['Zombie',          22,  4, 1,  35, 10,  'ruins',   3],
  ['Orc',             15,  9, 3,  45, 25,  'caves',   3],
  ['Giant Spider',    26,  7, 2,  50, 20,  'swamp',   3],
  ['Ghoul',           22,  7, 2,  55, 22,  'ruins',   4],
  ['Ogre',            59, 13, 3,  90, 60,  'meadows', 4],
  ['Harpy',           38,  6, 1,  75, 40,  'desert',  4],
  ['Owlbear',         59, 14, 3, 120, 70,  'forest',  5],
  ['Wight',           45, 10, 4, 140, 90,  'ruins',   5],
  ['Troll',           84, 18, 2, 200,130,  'swamp',   6],
  ['Manticore',       68, 14, 4, 240,150,  'desert',  6],
  ['Wyvern',         110, 20, 5, 320,200,  'volcano', 7],
  ['Young Dragon',   178, 30, 8, 600,450,  'dragon_lair', 9],
];

async function seedEnemies() {
  let added = 0;
  for (const [enemy_name, health, damage, defense, exp_reward, gold_reward, zone, level] of ENEMIES) {
    const [rows] = await pool.execute('SELECT enemy_id FROM dnd_enemies WHERE enemy_name = ?', [enemy_name]);
    if (rows.length) continue;
    await pool.execute(
      `INSERT INTO dnd_enemies (enemy_name, health, damage, defense, exp_reward, gold_reward, zone, level)
       VALUES (?,?,?,?,?,?,?,?)`,
      [enemy_name, health, damage, defense, exp_reward, gold_reward, zone, level]
    );
    added++;
  }
  log(`enemies: added ${added} (existing kept)`);
}

// ---------------------------------------------------------------------------
// 5. QUESTS  — live cols: quest_name, description, required_level, reward_exp,
//    reward_gold, reward_item_id, zone, difficulty ENUM(easy,medium,hard,legendary).
//    No UNIQUE on name -> guard by name-existence. reward_item_id resolved by name.
// ---------------------------------------------------------------------------
const QUESTS = [
  // [name, description, required_level, reward_exp, reward_gold, reward_item_name|null, zone, difficulty]
  ['Goblin Cleanup',     'Goblins have been raiding the road. Cull their numbers in the forest.',          1,  50,  25, 'Health Potion',         'forest',  'easy'],
  ['Rats in the Cellar', 'The tavern keeper begs you to clear giant rats from the cellar.',                1,  40,  20, null,                    'town',    'easy'],
  ['Bandit Bounty',      'A reward is posted for breaking up the bandit gang on the meadows.',             2, 120,  75, 'Iron Sword',            'meadows', 'medium'],
  ['The Restless Dead',  'Skeletons walk the old ruins by night. Lay them to rest.',                       3, 180, 110, 'Scroll of Identify',    'ruins',   'medium'],
  ['Spider’s Nest', 'Travelers vanish in the swamp. Destroy the giant spiders’ nest.',           3, 200, 130, 'Antidote',              'swamp',   'medium'],
  ['Ogre Hunt',          'A hungry ogre terrorizes the outlying farms. End the threat.',                   4, 320, 220, 'Greater Health Potion', 'meadows', 'hard'],
  ['Tomb of the Wight',  'A wight commands the undead from a sealed tomb. Destroy it.',                    5, 450, 300, 'Enchanted Blade',       'ruins',   'hard'],
  ['Slay the Dragon',    'A young dragon hoards treasure in its lair. Few return — will you?',        9, 900, 700, 'Dragon Slayer',         'dragon_lair', 'legendary'],
];

async function getItemIdByName(name) {
  if (!name) return null;
  const [rows] = await pool.execute('SELECT item_id FROM dnd_items WHERE item_name = ?', [name]);
  return rows.length ? rows[0].item_id : null;
}

async function seedQuests() {
  let added = 0;
  for (const [quest_name, description, required_level, reward_exp, reward_gold, reward_item_name, zone, difficulty] of QUESTS) {
    const [rows] = await pool.execute('SELECT quest_id FROM dnd_quests WHERE quest_name = ?', [quest_name]);
    if (rows.length) continue;
    const reward_item_id = await getItemIdByName(reward_item_name);
    await pool.execute(
      `INSERT INTO dnd_quests
         (quest_name, description, required_level, reward_exp, reward_gold, reward_item_id, zone, difficulty)
       VALUES (?,?,?,?,?,?,?,?)`,
      [quest_name, description, required_level, reward_exp, reward_gold, reward_item_id, zone, difficulty]
    );
    added++;
  }
  log(`quests: added ${added}`);
}

// ---------------------------------------------------------------------------
// 6. DUNGEONS + ROOMS  — the live table already has 5 dungeons; only dungeon 1
//    has its rooms. Backfill rooms for the others (guard by dungeon_id+room_number).
//    Also ensure a small homebrew dungeon exists. room_type ENUM:
//    entrance/combat/puzzle/trap/treasure/rest/boss/exit.
// ---------------------------------------------------------------------------
// Room sets keyed by dungeon NAME so we attach to whatever dungeon_id exists.
// [room_number, room_name, room_type, description, enemies(arr), loot_table(obj|null)]
const DUNGEON_ROOMS = {
  'Bandit Hideout': [
    [1, 'Hideout Mouth',     'entrance', 'A camouflaged opening leads into the bandit warren.',        [],                              null],
    [2, 'Lookout Post',      'combat',   'A pair of bandits keep watch here.',                          ['Bandit','Bandit'],             {gold:[10,30]}],
    [3, 'Snare Hall',        'trap',     'Tripwires and pit traps line this narrow hall.',              [],                              null],
    [4, 'Common Room',       'combat',   'The gang gathers around a fire — and turns to fight.',   ['Bandit','Bandit','Wolf'],      {items:['Iron Sword']}],
    [5, 'Treasure Stash',    'treasure', 'Stolen goods are piled in crates.',                           [],                              {gold:[40,80],items:['Health Potion']}],
    [6, 'Bandit Captain',    'boss',     'The scarred captain bars the way out.',                       ['Bandit','Bandit','Ogre'],      {gold:[80,160],items:['Enchanted Blade']}],
  ],
  'Undead Crypt': [
    [1, 'Crypt Stairs',      'entrance', 'Cold stone steps descend into darkness.',                     [],                              null],
    [2, 'Bone Pile',         'combat',   'Skeletons rise from a heap of bones.',                        ['Skeleton','Skeleton'],         {gold:[15,35]}],
    [3, 'Sealed Door',       'puzzle',   'A riddle-locked door guards the inner crypt.',                [],                              null],
    [4, 'Rotting Gallery',   'combat',   'Zombies shamble between crumbling sarcophagi.',               ['Zombie','Zombie','Ghoul'],     {items:['Antidote']}],
    [5, 'Reliquary',         'treasure', 'Funerary treasures lie undisturbed — for now.',          [],                              {gold:[50,100],items:['Scroll of Identify']}],
    [6, 'Quiet Chamber',     'rest',     'A still alcove where the dead do not tread. Catch your breath.',[],                            null],
    [7, 'The Wight’s Throne','boss', 'The wight commands its legion from a bone throne.',           ['Wight','Skeleton','Skeleton'], {gold:[120,240],items:['Enchanted Blade']}],
  ],
  "Dragon's Lair": [
    [1, 'Scorched Approach',  'entrance', 'The ground is blackened by old dragonfire.',                 [],                                 null],
    [2, 'Bone Field',         'combat',   'Kobold servants swarm the intruders.',                        ['Kobold','Kobold','Kobold'],      {gold:[20,40]}],
    [3, 'Lava Bridge',        'trap',     'A crumbling span crosses a river of lava.',                   [],                                 null],
    [4, 'Guardian Roost',     'combat',   'A wyvern nests above the passage.',                           ['Wyvern'],                         {items:['Dragon Scale']}],
    [5, 'Hoard Antechamber',  'treasure', 'Glittering coins spill across the floor.',                    [],                                 {gold:[150,300]}],
    [6, 'Smoldering Hall',    'rest',     'A warm but safe alcove away from the dragon’s gaze.',    [],                                 null],
    [7, 'Treasure Vault',     'treasure', 'The deepest cache of the dragon’s wealth.',              [],                                 {gold:[200,400],items:['Mithral Ore']}],
    [8, 'The Dragon’s Den','boss',   'The young dragon uncoils to defend its hoard.',               ['Young Dragon'],                   {gold:[400,800],items:['Dragon Scale Armor']}],
  ],
  'Demon Portal': [
    [1, 'Riftgate',          'entrance', 'A torn seam in reality crackles with abyssal energy.',        [],                                 null],
    [2, 'Corrupted Hall',    'combat',   'Twisted beasts pour from the rift.',                          ['Owlbear','Harpy'],               {gold:[30,60]}],
    [3, 'Sigil Lock',        'puzzle',   'Demonic glyphs must be aligned to proceed.',                  [],                                 null],
    [4, 'Pit of Bones',      'trap',     'The floor gives way over a spiked chasm.',                    [],                                 null],
    [5, 'Hellforge',         'combat',   'Trolls labor at infernal anvils.',                            ['Troll','Troll'],                 {items:['Mithral Ore']}],
    [6, 'Warded Sanctum',    'rest',     'A circle of protective runes offers brief respite.',          [],                                 null],
    [7, 'Abyssal Cache',     'treasure', 'Forbidden riches glow with malevolent light.',                [],                                 {gold:[200,400],items:['Flame Tongue']}],
    [8, 'Bridge of Souls',   'combat',   'Wraith-like manticores bar the final approach.',              ['Manticore','Manticore'],         {gold:[80,160]}],
    [9, 'Inner Sanctum',     'puzzle',   'The portal’s anchor must be unbound.',                   [],                                 null],
    [10,'The Portal Heart',  'boss',     'A monstrous guardian defends the heart of the rift.',         ['Young Dragon','Troll'],          {gold:[500,1000],items:['Dragon Scale Armor']}],
  ],
};

// One small homebrew dungeon, created if absent.
const HOMEBREW_DUNGEON = {
  name: 'The Sunken Grotto',
  description: 'A flooded sea-cave rumored to hide a smuggler’s lost fortune.',
  min_level: 1, max_level: 4, total_rooms: 4, difficulty: 'easy', theme: 'water cave',
  reward_exp_base: 120, reward_gold_base: 60,
  rooms: [
    [1, 'Tidepool Entrance', 'entrance', 'Waves lap at the mouth of the grotto.',          [],                       null],
    [2, 'Crab Shallows',     'combat',   'Giant rats and spiders scurry across wet stone.', ['Giant Rat','Giant Spider'], {gold:[10,25]}],
    [3, 'Smuggler’s Cache','treasure','A waterlogged chest sits on a ledge.',          [],                       {gold:[30,70],items:['Health Potion']}],
    [4, 'Drowned Guardian',  'boss',     'An ogre has made the deepest cavern its home.',  ['Ogre'],                 {gold:[60,120],items:['Studded Leather']}],
  ],
};

async function seedDungeonsAndRooms() {
  // Backfill rooms for existing named dungeons.
  let roomsAdded = 0;
  for (const [dungeonName, rooms] of Object.entries(DUNGEON_ROOMS)) {
    const [dRows] = await pool.execute('SELECT dungeon_id FROM dnd_dungeons WHERE dungeon_name = ?', [dungeonName]);
    if (!dRows.length) continue; // dungeon doesn't exist; skip (we don't invent it)
    const dungeonId = dRows[0].dungeon_id;
    for (const [room_number, room_name, room_type, description, enemies, loot_table] of rooms) {
      const [exists] = await pool.execute(
        'SELECT room_id FROM dnd_dungeon_rooms WHERE dungeon_id = ? AND room_number = ?',
        [dungeonId, room_number]
      );
      if (exists.length) continue;
      await pool.execute(
        `INSERT INTO dnd_dungeon_rooms
           (dungeon_id, room_number, room_name, room_type, description, enemies, loot_table)
         VALUES (?,?,?,?,?,?,?)`,
        [dungeonId, room_number, room_name, room_type, description,
         JSON.stringify(enemies), loot_table ? JSON.stringify(loot_table) : null]
      );
      roomsAdded++;
    }
  }

  // Ensure the homebrew dungeon exists.
  const hb = HOMEBREW_DUNGEON;
  let [hbRows] = await pool.execute('SELECT dungeon_id FROM dnd_dungeons WHERE dungeon_name = ?', [hb.name]);
  if (!hbRows.length) {
    const [res] = await pool.execute(
      `INSERT INTO dnd_dungeons
         (dungeon_name, description, min_level, max_level, total_rooms, difficulty, theme, reward_exp_base, reward_gold_base, is_active)
       VALUES (?,?,?,?,?,?,?,?,?,1)`,
      [hb.name, hb.description, hb.min_level, hb.max_level, hb.total_rooms, hb.difficulty, hb.theme, hb.reward_exp_base, hb.reward_gold_base]
    );
    const hbId = res.insertId;
    for (const [room_number, room_name, room_type, description, enemies, loot_table] of hb.rooms) {
      await pool.execute(
        `INSERT INTO dnd_dungeon_rooms
           (dungeon_id, room_number, room_name, room_type, description, enemies, loot_table)
         VALUES (?,?,?,?,?,?,?)`,
        [hbId, room_number, room_name, room_type, description,
         JSON.stringify(enemies), loot_table ? JSON.stringify(loot_table) : null]
      );
      roomsAdded++;
    }
  }
  log(`dungeon rooms: added ${roomsAdded} (homebrew dungeon ensured)`);
}

// ---------------------------------------------------------------------------
// 7. CAMPAIGN MODULES  — PRIMARY KEY module_id. Upsert.
//    cols: module_id, module_name, description, min_level, max_level,
//          estimated_sessions, setting, content(JSON longtext), is_active
// ---------------------------------------------------------------------------
const MODULES = [
  ['lost_mine',     'Lost Mine of Phandelver',
   'The classic starter adventure: rescue a captured friend, clear out goblin raiders, and uncover the lost Wave Echo Cave beneath the town of Phandalin.',
   1, 5, 8, 'Forgotten Realms',
   {hooks:['Escort wagon ambushed','Find Gundren Rockseeker'],locations:['Cragmaw Hideout','Phandalin','Wave Echo Cave'],boss:'The Black Spider'}],
  ['dragon_heist',  'Waterdeep: Dragon Heist',
   'An urban caper through the City of Splendors as rival factions race to recover a fabulous hidden fortune of gold.',
   1, 5, 10, 'Forgotten Realms',
   {hooks:['A brawl at the Yawning Portal','A missing nobleman'],locations:['The Yawning Portal','Trollskull Manor','Waterdeep sewers'],theme:'intrigue'}],
  ['curse_strahd',  'Curse of Strahd',
   'Trapped within the mist-shrouded realm of Barovia, the heroes must confront the vampire lord Strahd von Zarovich in his cursed domain.',
   3, 10, 12, 'Ravenloft',
   {hooks:['Mysterious letter from Kolyan Indirovich','Drawn through the mists'],locations:['Village of Barovia','Castle Ravenloft','Amber Temple'],boss:'Strahd von Zarovich'}],
  ['emberfall_keep','Embers of Emberfall Keep (Homebrew)',
   'A homebrew starter: a frontier keep besieged by a cult summoning fire elementals. Defend the keep, root out the cult, and seal the burning rift below.',
   1, 4, 6, 'Homebrew',
   {hooks:['Smoke on the horizon','A refugee begs for aid'],locations:['Emberfall Keep','The Cult Warren','The Burning Rift'],boss:'Pyromancer Vael'}],
];

async function seedModules() {
  let n = 0;
  for (const [module_id, module_name, description, min_level, max_level, estimated_sessions, setting, content] of MODULES) {
    await pool.execute(
      `INSERT INTO dnd_campaign_modules
         (module_id, module_name, description, min_level, max_level, estimated_sessions, setting, content, is_active)
       VALUES (?,?,?,?,?,?,?,?,1)
       ON DUPLICATE KEY UPDATE module_name=VALUES(module_name), description=VALUES(description),
         min_level=VALUES(min_level), max_level=VALUES(max_level),
         estimated_sessions=VALUES(estimated_sessions), setting=VALUES(setting), content=VALUES(content)`,
      [module_id, module_name, description, min_level, max_level, estimated_sessions, setting, JSON.stringify(content)]
    );
    n++;
  }
  log(`campaign modules: upserted ${n}`);
}

// ---------------------------------------------------------------------------
// 8. ACHIEVEMENTS  — UNIQUE(achievement_key). cols: achievement_key, name,
//    description, category ENUM, tier ENUM, requirement_type, requirement_value,
//    reward_gold, reward_exp, reward_title, icon_emoji, is_hidden, is_active.
//    Live table already has 17; this upserts a canonical set (safe).
// ---------------------------------------------------------------------------
const ACHIEVEMENTS = [
  // [key, name, description, category, tier, req_type, req_value, gold, exp, title, emoji]
  ['first_blood',    'First Blood',        'Win your first battle.',                       'combat',     'bronze',   'enemies_defeated', 1,    20,  50, null,            '⚔️'],
  ['monster_hunter', 'Monster Hunter',     'Defeat 50 enemies.',                           'combat',     'silver',   'enemies_defeated', 50,  150, 400, 'the Hunter',    '🏹'],
  ['slayer',         'Slayer',             'Defeat 250 enemies.',                          'combat',     'gold',     'enemies_defeated', 250, 500,1500, 'the Slayer',    '🗡️'],
  ['dragonslayer',   'Dragonslayer',       'Slay a dragon.',                               'combat',     'legendary','dragons_slain',    1,  1000,2000, 'Dragonslayer',  '🐉'],
  ['ding_5',         'Seasoned Adventurer','Reach character level 5.',                     'general',    'bronze',   'level',            5,    50, 100, null,            '⭐'],
  ['ding_10',        'Veteran',            'Reach character level 10.',                    'general',    'silver',   'level',            10,  200, 500, 'the Veteran',   '🌟'],
  ['ding_20',        'Legend',             'Reach the maximum character level of 20.',     'general',    'legendary','level',            20, 2000,5000, 'the Legend',    '👑'],
  ['rich_1k',        'Coin Collector',     'Accumulate 1,000 gold.',                       'collection', 'bronze',   'gold_earned',      1000, 0, 100, null,            '💰'],
  ['rich_10k',       'Wealthy',            'Accumulate 10,000 gold.',                      'collection', 'gold',     'gold_earned',      10000,0,1000, 'the Wealthy',   '💎'],
  ['collector',      'Hoarder',            'Own 25 distinct items.',                       'collection', 'silver',   'unique_items',     25,  100, 300, null,            '🎒'],
  ['questgiver',     'Errand Runner',      'Complete 10 quests.',                          'exploration','silver',   'quests_completed', 10,  150, 400, null,            '📜'],
  ['cartographer',   'Cartographer',       'Visit every zone in the realm.',               'exploration','gold',     'zones_visited',    10,  300, 800, 'the Explorer',  '🗺️'],
  ['delver',         'Dungeon Delver',     'Clear 5 dungeons.',                            'dungeon',    'silver',   'dungeons_cleared', 5,   250, 600, null,            '🏰'],
  ['spellslinger',   'Spellslinger',       'Cast 100 spells.',                             'class',      'silver',   'spells_cast',      100, 150, 400, null,            '✨'],
  ['duelist',        'Duelist',            'Win 10 PvP matches.',                          'pvp',        'gold',     'pvp_wins',         10,  300, 700, 'the Duelist',   '🏆'],
  ['party_animal',   'Party Animal',       'Join a party.',                                'social',     'bronze',   'parties_joined',   1,    25,  50, null,            '🤝'],
];

async function seedAchievements() {
  let n = 0;
  for (const [achievement_key, name, description, category, tier, requirement_type, requirement_value, reward_gold, reward_exp, reward_title, icon_emoji] of ACHIEVEMENTS) {
    await pool.execute(
      `INSERT INTO dnd_achievements
         (achievement_key, name, description, category, tier, requirement_type, requirement_value,
          reward_gold, reward_exp, reward_title, icon_emoji, is_hidden, is_active)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,0,1)
       ON DUPLICATE KEY UPDATE name=VALUES(name), description=VALUES(description),
         category=VALUES(category), tier=VALUES(tier), requirement_type=VALUES(requirement_type),
         requirement_value=VALUES(requirement_value), reward_gold=VALUES(reward_gold),
         reward_exp=VALUES(reward_exp), reward_title=VALUES(reward_title), icon_emoji=VALUES(icon_emoji)`,
      [achievement_key, name, description, category, tier, requirement_type, requirement_value,
       reward_gold, reward_exp, reward_title, icon_emoji]
    );
    n++;
  }
  log(`achievements: upserted ${n}`);
}

// ---------------------------------------------------------------------------
// 9. SHOPS  — cols: shop_name, zone, item_id, price, stock.
//    NOTE: the LIVE dnd_shops table has NO unique key on (zone,item_id) (only
//    PRIMARY shop_id), so we cannot rely on ON DUPLICATE KEY UPDATE — we
//    check-then-insert/update by (zone,item_id) to stay idempotent.
//    Stock a 'town' general store and a 'market' zone. -1 = unlimited stock.
//    Prices reference the real seeded item_ids (resolved by name).
// ---------------------------------------------------------------------------
// [zone, shop_name, [ [item_name, price, stock], ... ] ]
const SHOPS = [
  ['town', 'Phandalin General Store', [
    ['Dagger', 2, -1], ['Shortsword', 10, -1], ['Mace', 5, -1], ['Quarterstaff', 2, -1],
    ['Shortbow', 25, -1], ['Light Crossbow', 25, -1],
    ['Leather Armor', 50, -1], ['Studded Leather', 45, -1], ['Wooden Shield', 10, -1],
    ['Health Potion', 30, -1], ['Mana Potion', 40, -1], ['Antidote', 25, -1],
    ['Torch', 1, -1], ['Rope (50 ft.)', 1, -1], ["Thieves' Tools", 25, -1],
  ]],
  ['market', 'The Adventurers’ Bazaar', [
    ['Iron Sword', 100, -1], ['Steel Longsword', 300, 5], ['Battleaxe', 12, -1],
    ['Greatsword', 60, 3], ['Longbow', 55, 3],
    ['Chainmail', 200, -1], ['Half Plate', 750, 2], ['Tower Shield', 130, 3],
    ['Greater Health Potion', 110, 10], ['Greater Mana Potion', 130, 10],
    ['Superior Healing Potion', 480, 3], ['Potion of Fire Resistance', 320, 4],
    ['Scroll of Identify', 110, 5], ['Scroll of Fireball', 640, 2], ['Ring of Protection', 320, 1],
  ]],
];

async function seedShops() {
  let n = 0;
  for (const [zone, shop_name, items] of SHOPS) {
    for (const [item_name, price, stock] of items) {
      const item_id = await getItemIdByName(item_name);
      if (!item_id) { log(`  WARN: shop item "${item_name}" not found, skipping`); continue; }
      const [existing] = await pool.execute(
        'SELECT shop_id FROM dnd_shops WHERE zone = ? AND item_id = ?',
        [zone, item_id]
      );
      if (existing.length) {
        await pool.execute(
          'UPDATE dnd_shops SET shop_name = ?, price = ?, stock = ? WHERE shop_id = ?',
          [shop_name, price, stock, existing[0].shop_id]
        );
      } else {
        await pool.execute(
          'INSERT INTO dnd_shops (shop_name, zone, item_id, price, stock) VALUES (?,?,?,?,?)',
          [shop_name, zone, item_id, price, stock]
        );
      }
      n++;
    }
  }
  log(`shops: upserted ${n} stock rows`);
}

// ---------------------------------------------------------------------------
// Run + verify
// ---------------------------------------------------------------------------
async function main() {
  log('starting D&D content seed...');
  await seedItems();
  await seedSpells();
  await seedConditions();
  await seedEnemies();
  await seedQuests();        // after items (reward_item_id lookups)
  await seedDungeonsAndRooms();
  await seedModules();
  await seedAchievements();
  await seedShops();         // after items (item_id lookups)

  log('--- final row counts ---');
  const tables = [
    'dnd_items','dnd_spells','dnd_conditions','dnd_enemies','dnd_quests',
    'dnd_dungeons','dnd_dungeon_rooms','dnd_campaign_modules','dnd_achievements','dnd_shops',
  ];
  for (const t of tables) {
    const [rows] = await pool.execute(`SELECT COUNT(*) AS c FROM ${t}`);
    log(`  ${t.padEnd(22)} = ${rows[0].c}`);
  }
  log('done.');
}

main()
  .then(() => pool.end())
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[seed-dnd] FAILED:', err);
    pool.end().finally(() => process.exit(1));
  });
