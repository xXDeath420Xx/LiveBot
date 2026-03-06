/**
 * Contracts Component
 * Accept and deliver contracts for rewards
 */

import { CFBaseComponent, registerComponent } from './base-component.js';
import { h } from '../utils/dom.js';
import { api } from '../api/client.js';
import { formatCurrency, formatTimeRemaining, formatRarity } from '../utils/format.js';

const CONTRACT_TYPES = {
    standard: { label: 'Standard', color: '#6b7280' },
    premium: { label: 'Premium', color: '#8b5cf6' },
    urgent: { label: 'Urgent', color: '#ef4444' },
    bulk: { label: 'Bulk', color: '#22c55e' }
};

class CFContracts extends CFBaseComponent {
    constructor() {
        super();
        this._available = [];
        this._active = [];
        this._stats = { completed: 0, totalEarned: 0 };
        this._maxActive = 3;
        this._loading = true;
        this._error = null;
        this._activeTab = 'active';
        this._showDeliverModal = false;
        this._selectedContract = null;
        this._inventory = [];
    }

    async onMount() {
        await this._loadContracts();

        this.on('click', '.cf-tab-btn', (e) => {
            const tab = e.target.closest('.cf-tab-btn');
            if (!tab) return;
            this._activeTab = tab.dataset.tab;
            this.render();
        });

        this.on('click', '.cf-accept-contract', async (e) => {
            const btn = e.target.closest('.cf-accept-contract');
            if (!btn) return;
            const contractId = parseInt(btn.dataset.contractId, 10);
            await this._acceptContract(contractId);
        });

        this.on('click', '.cf-deliver-btn', async (e) => {
            const btn = e.target.closest('.cf-deliver-btn');
            if (!btn) return;
            const contractId = parseInt(btn.dataset.contractId, 10);
            this._selectedContract = this._active.find(c => c.id === contractId);
            await this._loadInventory();
            this._showDeliverModal = true;
            this.render();
        });

        this.on('click', '.cf-cancel-contract', async (e) => {
            const btn = e.target.closest('.cf-cancel-contract');
            if (!btn) return;
            const contractId = parseInt(btn.dataset.contractId, 10);
            if (confirm('Cancel this contract? This may affect your reputation.')) {
                await this._cancelContract(contractId);
            }
        });

        this.on('click', '.cf-deliver-item', async (e) => {
            const item = e.target.closest('.cf-deliver-item');
            if (!item) return;
            const inventoryId = parseInt(item.dataset.inventoryId, 10);
            await this._deliverItem(inventoryId);
        });

        this.on('click', '.cf-modal-close, .cf-modal-backdrop', (e) => {
            if (e.target.classList.contains('cf-modal-backdrop') || e.target.classList.contains('cf-modal-close')) {
                this._showDeliverModal = false;
                this._selectedContract = null;
                this.render();
            }
        });
    }

    async _loadContracts() {
        // Only show loading spinner on first load
        const isFirstLoad = this._available.length === 0 && this._active.length === 0;

        if (isFirstLoad) {
            this._loading = true;
            this._error = null;
            this.render();
        }

        try {
            const response = await api.getContracts();
            if (response.success) {
                this._available = response.available || [];
                this._active = response.active || [];
                this._stats = response.stats || { completed: 0, totalEarned: 0 };
                this._maxActive = response.maxActive || 3;
            } else if (isFirstLoad) {
                this._error = response.error;
            }
        } catch (err) {
            if (isFirstLoad) {
                this._error = err.message;
            }
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
            console.error('[Contracts] Failed to load inventory:', err);
        }
    }

    async _acceptContract(contractId) {
        const contract = this._available.find(c => c.id === contractId);
        if (!contract) return;

        // Save state for rollback
        const oldAvailable = [...this._available];
        const oldActive = [...this._active];

        // Optimistic update - move contract from available to active
        this._available = this._available.filter(c => c.id !== contractId);
        const activeContract = {
            ...contract,
            quantityDelivered: 0,
            progress: 0,
            deadlineAt: new Date(Date.now() + (contract.deadlineHours || 24) * 60 * 60 * 1000).toISOString()
        };
        this._active = [...this._active, activeContract];
        this.scheduleRender();

        this.emit('notification', { type: 'success', message: 'Contract accepted!' });

        try {
            const response = await api.acceptContract(contractId);
            if (response.success) {
                // Refresh contracts in background
                api.getContracts().then(data => {
                    if (data.success) {
                        this._available = data.available || [];
                        this._active = data.active || [];
                        this.scheduleRender();
                    }
                }).catch(() => {});
            } else {
                // Rollback
                this._available = oldAvailable;
                this._active = oldActive;
                this.scheduleRender();
                this.emit('notification', { type: 'error', message: response.error });
            }
        } catch (err) {
            // Rollback
            this._available = oldAvailable;
            this._active = oldActive;
            this.scheduleRender();
            this.emit('notification', { type: 'error', message: err.message });
        }
    }

    async _deliverItem(inventoryId) {
        if (!this._selectedContract) return;

        const invItem = this._inventory.find(i => i.id === inventoryId);
        if (!invItem) return;

        const remaining = this._selectedContract.quantityRequired - this._selectedContract.quantityDelivered;
        const deliverQty = Math.min(invItem.quantity, remaining);

        try {
            const response = await api.deliverToContract(this._selectedContract.id, inventoryId, deliverQty);
            if (response.success) {
                if (response.isComplete) {
                    this.emit('notification', {
                        type: 'success',
                        message: `Contract complete! Earned ${formatCurrency(response.rewards.cash)} and ${response.rewards.xp} XP!`
                    });
                    this._showDeliverModal = false;
                    this._selectedContract = null;
                } else {
                    this.emit('notification', {
                        type: 'success',
                        message: `Delivered ${response.delivered}. ${response.remaining} more needed.`
                    });
                    this._selectedContract.quantityDelivered = response.newTotal;
                    await this._loadInventory();
                }
                await this._loadContracts();
            } else {
                this.emit('notification', { type: 'error', message: response.error });
            }
        } catch (err) {
            this.emit('notification', { type: 'error', message: err.message });
        }
    }

    async _cancelContract(contractId) {
        try {
            const response = await api.cancelContract(contractId);
            if (response.success) {
                this.emit('notification', { type: 'info', message: response.message });
                await this._loadContracts();
            } else {
                this.emit('notification', { type: 'error', message: response.error });
            }
        } catch (err) {
            this.emit('notification', { type: 'error', message: err.message });
        }
    }

    render() {
        this.className = 'cf-contracts';

        if (this._loading) {
            this.setContent(h('div', { class: 'cf-loading' }, h('div', { class: 'cf-spinner' })));
            return;
        }

        if (this._error) {
            this.setContent(
                h('div', { class: 'cf-error-message' },
                    h('p', {}, this._error),
                    h('button', { class: 'cf-btn cf-btn--primary', onclick: () => this._loadContracts() }, 'Retry')
                )
            );
            return;
        }

        const content = [];

        // Header with stats
        content.push(
            h('div', { style: { marginBottom: 'var(--space-4)' } },
                h('h2', { class: 'cf-section__title' }, 'Contracts'),
                h('div', { class: 'text-sm text-muted' },
                    `${this._stats.completed} completed | ${formatCurrency(this._stats.totalEarned)} earned`
                )
            )
        );

        // Tabs
        content.push(
            h('div', { class: 'cf-tabs mb-3' },
                h('button', {
                    class: `cf-tab cf-tab-btn ${this._activeTab === 'active' ? 'cf-tab--active' : ''}`,
                    dataset: { tab: 'active' }
                }, `Active (${this._active.length}/${this._maxActive})`),
                h('button', {
                    class: `cf-tab cf-tab-btn ${this._activeTab === 'available' ? 'cf-tab--active' : ''}`,
                    dataset: { tab: 'available' }
                }, `Available (${this._available.length})`)
            )
        );

        // Content
        if (this._activeTab === 'active') {
            content.push(this._renderActiveContracts());
        } else {
            content.push(this._renderAvailableContracts());
        }

        // Deliver modal
        if (this._showDeliverModal && this._selectedContract) {
            content.push(this._renderDeliverModal());
        }

        this.setContent(...content);
    }

    _renderActiveContracts() {
        if (this._active.length === 0) {
            return h('div', { class: 'cf-empty' },
                h('p', { class: 'cf-empty__title' }, 'No active contracts'),
                h('p', { class: 'cf-empty__description' }, 'Accept contracts from the Available tab!')
            );
        }

        return h('div', { class: 'cf-contract-list' },
            ...this._active.map(c => this._renderActiveContract(c))
        );
    }

    _renderActiveContract(contract) {
        const typeInfo = CONTRACT_TYPES[contract.type] || CONTRACT_TYPES.standard;
        const deadline = new Date(contract.deadlineAt);
        const isExpired = deadline < new Date();
        const timeLeft = isExpired ? 'EXPIRED' : formatTimeRemaining(deadline - new Date());

        return h('div', {
            class: 'cf-card cf-contract-card',
            style: { marginBottom: 'var(--space-2)', opacity: isExpired ? 0.6 : 1 }
        },
            h('div', { class: 'cf-card__body' },
                // Header
                h('div', { style: { display: 'flex', justifyContent: 'space-between', marginBottom: 'var(--space-2)' } },
                    h('div', {},
                        h('span', {
                            class: 'cf-badge',
                            style: { background: typeInfo.color, marginRight: 'var(--space-2)' }
                        }, typeInfo.label),
                        h('span', { class: 'font-semibold' }, contract.clientName)
                    ),
                    h('span', {
                        class: 'text-sm',
                        style: { color: isExpired ? 'var(--color-danger)' : 'var(--text-muted)' }
                    }, timeLeft)
                ),

                // Requirements
                h('div', { class: 'text-sm mb-2' },
                    `Deliver ${contract.quantityRequired}x ${contract.strainName}`,
                    contract.qualityMin > 0 && ` (Q${contract.qualityMin}+)`
                ),

                // Progress
                h('div', { class: 'cf-progress mb-2' },
                    h('div', {
                        class: 'cf-progress__bar',
                        style: { width: `${contract.progress}%` }
                    })
                ),
                h('div', { class: 'text-xs text-muted mb-3' },
                    `${contract.quantityDelivered}/${contract.quantityRequired} delivered (${contract.progress}%)`
                ),

                // Rewards
                h('div', { class: 'text-sm mb-3', style: { color: 'var(--color-success)' } },
                    `Reward: ${formatCurrency(contract.rewardCash)} + ${contract.rewardXp} XP`
                ),

                // Actions
                h('div', { style: { display: 'flex', gap: 'var(--space-2)' } },
                    !isExpired && h('button', {
                        class: 'cf-btn cf-btn--primary cf-btn--sm cf-deliver-btn',
                        dataset: { contractId: contract.id.toString() }
                    }, 'Deliver'),
                    h('button', {
                        class: 'cf-btn cf-btn--ghost cf-btn--sm cf-cancel-contract',
                        dataset: { contractId: contract.id.toString() },
                        style: { color: 'var(--color-danger)' }
                    }, 'Cancel')
                )
            )
        );
    }

    _renderAvailableContracts() {
        if (this._available.length === 0) {
            return h('div', { class: 'cf-empty' },
                h('p', { class: 'cf-empty__title' }, 'No contracts available'),
                h('p', { class: 'cf-empty__description' }, 'Check back later for new contracts!')
            );
        }

        return h('div', { class: 'cf-contract-list' },
            ...this._available.map(c => this._renderAvailableContract(c))
        );
    }

    _renderAvailableContract(contract) {
        const typeInfo = CONTRACT_TYPES[contract.type] || CONTRACT_TYPES.standard;
        const canAccept = this._active.length < this._maxActive;

        return h('div', { class: 'cf-card cf-contract-card', style: { marginBottom: 'var(--space-2)' } },
            h('div', { class: 'cf-card__body' },
                // Header
                h('div', { style: { display: 'flex', justifyContent: 'space-between', marginBottom: 'var(--space-2)' } },
                    h('div', {},
                        h('span', {
                            class: 'cf-badge',
                            style: { background: typeInfo.color, marginRight: 'var(--space-2)' }
                        }, typeInfo.label),
                        h('span', { class: 'font-semibold' }, contract.clientName)
                    ),
                    h('span', { class: 'text-xs text-muted' }, `${contract.deadlineHours}h deadline`)
                ),

                // Requirements
                h('div', { class: 'text-sm mb-2' },
                    `Need ${contract.quantityRequired}x ${contract.strainName}`,
                    contract.qualityMin > 0 && ` (Q${contract.qualityMin}+)`
                ),

                // Rewards
                h('div', { class: 'text-sm mb-3', style: { color: 'var(--color-success)' } },
                    `Reward: ${formatCurrency(contract.rewardCash)} + ${contract.rewardXp} XP`
                ),

                // Accept button
                h('button', {
                    class: 'cf-btn cf-btn--primary cf-btn--sm cf-accept-contract',
                    dataset: { contractId: contract.id.toString() },
                    disabled: !canAccept
                }, canAccept ? 'Accept' : 'Max contracts reached')
            )
        );
    }

    _renderDeliverModal() {
        const contract = this._selectedContract;
        const remaining = contract.quantityRequired - contract.quantityDelivered;

        // Filter inventory for matching items
        const validItems = this._inventory.filter(item => {
            if (contract.strainId && item.strainId !== contract.strainId) return false;
            if (item.quality < contract.qualityMin) return false;
            return true;
        });

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
                    h('span', { class: 'font-semibold' }, `Deliver to ${contract.clientName}`),
                    h('button', { class: 'cf-modal-close cf-btn cf-btn--ghost' }, '×')
                ),

                // Info
                h('div', { style: { padding: 'var(--space-3)', background: 'var(--bg-secondary)' } },
                    h('div', { class: 'text-sm' },
                        `Need: ${contract.strainName}`,
                        contract.qualityMin > 0 && ` (Q${contract.qualityMin}+)`
                    ),
                    h('div', { class: 'text-sm text-muted' }, `${remaining} more needed`)
                ),

                // Items
                h('div', { style: { overflowY: 'auto', padding: 'var(--space-3)', flex: 1 } },
                    validItems.length === 0
                        ? h('p', { class: 'text-muted text-center' }, 'No matching items in inventory')
                        : validItems.map(item =>
                            h('div', {
                                class: 'cf-deliver-item cf-card',
                                dataset: { inventoryId: item.id.toString() },
                                style: { marginBottom: 'var(--space-2)', cursor: 'pointer' }
                            },
                                h('div', {
                                    class: 'cf-card__body',
                                    style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' }
                                },
                                    h('div', {},
                                        h('div', { class: 'font-medium' }, item.strainName || 'Unknown'),
                                        h('div', { class: 'text-xs text-muted' }, `Q${item.quality} | x${item.quantity}`)
                                    ),
                                    h('span', { style: { color: 'var(--color-primary)' } }, 'Deliver →')
                                )
                            )
                        )
                )
            )
        );
    }
}

registerComponent('cf-contracts', CFContracts);
export default CFContracts;
