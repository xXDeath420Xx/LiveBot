/**
 * CertiFried Extension - HTTP API Client
 * Handles REST API calls with auth token injection and retry logic
 */

import { store } from '../state/store.js';

const API_BASE = '/api/v1';
const MAX_RETRIES = 3;
const RETRY_DELAY = 1000;

// Cache TTLs in milliseconds
const CACHE_TTL = {
    strains: 5 * 60 * 1000,        // 5 minutes - strains rarely change
    skills: 5 * 60 * 1000,         // 5 minutes - skill tree is static
    shop: 2 * 60 * 1000,           // 2 minutes - shop items mostly static
    achievements: 5 * 60 * 1000,   // 5 minutes - achievements are static
    research: 3 * 60 * 1000,       // 3 minutes - research tree is static
    equipment: 3 * 60 * 1000,      // 3 minutes - equipment list is static
    locations: 3 * 60 * 1000,      // 3 minutes - locations are static
    market_prices: 30 * 1000,      // 30 seconds - prices change moderately
    default: 60 * 1000             // 1 minute default
};

class ApiClient {
    constructor() {
        this.baseUrl = API_BASE;
        this.pendingRequests = new Map();
        this.cache = new Map();
        this.cacheTimestamps = new Map();
    }

    /**
     * Get cached response if valid
     * @param {string} cacheKey - Cache key
     * @param {number} ttl - TTL in ms
     */
    _getCached(cacheKey, ttl) {
        const cached = this.cache.get(cacheKey);
        const timestamp = this.cacheTimestamps.get(cacheKey);

        if (cached && timestamp && (Date.now() - timestamp) < ttl) {
            return cached;
        }
        return null;
    }

    /**
     * Set cached response
     * @param {string} cacheKey - Cache key
     * @param {*} data - Data to cache
     */
    _setCache(cacheKey, data) {
        this.cache.set(cacheKey, data);
        this.cacheTimestamps.set(cacheKey, Date.now());
    }

    /**
     * Invalidate cache entries by prefix
     * @param {string} prefix - Cache key prefix to invalidate
     */
    invalidateCache(prefix = null) {
        if (prefix) {
            for (const key of this.cache.keys()) {
                if (key.startsWith(prefix)) {
                    this.cache.delete(key);
                    this.cacheTimestamps.delete(key);
                }
            }
        } else {
            this.cache.clear();
            this.cacheTimestamps.clear();
        }
    }

    /**
     * Make cached GET request
     * @param {string} endpoint - API endpoint
     * @param {number} ttl - Cache TTL in ms
     * @param {object} options - Additional options
     */
    async getCached(endpoint, ttl = CACHE_TTL.default, options = {}) {
        const cacheKey = `GET:${endpoint}`;

        // Check cache first
        const cached = this._getCached(cacheKey, ttl);
        if (cached) {
            return cached;
        }

        // Fetch fresh data
        const data = await this.get(endpoint, options);
        this._setCache(cacheKey, data);
        return data;
    }

    /**
     * Stale-while-revalidate: Return cached data immediately (even if stale),
     * then refresh in background. Ideal for UI that needs to show something fast.
     *
     * @param {string} endpoint - API endpoint
     * @param {number} ttl - Cache TTL in ms
     * @param {function} onRefresh - Callback when fresh data arrives
     * @returns {Promise} Resolves with cached data (if any) or fresh data
     */
    async getStaleWhileRevalidate(endpoint, ttl = CACHE_TTL.default, onRefresh = null) {
        const cacheKey = `GET:${endpoint}`;
        const cached = this.cache.get(cacheKey);
        const timestamp = this.cacheTimestamps.get(cacheKey);
        const isStale = !timestamp || (Date.now() - timestamp) >= ttl;

        // If we have cached data
        if (cached) {
            // If stale, refresh in background
            if (isStale) {
                this.get(endpoint).then(freshData => {
                    this._setCache(cacheKey, freshData);
                    if (onRefresh) onRefresh(freshData);
                }).catch(() => {}); // Ignore background refresh errors
            }
            return cached;
        }

        // No cache - must fetch
        const data = await this.get(endpoint);
        this._setCache(cacheKey, data);
        return data;
    }

    /**
     * Set base URL (for standalone mode)
     * @param {string} url - API base URL
     */
    setBaseUrl(url) {
        this.baseUrl = url;
    }

    /**
     * Get auth headers based on current mode
     */
    getAuthHeaders() {
        const { mode, token } = store.get('auth');
        const headers = {
            'Content-Type': 'application/json'
        };

        if (mode === 'extension' && token) {
            headers['X-Extension-JWT'] = token;
        } else if (mode === 'standalone' && token) {
            headers['Authorization'] = `Bearer ${token}`;
        }

        return headers;
    }

    /**
     * Make API request with retry logic
     * @param {string} method - HTTP method
     * @param {string} endpoint - API endpoint
     * @param {object} [data] - Request body
     * @param {object} [options] - Additional options
     */
    async request(method, endpoint, data = null, options = {}) {
        const url = `${this.baseUrl}${endpoint}`;
        const requestKey = `${method}:${endpoint}`;

        // Dedupe identical in-flight requests
        if (options.dedupe !== false && this.pendingRequests.has(requestKey)) {
            return this.pendingRequests.get(requestKey);
        }

        const requestPromise = this._executeRequest(method, url, data, options);

        if (options.dedupe !== false) {
            this.pendingRequests.set(requestKey, requestPromise);
            requestPromise.finally(() => this.pendingRequests.delete(requestKey));
        }

        return requestPromise;
    }

    async _executeRequest(method, url, data, options, attempt = 1) {
        const headers = this.getAuthHeaders();

        const fetchOptions = {
            method,
            headers,
            credentials: 'include'
        };

        if (data && method !== 'GET') {
            fetchOptions.body = JSON.stringify(data);
        }

        try {
            const response = await fetch(url, fetchOptions);

            // Handle auth errors
            if (response.status === 401) {
                store.set('auth.isAuthenticated', false);
                store.set('ui.connectionError', 'Session expired. Please refresh.');
                throw new ApiError('Unauthorized', 401);
            }

            // Handle rate limiting
            if (response.status === 429) {
                const retryAfter = parseInt(response.headers.get('Retry-After') || '5', 10);
                if (attempt < MAX_RETRIES) {
                    await this._delay(retryAfter * 1000);
                    return this._executeRequest(method, url, data, options, attempt + 1);
                }
                throw new ApiError('Rate limited', 429);
            }

            // Parse response
            const contentType = response.headers.get('Content-Type') || '';
            let responseData;

            if (contentType.includes('application/json')) {
                responseData = await response.json();
            } else {
                responseData = await response.text();
            }

            // Handle error responses
            if (!response.ok) {
                const message = responseData?.error || responseData?.message || 'Request failed';
                throw new ApiError(message, response.status, responseData);
            }

            return responseData;

        } catch (error) {
            // Retry on network errors
            if (error.name === 'TypeError' && attempt < MAX_RETRIES) {
                await this._delay(RETRY_DELAY * attempt);
                return this._executeRequest(method, url, data, options, attempt + 1);
            }

            throw error;
        }
    }

    _delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // Convenience methods
    get(endpoint, options) {
        return this.request('GET', endpoint, null, options);
    }

    post(endpoint, data, options) {
        return this.request('POST', endpoint, data, options);
    }

    put(endpoint, data, options) {
        return this.request('PUT', endpoint, data, options);
    }

    delete(endpoint, options) {
        return this.request('DELETE', endpoint, null, options);
    }

    // ============ Game State ============

    async getGameState() {
        return this.get('/game/state');
    }

    // ============ Garden / Grow ============

    async plantSeed(strainId, slotNumber) {
        return this.post('/grow/plant', { strainId, slotNumber });
    }

    async harvestPlot(slotNumber) {
        return this.post('/grow/harvest', { slotNumber });
    }

    async harvestAll() {
        return this.post('/grow/harvest-all');
    }

    async quickPlantAll() {
        return this.post('/grow/quick-plant');
    }

    async bulkPlant(strainId) {
        return this.post('/grow/bulk-plant', { strainId });
    }

    async waterPlot(plotId) {
        return this.post('/grow/water', { plot_id: plotId });
    }

    async removePlot(plotId) {
        return this.post('/grow/remove', { plot_id: plotId });
    }

    // ============ Inventory ============

    async getInventory() {
        return this.get('/inventory');
    }

    async useItem(itemId, quantity = 1) {
        return this.post('/inventory/use', { item_id: itemId, quantity });
    }

    async sellAll(options = {}) {
        return this.post('/inventory/sell-all', options);
    }

    async sellByQuality(qualityMin, qualityMax = 100) {
        return this.post('/inventory/sell-all', { qualityMin, qualityMax });
    }

    // ============ Market ============

    async getMarketPrices() {
        return this.getCached('/market/prices', CACHE_TTL.market_prices);
    }

    async quickSell(inventoryId, quantity) {
        return this.post('/inventory/sell', { inventoryId, quantity });
    }

    async createListing(inventoryId, quantity, pricePerUnit) {
        return this.post('/market/list', { inventoryId, quantity, pricePerUnit });
    }

    async getListings(strainId = null) {
        const endpoint = strainId ? `/market/listings?strainId=${strainId}` : '/market/listings';
        return this.get(endpoint);
    }

    async buyListing(listingId, quantity) {
        return this.post('/market/buy', { listingId, quantity });
    }

    async cancelListing(listingId) {
        return this.post('/market/cancel', { listingId });
    }

    // ============ Strains (Available for planting) ============

    async getAvailableStrains() {
        return this.get('/grow/strains');
    }

    // ============ Breeding ============

    async startBreeding(parent1Id, parent2Id) {
        return this.post('/breed/start', { parent1StrainId: parent1Id, parent2StrainId: parent2Id });
    }

    async claimBreeding(breedingId) {
        return this.post('/breed/claim', { operationId: breedingId });
    }

    async cancelBreeding(breedingId) {
        return this.post('/breed/cancel', { breedingId });
    }

    async getBreedingHistory() {
        return this.get('/breed/history');
    }

    // ============ Skills ============

    async getSkillTree() {
        return this.getCached('/skills/tree', CACHE_TTL.skills);
    }

    async unlockSkill(skillId) {
        const result = await this.post('/skills/unlock', { skillId });
        this.invalidateCache('GET:/skills');  // Invalidate skill cache after unlock
        return result;
    }

    // ============ Quests ============

    async getQuests() {
        return this.get('/quests');
    }

    async claimQuest(questId) {
        return this.post('/quests/claim', { questId });
    }

    // ============ Facility ============

    async upgradeFacility(upgradeKey) {
        return this.post('/facility/upgrade', { upgradeKey });
    }

    async getFacilityInfo() {
        return this.get('/facility');
    }

    // ============ Trading ============

    async getPendingTrades() {
        return this.get('/trade/pending');
    }

    async createTrade(receiverId, offeredItems, offeredCash = 0) {
        return this.post('/trade/create', {
            receiverId,
            offeredItems,
            offeredCash
        });
    }

    async acceptTrade(tradeId) {
        return this.post('/trade/accept', { tradeId });
    }

    async declineTrade(tradeId) {
        return this.post('/trade/decline', { tradeId });
    }

    async cancelTrade(tradeId) {
        return this.post('/trade/cancel', { tradeId });
    }

    async searchPlayers(query) {
        return this.get(`/social/search?q=${encodeURIComponent(query)}`);
    }

    // ============ Social ============

    async getLeaderboard(type = 'level', limit = 50) {
        return this.get(`/social/leaderboard?type=${type}&limit=${limit}`);
    }

    async getProfile(playerId) {
        return this.get(`/social/player/${playerId}`);
    }

    // ============ Shop ============

    async getShopItems(category = null) {
        const endpoint = category ? `/shop/items?category=${category}` : '/shop/items';
        return this.getCached(endpoint, CACHE_TTL.shop);
    }

    async buyShopItem(itemId, quantity = 1) {
        const result = await this.post('/shop/buy', { itemId, quantity });
        this.invalidateCache('GET:/shop');  // Invalidate shop cache after purchase
        return result;
    }

    async getOwnedItems() {
        return this.get('/shop/owned');
    }

    async getActiveBoosters() {
        return this.get('/shop/active-boosters');
    }

    async getShopDeals() {
        return this.getCached('/shop/deals', 60 * 1000); // 1 min cache - deals change
    }

    async buyShopDeal(dealId, quantity = 1) {
        const result = await this.post('/shop/buy-deal', { dealId, quantity });
        this.invalidateCache('GET:/shop');
        return result;
    }

    // ============ Bits / Premium ============

    async getBitsProducts() {
        return this.get('/bits/products');
    }

    async redeemBits(productId, transactionId) {
        return this.post('/bits/redeem', { product_id: productId, transaction_id: transactionId });
    }

    // ============ Prestige ============

    async getPrestigeInfo() {
        return this.get('/prestige/info');
    }

    async performPrestige() {
        return this.post('/prestige/reset');
    }

    async buyPrestigeUpgrade(upgradeId) {
        return this.post('/prestige/buy', { upgrade_id: upgradeId });
    }

    // ============ Achievements ============

    async getAchievements() {
        return this.getCached('/achievements', CACHE_TTL.achievements);
    }

    async claimAchievement(achievementId) {
        return this.post('/achievements/claim', { achievementId });
    }

    // ============ Boosters / Item Usage ============

    async useBooster(itemId) {
        return this.post('/shop/use', { itemId });
    }

    // ============ Settings ============

    async getSettings() {
        return this.get('/settings');
    }

    async updateSettings(settings) {
        return this.put('/settings', settings);
    }

    // ============ Notifications ============

    async getNotifications(unreadOnly = false) {
        return this.get(`/notifications${unreadOnly ? '?unreadOnly=true' : ''}`);
    }

    async markNotificationRead(notificationId) {
        return this.post(`/notifications/${notificationId}/read`);
    }

    async markAllNotificationsRead() {
        return this.post('/notifications/read-all');
    }

    // ============ Gifts ============

    async getPendingGifts() {
        return this.get('/gifts/pending');
    }

    async sendGift(receiverId, giftType, data) {
        return this.post('/gifts/send', { receiverId, giftType, ...data });
    }

    async claimGift(giftId) {
        return this.post('/gifts/claim', { giftId });
    }

    // ============ Workers ============

    async getWorkerStatus() {
        return this.get('/workers/status');
    }

    async getWorkerLogs(workerType = null, limit = 20) {
        const endpoint = workerType
            ? `/workers/logs?workerType=${workerType}&limit=${limit}`
            : `/workers/logs?limit=${limit}`;
        return this.get(endpoint);
    }

    async toggleWorker(workerType, enabled) {
        return this.post('/workers/toggle', { workerType, enabled });
    }

    async getWorkerConfig() {
        return this.get('/workers/config');
    }

    async updateWorkerConfig(config) {
        return this.put('/workers/config', config);
    }

    // ============ Strain Collection ============

    async getStrainCollection() {
        return this.getCached('/strains/collection', CACHE_TTL.strains);
    }

    async getStrainDetails(strainId) {
        return this.getCached(`/strains/${strainId}`, CACHE_TTL.strains);
    }

    // ============ Strain Favorites ============

    async getFavorites() {
        return this.get('/favorites');
    }

    async addFavorite(strainId) {
        return this.post('/favorites', { strainId });
    }

    async removeFavorite(strainId) {
        return this.delete(`/favorites/${strainId}`);
    }

    async reorderFavorites(order) {
        return this.put('/favorites/reorder', { order });
    }

    // ============ Market History ============

    async getMarketHistory(strainId, hours = 24) {
        return this.get(`/market/history/${strainId}?hours=${hours}`);
    }

    // ============ Market Alerts ============

    async getMarketAlerts() {
        return this.get('/market/alerts');
    }

    async createMarketAlert(strainId, alertType, thresholdValue) {
        return this.post('/market/alerts', { strainId, alertType, thresholdValue });
    }

    async updateMarketAlert(alertId, updates) {
        return this.put(`/market/alerts/${alertId}`, updates);
    }

    async deleteMarketAlert(alertId) {
        return this.delete(`/market/alerts/${alertId}`);
    }

    // ============ Contracts ============

    async getContracts() {
        return this.get('/contracts');
    }

    async acceptContract(contractId) {
        return this.post(`/contracts/${contractId}/accept`);
    }

    async deliverToContract(playerContractId, inventoryId, quantity) {
        return this.post(`/contracts/${playerContractId}/deliver`, { inventoryId, quantity });
    }

    async cancelContract(playerContractId) {
        return this.post(`/contracts/${playerContractId}/cancel`);
    }

    async quickFulfillContract(playerContractId) {
        return this.post(`/contracts/${playerContractId}/quick-fulfill`);
    }

    // ============ Extraction Lab ============

    async getExtractionLab() {
        return this.get('/extraction');
    }

    async startExtraction(slotId, recipeId, inventoryId) {
        return this.post('/extraction/start', { slotId, recipeId, inventoryId });
    }

    async claimExtraction(slotId) {
        return this.post('/extraction/claim', { slotId });
    }

    async sellProduct(productId, quantity) {
        return this.post('/extraction/sell-product', { productId, quantity });
    }

    // ============ Black Market ============

    async getBlackMarket() {
        return this.get('/black-market');
    }

    async sellToBlackMarket(contactId, inventoryId, quantity) {
        return this.post('/black-market/sell', { contactId, inventoryId, quantity });
    }

    // ============ Mutations ============

    async getMutations() {
        return this.get('/mutations');
    }

    // ============ Player Profile ============

    async getPlayerProfile(playerId) {
        return this.get(`/social/player/${playerId}`);
    }

    // ============ Daily Rewards ============

    async getDailyRewardStatus() {
        return this.get('/daily-rewards/status');
    }

    async claimDailyReward() {
        return this.post('/daily-rewards/claim');
    }

    // ============ Statistics ============

    async getPlayerStats() {
        return this.get('/stats');
    }

    // ============ Offline Progress ============

    async getOfflineProgress() {
        return this.get('/offline-progress');
    }

    async dismissOfflineProgress(recordIds = null) {
        return this.post('/offline-progress/dismiss', { recordIds });
    }

    // ============ Events ============

    async getActiveEvents() {
        return this.get('/events');
    }

    async joinEvent(eventId) {
        return this.post('/events/join', { eventId });
    }

    async claimEventReward(eventId, milestoneIndex) {
        return this.post('/events/claim-reward', { eventId, milestoneIndex });
    }

    async getEventLeaderboard(eventId) {
        return this.get(`/events/leaderboard/${eventId}`);
    }

    // ============ Research Tree ============

    async getResearchTree() {
        return this.getCached('/research/tree', CACHE_TTL.research);
    }

    async startResearch(researchId) {
        return this.post('/research/start', { researchId });
    }

    async claimResearch(researchId) {
        const result = await this.post('/research/claim', { researchId });
        this.invalidateCache('GET:/research');  // Research tree changed
        this.invalidateCache('GET:/equipment'); // May unlock equipment
        return result;
    }

    async cancelResearch(researchId) {
        return this.post('/research/cancel', { researchId });
    }

    // ============ Equipment ============

    async getEquipment() {
        return this.getCached('/equipment', CACHE_TTL.equipment);
    }

    async buyEquipment(equipmentId) {
        const result = await this.post('/equipment/buy', { equipmentId });
        this.invalidateCache('GET:/equipment');  // Equipment list changed
        return result;
    }

    async toggleEquipment(equipmentId) {
        return this.put(`/equipment/${equipmentId}/toggle`);
    }

    async sellEquipment(equipmentId) {
        return this.post(`/equipment/${equipmentId}/sell`);
    }

    // ============ Locations ============

    async getLocations() {
        return this.getCached('/locations', CACHE_TTL.locations);
    }

    async buyLocation(locationId) {
        const result = await this.post('/locations/buy', { locationId });
        this.invalidateCache('GET:/locations');  // Locations list changed
        return result;
    }

    async upgradeLocation(locationId) {
        return this.post(`/locations/${locationId}/upgrade`);
    }

    async setPrimaryLocation(locationId) {
        return this.put(`/locations/${locationId}/set-primary`);
    }

    // ============ Cartels ============

    async getCartel() {
        return this.get('/cartels');
    }

    async createCartel(name, tag, description) {
        return this.post('/cartels/create', { name, tag, description });
    }

    async joinCartel(cartelId, inviteId = null) {
        return this.post('/cartels/join', { cartelId, inviteId });
    }

    async leaveCartel() {
        return this.post('/cartels/leave');
    }

    async inviteToCartel(targetPlayerId) {
        return this.post('/cartels/invite', { targetPlayerId });
    }

    async contributeToCartel(amount) {
        return this.post('/cartels/contribute', { amount });
    }

    async purchaseCartelUpgrade(upgradeId) {
        return this.post('/cartels/upgrade', { upgradeId });
    }

    // ============ Territories ============

    async getTerritories() {
        return this.getCached('/territories', 30 * 1000); // 30 sec cache
    }

    async attackTerritory(territoryId) {
        const result = await this.post(`/territories/${territoryId}/attack`);
        this.invalidateCache('GET:/territories');
        return result;
    }

    async contributeToWar(warId, contributionType, amount) {
        return this.post(`/territories/wars/${warId}/contribute`, { contributionType, amount });
    }

    async getWarDetails(warId) {
        return this.get(`/territories/wars/${warId}`);
    }

    // ============ Tournaments ============

    async getTournaments() {
        return this.get('/tournaments');
    }

    async getTournamentLeaderboard(tournamentId) {
        return this.get(`/tournaments/${tournamentId}/leaderboard`);
    }

    async joinTournament(tournamentId) {
        return this.post(`/tournaments/${tournamentId}/join`);
    }

    async claimTournamentReward(tournamentId) {
        return this.post(`/tournaments/${tournamentId}/claim`);
    }

    // ============ Reputation ============

    async getReputation() {
        return this.get('/reputation');
    }

    async getFactionDetails(factionKey) {
        return this.get(`/reputation/${factionKey}`);
    }

    // ============ Dispensary ============

    async getDispensary() {
        return this.get('/dispensary');
    }

    async toggleDispensary() {
        return this.post('/dispensary/toggle');
    }

    async listInDispensary(inventoryId, quantity, pricePerUnit) {
        return this.post('/dispensary/list', { inventoryId, quantity, pricePerUnit });
    }

    async unlistFromDispensary(listingId) {
        return this.post('/dispensary/unlist', { listingId });
    }

    async serveCustomer(orderId, listingId) {
        return this.post('/dispensary/serve', { orderId, listingId });
    }

    async spawnCustomer() {
        return this.post('/dispensary/spawn-customer');
    }

    // ============ Minigames ============

    async getMinigames() {
        return this.get('/minigames');
    }

    async startMinigame(minigameKey) {
        return this.post(`/minigames/${minigameKey}/start`);
    }

    async submitMinigameScore(minigameKey, score, sessionToken) {
        return this.post(`/minigames/${minigameKey}/submit`, { score, sessionToken });
    }

    async getMinigameLeaderboard(minigameKey) {
        return this.get(`/minigames/${minigameKey}/leaderboard`);
    }

    // ============ Bosses ============

    async getBosses() {
        return this.get('/bosses');
    }

    async challengeBoss(bossId) {
        return this.post(`/bosses/${bossId}/challenge`);
    }

    async updateBossScore(scoreType, amount) {
        return this.post('/bosses/update-score', { scoreType, amount });
    }

    async claimBossReward(bossId) {
        return this.post(`/bosses/${bossId}/claim`);
    }

    async abandonBossEncounter() {
        return this.post('/bosses/abandon');
    }

    // ============ Random Events ============

    async getActiveRandomEvents() {
        return this.get('/random-events/active');
    }

    async resolveRandomEvent(eventId, choice) {
        return this.post(`/random-events/${eventId}/resolve`, { choice });
    }

    async dismissRandomEvent(eventId) {
        return this.post('/random-events/dismiss', { eventId });
    }

    // ============ Enhanced Workers ============

    async getEnhancedWorkers() {
        return this.get('/workers-enhanced/enhanced');
    }

    async hireWorker(workerTypeId, name = null) {
        return this.post('/workers-enhanced/hire', { workerTypeId, name });
    }

    async upgradeWorker(workerId) {
        return this.post(`/workers-enhanced/${workerId}/upgrade`);
    }

    async getWorkerTraits() {
        return this.get('/workers-enhanced/traits');
    }

    async trainWorkerTrait(workerId, traitId) {
        return this.post(`/workers-enhanced/${workerId}/train`, { traitId });
    }

    async claimWorkerTraining(workerId) {
        return this.post(`/workers-enhanced/${workerId}/claim-training`);
    }

    async toggleEnhancedWorker(workerId, enabled) {
        return this.post(`/workers-enhanced/${workerId}/toggle`, { enabled });
    }

    async renameWorker(workerId, name) {
        return this.post(`/workers-enhanced/${workerId}/rename`, { name });
    }

    async getWorkerUpgradeInfo(workerId) {
        return this.get(`/workers-enhanced/${workerId}/upgrade-info`);
    }

    // ============ Raids ============

    async getRaidStatus() {
        return this.get('/raid/status');
    }

    async getRaidHistory(limit = 20) {
        return this.get(`/raid/history?limit=${limit}`);
    }

    async buyRaidDefense(defenseId) {
        return this.post('/raid/buy-defense', { defenseId });
    }

    async useRaidDefense(defenseId) {
        return this.post('/raid/use-defense', { defenseId });
    }

    async bribeRaid() {
        return this.post('/raid/bribe');
    }

    // ============ Vault ============

    async getVault() {
        return this.get('/vault');
    }

    async depositToVault(amount) {
        return this.post('/vault/deposit-cash', { amount });
    }

    async withdrawFromVault(amount) {
        return this.post('/vault/withdraw-cash', { amount });
    }

    async upgradeVault() {
        return this.post('/vault/upgrade');
    }

    async depositItemToVault(inventoryId, quantity = 1) {
        return this.post('/vault/deposit-item', { inventoryId, quantity });
    }

    async withdrawItemFromVault(vaultItemId, quantity = 1) {
        return this.post('/vault/withdraw-item', { vaultItemId, quantity });
    }

    async depositSeedsToVault(strainId, quantity = 1) {
        return this.post('/vault/deposit-seeds', { strainId, quantity });
    }

    async withdrawSeedsFromVault(strainId, quantity = 1) {
        return this.post('/vault/withdraw-seeds', { strainId, quantity });
    }

    // ============ Market (additional) ============

    async getMyListings() {
        return this.get('/market/my-listings');
    }
}

/**
 * Custom API Error class
 */
class ApiError extends Error {
    constructor(message, status, data = null) {
        super(message);
        this.name = 'ApiError';
        this.status = status;
        this.data = data;
    }
}

// Singleton instance
export const api = new ApiClient();
export { ApiError };
export default api;
