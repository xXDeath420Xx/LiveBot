import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import pool from '../utils/db.js';
import customBotRoutes from '../dashboard/routes/api/features/custom-bot.js';

// "Replace with a different bot" on the Bot appearance page: a token that fails validation used to
// be found only after the server's current custom bot had been unassigned, leaving the server on
// the shared bot. The current bot must stay assigned when the new token is refused.
const GUILD = '999000000000000101';
const OLD_BOT = '999000000000000102';

async function cleanup() {
    await pool.execute('DELETE FROM guild_bot_mapping WHERE guild_id = ?', [GUILD]);
    await pool.execute('DELETE FROM custom_bots WHERE bot_id = ?', [OLD_BOT]);
}

test('a refused token leaves the current custom bot assigned', async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.user = { id: '999000000000000103', username: 'test' }; next(); });
    app.use('/api/guilds/:guildId/custom-bot', customBotRoutes);
    const server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    try {
        await cleanup();
        await pool.execute(
            `INSERT INTO custom_bots (bot_id, bot_name, bot_token, client_id, owner_user_id, enabled, approved, self_service)
             VALUES (?, 'accd1 test bot', '{"test":true}', ?, '999000000000000103', 1, 1, 1)`,
            [OLD_BOT, OLD_BOT]
        );
        await pool.execute('INSERT INTO guild_bot_mapping (guild_id, bot_id, assigned_by) VALUES (?, ?, ?)', [GUILD, OLD_BOT, '999000000000000103']);

        const res = await fetch(`http://127.0.0.1:${server.address().port}/api/guilds/${GUILD}/custom-bot`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ client_id: '999000000000000104', bot_token: 'not.a.real-token' }),
        });
        assert.equal(res.status, 400);
        const body = await res.json();
        assert.equal(body.error, 'Bot validation failed');

        const [map] = await pool.execute('SELECT bot_id FROM guild_bot_mapping WHERE guild_id = ?', [GUILD]);
        assert.deepEqual(map.map((r) => String(r.bot_id)), [OLD_BOT]);
        const [bots] = await pool.execute('SELECT bot_id FROM custom_bots WHERE bot_id = ?', [OLD_BOT]);
        assert.equal(bots.length, 1);
    } finally {
        await cleanup();
        server.close();
    }
});
