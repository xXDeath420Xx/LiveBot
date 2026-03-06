import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { syncTwitchTeam } from './team-sync.js';

async function checkTeams(client) {
    logger.info('[Team Sync] ---> Starting hourly team sync @ ' + new Date().toLocaleTimeString(), { category: 'team-sync' });
    let connection;
    try {
        connection = await pool.getConnection();
        const [teamSubscriptions] = await connection.execute('SELECT id FROM twitch_teams');
        if (teamSubscriptions && teamSubscriptions.length > 0) {
            const syncPromises = teamSubscriptions.map(team => syncTwitchTeam(team.id, client));
            await Promise.allSettled(syncPromises);
        }
    } catch (error) {
        logger.error('[Team Sync] CRITICAL ERROR in checkTeams:', { error });
    } finally {
        if (connection) connection.release();
        logger.info('[Team Sync] ---> Finished hourly team sync.', { category: 'team-sync' });
    }
}

export { checkTeams };
