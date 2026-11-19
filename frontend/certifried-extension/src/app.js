/**
 * CertiFried Extension - Main Application Bootstrap
 * Handles initialization, mode detection, and auth flow
 */

import { store } from './state/store.js';
import { api } from './api/client.js';
import { ws } from './api/websocket.js';

// Detect environment
const IS_EXTENSION = window.Twitch?.ext !== undefined;
// Where the game server is reached.
//  - Twitch panel: the page lives on Twitch's CDN, so the EBS URL baked in at build time
//    (__EBS_URL__, default https://certifriedmultitool.com/cfx-api) is used for every call.
//  - Website: same origin, /cfx-api. The site's front server sends /cfx-api/* (and /cfx/*) to the game
//    server directly, so /cfx-api is the one address that reaches the API from every page (H-628).
const BUILD_EBS = typeof __EBS_URL__ !== 'undefined' && __EBS_URL__ ? __EBS_URL__ : 'https://certifriedmultitool.com/cfx-api';
const EBS_URL = IS_EXTENSION
    ? BUILD_EBS
    : `${window.location.origin}/cfx-api`;
const API_HOST = EBS_URL;
const WS_HOST = API_HOST.replace(/^http/, 'ws');
// Website sign-in (Twitch/Kick OAuth) is served by the game server at the old public path,
// because that is the redirect address registered with Twitch and Kick.
const OAUTH_HOST = IS_EXTENSION ? BUILD_EBS : `${window.location.origin}/cfx-api`;

// Shown when the game server says the game is frozen but gives no text (H-636)
const FROZEN_FALLBACK = 'CertiFried Tycoon is being rebuilt. The new game is coming soon.';

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

        // Absolute API base in both modes (the panel used to call /api/v1 on Twitch's CDN, H-404)
        api.setBaseUrl(`${API_HOST}/api/v1`);

        // CertiFried Tycoon is frozen until v2 (H-636). One cheap public check decides whether the game
        // starts at all; while frozen there is no sign-in, polling or WebSocket, only the frozen screen.
        if (await this._checkFrozen()) {
            this.initialized = true;
            document.dispatchEvent(new CustomEvent('cfx:ready'));
            return;
        }
        // A FROZEN answer later (frozen while this page was open) stops everything too
        store.subscribe('ui.frozen', (message) => { if (message) this._enterFrozen(); });

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
     * Ask the game server whether the game is frozen (GET /api/v1/status, public, no auth).
     * No answer (network error, or a server without /status): start normally; a 503 FROZEN on any
     * later request still switches to the frozen screen.
     */
    async _checkFrozen() {
        try {
            const res = await fetch(`${API_HOST}/api/v1/status`, { headers: { Accept: 'application/json' }, cache: 'no-store' });
            const body = await res.json().catch(() => null);
            if (body?.frozen || body?.code === 'FROZEN') {
                store.set('ui.frozen', body.message || FROZEN_FALLBACK);
                return true;
            }
        } catch { /* unknown: start normally */ }
        return false;
    }

    /** Frozen while running: stop refreshing, close live updates for good, drop pending toasts. */
    _enterFrozen() {
        this._stopAutoRefresh();
        ws.disconnect();
        store.set('ui.notifications', []);
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

                // auth.userId is always the opaque id ("U..." signed in, "A..." signed out), even after the
                // viewer shares their identity. The real Twitch id is Twitch.ext.viewer.id, and the token
                // carries user_id, which the server requires (H-404, H-634).
                let tokenUserId = null;
                try {
                    const part = String(auth.token || '').split('.')[1] || '';
                    tokenUserId = JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/'))).user_id || null;
                } catch { /* unreadable token: rely on viewer.id */ }
                const linkedId = window.Twitch.ext.viewer?.id || tokenUserId;
                const signedOut = String(auth.userId || '').startsWith('A');
                if (!linkedId) {
                    store.merge('auth', { token: auth.token, needsIdentity: true, signedOut, isAuthenticated: false });
                    resolve();
                    return;
                }
                store.set('auth.signedOut', false);
                store.set('auth.needsIdentity', false);

                store.merge('auth', {
                    token: auth.token,
                    channel: {
                        id: auth.channelId,
                        name: null  // Will be populated from context
                    }
                });

                // Load game state and connect WS
                this._loadGameState()
                    .then(() => {
                        store.set('ui.connectionError', null);
                        return this._connectWebSocket();
                    })
                    .catch((error) => {
                        if (error?.data?.code !== 'FROZEN') console.error('[CFX] Panel load failed:', error);
                        store.set('ui.connectionError', error?.data?.code === 'BANNED'
                            ? 'This account is banned from the game.'
                            : 'The game could not load. Try again in a minute.');
                    })
                    .finally(resolve);
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
        const refreshToken = localStorage.getItem('cfx_refresh');
        const params = new URLSearchParams(window.location.search);
        if (params.has('signin')) {
            // Back from the dashboard's Discord login (/game?signin=discord)
            const provider = params.get('signin');
            params.delete('signin');
            const qs = params.toString();
            window.history.replaceState(null, '', window.location.pathname + (qs ? `?${qs}` : ''));
            if (!token && provider === 'discord') {
                try {
                    await this.startDiscordSignIn();
                } catch (error) {
                    console.error('[CFX] Discord sign-in failed:', error);
                }
                return;
            }
        }

        if (token) {
            store.merge('auth', {
                token,
                refreshToken,
                isAuthenticated: true
            });

            try {
                await this._loadGameState();
                await this._connectWebSocket();
            } catch (error) {
                if (error.status === 401) {
                    // Token expired and could not be refreshed: back to the sign-in screen
                    localStorage.removeItem('cfx_token');
                    localStorage.removeItem('cfx_refresh');
                    store.merge('auth', { token: null, refreshToken: null, isAuthenticated: false });
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
            if (error?.data?.code !== 'FROZEN') console.error('[CFX] Failed to load game state:', error);
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
            // The server only trusts the receipt Twitch signed (H-401)
            const result = await api.redeemBits(transaction.transactionReceipt);

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
            } else if (!store.get('ui.frozen')) {
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
     * Finish a website sign-in: keep both tokens, load the game, connect live updates.
     */
    async _completeSignIn(token, refreshToken) {
        try {
            localStorage.setItem('cfx_token', token);
            if (refreshToken) localStorage.setItem('cfx_refresh', refreshToken);
        } catch (e) { /* private mode: this tab still works */ }
        store.merge('auth', { token, refreshToken: refreshToken || null });
        try {
            await this._loadGameState();
            await this._connectWebSocket();
            // Only set authenticated AFTER game state loads successfully
            store.set('auth.isAuthenticated', true);
        } catch (err) {
            console.error('[CFX] Post-auth error:', err);
            localStorage.removeItem('cfx_token');
            localStorage.removeItem('cfx_refresh');
            store.merge('auth', { token: null, refreshToken: null, isAuthenticated: false });
            store.set('ui.connectionError', 'The game did not load. Try signing in again.');
        }
    }

    /**
     * Sign in with the Discord account logged in to the dashboard (website only).
     * Not logged in yet: go through the dashboard's Discord login and come back.
     */
    async startDiscordSignIn() {
        if (IS_EXTENSION) return;
        // /game/* reaches the dashboard (which holds the Discord login); /cfx/* goes to the game server (H-628).
        const response = await fetch(`${window.location.origin}/game/session/discord`, {
            credentials: 'same-origin',
            headers: { Accept: 'application/json' }
        });
        const data = await response.json().catch(() => ({}));
        if (response.status === 401) {
            window.location.href = data.loginUrl || '/auth/discord?returnTo=%2Fgame%3Fsignin%3Ddiscord';
            return;
        }
        if (!response.ok || !data.token) {
            store.set('ui.connectionError', data.error || 'Discord sign-in failed. Try again.');
            return;
        }
        await this._completeSignIn(data.token, data.refreshToken);
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
            `${OAUTH_HOST}/api/v1/auth/${provider}`,
            'cfx_oauth',
            `width=${width},height=${height},left=${left},top=${top}`
        );

        let done = false;
        const finish = async (token, refreshToken) => {
            if (done || !token) return;
            done = true;
            clearInterval(checkLocalStorage);
            window.removeEventListener('message', messageHandler);
            localStorage.removeItem('cfx_oauth_token');
            localStorage.removeItem('cfx_oauth_refresh');
            await this._completeSignIn(token, refreshToken);
            try { popup?.close(); } catch (e) { /* already closed */ }
        };

        // The sign-in page posts the tokens back...
        const messageHandler = (event) => {
            if (event.origin !== window.location.origin) return;
            if (event.data?.type === 'cfx_oauth_success') {
                finish(event.data.token, event.data.refreshToken);
            }
        };
        window.addEventListener('message', messageHandler);

        // ...or, when the popup lost its link to this tab, leaves them in localStorage
        const checkLocalStorage = setInterval(() => {
            const oauthToken = localStorage.getItem('cfx_oauth_token');
            if (oauthToken) finish(oauthToken, localStorage.getItem('cfx_oauth_refresh'));
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
        localStorage.removeItem('cfx_refresh');
        ws.disconnect();
        store.reset();
    }

    /**
     * Start auto-refresh timers for time-sensitive data
     */
    _startAutoRefresh() {
        if (!store.get('auth.isAuthenticated') || store.get('ui.frozen')) return;

        // Stop any existing timers first
        this._stopAutoRefresh();

        // Restart these timers whenever live updates come or go (H-629): without them, refresh every 15 s.
        if (!this._liveModeWatch) {
            this._liveModeWatch = true;
            store.subscribe('ui.liveMode', () => { if (store.get('auth.isAuthenticated')) this._startAutoRefresh(); });
        }
        const polling = store.get('ui.liveMode') === 'polling';

        // Full game state refresh (less frequent) - silent refresh, no loading spinner
        this._autoRefreshTimers.gameState = setInterval(() => {
            if (!document.hidden && store.get('auth.isAuthenticated')) {
                this._loadGameState(false).catch(console.error);
            }
        }, polling ? 15 * 1000 : AUTO_REFRESH_INTERVALS.gameState);

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
