import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import pool from '../utils/db.js';
import prefixRoutes from '../dashboard/routes/api/features/prefix-commands.js';

// Saving "Prefixes and access" on the Prefixes and aliases page used to write every column of
// prefix_command_config, resetting the clean-up settings saved on the General settings page.
const GUILD = '999000000000000301';

async function withApp(fn) {
    const app = express();
    app.use(express.json());
    app.use('/api/guilds/:guildId/prefix-commands', prefixRoutes);
    const server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    try { return await fn(`http://127.0.0.1:${server.address().port}/api/guilds/${GUILD}/prefix-commands`); }
    finally { server.close(); }
}

test('saving prefixes keeps the clean-up settings', async () => {
    try {
        await pool.execute('DELETE FROM prefix_command_config WHERE guild_id = ?', [GUILD]);
        await pool.execute(
            `INSERT INTO prefix_command_config (guild_id, prefix, enabled, delete_trigger, cleanup_delay, private_categories)
             VALUES (?, '!', 1, 1, 30, '["moderation"]')`,
            [GUILD]
        );
        await withApp(async (base) => {
            const res = await fetch(`${base}/config`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prefix: '?', prefixes: ['?', '!'], allow_mention: false, universal_commands: true, enabled: 1 }),
            });
            assert.equal(res.status, 200);
        });
        const [[row]] = await pool.execute('SELECT * FROM prefix_command_config WHERE guild_id = ?', [GUILD]);
        assert.equal(row.prefix, '?');
        assert.deepEqual(JSON.parse(row.prefixes), ['?', '!']);
        assert.equal(row.allow_mention, 0);
        assert.equal(row.delete_trigger, 1);
        assert.equal(row.cleanup_delay, 30);
        assert.deepEqual(JSON.parse(row.private_categories), ['moderation']);
    } finally {
        await pool.execute('DELETE FROM prefix_command_config WHERE guild_id = ?', [GUILD]);
    }
});

test('a delay outside 0 to 300 seconds is refused', async () => {
    try {
        await withApp(async (base) => {
            const res = await fetch(`${base}/config`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ cleanup_delay: 900 }),
            });
            assert.equal(res.status, 400);
        });
    } finally {
        await pool.execute('DELETE FROM prefix_command_config WHERE guild_id = ?', [GUILD]);
    }
});
