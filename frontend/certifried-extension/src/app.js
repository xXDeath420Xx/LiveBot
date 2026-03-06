/**
 * CertiFried Extension - Main Application Bootstrap
 * Handles initialization, mode detection, and auth flow
 */

import { store } from './state/store.js';
import { api } from './api/client.js';
import { ws } from './api/websocket.js';

// Detect environment
const IS_EXTENSION = window.Twitch?.ext !== undefined;
// __EBS_URL__ is defined at build time via esbuild
const EBS_URL = typeof __EBS_URL__ !== 'undefined' ? __EBS_URL__ : window.location.origin;
const API_HOST = EBS_URL;
const WS_HOST = API_HOST.replace(/^http/, 'ws');

// Auto-refresh intervals in ms
const AUTO_REFRESH_INTERVALS = {
    gameState: 60 * 1000,      // Full state every 60 seconds
    gardenCheck: 10 * 1000,    // Check garden status every 10 seconds
};

class CertiFriedApp {
    constructor() {
        this.initialized = false;
        this.twitchAuth = null;
        this._autoRefreshTimers = {};
    }

    /**
     * Initialize the application
     */
    async init() {
        if (this.initialized) return;

        console.log('[CFX] Initializing...', {
            isExtension: IS_EXTENSION,
            apiHost: API_HOST
        });

        // Set API base URL for standalone mode
        if (!IS_EXTENSION) {
            api.setBaseUrl(`${API_HOST}/api/v1`);
        }

        // Initialize based on mode
        if (IS_EXTENSION) {
            await this._initExtensionMode();
        } else {
            await this._initStandaloneMode();
        }

        this._setupGlobalHandlers();
        this.initialized = true;

        // Dispatch app ready event
        document.dispatchEvent(new CustomEvent('cfx:ready'));
    }

    /**
     * Initialize in Twitch Extension mode
     */
    async _initExtensionMode() {
        return new Promise((resolve) => {
            store.set('auth.mode', 'extension');

            window.Twitch.ext.onAuthorized((auth) => {
                console.log('[CFX] Twitch authorized', {
                    channelId: auth.channelId,
                    userId: auth.userId
                });

                this.twitchAuth = auth;

                store.merge('auth', {
                    token: auth.token,
                    channel: {
                        id: auth.channelId,
                        name: null  // Will be populated from context
                    }
                });

                // Load game state and connect WS
                this._loadGameState()
                    .then(() => this._connectWebSocket())
                    .then(resolve);
            });

            // Listen for context updates
            window.Twitch.ext.onContext((context) => {
                console.log('[CFX] Twitch context:', context.mode);
                // context.mode: 'viewer', 'dashboard', 'config'
            });

            // Listen for Bits transactions
            if (window.Twitch.ext.bits) {
                window.Twitch.ext.bits.onTransactionComplete((transaction) => {
                    this._handleBitsTransaction(transaction);
                });
            }

            // Listen for errors
            window.Twitch.ext.onError((error) => {
                console.error('[CFX] Twitch error:', error);
            });
        });
    }

    /**
     * Initialize in standalone web mode
     */
    async _initStandaloneMode() {
        store.set('auth.mode', 'standalone');

        // Check for existing session
        const token = localStorage.getItem('cfx_token');

        if (token) {
            store.merge('auth', {
                token,
                isAuthenticated: true
            });

            try {
                await this._loadGameState();
                await this._connectWebSocket();
            } catch (error) {
                if (error.status === 401) {
                    // Token expired, clear and redirect to login
                    localStorage.removeItem('cfx_token');
                    store.set('auth.isAuthenticated', false);
                }
            }
        }
    }

    /**
     * Load full game state from API
     * @param {boolean} showLoading - Whether to show loading spinners (default: true for initial load only)
     */
    async _loadGameState(showLoading = true) {
        try {
            // Only show loading spinners for initial load, not background refreshes
            if (showLoading) {
                store.set('garden.isLoading', true);
                store.set('inventory.isLoading', true);
            }

            const gameState = await api.getGameState();

            store.loadGameState(gameState);
            store.set('auth.isAuthenticated', true);

            // Load automation settings from server (authoritative source)
            // Must happen before any component reads store.settings
            try {
                const settingsResult = await api.getSettings();
                if (settingsResult.settings) {
                    store.loadServerSettings(settingsResult.settings);
                }
            } catch (e) {
                console.warn('[CFX] Settings load failed, using defaults');
            }

            console.log('[CFX] Game state loaded', {
                level: gameState.player.level,
                plots: gameState.plots?.length
            });

            // Trigger prefetch of commonly-accessed data after initial load
            if (showLoading) {
                this._prefetchCommonData();
            }

            // Start auto-refresh for time-sensitive data
            this._startAutoRefresh();

        } catch (error) {
            console.error('[CFX] Failed to load game state:', error);
            throw error;

        } finally {
            if (showLoading) {
                store.set('garden.isLoading', false);
                store.set('inventory.isLoading', false);
            }
        }
    }

    /**
     * Prefetch commonly-accessed data in the background
     * This improves perceived performance when navigating to other tabs
     */
    async _prefetchCommonData() {
        // Wait a bit to not compete with initial render
        await new Promise(r => setTimeout(r, 500));

        // Prefetch data for common tabs in parallel
        // These all use getCached internally, so they'll be cached
        const prefetchPromises = [
            api.getMarketPrices().catch(() => {}),
            api.getStrainCollection().catch(() => {}),
            api.getShopItems().catch(() => {}),
            api.getAchievements().catch(() => {}),
        ];

        // Don't await - let these happen in background
        Promise.all(prefetchPromises).then(() => {
            console.log('[CFX] Common data prefetched');
        });
    }

    /**
     * Connect to WebSocket for real-time updates
     */
    async _connectWebSocket() {
        const playerId = store.get('player.id');
        if (!playerId) return;

        ws.connect(`${WS_HOST}/ws`);

        // Subscribe to player-specific channel
        ws.addEventListener('connected', () => {
            ws.subscribe(`player:${playerId}`);

            // Subscribe to global market updates
            ws.subscribe('market:prices');
        });
    }

    /**
     * Handle Bits transaction from Twitch
     */
    async _handleBitsTransaction(transaction) {
        console.log('[CFX] Bits transaction:', transaction);

        try {
            const result = await api.redeemBits(
                transaction.product.sku,
                transaction.transactionId
            );

            // Update premium currency
            if (result.premium_currency !== undefined) {
                store.set('player.premiumCurrency', result.premium_currency);
            }

            // Show success notification
            this._addNotification('success', `Purchased ${transaction.product.displayName}!`);

        } catch (error) {
            console.error('[CFX] Bits redemption failed:', error);
            this._addNotification('error', 'Purchase failed. Please contact support.');
        }
    }

    /**
     * Setup global event handlers
     */
    _setupGlobalHandlers() {
        // Handle visibility changes (pause/resume updates)
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {
                // Page hidden - pause auto-refresh
                this._stopAutoRefresh();
            } else {
                // Page visible - refresh state silently (no loading spinner) and restart auto-refresh
                this._loadGameState(false).catch(console.error);
                this._startAutoRefresh();
            }
        });

        // Handle beforeunload
        window.addEventListener('beforeunload', () => {
            ws.disconnect();
        });

        // Global error handler
        window.addEventListener('error', (event) => {
            console.error('[CFX] Global error:', event.error);
        });

        // Unhandled promise rejections
        window.addEventListener('unhandledrejection', (event) => {
            console.error('[CFX] Unhandled rejection:', event.reason);
        });

        // ============ Component Event Handlers ============
        // These handle events emitted by components that bubble up to document

        // Handle notification events from any component
        document.addEventListener('notification', (e) => {
            const { type, message } = e.detail || {};
            if (message) {
                this._addNotification(type || 'info', message);
            }
        });

        // Handle tab-change events from nav
        document.addEventListener('tab-change', (e) => {
            const { tab } = e.detail || {};
            if (tab) {
                store.set('ui.activeTab', tab);
            }
        });

        // Handle navigate events from components (AI Assistant, Dashboard, etc.)
        document.addEventListener('navigate', (e) => {
            const { view, subview } = e.detail || {};
            if (view) {
                // Set the main tab
                store.set('ui.activeTab', view);

                // If navigating to 'more' with a subview, set the subview
                if (view === 'more' && subview) {
                    store.set('ui.moreSubview', subview);
                }
            }
        });
    }

    /**
     * Add a notification toast
     * @param {string} type - 'success' | 'error' | 'warning' | 'info'
     * @param {string} message - Notification message
     */
    _addNotification(type, message) {
        const notifications = store.get('ui.notifications') || [];
        const id = Date.now();

        store.set('ui.notifications', [
            ...notifications,
            { id, type, message }
        ]);

        // Auto-dismiss after 5 seconds
        setTimeout(() => {
            const current = store.get('ui.notifications') || [];
            store.set('ui.notifications', current.filter(n => n.id !== id));
        }, 5000);
    }

    /**
     * Start OAuth flow (standalone mode)
     * @param {'twitch' | 'kick'} provider
     */
    startOAuth(provider) {
        if (IS_EXTENSION) {
            console.warn('[CFX] OAuth not available in extension mode');
            return;
        }

        const width = 500;
        const height = 700;
        const left = window.screenX + (window.outerWidth - width) / 2;
        const top = window.screenY + (window.outerHeight - height) / 2;

        const popup = window.open(
            `${API_HOST}/api/v1/auth/${provider}`,
            'cfx_oauth',
            `width=${width},height=${height},left=${left},top=${top}`
        );

        // Listen for OAuth completion
        const messageHandler = async (event) => {
            console.log('[CFX] Received postMessage:', event.origin, event.data);

            // Extract origin from API_HOST (strip path)
            const expectedOrigin = new URL(API_HOST).origin;
            console.log('[CFX] Expected origin:', expectedOrigin, 'Got:', event.origin);

            if (event.origin !== expectedOrigin) {
                console.log('[CFX] Origin mismatch, ignoring');
                return;
            }

            if (event.data?.type === 'cfx_oauth_success') {
                console.log('[CFX] OAuth success received!');
                const { token } = event.data;

                localStorage.setItem('cfx_token', token);
                // Set token but NOT isAuthenticated yet
                store.merge('auth', { token });

                try {
                    await this._loadGameState();
                    await this._connectWebSocket();
                    // Only set authenticated AFTER game state loads successfully
                    store.set('auth.isAuthenticated', true);
                } catch (err) {
                    console.error('[CFX] Post-auth error:', err);
                    localStorage.removeItem('cfx_token');
                    store.merge('auth', { token: null, isAuthenticated: false });
                    alert('Failed to load game. Please try again.');
                }

                popup?.close();
                window.removeEventListener('message', messageHandler);
            }
        };

        window.addEventListener('message', messageHandler);
        console.log('[CFX] OAuth message listener registered');

        // Fallback: Check localStorage periodically for token (in case opener is lost)
        const checkLocalStorage = setInterval(async () => {
            const oauthToken = localStorage.getItem('cfx_oauth_token');
            if (oauthToken) {
                console.log('[CFX] Found token in localStorage fallback');
                localStorage.removeItem('cfx_oauth_token');
                clearInterval(checkLocalStorage);
                window.removeEventListener('message', messageHandler);

                localStorage.setItem('cfx_token', oauthToken);
                // Set token but NOT isAuthenticated yet
                store.merge('auth', { token: oauthToken });

                try {
                    await this._loadGameState();
                    await this._connectWebSocket();
                    // Only set authenticated AFTER game state loads successfully
                    store.set('auth.isAuthenticated', true);
                } catch (err) {
                    console.error('[CFX] Post-auth error:', err);
                    localStorage.removeItem('cfx_token');
                    store.merge('auth', { token: null, isAuthenticated: false });
                    alert('Failed to load game. Please try again.');
                }

                popup?.close();
            }
        }, 500);

        // Stop checking after 5 minutes
        setTimeout(() => {
            clearInterval(checkLocalStorage);
            window.removeEventListener('message', messageHandler);
        }, 300000);
    }

    /**
     * Logout (standalone mode)
     */
    logout() {
        this._stopAutoRefresh();
        localStorage.removeItem('cfx_token');
        ws.disconnect();
        store.reset();
    }

    /**
     * Start auto-refresh timers for time-sensitive data
     */
    _startAutoRefresh() {
        if (!store.get('auth.isAuthenticated')) return;

        // Stop any existing timers first
        this._stopAutoRefresh();

        // Full game state refresh (less frequent) - silent refresh, no loading spinner
        this._autoRefreshTimers.gameState = setInterval(() => {
            if (!document.hidden && store.get('auth.isAuthenticated')) {
                this._loadGameState(false).catch(console.error);
            }
        }, AUTO_REFRESH_INTERVALS.gameState);

        // Garden status check (more frequent for time-sensitive plants)
        this._autoRefreshTimers.gardenCheck = setInterval(() => {
            if (!document.hidden && store.get('auth.isAuthenticated')) {
                this._checkGardenStatus();
            }
        }, AUTO_REFRESH_INTERVALS.gardenCheck);

        console.log('[CFX] Auto-refresh started');
    }

    /**
     * Stop all auto-refresh timers
     */
    _stopAutoRefresh() {
        for (const key of Object.keys(this._autoRefreshTimers)) {
            clearInterval(this._autoRefreshTimers[key]);
        }
        this._autoRefreshTimers = {};
    }

    /**
     * Check garden status and update any completed plants
     * This uses local time calculations to avoid API calls
     */
    _checkGardenStatus() {
        const plots = store.get('garden.plots') || [];
        const now = Date.now();
        let hasChanges = false;

        const updatedPlots = plots.map(plot => {
            if (plot.status === 'growing') {
                const readyAt = new Date(plot.readyAt).getTime();
                const witherAt = plot.witherAt ? new Date(plot.witherAt).getTime() : null;

                if (now >= readyAt && plot.status !== 'ready') {
                    hasChanges = true;
                    return { ...plot, status: 'ready' };
                }

                if (witherAt && now >= witherAt && plot.status !== 'withered') {
                    hasChanges = true;
                    return { ...plot, status: 'withered' };
                }
            }
            return plot;
        });

        if (hasChanges) {
            store.set('garden.plots', updatedPlots);
            console.log('[CFX] Garden status updated locally');
        }
    }

    /**
     * Refresh game state
     */
    async refresh() {
        await this._loadGameState();
    }

    /**
     * Get current mode
     */
    get mode() {
        return IS_EXTENSION ? 'extension' : 'standalone';
    }

    /**
     * Check if authenticated
     */
    get isAuthenticated() {
        return store.get('auth.isAuthenticated');
    }
}

// Singleton instance
export const app = new CertiFriedApp();

// Re-export store for standalone.html
export { store };

// Auto-initialize when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => app.init());
} else {
    app.init();
}

export default app;
