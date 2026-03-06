/**
 * CertiFried Extension - Components Index
 * Import all components to register them
 */

// Core components
export { default as CFBaseComponent, registerComponent } from './base-component.js';

// Layout components
export { default as CFHeader } from './cf-header.js';
export { default as CFNav } from './cf-nav.js';
export { default as CFToastContainer } from './cf-toast.js';
export { default as CFModal } from './cf-modal.js';
export { default as CFAppContainer } from './cf-app-container.js';

// Game components
export { default as CFGarden } from './cf-garden.js';
export { default as CFInventory } from './cf-inventory.js';
export { default as CFMarket } from './cf-market.js';
export { default as CFBreeding } from './cf-breeding.js';
export { default as CFQuests } from './cf-quests.js';
export { default as CFMore } from './cf-more.js';
export { default as CFSkills } from './cf-skills.js';
export { default as CFLeaderboard } from './cf-leaderboard.js';
export { default as CFAchievements } from './cf-achievements.js';

// New feature components
export { default as CFTrading } from './cf-trading.js';
export { default as CFWorkers } from './cf-workers.js';
export { default as CFSettings } from './cf-settings.js';
export { default as CFStrains } from './cf-strains.js';
export { default as CFNotifications } from './cf-notifications.js';
export { default as CFDailyRewards } from './cf-daily-rewards.js';
export { default as CFStats } from './cf-stats.js';
export { default as CFOfflineProgress } from './cf-offline-progress.js';
export { default as CFEvents } from './cf-events.js';
export { default as CFVault } from './cf-vault.js';
export { default as CFHeatIndicator } from './cf-heat-indicator.js';
export { default as CFFavorites } from './cf-favorites.js';
export { default as CFMarketAlerts } from './cf-market-alerts.js';
export { default as CFContracts } from './cf-contracts.js';
export { default as CFExtraction } from './cf-extraction.js';
export { default as CFBlackMarket } from './cf-black-market.js';
export { default as CFMutations } from './cf-mutations.js';
export { default as CFResearch } from './cf-research.js';
export { default as CFEquipment } from './cf-equipment.js';
export { default as CFLocations } from './cf-locations.js';
export { default as CFCartel } from './cf-cartel.js';
export { default as CFTerritories } from './cf-territories.js';
export { default as CFTournaments } from './cf-tournaments.js';
export { default as CFReputation } from './cf-reputation.js';
export { default as CFDispensary } from './cf-dispensary.js';
export { default as CFMinigames } from './cf-minigames.js';
export { default as CFBosses } from './cf-bosses.js';
export { default as CFRandomEvents } from './cf-random-events.js';
export { default as CFPrestige } from './cf-prestige.js';
export { default as CFRaids } from './cf-raids.js';
export { default as CFQualityInfo } from './cf-quality-info.js';
export { default as CFAIAssistant } from './cf-ai-assistant.js';
export { default as CFTimers } from './cf-timers.js';
export { default as CFBonuses } from './cf-bonuses.js';
export { default as CFFacilities } from './cf-facilities.js';
export { default as CFTraining } from './cf-training.js';
export { default as CFExpansions } from './cf-expansions.js';
export { default as CFDashboard } from './cf-dashboard.js';
export { default as CFBreedingHistory } from './cf-breeding-history.js';
export { default as CFUpgrades } from './cf-upgrades.js';
export { default as CFPermanentUnlocks } from './cf-permanent-unlocks.js';

// Utility components
export { default as CFStrainSelector } from './cf-strain-selector.js';
export { default as CFTutorial } from './cf-tutorial.js';

// Register all components when this module is imported
console.log('[CFX] Components registered');
