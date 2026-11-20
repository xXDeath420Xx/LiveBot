/*
 * Critters: the clean-room game module behind the /owo commands. One import for surfaces:
 *   import * as critters from '../core/critters/index.js';
 * See docs/critters-api.md for every function, its inputs, results and error codes.
 */
export * from './constants.js';
export { CritterError, isCritterError, setCrittersPool, setCrittersTablePrefix } from './db.js';

// Config and gates
export { getConfig, updateConfig, setEnabled, isEnabled, invalidateConfig, gate } from './config.js';
export {
    CONFIG_DEFAULTS, CONFIG_KEYS, FEATURE_KEYS, PATH_FEATURES, featureKeyForPath, mapLegacyFeatureKeys, checkGates, normalizeConfig,
} from './rules/config-rules.js';

// Economy
export { getWallet, grantCurrency, claimDaily, give, getGiveLimits, listTransactions, dropToFloor, pickupFromFloor, floorTotals } from './wallet.js';

// Zoo
export { hunt, sellDuplicates, sacrificeDuplicates, feedEssence, getZoo, getStats, getCatalog, huntLeaderboard } from './zoo.js';

// Gems and lootboxes
export { getGems, useGems, openLootboxes, grantLootboxes } from './gems.js';

// Weapons
export {
    openCrate, listWeapons, getWeapon, dismantleWeapon, forgeWeapon, forgePrices, setFavorite, getShards, grantShards, grantCrates, getCrateCount,
} from './weapons.js';

// Teams and pets
export {
    listTeams, createTeam, getTeam, addToTeam, removeFromTeam, switchTeam, renameTeam, deleteTeam, equipWeapon, unequipWeapon, setNickname,
} from './teams.js';

// Battles
export {
    getBattleSettings, setBattleSettings, battleCpu, checkChallenge, openChallenge, setChallengeMessage, findPendingChallenge,
    acceptChallenge, cancelChallenge, headToHead, sweepExpiredDuels,
} from './battle.js';

// Quests, passive play
export { viewQuests, claimQuest, claimAllQuests, bumpQuest } from './quests.js';
export { enableAutohunt, disableAutohunt, autohuntStatus, claimAutohunt, ranchStatus, claimRanch, rollLuck } from './passive.js';

// Social
export { prayOrCurse, getLuck, cookieStatus, giveCookie, socialBoard, earnsPoint, recordPoint, pointsCard } from './social.js';
export {
    ringCatalog, buyRing, sellRing, ringInventory, propose, changeRing, acceptProposal, declineProposal, divorce, marriageStatus,
} from './marriage.js';

// Lottery, boss
export { enterLottery, lotteryStatus, drawLottery, dueLotteryGuilds } from './lottery.js';
export { getBoss, getActiveBoss, maybeSpawnBoss, spawnBoss, setBossMessage, fightBoss, reapBosses } from './boss.js';

// Profile, wallpapers, shop
export {
    shopListing, wallpaperPreview, buyWallpaper, buyFromShop, equipWallpaper, unequipWallpaper, ownedWallpapers, getProfileRow,
    setAbout, setTitle, setAccent, setPrivacy, profileView, normalizeHex,
} from './profile.js';
export { renderWallpaper, renderProfileCard, wallpaperColors } from './render.js';

// Views, jobs, admin, privacy
export {
    bossMessage, handleBossButton, gateMessage, lotteryWinMessage, lotteryRolloverMessage, challengeExpiredMessage, BOSS_BUTTONS, BOSS_BUTTON_PREFIX,
} from './views.js';
export {
    runLotteryDraws, runEscrowSweep, runBossReaper, startLotteryDraw, stopLotteryDraw, startEscrowSweeper, stopEscrowSweeper,
    startBossReaper, stopBossReaper, startCritterJobs, stopCritterJobs,
} from './jobs.js';
export * as admin from './admin.js';
export { PRIVACY_DELETE_PLAN, PRIVACY_ANONYMISE_PLAN, EXPORT_EXTRA, PER_USER_TABLES, PER_USER_COLUMNS } from './privacy.js';

// Data and pure rules (for renderers and the dashboard)
export * as data from './data/index.js';
export { describeWeapon, weaponLabel, FORGE_PRICES } from './rules/weapon-rules.js';
export { splitLogFrames, parseSettingsText, SPEED_NAMES, BATTLE_SETTINGS_DEFAULTS } from './rules/battle-engine.js';
export { hpBar } from './rules/misc-rules.js';
export { lastLocalMidnight, nextLocalMidnight, msUntilNextMidnight } from './rules/time.js';
