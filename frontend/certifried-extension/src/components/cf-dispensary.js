/**
 * CertiFried Extension - Dispensary Component
 * Player-owned dispensary management with customer serving
 */

import { CFBaseComponent, registerComponent } from './base-component.js';
import { h } from '../utils/dom.js';
import { formatCurrency, formatNumber } from '../utils/format.js';
import { api } from '../api/client.js';

class CFDispensary extends CFBaseComponent {
    constructor() {
        super();
        this._dispensaryData = null;
        this._loading = true;
        this._selectedInventoryId = null;
        this._showListModal = false;
        this._listQuantity = 1;
        this._listPrice = 100;
        this._customerRefreshInterval = null;
    }

    _setupSubscriptions() {
        this.subscribe('player');
    }

    async onMount() {
        await this._loadData();

        // Auto-refresh customers every 10 seconds when open
        this._customerRefreshInterval = setInterval(() => {
            if (this._dispensaryData?.dispensary?.isOpen) {
                this._loadData();
            }
        }, 10000);

        // Toggle dispensary open/close
        this.on('click', '.cf-dispensary-toggle', async () => {
            try {
                const result = await api.toggleDispensary();
                if (result.success) {
                    this._dispensaryData.dispensary.isOpen = result.isOpen;
                    this.emit('notification', {
                        type: 'success',
                        message: result.message
                    });
                    this.render();
                }
            } catch (error) {
                this.emit('notification', { type: 'error', message: error.message });
            }
        });

        // Open list modal
        this.on('click', '.cf-dispensary-list-btn', (e) => {
            const btn = e.target.closest('.cf-dispensary-list-btn');
            this._selectedInventoryId = parseInt(btn.dataset.inventoryId, 10);
            const item = this._dispensaryData.playerInventory.find(i => i.id === this._selectedInventoryId);
            if (item) {
                this._listQuantity = Math.min(10, item.quantity);
                this._listPrice = 100;
                this._showListModal = true;
                this.render();
            }
        });

        // Close modal
        this.on('click', '.cf-modal-close, .cf-modal-backdrop', () => {
            this._showListModal = false;
            this.render();
        });

        // Quantity/price inputs
        this.on('input', '.cf-list-quantity', (e) => {
            this._listQuantity = Math.max(1, parseInt(e.target.value, 10) || 1);
        });

        this.on('input', '.cf-list-price', (e) => {
            this._listPrice = Math.max(1, parseInt(e.target.value, 10) || 1);
        });

        // Confirm list
        this.on('click', '.cf-list-confirm', async () => {
            try {
                const result = await api.listInDispensary(
                    this._selectedInventoryId,
                    this._listQuantity,
                    this._listPrice
                );
                if (result.success) {
                    this.emit('notification', { type: 'success', message: result.message });
                    this._showListModal = false;
                    await this._loadData();
                }
            } catch (error) {
                this.emit('notification', { type: 'error', message: error.message });
            }
        });

        // Unlist item
        this.on('click', '.cf-dispensary-unlist', async (e) => {
            const btn = e.target.closest('.cf-dispensary-unlist');
            const listingId = parseInt(btn.dataset.listingId, 10);

            try {
                const result = await api.unlistFromDispensary(listingId);
                if (result.success) {
                    this.emit('notification', { type: 'success', message: result.message });
                    await this._loadData();
                }
            } catch (error) {
                this.emit('notification', { type: 'error', message: error.message });
            }
        });

        // Serve customer
        this.on('click', '.cf-serve-customer', async (e) => {
            const btn = e.target.closest('.cf-serve-customer');
            const orderId = parseInt(btn.dataset.orderId, 10);
            const listingId = parseInt(btn.dataset.listingId, 10);

            btn.disabled = true;
            btn.textContent = 'Serving...';

            try {
                const result = await api.serveCustomer(orderId, listingId);
                if (result.success) {
                    this.emit('notification', { type: 'success', message: result.message });
                    await this._loadData();
                }
            } catch (error) {
                this.emit('notification', { type: 'error', message: error.message });
                btn.disabled = false;
                btn.textContent = 'Serve';
            }
        });

        // Spawn customer (dev)
        this.on('click', '.cf-spawn-customer', async () => {
            try {
                const result = await api.spawnCustomer();
                if (result.success && result.spawned) {
                    this.emit('notification', { type: 'success', message: result.message });
                    await this._loadData();
                } else if (result.success) {
                    this.emit('notification', { type: 'info', message: result.message });
                }
            } catch (error) {
                this.emit('notification', { type: 'error', message: error.message });
            }
        });
    }

    onUnmount() {
        if (this._customerRefreshInterval) {
            clearInterval(this._customerRefreshInterval);
        }
    }

    async _loadData() {
        // Only show spinner on first load when we have no data
        const isFirstLoad = !this._dispensaryData;

        if (isFirstLoad) {
            this._loading = true;
            this.render();
        }

        try {
            this._dispensaryData = await api.getDispensary();
        } catch (error) {
            console.error('[CFDispensary] Load error:', error);
        } finally {
            this._loading = false;
            this.scheduleRender();
        }
    }

    render() {
        this.className = 'cf-dispensary';

        if (this._loading) {
            this.setContent(
                h('div', { class: 'cf-loading' },
                    h('div', { class: 'cf-spinner' }),
                    h('p', {}, 'Loading dispensary...')
                )
            );
            return;
        }

        if (!this._dispensaryData) {
            this.setContent(h('div', { class: 'cf-error' }, 'Failed to load dispensary'));
            return;
        }

        const { dispensary, inventory, waitingCustomers, recentSales, playerInventory } = this._dispensaryData;

        this.setContent(
            // Header
            h('div', { class: 'cf-dispensary__header', style: { marginBottom: 'var(--space-4)' } },
                h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
                    h('div', {},
                        h('h2', { class: 'cf-section__title' }, dispensary.name || 'My Dispensary'),
                        h('div', { class: 'text-xs text-muted' }, `Tier ${dispensary.tier} • ${dispensary.reputation} reputation`)
                    ),
                    h('button', {
                        class: `cf-btn ${dispensary.isOpen ? 'cf-btn--danger' : 'cf-btn--success'} cf-dispensary-toggle`
                    }, dispensary.isOpen ? 'Close Shop' : 'Open Shop')
                )
            ),

            // Stats row
            h('div', { class: 'cf-stats-row', style: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 'var(--space-2)', marginBottom: 'var(--space-4)' } },
                this._renderStat('Total Sales', formatNumber(dispensary.totalSales)),
                this._renderStat('Revenue', formatCurrency(dispensary.totalRevenue)),
                this._renderStat('Capacity', `${waitingCustomers.length}/${dispensary.customerCapacity}`)
            ),

            // Waiting customers
            dispensary.isOpen && h('div', { class: 'cf-dispensary__customers', style: { marginBottom: 'var(--space-4)' } },
                h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--space-2)' } },
                    h('h3', { class: 'text-sm font-semibold' }, `Waiting Customers (${waitingCustomers.length})`),
                    h('button', { class: 'cf-btn cf-btn--ghost cf-btn--sm cf-spawn-customer' }, '+ Spawn')
                ),
                waitingCustomers.length === 0
                    ? h('div', { class: 'cf-empty text-center text-muted py-4' }, 'No customers waiting')
                    : h('div', { class: 'cf-customer-list' },
                        ...waitingCustomers.map(c => this._renderCustomer(c, inventory))
                    )
            ),

            // Dispensary inventory
            h('div', { class: 'cf-dispensary__inventory', style: { marginBottom: 'var(--space-4)' } },
                h('h3', { class: 'text-sm font-semibold mb-2' }, `Listed Items (${inventory.length})`),
                inventory.length === 0
                    ? h('div', { class: 'cf-empty text-center text-muted py-4' }, 'No items listed for sale')
                    : h('div', { class: 'cf-inventory-list' },
                        ...inventory.map(item => this._renderListedItem(item))
                    )
            ),

            // Player inventory to list
            h('div', { class: 'cf-dispensary__add', style: { marginBottom: 'var(--space-4)' } },
                h('h3', { class: 'text-sm font-semibold mb-2' }, 'Add from Inventory'),
                playerInventory.length === 0
                    ? h('div', { class: 'cf-empty text-center text-muted py-4' }, 'No items in inventory')
                    : h('div', { class: 'cf-player-inventory', style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 'var(--space-2)' } },
                        ...playerInventory.slice(0, 12).map(item => this._renderPlayerItem(item))
                    )
            ),

            // Recent sales
            recentSales.length > 0 && h('div', { class: 'cf-dispensary__recent' },
                h('h3', { class: 'text-sm font-semibold mb-2' }, 'Recent Sales'),
                h('div', { class: 'cf-sales-list' },
                    ...recentSales.slice(0, 5).map(sale => this._renderSale(sale))
                )
            ),

            // List modal
            this._showListModal && this._renderListModal()
        );
    }

    _renderStat(label, value) {
        return h('div', { class: 'cf-card text-center', style: { padding: 'var(--space-2)' } },
            h('div', { class: 'font-semibold' }, value),
            h('div', { class: 'text-xs text-muted' }, label)
        );
    }

    _renderCustomer(customer, inventory) {
        const timeLeft = Math.max(0, Math.floor(customer.timeLeft / 1000));
        const minutes = Math.floor(timeLeft / 60);
        const seconds = timeLeft % 60;
        const isUrgent = timeLeft < 30;

        // Find matching inventory items
        const matchingItems = inventory.filter(i =>
            i.quality >= customer.requestedQualityMin &&
            i.pricePerUnit <= customer.budget
        );

        return h('div', {
            class: 'cf-card mb-2',
            style: { borderColor: isUrgent ? 'var(--color-danger)' : 'var(--border-primary)' }
        },
            h('div', { class: 'cf-card__body' },
                h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' } },
                    h('div', {},
                        h('div', { class: 'font-semibold' }, customer.customerName),
                        h('div', { class: 'text-xs text-muted' },
                            `Wants Q${customer.requestedQualityMin}+ • Budget: ${formatCurrency(customer.budget)}`
                        ),
                        customer.tipChance > 0 && h('div', { class: 'text-xs', style: { color: 'var(--color-success)' } },
                            `${Math.round(customer.tipChance * 100)}% tip chance`
                        )
                    ),
                    h('div', {
                        class: 'text-sm',
                        style: { color: isUrgent ? 'var(--color-danger)' : 'var(--text-muted)' }
                    }, `${minutes}:${seconds.toString().padStart(2, '0')}`)
                ),
                matchingItems.length > 0 && h('div', { style: { marginTop: 'var(--space-2)' } },
                    h('select', {
                        class: 'cf-select cf-serve-select',
                        dataset: { orderId: customer.id },
                        style: { width: '100%', marginBottom: 'var(--space-2)' }
                    },
                        ...matchingItems.map(item => h('option', { value: item.id },
                            `${item.strainName} Q${item.quality} - ${formatCurrency(item.pricePerUnit)}`
                        ))
                    ),
                    h('button', {
                        class: 'cf-btn cf-btn--success cf-btn--sm cf-serve-customer',
                        dataset: { orderId: customer.id, listingId: matchingItems[0].id },
                        style: { width: '100%' }
                    }, 'Serve')
                ),
                matchingItems.length === 0 && h('div', {
                    class: 'text-xs text-center mt-2',
                    style: { color: 'var(--color-warning)' }
                }, 'No matching items available')
            )
        );
    }

    _renderListedItem(item) {
        return h('div', { class: 'cf-card mb-2' },
            h('div', {
                class: 'cf-card__body',
                style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' }
            },
                h('div', {},
                    h('div', { class: 'font-semibold' }, item.strainName),
                    h('div', { class: 'text-xs text-muted' },
                        `Q${item.quality} • ${item.quantity}x • ${formatCurrency(item.pricePerUnit)}/ea`
                    )
                ),
                h('button', {
                    class: 'cf-btn cf-btn--ghost cf-btn--sm cf-dispensary-unlist',
                    dataset: { listingId: item.id }
                }, 'Remove')
            )
        );
    }

    _renderPlayerItem(item) {
        return h('div', { class: 'cf-card', style: { padding: 'var(--space-2)' } },
            h('div', { class: 'text-sm font-semibold' }, item.strainName),
            h('div', { class: 'text-xs text-muted mb-2' }, `Q${item.quality} • ${item.quantity}x`),
            h('button', {
                class: 'cf-btn cf-btn--primary cf-btn--sm cf-dispensary-list-btn',
                dataset: { inventoryId: item.id },
                style: { width: '100%' }
            }, 'List')
        );
    }

    _renderSale(sale) {
        const total = sale.saleAmount + (sale.tipAmount || 0);
        return h('div', { class: 'cf-card mb-1', style: { padding: 'var(--space-2)' } },
            h('div', { style: { display: 'flex', justifyContent: 'space-between' } },
                h('span', { class: 'text-sm' }, sale.customerName),
                h('span', { class: 'text-sm font-semibold', style: { color: 'var(--color-success)' } },
                    formatCurrency(total) + (sale.tipAmount > 0 ? ' (+tip)' : '')
                )
            )
        );
    }

    _renderListModal() {
        const item = this._dispensaryData.playerInventory.find(i => i.id === this._selectedInventoryId);
        if (!item) return null;

        return h('div', { class: 'cf-modal-backdrop', style: {
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000
        }},
            h('div', { class: 'cf-modal', style: {
                background: 'var(--bg-primary)', borderRadius: 'var(--radius-lg)',
                padding: 'var(--space-4)', maxWidth: '300px', width: '90%'
            }},
                h('div', { style: { display: 'flex', justifyContent: 'space-between', marginBottom: 'var(--space-3)' } },
                    h('h3', { class: 'font-semibold' }, 'List Item'),
                    h('button', { class: 'cf-modal-close', style: { background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)' } }, '✕')
                ),
                h('div', { class: 'mb-3' },
                    h('div', { class: 'font-semibold' }, item.strainName),
                    h('div', { class: 'text-sm text-muted' }, `Q${item.quality} • ${item.quantity} available`)
                ),
                h('div', { class: 'mb-3' },
                    h('label', { class: 'text-sm font-semibold' }, 'Quantity'),
                    h('input', {
                        type: 'number',
                        class: 'cf-input cf-list-quantity',
                        value: this._listQuantity,
                        min: 1,
                        max: item.quantity,
                        style: { width: '100%' }
                    })
                ),
                h('div', { class: 'mb-3' },
                    h('label', { class: 'text-sm font-semibold' }, 'Price per unit'),
                    h('input', {
                        type: 'number',
                        class: 'cf-input cf-list-price',
                        value: this._listPrice,
                        min: 1,
                        style: { width: '100%' }
                    })
                ),
                h('button', {
                    class: 'cf-btn cf-btn--primary cf-list-confirm',
                    style: { width: '100%' }
                }, `List for ${formatCurrency(this._listQuantity * this._listPrice)}`)
            )
        );
    }
}

registerComponent('cf-dispensary', CFDispensary);
export default CFDispensary;
