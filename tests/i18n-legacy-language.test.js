import test from 'node:test';
import assert from 'node:assert/strict';
import pool from '../utils/db.js';
import { legacyGuildLanguage, resolveLocale } from '../utils/i18n.js';

// guild_settings.language defaults to 'en', so every server with a guild_settings row answered in
// English even with the Language page set to "Follow each member's Discord language".
const GUILD = '999000000000000201';

test('the legacy column default says nothing', () => {
    assert.equal(legacyGuildLanguage('en'), null);
    assert.equal(legacyGuildLanguage(null), null);
    assert.equal(legacyGuildLanguage(''), null);
    assert.equal(legacyGuildLanguage('de'), 'de');
});

test('a server with only the legacy default follows the member\'s Discord language', async () => {
    try {
        await pool.execute('DELETE FROM guild_language_prefs WHERE guild_id = ?', [GUILD]);
        await pool.execute(
            `INSERT INTO guild_settings (guild_id, language) VALUES (?, 'en')
             ON DUPLICATE KEY UPDATE language = 'en'`,
            [GUILD]
        );
        assert.equal(await resolveLocale({ guildId: GUILD, discordLocale: 'de' }), 'de');
    } finally {
        await pool.execute('DELETE FROM guild_settings WHERE guild_id = ?', [GUILD]);
    }
});
