/**
 * CertiFried Dashboard Socket.io Client
 * Handles real-time communication with the server
 */

class DashboardSocket {
    constructor() {
        this.socket = null;
        this.currentGuildId = null;
        this.listeners = new Map();
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 5;
        this.isConnected = false;
    }

    /**
     * Initialize socket connection
     */
    init() {
        if (typeof io === 'undefined') {
            console.error('[Socket] Socket.io client not loaded');
            return;
        }

        this.socket = io({
            transports: ['websocket', 'polling'],
            reconnection: true,
            reconnectionAttempts: this.maxReconnectAttempts,
            reconnectionDelay: 1000,
            reconnectionDelayMax: 5000
        });

        this._setupEventHandlers();
        console.log('[Socket] Initialized');
    }

    /**
     * Setup core event handlers
     */
    _setupEventHandlers() {
        this.socket.on('connect', () => {
            console.log('[Socket] Connected');
            this.isConnected = true;
            this.reconnectAttempts = 0;

            // Rejoin guild room if we were in one
            if (this.currentGuildId) {
                this.joinGuild(this.currentGuildId);
            }

            // Dispatch custom event
            window.dispatchEvent(new CustomEvent('socket:connected'));
        });

        this.socket.on('disconnect', (reason) => {
            console.log('[Socket] Disconnected:', reason);
            this.isConnected = false;
            window.dispatchEvent(new CustomEvent('socket:disconnected', { detail: { reason } }));
        });

        this.socket.on('connect_error', (error) => {
            console.error('[Socket] Connection error:', error.message);
            this.reconnectAttempts++;

            if (this.reconnectAttempts >= this.maxReconnectAttempts) {
                console.error('[Socket] Max reconnection attempts reached');
                window.dispatchEvent(new CustomEvent('socket:failed'));
            }
        });

        // Config events
        this.socket.on('config:saved', (data) => {
            this._emit('config:saved', data);
            this._showToast('success', `${data.feature} settings saved`);
        });

        this.socket.on('config:error', (data) => {
            this._emit('config:error', data);
            this._showToast('error', `Error saving ${data.feature}: ${data.error}`);
        });

        // Stats events
        this.socket.on('stats:update', (data) => {
            this._emit('stats:update', data);
        });

        this.socket.on('stats:members', (data) => {
            this._emit('stats:members', data);
            this._updateMemberCount(data);
        });

        // Moderation events
        this.socket.on('moderation:action', (data) => {
            this._emit('moderation:action', data);
        });

        this.socket.on('moderation:automod', (data) => {
            this._emit('moderation:automod', data);
        });

        // Security events
        this.socket.on('security:raid-detected', (data) => {
            this._emit('security:raid-detected', data);
            this._showToast('warning', 'Raid detected! Check security settings.');
        });

        this.socket.on('security:alert', (data) => {
            this._emit('security:alert', data);
        });

        // Stream events
        this.socket.on('stream:live', (data) => {
            this._emit('stream:live', data);
        });

        this.socket.on('stream:offline', (data) => {
            this._emit('stream:offline', data);
        });

        // Bot status events
        this.socket.on('bot:status', (data) => {
            this._emit('bot:status', data);
            this._updateBotStatus(data);
        });

        // User notifications
        this.socket.on('notification', (data) => {
            this._emit('notification', data);
            this._showToast(data.type, data.message);
        });

        // Ticket events
        this.socket.on('ticket:created', (data) => {
            this._emit('ticket:created', data);
        });

        this.socket.on('ticket:updated', (data) => {
            this._emit('ticket:updated', data);
        });

        // Giveaway events
        this.socket.on('giveaway:ended', (data) => {
            this._emit('giveaway:ended', data);
        });
    }

    /**
     * Join a guild room to receive guild-specific events
     * @param {string} guildId - Guild ID
     */
    joinGuild(guildId) {
        if (!guildId) return;

        // Leave previous guild room
        if (this.currentGuildId && this.currentGuildId !== guildId) {
            this.leaveGuild(this.currentGuildId);
        }

        this.currentGuildId = guildId;
        this.socket.emit('join:guild', guildId);
        console.log('[Socket] Joined guild:', guildId);
    }

    /**
     * Leave a guild room
     * @param {string} guildId - Guild ID
     */
    leaveGuild(guildId) {
        if (!guildId) return;
        this.socket.emit('leave:guild', guildId);
        console.log('[Socket] Left guild:', guildId);
    }

    /**
     * Register event listener
     * @param {string} event - Event name
     * @param {Function} callback - Callback function
     */
    on(event, callback) {
        if (!this.listeners.has(event)) {
            this.listeners.set(event, []);
        }
        this.listeners.get(event).push(callback);
    }

    /**
     * Remove event listener
     * @param {string} event - Event name
     * @param {Function} callback - Callback function
     */
    off(event, callback) {
        if (!this.listeners.has(event)) return;

        const callbacks = this.listeners.get(event);
        const index = callbacks.indexOf(callback);
        if (index > -1) {
            callbacks.splice(index, 1);
        }
    }

    /**
     * Emit event to registered listeners
     * @param {string} event - Event name
     * @param {any} data - Event data
     */
    _emit(event, data) {
        if (!this.listeners.has(event)) return;

        this.listeners.get(event).forEach(callback => {
            try {
                callback(data);
            } catch (error) {
                console.error(`[Socket] Error in listener for ${event}:`, error);
            }
        });
    }

    /**
     * Send config update to server
     * @param {string} feature - Feature name
     * @param {Object} config - Config data
     */
    updateConfig(feature, config) {
        this.socket.emit('config:update', {
            guildId: this.currentGuildId,
            feature,
            config
        });
    }

    /**
     * Show toast notification
     * @param {string} type - Toast type (success, error, warning, info)
     * @param {string} message - Toast message
     */
    _showToast(type, message) {
        if (typeof showToast === 'function') {
            showToast(type, message);
        } else {
            console.log(`[Toast ${type}] ${message}`);
        }
    }

    /**
     * Update member count display
     * @param {Object} data - Member count data
     */
    _updateMemberCount(data) {
        const totalEl = document.querySelector('[data-stat="total-members"]');
        const onlineEl = document.querySelector('[data-stat="online-members"]');

        if (totalEl) totalEl.textContent = data.totalMembers.toLocaleString();
        if (onlineEl) onlineEl.textContent = data.onlineMembers.toLocaleString();
    }

    /**
     * Update bot status indicator
     * @param {Object} data - Bot status data
     */
    _updateBotStatus(data) {
        const statusEl = document.querySelector('[data-bot-status]');
        if (statusEl) {
            statusEl.className = `status-dot status-${data.status === 'online' ? 'online' : 'offline'}`;
            statusEl.title = `Bot ${data.status}`;
        }
    }

    /**
     * Check if connected
     * @returns {boolean}
     */
    get connected() {
        return this.isConnected;
    }
}

// Create global instance
const dashboardSocket = new DashboardSocket();

// Auto-initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    dashboardSocket.init();

    // Auto-join guild if on manage page
    const guildIdMatch = window.location.pathname.match(/\/manage\/(\d+)/);
    if (guildIdMatch) {
        dashboardSocket.joinGuild(guildIdMatch[1]);
    }
});

// Export for module usage
if (typeof module !== 'undefined' && module.exports) {
    module.exports = dashboardSocket;
}
