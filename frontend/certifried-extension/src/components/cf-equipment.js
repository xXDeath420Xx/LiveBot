/**
 * Equipment Component
 * Tools and upgrades that provide passive bonuses
 */

import { CFBaseComponent, registerComponent } from './base-component.js';
import { h } from '../utils/dom.js';
import { api } from '../api/client.js';
import { formatCurrency } from '../utils/format.js';

const CATEGORY_INFO = {
    lighting: { name: 'Lighting', icon: '💡', description: 'Affects grow speed' },
    irrigation: { name: 'Irrigation', icon: '💧', description: 'Affects yield' },
    climate: { name: 'Climate', icon: '🌡️', description: 'Affects quality' },
    security: { name: 'Security', icon: '🔒', description: 'Reduces heat' },
    processing: { name: 'Processing', icon: '⚗️', description: 'Extraction bonuses' },
    storage: { name: 'Storage', icon: '📦', description: 'Inventory capacity' },
    automation: { name: 'Automation', icon: '🤖', description: 'Worker efficiency' },
    genetics: { name: 'Genetics', icon: '🧬', description: 'Breeding success' },
    nutrients: { name: 'Nutrients', icon: '🧪', description: 'Plant health bonuses' },
    defense: { name: 'Defense', icon: '🛡️', description: 'Raid protection' }
};

const EFFECT_LABELS = {
    grow_speed: 'Grow Speed',
    yield_bonus: 'Yield',
    quality_bonus: 'Quality',
    heat_reduction: 'Heat Reduction',
    extraction_yield: 'Extraction Yield',
    storage_capacity: 'Storage Capacity',
    quality_decay: 'Quality Decay',
    worker_efficiency: 'Worker Efficiency',
    breeding_success: 'Breeding Success',
    breeding_speed: 'Breeding Speed',
    mutation_chance: 'Mutation Chance',
    xp_bonus: 'XP Bonus',
    market_price: 'Market Price',
    raid_defense: 'Raid Defense',
    offline_earnings: 'Offline Earnings',
    auto_harvest: 'Auto-Harvest Speed',
    plant_health: 'Plant Health'
};

class CFEquipment extends CFBaseComponent {
    constructor() {
        super();
        this._equipment = {};
        this._allEquipment = [];
        this._activeBonuses = {};
        this._stats = { total: 0, owned: 0, active: 0 };
        this._player = { cash: 0, level: 1 };
        this._loading = true;
        this._error = null;
        this._activeCategory = 'lighting';
    }

    async onMount() {
        await this._loadEquipment();

        // Category tabs
        this.on('click', '.cf-category-tab', (e) => {
            const tab = e.target.closest('.cf-category-tab');
            if (!tab) return;
            this._activeCategory = tab.dataset.category;
            this.render();
        });

        // Buy equipment
        this.on('click', '.cf-buy-equipment', async (e) => {
            const btn = e.target.closest('.cf-buy-equipment');
            if (!btn || btn.disabled) return;
            await this._buyEquipment(parseInt(btn.dataset.id, 10));
        });

        // Toggle equipment
        this.on('click', '.cf-toggle-equipment', async (e) => {
            const btn = e.target.closest('.cf-toggle-equipment');
            if (!btn) return;
            await this._toggleEquipment(parseInt(btn.dataset.id, 10));
        });

        // Sell equipment
        this.on('click', '.cf-sell-equipment', async (e) => {
            const btn = e.target.closest('.cf-sell-equipment');
            if (!btn) return;
            if (confirm('Sell this equipment? You will get 50% of the purchase price.')) {
                await this._sellEquipment(parseInt(btn.dataset.id, 10));
            }
        });
    }

    async _loadEquipment() {
        // Only show spinner on first load when we have no data
        const isFirstLoad = this._allEquipment.length === 0;

        if (isFirstLoad) {
            this._loading = true;
            this._error = null;
            this.render();
        }

        try {
            const response = await api.getEquipment();
            if (response.success) {
                this._equipment = response.equipment || {};
                this._allEquipment = response.allEquipment || [];
                this._activeBonuses = response.activeBonuses || {};
                this._stats = response.stats || { total: 0, owned: 0, active: 0 };
                this._player = response.player || { cash: 0, level: 1 };
            } else {
                this._error = response.error;
            }
        } catch (err) {
            this._error = err.message;
        }

        this._loading = false;
        this.scheduleRender();
    }

    async _buyEquipment(equipmentId) {
        // Find the equipment item
        const item = this._allEquipment.find(e => e.id === equipmentId);
        if (!item) return;

        // Optimistic update
        const oldPlayerCash = this._player.cash;
        const oldItemOwned = item.isOwned;
        item.isOwned = true;
        item.isActive = true;
        this._player.cash -= item.price;
        this._stats.owned++;
        this._stats.active++;
        this.scheduleRender();

        try {
            const response = await api.buyEquipment(equipmentId);
            if (response.success) {
                this.emit('notification', { type: 'success', message: response.message });
                // Background refresh for accurate state
                this._loadEquipment();
            } else {
                // Rollback on failure
                item.isOwned = oldItemOwned;
                item.isActive = false;
                this._player.cash = oldPlayerCash;
                this._stats.owned--;
                this._stats.active--;
                this.scheduleRender();
                this.emit('notification', { type: 'error', message: response.error });
            }
        } catch (err) {
            // Rollback on error
            item.isOwned = oldItemOwned;
            item.isActive = false;
            this._player.cash = oldPlayerCash;
            this._stats.owned--;
            this._stats.active--;
            this.scheduleRender();
            this.emit('notification', { type: 'error', message: err.message });
        }
    }

    async _toggleEquipment(equipmentId) {
        // Find the equipment item
        const item = this._allEquipment.find(e => e.id === equipmentId);
        if (!item) return;

        // Optimistic update
        const wasActive = item.isActive;
        item.isActive = !wasActive;
        this._stats.active += wasActive ? -1 : 1;
        this.scheduleRender();

        try {
            const response = await api.toggleEquipment(equipmentId);
            if (response.success) {
                this.emit('notification', { type: 'info', message: response.message });
                // Background refresh for accurate state
                this._loadEquipment();
            } else {
                // Rollback on failure
                item.isActive = wasActive;
                this._stats.active += wasActive ? 1 : -1;
                this.scheduleRender();
                this.emit('notification', { type: 'error', message: response.error });
            }
        } catch (err) {
            // Rollback on error
            item.isActive = wasActive;
            this._stats.active += wasActive ? 1 : -1;
            this.scheduleRender();
            this.emit('notification', { type: 'error', message: err.message });
        }
    }

    async _sellEquipment(equipmentId) {
        try {
            const response = await api.sellEquipment(equipmentId);
            if (response.success) {
                this.emit('notification', { type: 'success', message: response.message });
                await this._loadEquipment();
            } else {
                this.emit('notification', { type: 'error', message: response.error });
            }
        } catch (err) {
            this.emit('notification', { type: 'error', message: err.message });
        }
    }

    render() {
        this.className = 'cf-equipment';

        if (this._loading) {
            this.setContent(h('div', { class: 'cf-loading' }, h('div', { class: 'cf-spinner' })));
            return;
        }

        if (this._error) {
            this.setContent(
                h('div', { class: 'cf-error-message' },
                    h('p', {}, this._error),
                    h('button', { class: 'cf-btn cf-btn--primary', onclick: () => this._loadEquipment() }, 'Retry')
                )
            );
            return;
        }

        const content = [];

        // Header
        content.push(
            h('div', { style: { marginBottom: 'var(--space-4)' } },
                h('h2', { class: 'cf-section__title' }, 'Equipment'),
                h('p', { class: 'text-sm text-muted' },
                    `Owned ${this._stats.owned}/${this._stats.total} | Active: ${this._stats.active}`
                )
            )
        );

        // Active bonuses summary
        const bonusEntries = Object.entries(this._activeBonuses);
        if (bonusEntries.length > 0) {
            content.push(
                h('div', { class: 'cf-card mb-4', style: { background: 'var(--bg-secondary)' } },
                    h('div', { class: 'cf-card__header' },
                        h('h4', { class: 'cf-card__title' }, 'Active Bonuses')
                    ),
                    h('div', { class: 'cf-card__body' },
                        h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 'var(--space-3)' } },
                            ...bonusEntries.map(([type, value]) => {
                                const label = EFFECT_LABELS[type] || type;
                                const displayValue = type === 'storage_capacity'
                                    ? `+${value}`
                                    : `${value > 0 ? '+' : ''}${Math.round(value * 100)}%`;
                                return h('div', { class: 'text-sm' },
                                    h('span', { class: 'text-muted' }, `${label}: `),
                                    h('span', { style: { color: 'var(--color-success)' } }, displayValue)
                                );
                            })
                        )
                    )
                )
            );
        }

        // Category tabs
        content.push(
            h('div', { class: 'cf-tabs mb-3', style: { flexWrap: 'wrap' } },
                ...Object.entries(CATEGORY_INFO).map(([key, info]) => {
                    const items = this._equipment[key] || [];
                    const owned = items.filter(e => e.isOwned).length;
                    return h('button', {
                        class: `cf-tab cf-category-tab ${this._activeCategory === key ? 'cf-tab--active' : ''}`,
                        dataset: { category: key }
                    }, `${info.icon} ${owned}/${items.length}`);
                })
            )
        );

        // Category header
        const catInfo = CATEGORY_INFO[this._activeCategory];
        content.push(
            h('div', { class: 'mb-3' },
                h('h3', {}, `${catInfo.icon} ${catInfo.name}`),
                h('p', { class: 'text-xs text-muted' }, catInfo.description)
            )
        );

        // Equipment list
        const items = this._equipment[this._activeCategory] || [];
        const byTier = {};
        for (const item of items) {
            if (!byTier[item.tier]) byTier[item.tier] = [];
            byTier[item.tier].push(item);
        }

        for (const [tier, tierItems] of Object.entries(byTier)) {
            content.push(
                h('div', { class: 'cf-equipment-tier mb-3' },
                    h('div', { class: 'text-xs text-muted mb-2' }, `Tier ${tier}`),
                    ...tierItems.map(item => this._renderItem(item))
                )
            );
        }

        // Player cash
        content.push(
            h('div', { class: 'cf-card mt-4', style: { background: 'var(--bg-secondary)' } },
                h('div', { class: 'cf-card__body text-center' },
                    h('div', { class: 'text-xs text-muted' }, 'Available Cash'),
                    h('div', { class: 'font-semibold', style: { color: 'var(--color-success)' } },
                        formatCurrency(this._player.cash)
                    )
                )
            )
        );

        this.setContent(...content);
    }

    _renderItem(item) {
        const effectLabel = EFFECT_LABELS[item.effectType] || item.effectType;
        const effectDisplay = item.effectType === 'storage_capacity'
            ? `+${item.effectValue}`
            : item.effectType === 'quality_decay'
                ? `${Math.round(item.effectValue * 100)}%`
                : `+${Math.round(item.effectValue * 100)}%`;

        return h('div', {
            class: 'cf-card cf-equipment-item',
            style: {
                marginBottom: 'var(--space-2)',
                opacity: !item.isOwned && !item.meetsResearch ? 0.5 : 1,
                borderLeft: item.isOwned
                    ? `3px solid ${item.isActive ? 'var(--color-success)' : 'var(--color-warning)'}`
                    : '3px solid var(--border-primary)'
            }
        },
            h('div', { class: 'cf-card__body' },
                // Header
                h('div', { style: { display: 'flex', alignItems: 'center', gap: 'var(--space-2)', marginBottom: 'var(--space-2)' } },
                    h('span', { style: { fontSize: '1.25rem' } }, item.icon),
                    h('div', { style: { flex: 1 } },
                        h('div', { class: 'font-semibold' }, item.name),
                        item.isOwned && h('span', {
                            class: 'text-xs',
                            style: { color: item.isActive ? 'var(--color-success)' : 'var(--color-warning)' }
                        }, item.isActive ? 'Active' : 'Inactive')
                    ),
                    !item.isOwned && h('div', { class: 'text-right' },
                        h('div', { class: 'font-semibold' }, formatCurrency(item.price))
                    )
                ),

                // Description
                h('p', { class: 'text-xs text-muted mb-2' }, item.description),

                // Effect
                h('div', { class: 'text-sm mb-2', style: { color: 'var(--color-primary)' } },
                    `${effectLabel}: ${effectDisplay}`
                ),

                // Requirements (if not owned)
                !item.isOwned && item.unlockResearchKey && h('div', {
                    class: 'text-xs mb-2',
                    style: { color: item.meetsResearch ? 'var(--color-success)' : 'var(--color-danger)' }
                },
                    item.meetsResearch ? '✓ Research complete' : `Requires: ${item.unlockResearchKey}`
                ),

                // Actions
                item.isOwned
                    ? h('div', { style: { display: 'flex', gap: 'var(--space-2)' } },
                        h('button', {
                            class: `cf-btn cf-btn--sm cf-toggle-equipment ${item.isActive ? 'cf-btn--warning' : 'cf-btn--success'}`,
                            dataset: { id: item.id.toString() },
                            style: { flex: 1 }
                        }, item.isActive ? 'Deactivate' : 'Activate'),
                        h('button', {
                            class: 'cf-btn cf-btn--sm cf-btn--ghost cf-sell-equipment',
                            dataset: { id: item.id.toString() }
                        }, 'Sell')
                    )
                    : h('button', {
                        class: `cf-btn cf-btn--sm cf-buy-equipment ${item.canPurchase ? 'cf-btn--primary' : ''}`,
                        dataset: { id: item.id.toString() },
                        disabled: !item.canPurchase,
                        style: { width: '100%' }
                    }, item.canPurchase ? 'Buy' : (
                        !item.meetsResearch ? 'Research Locked' :
                        !item.canAfford ? 'Cannot Afford' :
                        'Locked'
                    ))
            )
        );
    }
}

registerComponent('cf-equipment', CFEquipment);
export default CFEquipment;
