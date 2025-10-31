import { Client } from 'discord.js';
import { RowDataPacket } from 'mysql2';
import db from '../utils/db';
import logger from '../utils/logger';
import { syncTwitchTeam } from './team-sync';

interface TwitchTeam extends RowDataPacket {
    id: number;
}

async function checkTeams(client: Client): Promise<void> {
    logger.info('[Team Sync] ---> Starting hourly team sync @ ' + new Date().toLocaleTimeString(), { category: 'team-sync' });
    try {
        const [teamSubscriptions] = await db.execute<TwitchTeam[]>('SELECT id FROM twitch_teams');
        if (teamSubscriptions && teamSubscriptions.length > 0) {
            const syncPromises = teamSubscriptions.map(team => syncTwitchTeam(team.id, db));
            await Promise.allSettled(syncPromises);
        }
    } catch (error) {
        logger.error('[Team Sync] CRITICAL ERROR in checkTeams:', { _error });
    } finally {
        logger.info('[Team Sync] ---> Finished hourly team sync.', { category: 'team-sync' });
    }
}

export { checkTeams };
