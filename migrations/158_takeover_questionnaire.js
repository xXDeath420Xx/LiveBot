// The server owner's own answers to the takeover questions.
//
// The plan page is shown to someone who has no dashboard account and never will — it is her server,
// not her admin panel. So the page is reached by a CAPABILITY URL: a long random token that is the
// only thing standing between the public and this form. Anyone with the link can read and answer;
// nobody without it can find it. That is the right trade for a private questionnaire sent to one
// person, and it is why `token` is random and revocable rather than the guild id.
//
// Answers are stored one row per question so a half-finished form is a first-class state — she can
// answer three things, close the tab, and come back. Nothing here is ever applied automatically;
// these are her intentions, and a human still runs each step.

export async function up(db) {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS takeover_questionnaire_links (
      token       CHAR(43)    NOT NULL,   -- 32 random bytes, base64url
      guild_id    VARCHAR(20) NOT NULL,
      label       VARCHAR(64)     NULL,   -- who we sent it to, for our own memory
      revoked     TINYINT(1)  NOT NULL DEFAULT 0,
      created_at  TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (token),
      KEY idx_guild (guild_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS takeover_questionnaire (
      id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
      guild_id    VARCHAR(20)  NOT NULL,
      item_key    VARCHAR(64)  NOT NULL,  -- must match a key the server knows; never free-form
      value       VARCHAR(64)      NULL,  -- the chosen option, or 'yes'/'no' for a checkbox
      note        TEXT             NULL,  -- her own words, when a question invites them
      updated_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      -- One answer per question per guild. Re-answering updates in place, so autosave is safe to
      -- fire on every keystroke without stacking rows.
      UNIQUE KEY uq_guild_item (guild_id, item_key),
      KEY idx_guild (guild_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

export async function down(db) {
  await db.execute('DROP TABLE IF EXISTS takeover_questionnaire');
  await db.execute('DROP TABLE IF EXISTS takeover_questionnaire_links');
}
