/**
 * CertiFried Extension - WebSocket Client
 * Handles real-time updates with auto-reconnect and heartbeat
 */

import { store } from '../state/store.js';

const HEARTBEAT_INTERVAL = 25000;  // 25 seconds
const RECONNECT_DELAYS = [1000, 2000, 5000, 10000, 30000];
const MAX_RECONNECT_ATTEMPTS = 10;

class WebSocketClient extends EventTarget {
    constructor() {
        super();

        this.ws = null;
        this.url = null;
        this.heartbeatTimer = null;
        this.reconnectTimer = null;
        this.reconnectAttempt = 0;
        this.isIntentionallyClosed = false;
        this.subscribedChannels = new Set();
        this.messageQueue = [];
    }

    /**
     * Connect to WebSocket server
     * @param {string} url - WebSocket URL
     */
    connect(url) {
        if (this.ws?.readyState === WebSocket.OPEN) {
            console.log('[WS] Already connected');
            return;
        }

        this.url = url;
        this.isIntentionallyClosed = false;

        // Add auth token to URL
        const { mode, token } = store.get('auth');
        const separator = url.includes('?') ? '&' : '?';

        let authUrl = url;
        if (mode === 'extension' && token) {
            authUrl = `${url}${separator}ext_token=${encodeURIComponent(token)}`;
        } else if (mode === 'standalone' && token) {
            authUrl = `${url}${separator}token=${encodeURIComponent(token)}`;
        }

        try {
            this.ws = new WebSocket(authUrl);
            this._setupEventHandlers();
        } catch (error) {
            console.error('[WS] Connection failed:', error);
            this._scheduleReconnect();
        }
    }

    _setupEventHandlers() {
        this.ws.onopen = () => {
            console.log('[WS] Connected');
            this.reconnectAttempt = 0;
            store.set('ui.isConnected', true);
            store.set('ui.connectionError', null);

            this._startHeartbeat();
            this._resubscribeChannels();
            this._flushMessageQueue();

            this.dispatchEvent(new CustomEvent('connected'));
        };

        this.ws.onclose = (event) => {
            console.log('[WS] Disconnected:', event.code, event.reason);
            store.set('ui.isConnected', false);

            this._stopHeartbeat();

            if (!this.isIntentionallyClosed) {
                this._scheduleReconnect();
            }

            this.dispatchEvent(new CustomEvent('disconnected', {
                detail: { code: event.code, reason: event.reason }
            }));
        };

        this.ws.onerror = (error) => {
            console.error('[WS] Error:', error);
            store.set('ui.connectionError', 'Connection error');
        };

        this.ws.onmessage = (event) => {
            try {
                const message = JSON.parse(event.data);
                this._handleMessage(message);
            } catch (error) {
                console.error('[WS] Failed to parse message:', error);
            }
        };
    }

    _handleMessage(message) {
        const { type, data, channel } = message;

        // Handle batched events from server
        if (type === 'batch' && Array.isArray(message.events)) {
            // Begin batch mode to coalesce store updates
            store.beginBatch?.();
            try {
                for (const event of message.events) {
                    this._handleMessage(event);
                }
            } finally {
                // End batch mode - triggers single update notification
                store.endBatch?.();
            }
            return;
        }

        switch (type) {
            case 'pong':
                // Heartbeat response - connection is alive
                break;

            case 'subscribed':
                console.log('[WS] Subscribed to:', data.channel);
                break;

            case 'unsubscribed':
                console.log('[WS] Unsubscribed from:', data.channel);
                break;

            case 'error':
                console.error('[WS] Server error:', data.message);
                store.set('ui.connectionError', data.message);
                break;

            // Game events
            case 'plot:updated':
                this._handlePlotUpdate(data);
                break;

            case 'plot:ready':
                this._handlePlotReady(data);
                break;

            case 'plot:withered':
                this._handlePlotWithered(data);
                break;

            case 'inventory:updated':
                this._handleInventoryUpdate(data);
                break;

            case 'currency:updated':
                this._handleCurrencyUpdate(data);
                break;

            case 'xp:gained':
                this._handleXpGained(data);
                break;

            case 'level:up':
                this._handleLevelUp(data);
                break;

            case 'quest:progress':
                this._handleQuestProgress(data);
                break;

            case 'quest:completed':
                this._handleQuestCompleted(data);
                break;

            case 'market:price_update':
                this._handleMarketPriceUpdate(data);
                break;

            case 'trade:received':
                this._handleTradeReceived(data);
                break;

            case 'breeding:complete':
                this._handleBreedingComplete(data);
                break;

            case 'achievement:unlocked':
                this._handleAchievementUnlocked(data);
                break;

            case 'notification':
                this._handleNotification(data);
                break;

            default:
                // Dispatch custom event for unknown types
                this.dispatchEvent(new CustomEvent(`message:${type}`, {
                    detail: { data, channel }
                }));
        }

        // Always dispatch raw message event
        this.dispatchEvent(new CustomEvent('message', {
            detail: message
        }));
    }

    // ============ Game Event Handlers ============

    _handlePlotUpdate(data) {
        const plots = store.get('garden.plots');
        const index = plots.findIndex(p => p.id === data.plot_id);

        if (index !== -1) {
            const updatedPlots = [...plots];
            updatedPlots[index] = { ...updatedPlots[index], ...data };
            store.set('garden.plots', updatedPlots);
        }
    }

    _handlePlotReady(data) {
        this._handlePlotUpdate({ ...data, is_ready: true });
        this._addNotification('success', `${data.strain_name} is ready to harvest!`);
    }

    _handlePlotWithered(data) {
        this._handlePlotUpdate({ ...data, is_withered: true });
        this._addNotification('warning', `${data.strain_name} has withered!`);
    }

    _handleInventoryUpdate(data) {
        const items = store.get('inventory.items') || [];

        // Support both snake_case (from WS) and camelCase (from REST API)
        const dataStrainId = data.strain_id || data.strainId;

        const index = items.findIndex(i => {
            const itemStrainId = i.strain_id || i.strainId;
            return itemStrainId === dataStrainId && i.quality === data.quality;
        });

        if (index !== -1) {
            const updatedItems = [...items];
            if (data.quantity <= 0) {
                updatedItems.splice(index, 1);
            } else {
                // Merge data but normalize to camelCase
                updatedItems[index] = {
                    ...updatedItems[index],
                    ...data,
                    strainId: dataStrainId  // Ensure camelCase
                };
            }
            store.set('inventory.items', updatedItems);
        } else if (data.quantity > 0) {
            // Normalize new item to camelCase
            store.set('inventory.items', [...items, {
                ...data,
                strainId: dataStrainId  // Ensure camelCase
            }]);
        }
    }

    _handleCurrencyUpdate(data) {
        if (data.currency !== undefined) {
            store.set('player.currency', data.currency);
        }
        if (data.premium_currency !== undefined) {
            store.set('player.premiumCurrency', data.premium_currency);
        }
    }

    _handleXpGained(data) {
        store.set('player.xp', data.current_xp);
        this._addNotification('info', `+${data.amount} XP`);
    }

    _handleLevelUp(data) {
        store.set('player.level', data.new_level);
        store.set('player.xpToNextLevel', data.xp_to_next);
        this._addNotification('success', `Level Up! You're now level ${data.new_level}!`);
    }

    _handleQuestProgress(data) {
        const dailyQuests = store.get('quests.daily');
        const weeklyQuests = store.get('quests.weekly');

        const updateQuest = (quests, setter) => {
            const index = quests.findIndex(q => q.id === data.quest_id);
            if (index !== -1) {
                const updated = [...quests];
                updated[index] = { ...updated[index], progress: data.progress };
                store.set(setter, updated);
            }
        };

        updateQuest(dailyQuests, 'quests.daily');
        updateQuest(weeklyQuests, 'quests.weekly');
    }

    _handleQuestCompleted(data) {
        this._addNotification('success', `Quest complete: ${data.quest_name}!`);
    }

    _handleMarketPriceUpdate(data) {
        const prices = store.get('market.prices');
        const index = prices.findIndex(p => p.strain_id === data.strain_id);

        if (index !== -1) {
            const updated = [...prices];
            updated[index] = { ...updated[index], ...data };
            store.set('market.prices', updated);
        }
    }

    _handleTradeReceived(data) {
        this._addNotification('info', `New trade offer from ${data.from_player}!`);
    }

    _handleBreedingComplete(data) {
        store.set('breeding.inProgress', null);
        this._addNotification('success', `Breeding complete! New strain: ${data.strain_name}`);
    }

    _handleAchievementUnlocked(data) {
        this._addNotification('success', `Achievement unlocked: ${data.name}!`);
    }

    _handleNotification(data) {
        this._addNotification(data.type || 'info', data.message);
    }

    _addNotification(type, message) {
        const notifications = store.get('ui.notifications');
        const id = Date.now();

        store.set('ui.notifications', [
            ...notifications,
            { id, type, message, timestamp: new Date() }
        ]);

        // Auto-remove after 5 seconds
        setTimeout(() => {
            const current = store.get('ui.notifications');
            store.set('ui.notifications', current.filter(n => n.id !== id));
        }, 5000);
    }

    // ============ Connection Management ============

    _startHeartbeat() {
        this._stopHeartbeat();

        this.heartbeatTimer = setInterval(() => {
            if (this.ws?.readyState === WebSocket.OPEN) {
                this.send({ type: 'ping' });
            }
        }, HEARTBEAT_INTERVAL);
    }

    _stopHeartbeat() {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
    }

    _scheduleReconnect() {
        if (this.reconnectTimer) return;
        if (this.reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
            console.error('[WS] Max reconnect attempts reached');
            store.set('ui.connectionError', 'Unable to connect. Please refresh the page.');
            return;
        }

        const delay = RECONNECT_DELAYS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS.length - 1)];
        console.log(`[WS] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempt + 1})`);

        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.reconnectAttempt++;
            this.connect(this.url);
        }, delay);
    }

    _resubscribeChannels() {
        for (const channel of this.subscribedChannels) {
            this.send({ type: 'subscribe', channel });
        }
    }

    _flushMessageQueue() {
        while (this.messageQueue.length > 0) {
            const message = this.messageQueue.shift();
            this.send(message);
        }
    }

    // ============ Public API ============

    /**
     * Send message through WebSocket
     * @param {object} message - Message to send
     */
    send(message) {
        if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(message));
        } else {
            // Queue message for when connected
            this.messageQueue.push(message);
        }
    }

    /**
     * Subscribe to a channel
     * @param {string} channel - Channel name
     */
    subscribe(channel) {
        this.subscribedChannels.add(channel);
        this.send({ type: 'subscribe', channel });
    }

    /**
     * Unsubscribe from a channel
     * @param {string} channel - Channel name
     */
    unsubscribe(channel) {
        this.subscribedChannels.delete(channel);
        this.send({ type: 'unsubscribe', channel });
    }

    /**
     * Close connection
     */
    disconnect() {
        this.isIntentionallyClosed = true;
        this._stopHeartbeat();

        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }

        if (this.ws) {
            this.ws.close(1000, 'Client disconnect');
            this.ws = null;
        }

        this.subscribedChannels.clear();
        this.messageQueue = [];
    }

    /**
     * Check if connected
     */
    get isConnected() {
        return this.ws?.readyState === WebSocket.OPEN;
    }
}

// Singleton instance
export const ws = new WebSocketClient();
export default ws;
