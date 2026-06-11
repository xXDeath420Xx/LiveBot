/**
 * Migration 126: Live turn-by-turn PvP combat state.
 *
 * Layers persisted live-combat state onto the existing `dnd_pvp_matches` table
 * (created by 125_dnd_rpg.js — left untouched) so two players can act across
 * SEPARATE interactions (button clicks / slash actions) with the match state
 * surviving in the DB between turns.
 *
 * Added columns:
 *   challenger_hp INT          -- current HP of challenger (side 'a')
 *   defender_hp INT            -- current HP of defender   (side 'b')
 *   challenger_max_hp INT      -- snapshot of challenger max HP at match start
 *   defender_max_hp INT        -- snapshot of defender max HP at match start
 *   active_turn VARCHAR(16)    -- whose turn: character_id of the side to act
 *   round_number INT DEFAULT 1 -- current round (bumps when both sides have acted)
 *   combat_log TEXT            -- newline-joined turn log
 *   turn_started_at DATETIME   -- when the active side's turn began (timeout clock)
 *   board_channel_id VARCHAR(20) -- channel of the live combat board message
 *   board_message_id VARCHAR(20) -- id of the live combat board message (edited in place)
 *   defending VARCHAR(16) NULL -- character_id of the side that used Defend this turn
 *
 * Idempotent: each ADD COLUMN is guarded by an information_schema existence
 * check, so re-running against the live table (which already exists) is safe.
 */

const TABLE = 'dnd_pvp_matches';

// Column -> DDL fragment (added AFTER an existing/earlier column to keep order tidy).
const COLUMNS = [
  ['challenger_hp',     'ADD COLUMN `challenger_hp` INT NULL AFTER `winner_id`'],
  ['defender_hp',       'ADD COLUMN `defender_hp` INT NULL AFTER `challenger_hp`'],
  ['challenger_max_hp', 'ADD COLUMN `challenger_max_hp` INT NULL AFTER `defender_hp`'],
  ['defender_max_hp',   'ADD COLUMN `defender_max_hp` INT NULL AFTER `challenger_max_hp`'],
  ['active_turn',       'ADD COLUMN `active_turn` VARCHAR(16) NULL AFTER `defender_max_hp`'],
  ['round_number',      'ADD COLUMN `round_number` INT DEFAULT 1 AFTER `active_turn`'],
  ['combat_log',        'ADD COLUMN `combat_log` TEXT NULL AFTER `round_number`'],
  ['turn_started_at',   'ADD COLUMN `turn_started_at` DATETIME NULL AFTER `combat_log`'],
  ['board_channel_id',  'ADD COLUMN `board_channel_id` VARCHAR(20) NULL AFTER `turn_started_at`'],
  ['board_message_id',  'ADD COLUMN `board_message_id` VARCHAR(20) NULL AFTER `board_channel_id`'],
  ['defending',         'ADD COLUMN `defending` VARCHAR(16) NULL AFTER `board_message_id`'],
];

async function columnExists(db, column) {
  const [rows] = await db.execute(
    `SELECT COUNT(*) AS n FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
    [TABLE, column]
  );
  return rows[0].n > 0;
}

export async function up(db) {
  for (const [column, ddl] of COLUMNS) {
    if (await columnExists(db, column)) continue;
    try {
      await db.execute(`ALTER TABLE \`${TABLE}\` ${ddl}`);
    } catch (err) {
      // Duplicate-column is benign (race / partial prior run); rethrow anything else.
      if (err && err.code === 'ER_DUP_FIELDNAME') continue;
      throw err;
    }
  }
}

export async function down(db) {
  // Drop in reverse so AFTER-ordering never references a missing column.
  for (const [column] of [...COLUMNS].reverse()) {
    if (!(await columnExists(db, column))) continue;
    try {
      await db.execute(`ALTER TABLE \`${TABLE}\` DROP COLUMN \`${column}\``);
    } catch (err) {
      if (err && err.code === 'ER_CANT_DROP_FIELD_OR_KEY') continue;
      throw err;
    }
  }
}

export default { up, down };
