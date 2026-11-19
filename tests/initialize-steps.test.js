import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import pool from '../utils/db.js';
import initializeRoutes from '../dashboard/routes/api/features/initialize.js';

// The setup wizard's "done" flags must follow what the bot reads: logging switched off is not
// done, prefixes are on by default for a server that never saved them, and raid protection links
// to the page that sets the table its flag is read from.
const GUILD = '999000000000000401';

async function status() {
    const app = express();
    app.use(express.json());
    app.use('/api/guilds/:guildId/initialize', initializeRoutes);
    const server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    try {
        const res = await fetch(`http://127.0.0.1:${server.address().port}/api/guilds/${GUILD}/initialize/status`);
        assert.equal(res.status, 200);
        return await res.json();
    } finally { server.close(); }
}

test('setup steps read the live settings', async () => {
    try {
        await pool.execute('DELETE FROM prefix_command_config WHERE guild_id = ?', [GUILD]);
        await pool.execute('DELETE FROM logging_config WHERE guild_id = ?', [GUILD]);
        await pool.execute('INSERT INTO logging_config (guild_id, log_channel_id, enabled) VALUES (?, ?, 0)', [GUILD, '999000000000000402']);

        let data = await status();
        const step = (id) => data.steps.find((s) => s.id === id);
        assert.equal(step('logging').done, false, 'logging switched off is not done');
        assert.equal(step('prefixes').done, true, 'prefixes are on with no saved row');
        assert.equal(step('security').section, 'advanced-protection');

        await pool.execute('INSERT INTO prefix_command_config (guild_id, enabled) VALUES (?, 0)', [GUILD]);
        data = await status();
        assert.equal(data.steps.find((s) => s.id === 'prefixes').done, false, 'prefixes switched off are not done');
    } finally {
        await pool.execute('DELETE FROM prefix_command_config WHERE guild_id = ?', [GUILD]);
        await pool.execute('DELETE FROM logging_config WHERE guild_id = ?', [GUILD]);
    }
});
