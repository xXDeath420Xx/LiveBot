/**
 * Set up reaction role for the game night sign-up message
 */
import pool from '../utils/db.js';

const GUILD_ID = '1307517872301670480';
const CHANNEL_ID = '1311419150161412116';
const MESSAGE_ID = '1462826747509866577';
const ROLE_ID = '1311419737149931551';

async function main() {
    try {
        console.log('Setting up reaction role...');

        // Create panel with correct schema
        await pool.execute(`
            INSERT INTO reaction_role_panels
            (guild_id, channel_id, message_id, panel_name, description, embed_color, panel_mode, interaction_type)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE message_id = VALUES(message_id)
        `, [
            GUILD_ID,
            CHANNEL_ID,
            MESSAGE_ID,
            'Game Night Sign-Up',
            'React to sign up for game night',
            '#57F287',
            'normal',
            'reaction'
        ]);

        // Get the panel ID
        const [[panel]] = await pool.execute(
            'SELECT id FROM reaction_role_panels WHERE message_id = ?',
            [MESSAGE_ID]
        );

        console.log('Panel ID:', panel.id);

        // Create the role mapping with correct schema
        await pool.execute(`
            INSERT INTO reaction_role_mappings
            (panel_id, emoji_id, role_id)
            VALUES (?, ?, ?)
            ON DUPLICATE KEY UPDATE role_id = VALUES(role_id)
        `, [
            panel.id,
            '👍',
            ROLE_ID
        ]);

        console.log('✅ Reaction role configured: 👍 → Role', ROLE_ID);

    } catch (error) {
        console.error('Error:', error.message);
    } finally {
        await pool.end();
        process.exit(0);
    }
}

main();
