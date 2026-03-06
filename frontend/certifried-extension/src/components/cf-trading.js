/**
 * CertiFried Extension - Trading Component
 * Player-to-player item trading interface
 */

import { CFBaseComponent, registerComponent } from './base-component.js';
import { h } from '../utils/dom.js';
import { formatCurrency, formatQualityTier } from '../utils/format.js';
import { api } from '../api/client.js';
import { store } from '../state/store.js';

class CFTrading extends CFBaseComponent {
    constructor() {
        super();
        this._trades = [];
        this._isLoading = true;
        this._activeTab = 'received'; // 'received' | 'sent' | 'create'
        this._searchResults = [];
        this._selectedRecipient = null;
        this._selectedItems = [];
        this._offeredCash = 0;
    }

    _setupSubscriptions() {
        this.subscribe('inventory');
    }

    onMount() {
        this._loadTrades();

        // Tab switching
        this.on('click', '.cf-trading__tab', (e) => {
            const tab = e.target.closest('.cf-trading__tab');
            if (!tab) return;
            this._activeTab = tab.dataset.tab;
            if (this._activeTab !== 'create') {
                this._loadTrades();
            }
            this.render();
        });

        // Accept trade
        this.on('click', '.cf-trade__accept', async (e) => {
            const tradeId = parseInt(e.target.dataset.tradeId, 10);
            await this._acceptTrade(tradeId);
        });

        // Decline trade
        this.on('click', '.cf-trade__decline', async (e) => {
            const tradeId = parseInt(e.target.dataset.tradeId, 10);
            await this._declineTrade(tradeId);
        });

        // Cancel trade
        this.on('click', '.cf-trade__cancel', async (e) => {
            const tradeId = parseInt(e.target.dataset.tradeId, 10);
            await this._cancelTrade(tradeId);
        });

        // Search players
        this.on('input', '.cf-player-search', async (e) => {
            const query = e.target.value.trim();
            if (query.length >= 2) {
                await this._searchPlayers(query);
            } else {
                this._searchResults = [];
                this.render();
            }
        });

        // Select recipient
        this.on('click', '.cf-search-result', (e) => {
            const result = e.target.closest('.cf-search-result');
            if (!result) return;
            this._selectedRecipient = {
                id: parseInt(result.dataset.playerId, 10),
                name: result.dataset.playerName
            };
            this._searchResults = [];
            this.render();
        });

        // Clear recipient
        this.on('click', '.cf-clear-recipient', () => {
            this._selectedRecipient = null;
            this.render();
        });

        // Toggle item selection
        this.on('click', '.cf-selectable-item', (e) => {
            const item = e.target.closest('.cf-selectable-item');
            if (!item) return;
            const inventoryId = parseInt(item.dataset.inventoryId, 10);
            const idx = this._selectedItems.findIndex(i => i.inventoryId === inventoryId);
            if (idx >= 0) {
                this._selectedItems.splice(idx, 1);
            } else {
                this._selectedItems.push({ inventoryId, quantity: 1 });
            }
            this.render();
        });

        // Update item quantity
        this.on('change', '.cf-item-qty', (e) => {
            const inventoryId = parseInt(e.target.dataset.inventoryId, 10);
            const maxQty = parseInt(e.target.dataset.maxQty, 10);
            let quantity = parseInt(e.target.value, 10) || 1;
            quantity = Math.max(1, Math.min(maxQty, quantity));
            e.target.value = quantity;

            const item = this._selectedItems.find(i => i.inventoryId === inventoryId);
            if (item) {
                item.quantity = quantity;
            }
        });

        // Update offered cash
        this.on('input', '.cf-cash-offer', (e) => {
            this._offeredCash = Math.max(0, parseInt(e.target.value, 10) || 0);
        });

        // Send trade
        this.on('click', '.cf-send-trade', async () => {
            await this._sendTrade();
        });
    }

    async _loadTrades() {
        // Only show spinner on first load when we have no data
        const isFirstLoad = this._trades.length === 0;

        if (isFirstLoad) {
            this._isLoading = true;
            this.render();
        }

        try {
            const data = await api.getPendingTrades();
            this._trades = data.trades || [];

        } catch (error) {
            console.error('Failed to load trades:', error);
        } finally {
            this._isLoading = false;
            this.scheduleRender();
        }
    }

    async _acceptTrade(tradeId) {
        // Optimistic update - remove trade from list immediately
        const trade = this._trades.find(t => t.id === tradeId);
        const oldTrades = [...this._trades];
        this._trades = this._trades.filter(t => t.id !== tradeId);
        this.scheduleRender();

        try {
            await api.acceptTrade(tradeId);

            this.emit('notification', {
                type: 'success',
                message: 'Trade accepted!'
            });

            // Background refresh for inventory and trades
            api.getInventory().then(data => {
                this.setState('inventory.items', data.items || []);
            });
            this._loadTrades();

        } catch (error) {
            // Rollback on error
            this._trades = oldTrades;
            this.scheduleRender();
            this.emit('notification', {
                type: 'error',
                message: error.message || 'Failed to accept trade'
            });
        }
    }

    async _declineTrade(tradeId) {
        // Optimistic update - remove trade from list immediately
        const oldTrades = [...this._trades];
        this._trades = this._trades.filter(t => t.id !== tradeId);
        this.scheduleRender();

        try {
            await api.declineTrade(tradeId);

            this.emit('notification', {
                type: 'success',
                message: 'Trade declined'
            });

            // Background refresh
            this._loadTrades();

        } catch (error) {
            // Rollback on error
            this._trades = oldTrades;
            this.scheduleRender();
            this.emit('notification', {
                type: 'error',
                message: error.message || 'Failed to decline trade'
            });
        }
    }

    async _cancelTrade(tradeId) {
        // Optimistic update - remove trade from list immediately
        const oldTrades = [...this._trades];
        this._trades = this._trades.filter(t => t.id !== tradeId);
        this.scheduleRender();

        try {
            await api.cancelTrade(tradeId);

            this.emit('notification', {
                type: 'success',
                message: 'Trade cancelled'
            });

            // Background refresh
            this._loadTrades();

        } catch (error) {
            // Rollback on error
            this._trades = oldTrades;
            this.scheduleRender();
            this.emit('notification', {
                type: 'error',
                message: error.message || 'Failed to cancel trade'
            });
        }
    }

    async _searchPlayers(query) {
        try {
            const data = await api.searchPlayers(query);
            // Filter out current player
            const playerId = store.get('player.id');
            this._searchResults = (data.results || []).filter(p => p.id !== playerId);
            this.render();
        } catch (error) {
            console.error('Search failed:', error);
            this._searchResults = [];
        }
    }

    async _sendTrade() {
        if (!this._selectedRecipient) {
            this.emit('notification', { type: 'error', message: 'Select a recipient first' });
            return;
        }

        if (this._selectedItems.length === 0 && this._offeredCash === 0) {
            this.emit('notification', { type: 'error', message: 'Offer at least one item or cash' });
            return;
        }

        try {
            await api.createTrade(
                this._selectedRecipient.id,
                this._selectedItems,
                this._offeredCash
            );

            this.emit('notification', {
                type: 'success',
                message: `Trade offer sent to ${this._selectedRecipient.name}!`
            });

            // Reset form
            this._selectedRecipient = null;
            this._selectedItems = [];
            this._offeredCash = 0;
            this._activeTab = 'sent';
            await this._loadTrades();

        } catch (error) {
            this.emit('notification', {
                type: 'error',
                message: error.message || 'Failed to send trade'
            });
        }
    }

    render() {
        const playerId = store.get('player.id');
        const receivedTrades = this._trades.filter(t => !t.isOfferer);
        const sentTrades = this._trades.filter(t => t.isOfferer);
        const inventory = this.getState('inventory.items') || [];

        this.className = 'cf-section cf-trading';
        this.setContent(
            // Header
            h('div', { class: 'cf-section__header' },
                h('h2', { class: 'cf-section__title' }, 'Trading'),
                receivedTrades.length > 0 && h('span', {
                    class: 'cf-badge cf-badge--warning',
                    style: { marginLeft: '8px' }
                }, `${receivedTrades.length} incoming`)
            ),

            // Tabs
            h('div', { class: 'cf-tabs mb-3' },
                this._renderTab('received', `Received (${receivedTrades.length})`),
                this._renderTab('sent', `Sent (${sentTrades.length})`),
                this._renderTab('create', 'New Trade')
            ),

            // Content
            this._isLoading && this._activeTab !== 'create' && h('div', { class: 'cf-loading' },
                h('div', { class: 'cf-spinner' })
            ),

            !this._isLoading && this._activeTab === 'received' && this._renderReceivedTrades(receivedTrades),
            !this._isLoading && this._activeTab === 'sent' && this._renderSentTrades(sentTrades),
            this._activeTab === 'create' && this._renderCreateTrade(inventory)
        );
    }

    _renderTab(tab, label) {
        return h('button', {
            class: `cf-tab cf-trading__tab ${this._activeTab === tab ? 'cf-tab--active' : ''}`,
            dataset: { tab }
        }, label);
    }

    _renderReceivedTrades(trades) {
        if (trades.length === 0) {
            return h('div', { class: 'cf-empty' },
                h('p', { class: 'cf-empty__title' }, 'No incoming trades'),
                h('p', { class: 'cf-empty__description' }, 'Trade offers from other players will appear here')
            );
        }

        return h('div', { class: 'cf-trade-list' },
            ...trades.map(trade => this._renderTradeCard(trade, 'received'))
        );
    }

    _renderSentTrades(trades) {
        if (trades.length === 0) {
            return h('div', { class: 'cf-empty' },
                h('p', { class: 'cf-empty__title' }, 'No outgoing trades'),
                h('p', { class: 'cf-empty__description' }, 'Create a trade offer to send items to other players')
            );
        }

        return h('div', { class: 'cf-trade-list' },
            ...trades.map(trade => this._renderTradeCard(trade, 'sent'))
        );
    }

    _renderTradeCard(trade, type) {
        const isReceived = type === 'received';
        const otherPlayer = isReceived ? trade.offerer : trade.receiver;
        const items = trade.offererItems || [];

        return h('div', { class: 'cf-trade-card' },
            // Header
            h('div', { class: 'cf-trade-card__header' },
                h('span', { class: 'font-semibold' },
                    isReceived ? `From: ${otherPlayer.name}` : `To: ${otherPlayer?.name || 'Unknown'}`
                ),
                h('span', { class: 'text-xs text-muted' },
                    this._formatTimeAgo(trade.createdAt)
                )
            ),

            // Items offered
            h('div', { class: 'cf-trade-card__items' },
                items.length > 0 && h('div', { class: 'text-sm' },
                    h('span', { class: 'text-muted' }, 'Items: '),
                    items.map(item =>
                        h('span', { class: 'cf-badge cf-badge--primary mr-1' },
                            `${item.quantity}x #${item.inventoryId}`
                        )
                    )
                ),
                trade.offererCash > 0 && h('div', { class: 'text-sm' },
                    h('span', { class: 'text-muted' }, 'Cash: '),
                    h('span', { class: 'text-success font-semibold' }, formatCurrency(trade.offererCash))
                )
            ),

            // Actions
            h('div', { class: 'cf-trade-card__actions' },
                isReceived ? [
                    h('button', {
                        class: 'cf-btn cf-btn--primary cf-btn--sm cf-trade__accept',
                        dataset: { tradeId: trade.id.toString() }
                    }, 'Accept'),
                    h('button', {
                        class: 'cf-btn cf-btn--secondary cf-btn--sm cf-trade__decline',
                        dataset: { tradeId: trade.id.toString() }
                    }, 'Decline')
                ] : h('button', {
                    class: 'cf-btn cf-btn--secondary cf-btn--sm cf-trade__cancel',
                    dataset: { tradeId: trade.id.toString() }
                }, 'Cancel')
            )
        );
    }

    _renderCreateTrade(inventory) {
        const playerCash = store.get('player.currency') || 0;

        return h('div', { class: 'cf-create-trade' },
            // Recipient selector
            h('div', { class: 'cf-form-group mb-4' },
                h('label', { class: 'cf-label' }, 'Send To'),
                this._selectedRecipient
                    ? h('div', { class: 'cf-selected-recipient' },
                        h('span', { class: 'font-semibold' }, this._selectedRecipient.name),
                        h('button', {
                            class: 'cf-btn cf-btn--sm cf-clear-recipient ml-2',
                            style: { padding: '2px 8px' }
                        }, 'Change')
                    )
                    : [
                        h('input', {
                            type: 'text',
                            class: 'cf-input cf-player-search',
                            placeholder: 'Search player name...'
                        }),
                        this._searchResults.length > 0 && h('div', { class: 'cf-search-results' },
                            ...this._searchResults.map(p =>
                                h('div', {
                                    class: 'cf-search-result',
                                    dataset: { playerId: p.id.toString(), playerName: p.displayName }
                                },
                                    h('span', {}, p.displayName),
                                    h('span', { class: 'text-xs text-muted' }, `Lv.${p.level}`)
                                )
                            )
                        )
                    ]
            ),

            // Item selection
            h('div', { class: 'cf-form-group mb-4' },
                h('label', { class: 'cf-label' }, 'Offer Items'),
                inventory.length > 0
                    ? h('div', { class: 'cf-selectable-items' },
                        ...inventory.map(item => {
                            const isSelected = this._selectedItems.some(i => i.inventoryId === item.id);
                            const selectedItem = this._selectedItems.find(i => i.inventoryId === item.id);
                            const qualityInfo = formatQualityTier(item.quality || 50);

                            return h('div', {
                                class: `cf-selectable-item ${isSelected ? 'cf-selectable-item--selected' : ''}`,
                                dataset: { inventoryId: item.id.toString() }
                            },
                                h('div', { class: 'cf-selectable-item__info' },
                                    h('span', { class: 'font-semibold' }, item.strainName || 'Unknown'),
                                    h('span', {
                                        class: 'cf-badge ml-1',
                                        style: { background: qualityInfo.color, fontSize: '9px' }
                                    }, `${item.quality}%`)
                                ),
                                h('div', { class: 'cf-selectable-item__qty' },
                                    h('span', { class: 'text-xs text-muted' }, `Have: ${item.quantity}`),
                                    isSelected && h('input', {
                                        type: 'number',
                                        class: 'cf-input cf-input--sm cf-item-qty',
                                        value: selectedItem?.quantity || 1,
                                        min: 1,
                                        max: item.quantity,
                                        dataset: { inventoryId: item.id.toString(), maxQty: item.quantity.toString() },
                                        onclick: (e) => e.stopPropagation()
                                    })
                                )
                            );
                        })
                    )
                    : h('p', { class: 'text-muted text-sm' }, 'No items in inventory')
            ),

            // Cash offer
            h('div', { class: 'cf-form-group mb-4' },
                h('label', { class: 'cf-label' }, `Offer Cash (You have: ${formatCurrency(playerCash)})`),
                h('input', {
                    type: 'number',
                    class: 'cf-input cf-cash-offer',
                    value: this._offeredCash,
                    min: 0,
                    max: playerCash,
                    placeholder: '0'
                })
            ),

            // Summary
            h('div', { class: 'cf-trade-summary mb-4' },
                h('div', { class: 'text-sm font-semibold mb-2' }, 'Trade Summary'),
                h('div', { class: 'text-sm' },
                    `${this._selectedItems.length} item(s)`,
                    this._offeredCash > 0 && ` + ${formatCurrency(this._offeredCash)}`
                )
            ),

            // Send button
            h('button', {
                class: 'cf-btn cf-btn--primary cf-btn--block cf-send-trade',
                disabled: !this._selectedRecipient || (this._selectedItems.length === 0 && this._offeredCash === 0)
            }, 'Send Trade Offer')
        );
    }

    _formatTimeAgo(dateStr) {
        const date = new Date(dateStr);
        const now = new Date();
        const diffMs = now - date;
        const diffMins = Math.floor(diffMs / 60000);
        const diffHours = Math.floor(diffMs / 3600000);
        const diffDays = Math.floor(diffMs / 86400000);

        if (diffMins < 1) return 'just now';
        if (diffMins < 60) return `${diffMins}m ago`;
        if (diffHours < 24) return `${diffHours}h ago`;
        return `${diffDays}d ago`;
    }
}

registerComponent('cf-trading', CFTrading);
export default CFTrading;
