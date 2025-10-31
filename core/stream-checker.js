"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkTeams = checkTeams;
const db_1 = __importDefault(require("../utils/db"));
const logger_1 = __importDefault(require("../utils/logger"));
const team_sync_1 = require("./team-sync");
async function checkTeams(client) {
    logger_1.default.info('[Team Sync] ---> Starting hourly team sync @ ' + new Date().toLocaleTimeString(), { category: 'team-sync' });
    try {
        const [teamSubscriptions] = await db_1.default.execute('SELECT id FROM twitch_teams');
        if (teamSubscriptions && teamSubscriptions.length > 0) {
            const syncPromises = teamSubscriptions.map(team => (0, team_sync_1.syncTwitchTeam)(team.id, db_1.default));
            await Promise.allSettled(syncPromises);
        }
    }
    catch (error) {
        logger_1.default.error('[Team Sync] CRITICAL ERROR in checkTeams:', { error });
    }
    finally {
        logger_1.default.info('[Team Sync] ---> Finished hourly team sync.', { category: 'team-sync' });
    }
}
