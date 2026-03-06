/**
 * CertiFried Extension - Reactive Store
 * EventTarget-based state management for Vanilla JS
 */

class Store extends EventTarget {
    constructor() {
        super();

        this.state = {
            // Auth state
            auth: {
                mode: null,           // 'extension' | 'standalone' | null
                isAuthenticated: false,
                token: null,
                user: null,           // { id, platform, platform_user_id, display_name }
                channel: null         // Extension context: channel info
            },

            // Player state
            player: {
                id: null,
                level: 1,
                xp: 0,
                xpToNextLevel: 100,
                currency: 0,
                premiumCurrency: 0,
                prestigeLevel: 0,
                prestigeTokens: 0,
                facilityLevel: 1,
                maxPlots: 4,
                unlockedStrains: [],
                skills: {},
                lastOnline: null
            },

            // Garden state
            garden: {
                plots: [],            // { id, strain_id, planted_at, maturity, quality, is_withered }
                isLoading: false
            },

            // Inventory state
            inventory: {
                items: [],            // { strain_id, strain_name, quantity, quality }
                isLoading: false
            },

            // Market state
            market: {
                prices: [],           // { strain_id, strain_name, current_price, change_24h }
                listings: [],         // Player listings
                isLoading: false
            },

            // Breeding state
            breeding: {
                inProgress: null,     // Active breeding
                history: [],
                isLoading: false
            },

            // Quests state
            quests: {
                daily: [],
                weekly: [],
                isLoading: false
            },

            // UI state
            ui: {
                activeTab: 'garden',
                modal: null,
                notifications: [],
                isConnected: false,
                connectionError: null
            },

            // Bot bonuses (synced from main bot)
            botBonuses: {
                level: 0,
                growthSpeedBonus: 0,
                yieldBonus: 0,
                xpBonus: 0,
                sellPriceBonus: 0
            },

            // Strains reference data
            strains: new Map(),

            // Heat/Raid state
            heat: {
                current: 0,
                status: 'cold',
                raidChance: 0
            },

            // Game state (raid status, etc.)
            game: {
                raidStatus: null
            },

            // Equipment state (populated by cf-upgrades, cf-bonuses)
            equipment: {
                items: [],
                activeBonuses: {}
            },

            // Reputation state (populated by cf-reputation)
            reputation: {
                factions: [],
                activePerks: []
            },

            // Cartel state (populated by cf-cartel)
            cartel: {
                id: null,
                bonuses: {}
            },

            // Territory state (populated by cf-territories)
            territories: {
                list: [],
                bonuses: {}
            },

            // Extraction state (populated by cf-extraction)
            extraction: {
                slots: []
            },

            // Workers state (populated by cf-workers)
            workers: {
                list: [],
                activeBonuses: {}
            },

            // Boss state (populated by cf-bosses)
            bosses: {
                activeEncounter: null
            },

            // Tournament state (populated by cf-tournaments)
            tournaments: {
                list: []
            },

            // User settings (single source of truth for all components)
            // Synced: localStorage (backup) ↔ store (runtime) ↔ server (authoritative)
            settings: {
                notifications: true,
                sound: true,
                autoHarvest: false,
                autoReplant: false,
                autoSell: false,
                autoBreed: false,
                autoCollect: false,
                workersEnabled: true,
                compactView: false,
                theme: 'dark',
                offlineHarvestEnabled: true,
                offlineSellEnabled: false,
                offlinePlantEnabled: false,
                offlineSellMinQuality: 0,
                autoBuySeeds: false,
                autoBuySeedsThreshold: 5,
                autoBuySeedsMaxPrice: 500
            }
        };

        // Load settings from localStorage
        this._loadSettings();

        this._subscribers = new Map();
        this._batchDepth = 0;
        this._batchedEvents = [];
    }

    /**
     * Get current state (or a path within it)
     * @param {string} [path] - Dot-notation path (e.g., 'player.level')
     */
    get(path) {
        if (!path) return this.state;

        return path.split('.').reduce((obj, key) =>
            obj && obj[key] !== undefined ? obj[key] : undefined,
            this.state
        );
    }

    /**
     * Update state and notify subscribers
     * @param {string} path - Dot-notation path
     * @param {*} value - New value
     */
    set(path, value) {
        const keys = path.split('.');
        const lastKey = keys.pop();

        let obj = this.state;
        for (const key of keys) {
            if (!(key in obj)) obj[key] = {};
            obj = obj[key];
        }

        const oldValue = obj[lastKey];
        obj[lastKey] = value;

        // Dispatch change event
        this.dispatchEvent(new CustomEvent('change', {
            detail: { path, value, oldValue }
        }));

        // Dispatch path-specific event
        this.dispatchEvent(new CustomEvent(`change:${keys[0] || lastKey}`, {
            detail: { path, value, oldValue }
        }));
    }

    /**
     * Merge object into state path
     * @param {string} path - Dot-notation path
     * @param {object} data - Data to merge
     */
    merge(path, data) {
        const current = this.get(path) || {};
        this.set(path, { ...current, ...data });
    }

    /**
     * Subscribe to state changes
     * @param {string} path - Path to watch (or '*' for all)
     * @param {function} callback - Called on change
     * @returns {function} Unsubscribe function
     */
    subscribe(path, callback) {
        const eventName = path === '*' ? 'change' : `change:${path.split('.')[0]}`;

        const handler = (e) => {
            if (path === '*' || e.detail.path.startsWith(path)) {
                callback(e.detail.value, e.detail.oldValue, e.detail.path);
            }
        };

        this.addEventListener(eventName, handler);

        return () => this.removeEventListener(eventName, handler);
    }

    /**
     * Batch multiple updates
     * @param {function} fn - Function that makes updates
     */
    batch(fn) {
        this.beginBatch();
        try {
            fn();
        } finally {
            this.endBatch();
        }
    }

    /**
     * Begin batching updates (for async operations)
     * Events are queued until endBatch() is called
     */
    beginBatch() {
        this._batchDepth++;
    }

    /**
     * End batching and dispatch all queued events
     * Only dispatches when all nested batches are complete
     */
    endBatch() {
        if (this._batchDepth <= 0) return;

        this._batchDepth--;

        if (this._batchDepth === 0 && this._batchedEvents.length > 0) {
            // Dedupe events by path (keep last value per path)
            const eventsByPath = new Map();
            for (const e of this._batchedEvents) {
                const key = e.type + ':' + e.detail.path;
                eventsByPath.set(key, e);
            }

            // Dispatch deduplicated events
            for (const e of eventsByPath.values()) {
                EventTarget.prototype.dispatchEvent.call(this, e);
            }

            this._batchedEvents = [];
        }
    }

    /**
     * Override dispatchEvent to support batching
     */
    dispatchEvent(event) {
        if (this._batchDepth > 0 && event.type.startsWith('change')) {
            this._batchedEvents.push(event);
            return true;
        }
        return super.dispatchEvent(event);
    }

    /**
     * Reset state to initial values
     */
    reset() {
        this.state.auth = {
            mode: null,
            isAuthenticated: false,
            token: null,
            user: null,
            channel: null
        };

        this.state.player = {
            id: null,
            level: 1,
            xp: 0,
            xpToNextLevel: 100,
            currency: 0,
            premiumCurrency: 0,
            prestigeLevel: 0,
            prestigeTokens: 0,
            facilityLevel: 1,
            maxPlots: 4,
            unlockedStrains: [],
            skills: {},
            lastOnline: null
        };

        this.state.garden.plots = [];
        this.state.inventory.items = [];
        this.state.market.prices = [];
        this.state.market.listings = [];

        this.dispatchEvent(new CustomEvent('reset'));
    }

    /**
     * Load full game state from API response
     * @param {object} gameState - Full game state from /api/v1/game/state
     */
    loadGameState(gameState) {
        console.log('[Store] Loading game state:', gameState);

        this.batch(() => {
            // Player data (backend returns camelCase)
            const p = gameState.player || {};
            const playerCash = p.cash || 0;
            this.merge('player', {
                id: p.id,
                displayName: p.displayName || p.display_name,
                cash: playerCash,
                level: p.level || 1,
                xp: p.xp || 0,
                xpInLevel: p.xpInLevel || 0,
                xpToNextLevel: p.xpForNextLevel || 100,
                currency: playerCash,  // Keep both paths in sync
                premiumCurrency: p.premiumCurrency || 0,
                prestigeLevel: p.prestigeLevel || 0,
                prestigeTokens: p.prestigeTokens || 0,
                skillPoints: p.skillPoints || 0,
                facilityLevel: p.facilityLevel || 1,
                maxPlots: p.maxGrowSlots || 2,
                tutorialCompleted: p.tutorialCompleted || false,
                lifetimeEarnings: parseFloat(p.lifetimeEarnings) || 0,
                lifetimeSales: parseInt(p.lifetimeSales) || 0,
                unlockedStrains: gameState.unlockedStrains || [],
                skills: gameState.skills || [],
                lastOnline: p.lastOnline
            });

            // Garden slots (backend calls them 'slots')
            this.set('garden.plots', gameState.slots || []);

            // Inventory
            this.set('inventory.items', gameState.inventory || []);

            // Bonuses
            if (gameState.bonuses) {
                this.merge('botBonuses', {
                    growthSpeedBonus: gameState.bonuses.growSpeedBonus || 0,
                    yieldBonus: gameState.bonuses.yieldBonus || 0,
                    xpBonus: gameState.bonuses.xpBonus || 0,
                    sellPriceBonus: gameState.bonuses.sellBonus || 0
                });
            }

            // Quests - handle both camelCase and snake_case from API
            if (gameState.quests && Array.isArray(gameState.quests)) {
                this.set('quests.daily', gameState.quests.filter(q => (q.questType || q.quest_type) === 'daily'));
                this.set('quests.weekly', gameState.quests.filter(q => (q.questType || q.quest_type) === 'weekly'));
                // Also include achievement quests in daily tab for now
                const achievementQuests = gameState.quests.filter(q => (q.questType || q.quest_type) === 'achievement');
                const currentDaily = this.state.quests?.daily || [];
                this.set('quests.daily', [...currentDaily, ...achievementQuests]);
            }

            // Active breeding
            if (gameState.breeding && gameState.breeding.length > 0) {
                this.set('breeding.inProgress', gameState.breeding[0]);
            }
        });

        this.dispatchEvent(new CustomEvent('gamestate:loaded'));
    }

    /**
     * Load settings from server response and merge into store
     * Called by components after fetching from GET /settings
     * @param {object} serverSettings - Settings object from server
     */
    loadServerSettings(serverSettings) {
        if (!serverSettings) return;
        this.batch(() => {
            for (const [key, value] of Object.entries(serverSettings)) {
                if (value !== undefined) {
                    this.set(`settings.${key}`, value);
                }
            }
        });
        // Persist to localStorage as backup
        this._persistSettings();
    }

    /**
     * Persist current settings to localStorage
     */
    _persistSettings() {
        try {
            localStorage.setItem('cfx_settings', JSON.stringify(this.state.settings));
        } catch (e) {
            console.warn('[CFX] Failed to persist settings:', e);
        }
    }

    /**
     * Load settings from localStorage
     */
    _loadSettings() {
        try {
            const saved = localStorage.getItem('cfx_settings');
            if (saved) {
                const settings = JSON.parse(saved);
                this.state.settings = {
                    ...this.state.settings,
                    ...settings
                };
            }
        } catch (e) {
            console.warn('[CFX] Failed to load settings:', e);
        }
    }
}

// Singleton instance
export const store = new Store();
export default store;
