// A guild's RECOVERED profile — the things we can only learn by reading its history.
//
// Which streamer its incumbent announces. Which channel holds its role panels. Which `!commands`
// its Nightbot answers. None of it is guessable and all of it is meaningless in another server.
//
// It used to be hardcoded in core/takeover-manager.js, which meant (a) taking over a second server
// was a code change, and (b) one guild's data could be applied to another — plan() offered Kabster's
// streamer to every guild with Pingcord, and apply() would have written it there.
//
// Now it is derived per guild and stored here. Two states, and the gap between them is the point:
//
//   proposed  — a machine read the history and guessed. Some fields it is sure about (a Twitch
//               handle in an announcement is unambiguous); some it is NOT (which Discord role a
//               Carl-bot panel's 🧡 button grants is nowhere in the message — it has to be inferred
//               from the role's name, and it can be wrong).
//   approved  — a human looked at it. ONLY an approved profile is allowed to drive apply().
//
// That gate is the whole design. Derivation is a research assistant, not an oracle: the confidence
// score travels with every field so a human reviews the guesses rather than the certainties.

export async function up(db) {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS takeover_profiles (
      guild_id     VARCHAR(20)  NOT NULL,
      data         JSON         NOT NULL,   -- the derived profile, with per-field confidence + evidence
      status       ENUM('proposed','approved') NOT NULL DEFAULT 'proposed',
      derived_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
      approved_by  VARCHAR(20)      NULL,
      approved_at  TIMESTAMP        NULL,
      PRIMARY KEY (guild_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

export async function down(db) {
  await db.execute('DROP TABLE IF EXISTS takeover_profiles');
}
