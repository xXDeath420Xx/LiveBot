/**
 * CertiFried Extension - Upgrades Hub Component
 * Centralized view of all upgrade paths across game systems
 */

import { CFBaseComponent, registerComponent } from './base-component.js';
import { h } from '../utils/dom.js';
import { formatCurrency, formatNumber } from '../utils/format.js';
import { api } from '../api/client.js';
import { store } from '../state/store.js';

// Upgrade categories
const UPGRADE_CATEGORIES = {
    facility: {
        name: 'Facility',
        icon: '🏭',
        description: 'Grow operation improvements',
        color: 'var(--color-primary)'
    },
    equipment: {
        name: 'Equipment',
        icon: '🔧',
        description: 'Tools and machinery',
        color: 'var(--color-success)'
    },
    workers: {
        name: 'Workers',
        icon: '👷',
        description: 'Staff upgrades and training',
        color: 'var(--color-warning)'
    },
    research: {
        name: 'Research',
        icon: '🔬',
        description: 'Unlock new technologies',
        color: 'var(--color-epic)'
    },
    prestige: {
        name: 'Prestige',
        icon: '⭐',
        description: 'Permanent bonuses',
        color: 'var(--color-legendary)'
    },
    properties: {
        name: 'Properties',
        icon: '🏠',
        description: 'Locations and expansions',
        color: 'var(--color-rare)'
    }
};

class CFUpgrades extends CFBaseComponent {
    constructor() {
        super();
        this._loading = true;
        this._error = null;
        this._activeCategory = 'all';
        this._upgrades = {
            facility: [],
            equipment: [],
            workers: [],
            research: [],
            prestige: [],
            properties: []
        };
        this._stats = {
            totalAvailable: 0,
            affordable: 0,
            maxed: 0
        };
    }

    _setupSubscriptions() {
        this.subscribe('player');
    }

    async onMount() {
        await this._loadAllUpgrades();

        // Category filter
        this.on('click', '.cf-upgrade-category', (e) => {
            const btn = e.target.closest('.cf-upgrade-category');
            if (!btn) return;
            this._activeCategory = btn.dataset.category;
            this.render();
        });

        // Purchase upgrade
        this.on('click', '.cf-purchase-upgrade', async (e) => {
            const btn = e.target.closest('.cf-purchase-upgrade');
            if (!btn || btn.disabled) return;
            const category = btn.dataset.category;
            const upgradeId = btn.dataset.upgradeId;
            await this._purchaseUpgrade(category, upgradeId);
        });
    }

    async _loadAllUpgrades() {
        const isFirstLoad = !this._upgrades.facility.length;

        if (isFirstLoad) {
            this._loading = true;
            this._error = null;
            this.render();
        }

        try {
            // Load upgrades from various sources in parallel
            const [facilityRes, equipmentRes, researchRes, prestigeRes, locationsRes] = await Promise.all([
                api.getFacilityInfo().catch(() => ({ upgrades: [] })),
                api.getEquipment().catch(() => ({ allEquipment: [] })),
                api.getResearchTree().catch(() => ({ nodes: [] })),
                api.getPrestigeInfo().catch(() => ({ availableUpgrades: [] })),
                api.getLocations().catch(() => ({ locations: [] }))
            ]);

            // Process facility upgrades
            this._upgrades.facility = (facilityRes.upgrades || [])
                .filter(u => !u.isMaxed && !u.maxed)
                .map(u => ({
                    id: u.id || u.key,
                    key: u.key,
                    name: u.name,
                    description: u.description,
                    cost: u.nextCost || u.cost || 0,
                    category: 'facility',
                    purchasable: !!(u.nextCost || u.cost),
                    effectType: u.effectType,
                    effectValue: u.nextValue || u.effectValue
                }));

            // Process equipment (items not owned)
            this._upgrades.equipment = (equipmentRes.allEquipment || [])
                .filter(e => !e.isOwned)
                .map(e => ({
                    id: e.id,
                    name: e.name,
                    description: e.description,
                    cost: e.price,
                    category: 'equipment',
                    purchasable: e.canPurchase ?? true,
                    effectType: e.effectType,
                    effectValue: e.effectValue
                }));

            // Process research (not completed)
            this._upgrades.research = (researchRes.nodes || [])
                .filter(r => !r.isComplete && !r.isCompleted && r.status !== 'completed' && r.status !== 'in_progress')
                .map(r => ({
                    id: r.id,
                    name: r.name,
                    description: r.description,
                    cost: r.cost || r.cashCost || 0,
                    category: 'research',
                    purchasable: r.canStart !== false && r.meetsRequirements !== false,
                    duration: r.duration || r.durationHours
                }));

            // Process prestige upgrades
            this._upgrades.prestige = (prestigeRes.availableUpgrades || []).map(u => ({
                id: u.id,
                name: u.name,
                description: u.description,
                cost: u.cost,
                costType: 'prestige_tokens',
                category: 'prestige',
                purchasable: true,
                effectType: u.effectType,
                effectValue: u.effectValue
            }));

            // Process properties (filter out owned ones using correct field name)
            this._upgrades.properties = (locationsRes.locations || [])
                .filter(l => !l.isOwned && !l.isStarter)
                .map(p => ({
                    id: p.id,
                    name: p.name,
                    description: p.description || `${p.baseSlots || p.growSlots || 0} grow slots`,
                    cost: p.purchasePrice || p.price || 0,
                    category: 'properties',
                    purchasable: p.canPurchase !== false && p.meetsLevel !== false && p.meetsResearch !== false
                }));

            // Calculate stats
            this._calculateStats();

        } catch (err) {
            this._error = err.message;
        }

        this._loading = false;
        this.scheduleRender();
    }

    _calculateStats() {
        const player = this.getState('player') || {};
        const cash = player.currency || 0;
        const tokens = player.prestigeTokens || 0;

        let totalAvailable = 0;
        let affordable = 0;
        let maxed = 0;

        Object.values(this._upgrades).forEach(categoryUpgrades => {
            categoryUpgrades.forEach(upgrade => {
                totalAvailable++;
                if (upgrade.maxed) {
                    maxed++;
                } else if (upgrade.purchasable) {
                    const cost = upgrade.cost || 0;
                    const canAfford = upgrade.costType === 'prestige_tokens'
                        ? tokens >= cost
                        : cash >= cost;
                    if (canAfford) affordable++;
                }
            });
        });

        this._stats = { totalAvailable, affordable, maxed };
    }

    async _purchaseUpgrade(category, upgradeId) {
        const upgrade = this._upgrades[category]?.find(u => u.id.toString() === upgradeId);
        if (!upgrade) return;

        try {
            let result;
            switch (category) {
                case 'facility':
                    result = await api.upgradeFacility(upgrade.key || upgradeId);
                    break;
                case 'equipment':
                    result = await api.buyEquipment(parseInt(upgradeId, 10));
                    break;
                case 'research':
                    result = await api.startResearch(parseInt(upgradeId, 10));
                    break;
                case 'prestige':
                    result = await api.buyPrestigeUpgrade(parseInt(upgradeId, 10));
                    break;
                case 'properties':
                    result = await api.buyLocation(upgradeId);
                    break;
            }

            if (result?.success !== false) {
                this.emit('notification', {
                    type: 'success',
                    message: `Purchased ${upgrade.name}!`
                });
                await this._loadAllUpgrades();
            } else {
                throw new Error(result?.error || 'Purchase failed');
            }
        } catch (err) {
            this.emit('notification', { type: 'error', message: err.message });
        }
    }

    render() {
        this.className = 'cf-upgrades';

        if (this._loading) {
            this.setContent(h('div', { class: 'cf-loading' }, h('div', { class: 'cf-spinner' })));
            return;
        }

        if (this._error) {
            this.setContent(
                h('div', { class: 'cf-error-message' },
                    h('p', {}, this._error),
                    h('button', { class: 'cf-btn cf-btn--primary', onclick: () => this._loadAllUpgrades() }, 'Retry')
                )
            );
            return;
        }

        const player = this.getState('player') || {};

        this.setContent(
            h('h2', { class: 'cf-section__title mb-3' }, '⬆️ Upgrades Hub'),

            // Summary stats
            h('div', { class: 'cf-card mb-3' },
                h('div', { class: 'cf-card__body' },
                    h('div', {
                        style: {
                            display: 'flex',
                            justifyContent: 'space-around',
                            textAlign: 'center'
                        }
                    },
                        h('div', {},
                            h('div', { class: 'text-lg font-bold' }, this._stats.totalAvailable),
                            h('div', { class: 'text-xs text-muted' }, 'Available')
                        ),
                        h('div', {},
                            h('div', { class: 'text-lg font-bold', style: { color: 'var(--color-success)' } },
                                this._stats.affordable
                            ),
                            h('div', { class: 'text-xs text-muted' }, 'Affordable')
                        ),
                        h('div', {},
                            h('div', { class: 'text-lg font-bold', style: { color: 'var(--color-primary)' } },
                                formatCurrency(player.currency || 0, true)
                            ),
                            h('div', { class: 'text-xs text-muted' }, 'Cash')
                        )
                    )
                )
            ),

            // Category filters
            h('div', { class: 'cf-tabs mb-3', style: { flexWrap: 'wrap' } },
                h('button', {
                    class: `cf-tab cf-upgrade-category ${this._activeCategory === 'all' ? 'cf-tab--active' : ''}`,
                    dataset: { category: 'all' }
                }, 'All'),
                ...Object.entries(UPGRADE_CATEGORIES).map(([key, cat]) => {
                    const count = this._upgrades[key]?.length || 0;
                    return h('button', {
                        class: `cf-tab cf-upgrade-category ${this._activeCategory === key ? 'cf-tab--active' : ''}`,
                        dataset: { category: key }
                    }, `${cat.icon} ${count}`);
                })
            ),

            // Upgrade list
            this._renderUpgradeList(player)
        );
    }

    _renderUpgradeList(player) {
        let upgrades = [];

        if (this._activeCategory === 'all') {
            Object.entries(this._upgrades).forEach(([category, items]) => {
                items.forEach(item => upgrades.push({ ...item, category }));
            });
        } else {
            upgrades = this._upgrades[this._activeCategory] || [];
        }

        // Sort by affordable first, then by cost
        upgrades.sort((a, b) => {
            const aAffordable = this._canAfford(a, player) ? 0 : 1;
            const bAffordable = this._canAfford(b, player) ? 0 : 1;
            if (aAffordable !== bAffordable) return aAffordable - bAffordable;
            return (a.cost || 0) - (b.cost || 0);
        });

        if (upgrades.length === 0) {
            return h('div', { class: 'cf-empty' },
                h('p', { class: 'cf-empty__title' }, 'No Upgrades Available'),
                h('p', { class: 'cf-empty__description' },
                    this._activeCategory === 'all'
                        ? 'All upgrades purchased!'
                        : 'No upgrades in this category'
                )
            );
        }

        return h('div', { class: 'cf-upgrade-list' },
            ...upgrades.map(upgrade => this._renderUpgradeCard(upgrade, player))
        );
    }

    _canAfford(upgrade, player) {
        const cost = upgrade.cost || 0;
        if (upgrade.costType === 'prestige_tokens') {
            return (player.prestigeTokens || 0) >= cost;
        }
        return (player.currency || 0) >= cost;
    }

    _renderUpgradeCard(upgrade, player) {
        const catInfo = UPGRADE_CATEGORIES[upgrade.category] || {};
        const canAfford = this._canAfford(upgrade, player);
        const isPrestige = upgrade.costType === 'prestige_tokens';
        const costDisplay = isPrestige
            ? `🪙 ${upgrade.cost}`
            : formatCurrency(upgrade.cost || 0);

        return h('div', {
            class: 'cf-card mb-2',
            style: {
                borderLeft: `3px solid ${catInfo.color || 'var(--border-primary)'}`,
                opacity: canAfford ? 1 : 0.7
            }
        },
            h('div', { class: 'cf-card__body' },
                h('div', { style: { display: 'flex', alignItems: 'center', gap: 'var(--space-3)' } },
                    h('div', {
                        style: {
                            width: '36px',
                            height: '36px',
                            background: 'var(--bg-tertiary)',
                            borderRadius: 'var(--radius-md)',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            fontSize: '1.25rem'
                        }
                    }, catInfo.icon || '⬆️'),
                    h('div', { style: { flex: 1 } },
                        h('div', { class: 'font-semibold' }, upgrade.name),
                        h('div', { class: 'text-xs text-muted' }, upgrade.description),
                        upgrade.effectValue && h('div', {
                            class: 'text-xs mt-1',
                            style: { color: 'var(--color-success)' }
                        }, `+${this._formatEffect(upgrade)}`),
                        h('div', { class: 'text-xs', style: { color: catInfo.color } },
                            catInfo.name
                        )
                    ),
                    h('button', {
                        class: `cf-btn cf-btn--sm cf-purchase-upgrade ${canAfford ? 'cf-btn--primary' : ''}`,
                        dataset: {
                            category: upgrade.category,
                            upgradeId: upgrade.id?.toString()
                        },
                        disabled: !canAfford || !upgrade.purchasable
                    }, costDisplay)
                )
            )
        );
    }

    _formatEffect(upgrade) {
        const value = upgrade.effectValue || 0;
        const type = upgrade.effectType || '';

        if (type.includes('multiplier') || type.includes('percent') || type.includes('bonus')) {
            return `${Math.round(value * 100)}% ${type.replace(/_/g, ' ')}`;
        }
        if (type.includes('capacity') || type.includes('slots')) {
            return `${value} ${type.replace(/_/g, ' ')}`;
        }
        return `${value}`;
    }
}

registerComponent('cf-upgrades', CFUpgrades);
export default CFUpgrades;
