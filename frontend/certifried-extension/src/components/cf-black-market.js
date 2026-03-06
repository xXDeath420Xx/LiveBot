/**
 * Black Market Component
 * High-risk, high-reward selling channel
 */

import { CFBaseComponent, registerComponent } from './base-component.js';
import { h } from '../utils/dom.js';
import { api } from '../api/client.js';
import { formatCurrency, formatTimeRemaining } from '../utils/format.js';

class CFBlackMarket extends CFBaseComponent {
    constructor() {
        super();
        this._contacts = [];
        this._recentSales = [];
        this._playerReputation = 0;
        this._loading = true;
        this._error = null;
        this._showSellModal = false;
        this._selectedContact = null;
        this._inventory = [];
    }

    async onMount() {
        await this._loadBlackMarket();

        // Open sell modal
        this.on('click', '.cf-sell-to-contact', async (e) => {
            const btn = e.target.closest('.cf-sell-to-contact');
            if (!btn) return;
            const contactId = parseInt(btn.dataset.contactId, 10);
            this._selectedContact = this._contacts.find(c => c.id === contactId);
            if (this._selectedContact && this._selectedContact.isUnlocked && !this._selectedContact.isOnCooldown) {
                await this._loadInventory();
                this._showSellModal = true;
                this.render();
            }
        });

        // Select item to sell
        this.on('click', '.cf-sell-item', async (e) => {
            const item = e.target.closest('.cf-sell-item');
            if (!item) return;
            const inventoryId = parseInt(item.dataset.inventoryId, 10);
            await this._sellItem(inventoryId);
        });

        // Close modal
        this.on('click', '.cf-modal-close, .cf-modal-backdrop', (e) => {
            if (e.target.classList.contains('cf-modal-backdrop') || e.target.classList.contains('cf-modal-close')) {
                this._showSellModal = false;
                this._selectedContact = null;
                this.render();
            }
        });
    }

    async _loadBlackMarket() {
        // Only show spinner on first load when we have no data
        const isFirstLoad = this._contacts.length === 0;

        if (isFirstLoad) {
            this._loading = true;
            this._error = null;
            this.render();
        }

        try {
            const response = await api.getBlackMarket();
            if (response.success) {
                this._contacts = response.contacts || [];
                this._recentSales = response.recentSales || [];
                this._playerReputation = response.playerReputation || 0;
            } else {
                this._error = response.error;
            }
        } catch (err) {
            this._error = err.message;
        }

        this._loading = false;
        this.scheduleRender();
    }

    async _loadInventory() {
        try {
            const response = await api.getInventory();
            if (response.success) {
                this._inventory = response.items || [];
            }
        } catch (err) {
            console.error('[BlackMarket] Failed to load inventory:', err);
        }
    }

    async _sellItem(inventoryId) {
        if (!this._selectedContact) return;

        const invItem = this._inventory.find(i => i.id === inventoryId);
        if (!invItem) return;

        const sellQty = Math.min(invItem.quantity, this._selectedContact.maxQuantity);
        const contactName = this._selectedContact.name;

        // Optimistic update - close modal immediately
        this._showSellModal = false;
        this._selectedContact = null;
        this.scheduleRender();

        try {
            const response = await api.sellToBlackMarket(
                this._contacts.find(c => c.name === contactName)?.id,
                inventoryId,
                sellQty
            );

            if (response.success) {
                this.emit('notification', {
                    type: 'success',
                    message: response.message
                });
                // Background refresh for accurate state
                this._loadBlackMarket();
            } else {
                this.emit('notification', { type: 'error', message: response.error });
            }
        } catch (err) {
            this.emit('notification', { type: 'error', message: err.message });
        }
    }

    render() {
        this.className = 'cf-black-market';

        if (this._loading) {
            this.setContent(h('div', { class: 'cf-loading' }, h('div', { class: 'cf-spinner' })));
            return;
        }

        if (this._error) {
            this.setContent(
                h('div', { class: 'cf-error-message' },
                    h('p', {}, this._error),
                    h('button', { class: 'cf-btn cf-btn--primary', onclick: () => this._loadBlackMarket() }, 'Retry')
                )
            );
            return;
        }

        const content = [];

        // Header
        content.push(
            h('div', { style: { marginBottom: 'var(--space-4)' } },
                h('h2', { class: 'cf-section__title' }, 'Black Market'),
                h('p', { class: 'text-sm text-muted' },
                    'Higher prices, higher heat. Trade carefully.'
                )
            )
        );

        // Warning banner
        content.push(
            h('div', {
                style: {
                    background: 'rgba(239, 68, 68, 0.1)',
                    border: '1px solid rgba(239, 68, 68, 0.3)',
                    borderRadius: 'var(--radius-md)',
                    padding: 'var(--space-3)',
                    marginBottom: 'var(--space-4)'
                }
            },
                h('div', { class: 'text-sm', style: { color: 'var(--color-danger)' } },
                    '⚠️ Black market sales generate significant heat and increase raid risk!'
                )
            )
        );

        // Contacts
        content.push(h('h3', { class: 'text-sm font-semibold text-muted mb-2' }, 'Contacts'));
        content.push(
            h('div', { class: 'cf-contacts' },
                ...this._contacts.map(contact => this._renderContact(contact))
            )
        );

        // Recent sales
        if (this._recentSales.length > 0) {
            content.push(h('h3', { class: 'text-sm font-semibold text-muted mt-4 mb-2' }, 'Recent Sales'));
            content.push(
                h('div', { class: 'cf-recent-sales' },
                    ...this._recentSales.slice(0, 5).map(sale => this._renderSale(sale))
                )
            );
        }

        // Sell modal
        if (this._showSellModal && this._selectedContact) {
            content.push(this._renderSellModal());
        }

        this.setContent(...content);
    }

    _renderContact(contact) {
        const isLocked = !contact.isUnlocked;
        const isOnCooldown = contact.isOnCooldown;

        let statusText = '';
        let statusColor = 'var(--color-success)';

        if (isLocked) {
            statusText = `Need ${contact.reputationRequired} rep`;
            statusColor = 'var(--text-muted)';
        } else if (isOnCooldown) {
            const timeLeft = formatTimeRemaining(new Date(contact.cooldownEnds) - new Date());
            statusText = `Cooldown: ${timeLeft}`;
            statusColor = 'var(--color-warning)';
        } else {
            statusText = 'Available';
        }

        return h('div', {
            class: 'cf-card cf-contact-card',
            style: { marginBottom: 'var(--space-2)', opacity: isLocked ? 0.5 : 1 }
        },
            h('div', { class: 'cf-card__body' },
                // Header
                h('div', { style: { display: 'flex', justifyContent: 'space-between', marginBottom: 'var(--space-2)' } },
                    h('span', { class: 'font-semibold' }, contact.name),
                    h('span', { class: 'text-xs', style: { color: statusColor } }, statusText)
                ),

                // Description
                h('p', { class: 'text-sm text-muted mb-2' }, contact.description),

                // Stats
                h('div', { class: 'text-xs mb-3', style: { display: 'flex', gap: 'var(--space-3)' } },
                    h('span', { style: { color: 'var(--color-success)' } },
                        `${contact.priceMultiplier}x price`
                    ),
                    h('span', { style: { color: 'var(--color-danger)' } },
                        `${contact.heatMultiplier}x heat`
                    ),
                    contact.minQuality > 0 && h('span', { class: 'text-muted' },
                        `Q${contact.minQuality}+ only`
                    )
                ),

                // Sales stats
                contact.totalSales > 0 && h('div', { class: 'text-xs text-muted mb-2' },
                    `${contact.totalSales} sales | ${formatCurrency(contact.totalRevenue)} earned`
                ),

                // Action button
                h('button', {
                    class: 'cf-btn cf-btn--sm cf-sell-to-contact',
                    dataset: { contactId: contact.id.toString() },
                    disabled: isLocked || isOnCooldown,
                    style: {
                        background: isLocked || isOnCooldown ? 'var(--bg-tertiary)' : 'var(--color-danger)',
                        color: 'white',
                        width: '100%'
                    }
                }, isLocked ? '🔒 Locked' : (isOnCooldown ? 'On Cooldown' : 'Sell'))
            )
        );
    }

    _renderSale(sale) {
        return h('div', {
            class: 'cf-card',
            style: { marginBottom: 'var(--space-1)', padding: 'var(--space-2)' }
        },
            h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
                h('div', {},
                    h('span', { class: 'text-sm font-medium' }, sale.contactName),
                    h('span', { class: 'text-xs text-muted ml-2' },
                        `${sale.quantity}x ${sale.strainName || 'Unknown'}`
                    )
                ),
                h('div', { class: 'text-right' },
                    h('div', { class: 'text-sm', style: { color: 'var(--color-success)' } },
                        formatCurrency(sale.finalPrice)
                    ),
                    h('div', { class: 'text-xs', style: { color: 'var(--color-danger)' } },
                        `+${sale.heatGenerated} heat`
                    )
                )
            )
        );
    }

    _renderSellModal() {
        const contact = this._selectedContact;

        // Filter valid inventory items
        const validItems = this._inventory.filter(item =>
            item.quality >= contact.minQuality
        );

        return h('div', {
            class: 'cf-modal-backdrop',
            style: {
                position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
                background: 'rgba(0,0,0,0.7)', display: 'flex',
                alignItems: 'center', justifyContent: 'center', zIndex: 1000
            }
        },
            h('div', {
                style: {
                    background: 'var(--bg-primary)', borderRadius: 'var(--radius-lg)',
                    maxWidth: '400px', width: '90%', maxHeight: '70vh', overflow: 'hidden',
                    display: 'flex', flexDirection: 'column'
                }
            },
                // Header
                h('div', {
                    style: {
                        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                        padding: 'var(--space-4)', borderBottom: '1px solid var(--border-primary)'
                    }
                },
                    h('span', { class: 'font-semibold' }, `Sell to ${contact.name}`),
                    h('button', { class: 'cf-modal-close cf-btn cf-btn--ghost' }, '×')
                ),

                // Info
                h('div', {
                    style: {
                        padding: 'var(--space-3)',
                        background: 'rgba(239, 68, 68, 0.1)',
                        borderBottom: '1px solid var(--border-primary)'
                    }
                },
                    h('div', { class: 'text-sm' },
                        h('span', { style: { color: 'var(--color-success)' } }, `${contact.priceMultiplier}x prices`),
                        h('span', { class: 'text-muted' }, ' | '),
                        h('span', { style: { color: 'var(--color-danger)' } }, `${contact.heatMultiplier}x heat`)
                    ),
                    contact.minQuality > 0 && h('div', { class: 'text-xs text-muted' },
                        `Minimum quality: ${contact.minQuality}`
                    )
                ),

                // Items
                h('div', { style: { overflowY: 'auto', padding: 'var(--space-3)', flex: 1 } },
                    validItems.length === 0
                        ? h('p', { class: 'text-muted text-center' },
                            contact.minQuality > 0
                                ? `No items with quality ${contact.minQuality}+`
                                : 'No items in inventory'
                        )
                        : validItems.map(item => {
                            const sellQty = Math.min(item.quantity, contact.maxQuantity);
                            const basePrice = (item.basePrice || 100) * (item.quality / 50);
                            const estimatedPrice = basePrice * sellQty * contact.priceMultiplier;
                            const estimatedHeat = Math.ceil(sellQty * contact.heatMultiplier * 2);

                            return h('div', {
                                class: 'cf-sell-item cf-card',
                                dataset: { inventoryId: item.id.toString() },
                                style: { marginBottom: 'var(--space-2)', cursor: 'pointer' }
                            },
                                h('div', { class: 'cf-card__body' },
                                    h('div', { style: { display: 'flex', justifyContent: 'space-between', marginBottom: 'var(--space-1)' } },
                                        h('span', { class: 'font-medium' }, item.strainName || 'Unknown'),
                                        h('span', { class: 'text-xs text-muted' }, `Q${item.quality} | x${item.quantity}`)
                                    ),
                                    h('div', { style: { display: 'flex', justifyContent: 'space-between' } },
                                        h('span', { class: 'text-sm', style: { color: 'var(--color-success)' } },
                                            `~${formatCurrency(estimatedPrice)}`
                                        ),
                                        h('span', { class: 'text-sm', style: { color: 'var(--color-danger)' } },
                                            `+${estimatedHeat} heat`
                                        )
                                    )
                                )
                            );
                        })
                )
            )
        );
    }
}

registerComponent('cf-black-market', CFBlackMarket);
export default CFBlackMarket;
