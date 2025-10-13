const db = require('../utils/db');
const logger = require('../utils/logger');
const { syncTwitchTeam } = require('./team-sync');

async function checkTeams(client) {
    logger.info('[Team Sync] ---> Starting hourly team sync @ ' + new Date().toLocaleTimeString(), { category: 'team-sync' });
    try {
        const [teamSubscriptions] = await db.execute('SELECT id FROM twitch_teams');
        if (teamSubscriptions && teamSubscriptions.length > 0) {
            const syncPromises = teamSubscriptions.map(team => syncTwitchTeam(team.id, db));
            await Promise.allSettled(syncPromises);
        }
    } catch (error) {
        logger.error('[Team Sync] CRITICAL ERROR in checkTeams:', { error });
    } finally {
        logger.info('[Team Sync] ---> Finished hourly team sync.', { category: 'team-sync' });
    }
}

module.exports = { checkTeams };