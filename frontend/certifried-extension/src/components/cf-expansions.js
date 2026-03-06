/**
 * CertiFried Extension - Expansions Component
 * Property management, expansion slots, and real estate
 */

import { CFBaseComponent, registerComponent } from './base-component.js';
import { h } from '../utils/dom.js';
import { formatCurrency, formatNumber } from '../utils/format.js';
import { api } from '../api/client.js';

// Property types
const PROPERTY_TYPES = {
    greenhouse: {
        name: 'Greenhouse',
        icon: '🏡',
        description: 'Small but efficient grow space',
        baseSlots: 4,
        color: 'var(--color-success)'
    },
    warehouse: {
        name: 'Warehouse',
        icon: '🏭',
        description: 'Industrial-scale operation',
        baseSlots: 12,
        color: 'var(--color-primary)'
    },
    bunker: {
        name: 'Underground Bunker',
        icon: '🏚️',
        description: 'Hidden and secure facility',
        baseSlots: 8,
        color: 'var(--color-warning)'
    },
    penthouse: {
        name: 'Penthouse Suite',
        icon: '🏢',
        description: 'Luxury grow with quality bonuses',
        baseSlots: 6,
        color: 'var(--color-epic)'
    },
    island: {
        name: 'Private Island',
        icon: '🏝️',
        description: 'Ultimate expansion - massive capacity',
        baseSlots: 24,
        color: 'var(--color-legendary)'
    }
};

// Expansion tiers
const EXPANSION_TIERS = [
    { level: 1, name: 'Starter', bonus: 0 },
    { level: 2, name: 'Basic', bonus: 0.05 },
    { level: 3, name: 'Improved', bonus: 0.10 },
    { level: 4, name: 'Advanced', bonus: 0.20 },
    { level: 5, name: 'Premium', bonus: 0.35 },
    { level: 6, name: 'Elite', bonus: 0.50 }
];

class CFExpansions extends CFBaseComponent {
    constructor() {
        super();
        this._properties = [];
        this._availableExpansions = [];
        this._stats = {
            totalSlots: 0,
            ownedProperties: 0,
            maxProperties: 5
        };
        this._loading = true;
        this._error = null;
        this._activeTab = 'owned'; // 'owned' | 'available' | 'upgrades'
        this._selectedProperty = null;
    }

    _setupSubscriptions() {
        this.subscribe('player');
    }

    async onMount() {
        await this._loadExpansionData();

        // Tab switching
        this.on('click', '.cf-tab-btn', (e) => {
            const tab = e.target.closest('.cf-tab-btn');
            if (!tab) return;
            this._activeTab = tab.dataset.tab;
            this._selectedProperty = null;
            this.render();
        });

        // Select property
        this.on('click', '.cf-property-card', (e) => {
            const card = e.target.closest('.cf-property-card');
            if (!card) return;
            const propertyId = card.dataset.propertyId;
            this._selectedProperty = this._properties.find(p => p.id.toString() === propertyId) ||
                                     this._availableExpansions.find(p => p.id.toString() === propertyId);
            this.render();
        });

        // Back button
        this.on('click', '.cf-property-back', () => {
            this._selectedProperty = null;
            this.render();
        });

        // Purchase expansion
        this.on('click', '.cf-purchase-expansion', async (e) => {
            const btn = e.target.closest('.cf-purchase-expansion');
            if (!btn || btn.disabled) return;
            const propertyId = btn.dataset.propertyId;
            await this._purchaseProperty(propertyId);
        });

        // Upgrade property
        this.on('click', '.cf-upgrade-property', async (e) => {
            const btn = e.target.closest('.cf-upgrade-property');
            if (!btn || btn.disabled) return;
            await this._upgradeProperty(this._selectedProperty.id);
        });

        // Set primary
        this.on('click', '.cf-set-primary', async (e) => {
            const btn = e.target.closest('.cf-set-primary');
            if (!btn) return;
            await this._setPrimaryProperty(this._selectedProperty.id);
        });
    }

    async _loadExpansionData() {
        const isFirstLoad = this._properties.length === 0;

        if (isFirstLoad) {
            this._loading = true;
            this._error = null;
            this.render();
        }

        try {
            const response = await api.getLocations();
            // API returns 'isOwned' not 'owned'
            this._properties = response.locations?.filter(l => l.isOwned) || [];
            this._availableExpansions = response.locations?.filter(l => !l.isOwned && !l.isStarter) || [];
            this._stats = {
                totalSlots: this._properties.reduce((sum, p) => sum + (p.currentSlots || p.growSlots || 0), 0),
                ownedProperties: this._properties.length,
                maxProperties: response.maxProperties || 5
            };
        } catch (err) {
            this._error = err.message;
        }

        this._loading = false;
        this.scheduleRender();
    }

    async _purchaseProperty(propertyId) {
        const property = this._availableExpansions.find(p => p.id.toString() === propertyId);
        if (!property) return;

        const player = this.getState('player') || {};
        const price = property.purchasePrice || property.price || 0;
        if ((player.currency || 0) < price) {
            this.emit('notification', { type: 'error', message: 'Not enough cash' });
            return;
        }

        try {
            const result = await api.buyLocation(propertyId);
            if (result.success) {
                this.emit('notification', {
                    type: 'success',
                    message: `Purchased ${property.name}!`
                });
                await this._loadExpansionData();
                this._activeTab = 'owned';
                this._selectedProperty = null;
            } else {
                throw new Error(result.error);
            }
        } catch (err) {
            this.emit('notification', { type: 'error', message: err.message });
        }
    }

    async _upgradeProperty(propertyId) {
        try {
            const result = await api.upgradeLocation(propertyId);
            if (result.success) {
                this.emit('notification', { type: 'success', message: 'Property upgraded!' });
                await this._loadExpansionData();
            } else {
                throw new Error(result.error);
            }
        } catch (err) {
            this.emit('notification', { type: 'error', message: err.message });
        }
    }

    async _setPrimaryProperty(propertyId) {
        try {
            const result = await api.setPrimaryLocation(propertyId);
            if (result.success) {
                this.emit('notification', { type: 'success', message: 'Primary location updated!' });
                await this._loadExpansionData();
            } else {
                throw new Error(result.error);
            }
        } catch (err) {
            this.emit('notification', { type: 'error', message: err.message });
        }
    }

    render() {
        this.className = 'cf-expansions';

        if (this._loading) {
            this.setContent(h('div', { class: 'cf-loading' }, h('div', { class: 'cf-spinner' })));
            return;
        }

        if (this._error) {
            this.setContent(
                h('div', { class: 'cf-error-message' },
                    h('p', {}, this._error),
                    h('button', { class: 'cf-btn cf-btn--primary', onclick: () => this._loadExpansionData() }, 'Retry')
                )
            );
            return;
        }

        if (this._selectedProperty) {
            this.setContent(this._renderPropertyDetail());
            return;
        }

        this.setContent(
            h('h2', { class: 'cf-section__title mb-3' }, '🏠 Properties & Expansions'),

            // Summary
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
                            h('div', { class: 'text-lg font-bold' }, this._stats.ownedProperties),
                            h('div', { class: 'text-xs text-muted' }, `/ ${this._stats.maxProperties} Properties`)
                        ),
                        h('div', {},
                            h('div', { class: 'text-lg font-bold', style: { color: 'var(--color-success)' } },
                                this._stats.totalSlots
                            ),
                            h('div', { class: 'text-xs text-muted' }, 'Total Grow Slots')
                        ),
                        h('div', {},
                            h('div', { class: 'text-lg font-bold', style: { color: 'var(--color-primary)' } },
                                formatCurrency(this.getState('player.currency') || 0, true)
                            ),
                            h('div', { class: 'text-xs text-muted' }, 'Cash')
                        )
                    )
                )
            ),

            // Tabs
            h('div', { class: 'cf-tabs mb-3' },
                h('button', {
                    class: `cf-tab cf-tab-btn ${this._activeTab === 'owned' ? 'cf-tab--active' : ''}`,
                    dataset: { tab: 'owned' }
                }, `Owned (${this._properties.length})`),
                h('button', {
                    class: `cf-tab cf-tab-btn ${this._activeTab === 'available' ? 'cf-tab--active' : ''}`,
                    dataset: { tab: 'available' }
                }, 'Available'),
                h('button', {
                    class: `cf-tab cf-tab-btn ${this._activeTab === 'upgrades' ? 'cf-tab--active' : ''}`,
                    dataset: { tab: 'upgrades' }
                }, 'Upgrades')
            ),

            // Tab content
            this._activeTab === 'owned' && this._renderOwnedTab(),
            this._activeTab === 'available' && this._renderAvailableTab(),
            this._activeTab === 'upgrades' && this._renderUpgradesTab()
        );
    }

    _renderOwnedTab() {
        if (this._properties.length === 0) {
            return h('div', { class: 'cf-empty' },
                h('p', { class: 'cf-empty__title' }, 'No Properties Owned'),
                h('p', { class: 'cf-empty__description' },
                    'Purchase your first property from the Available tab'
                )
            );
        }

        return h('div', { class: 'cf-expansion-owned' },
            ...this._properties.map(property => this._renderPropertyCard(property, true))
        );
    }

    _renderAvailableTab() {
        const player = this.getState('player') || {};

        if (this._properties.length >= this._stats.maxProperties) {
            return h('div', { class: 'cf-empty' },
                h('p', { class: 'cf-empty__title' }, 'Maximum Properties Reached'),
                h('p', { class: 'cf-empty__description' },
                    'You own the maximum number of properties. Prestige to unlock more slots!'
                )
            );
        }

        if (this._availableExpansions.length === 0) {
            return h('div', { class: 'cf-empty' },
                h('p', { class: 'cf-empty__title' }, 'No Expansions Available'),
                h('p', { class: 'cf-empty__description' },
                    'Check back at higher levels for new expansion opportunities'
                )
            );
        }

        return h('div', { class: 'cf-expansion-available' },
            h('p', { class: 'text-sm text-muted mb-3' },
                `Available: ${formatCurrency(player.currency || 0)}`
            ),
            ...this._availableExpansions.map(property => this._renderPropertyCard(property, false))
        );
    }

    _renderPropertyCard(property, owned) {
        const typeInfo = PROPERTY_TYPES[property.type || property.key] || {
            icon: property.icon || '🏠',
            color: 'var(--text-muted)',
            name: property.name || 'Property'
        };
        const currentSlots = property.currentSlots || property.baseSlots || 0;
        const maxSlots = property.maxSlots || property.max_slots || 10;

        return h('div', {
            class: 'cf-card cf-property-card mb-2',
            dataset: { propertyId: property.id.toString() },
            style: {
                cursor: 'pointer',
                borderLeft: `3px solid ${typeInfo.color}`
            }
        },
            h('div', { class: 'cf-card__body' },
                h('div', { style: { display: 'flex', alignItems: 'center', gap: 'var(--space-3)' } },
                    h('div', {
                        style: {
                            width: '48px',
                            height: '48px',
                            background: 'var(--bg-tertiary)',
                            borderRadius: 'var(--radius-md)',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            fontSize: '1.5rem'
                        }
                    }, property.icon || typeInfo.icon),
                    h('div', { style: { flex: 1 } },
                        h('div', { style: { display: 'flex', alignItems: 'center', gap: 'var(--space-2)' } },
                            h('span', { class: 'font-semibold' }, property.name || typeInfo.name),
                            property.isPrimary && h('span', {
                                class: 'text-xs',
                                style: {
                                    background: 'var(--color-success)',
                                    padding: '1px 6px',
                                    borderRadius: 'var(--radius-sm)'
                                }
                            }, 'Primary')
                        ),
                        h('div', { class: 'text-xs text-muted' },
                            owned
                                ? `${currentSlots}/${maxSlots} slots`
                                : (property.description || typeInfo.description)
                        ),
                        !owned && h('div', { class: 'text-sm font-semibold mt-1', style: { color: 'var(--color-primary)' } },
                            formatCurrency(property.purchasePrice || property.price || 0)
                        )
                    ),
                    h('span', { style: { color: 'var(--text-muted)' } }, '→')
                )
            )
        );
    }

    _renderPropertyDetail() {
        const property = this._selectedProperty;
        const typeInfo = PROPERTY_TYPES[property.type || property.key] || {
            icon: property.icon || '🏠',
            color: 'var(--text-muted)',
            name: property.name || 'Property'
        };
        const player = this.getState('player') || {};
        const owned = this._properties.some(p => p.id === property.id);

        const currentSlots = property.currentSlots || property.baseSlots || 0;
        const maxSlots = property.maxSlots || 10;
        const upgradeCost = owned ? (property.nextUpgradeCost || this._getUpgradeCost(property)) : 0;
        const purchasePrice = property.purchasePrice || property.price || 0;
        const canAfford = (player.currency || 0) >= (owned ? upgradeCost : purchasePrice);
        const isMaxSlots = currentSlots >= maxSlots;

        return h('div', { class: 'cf-property-detail' },
            h('button', { class: 'cf-btn cf-btn--ghost cf-property-back mb-3' }, '← Back'),

            // Property header
            h('div', { class: 'cf-card mb-3', style: { borderLeft: `4px solid ${typeInfo.color}` } },
                h('div', { class: 'cf-card__body text-center' },
                    h('div', { style: { fontSize: '3rem', marginBottom: 'var(--space-2)' } }, property.icon || typeInfo.icon),
                    h('h3', { class: 'font-bold mb-1' }, property.name || typeInfo.name),
                    owned && h('div', {
                        style: {
                            display: 'inline-block',
                            padding: 'var(--space-1) var(--space-3)',
                            background: typeInfo.color,
                            borderRadius: 'var(--radius-full)',
                            fontSize: 'var(--font-size-sm)',
                            marginBottom: 'var(--space-2)'
                        }
                    }, `${currentSlots}/${maxSlots} Slots`),
                    property.isPrimary && h('div', {
                        class: 'text-xs mt-1',
                        style: { color: 'var(--color-success)' }
                    }, '⭐ Primary Location')
                )
            ),

            // Property stats
            owned && h('div', { class: 'cf-card mb-3' },
                h('div', { class: 'cf-card__header' },
                    h('h4', { class: 'cf-card__title' }, 'Property Stats')
                ),
                h('div', { class: 'cf-card__body' },
                    h('div', {
                        style: {
                            display: 'grid',
                            gridTemplateColumns: 'repeat(2, 1fr)',
                            gap: 'var(--space-2)'
                        }
                    },
                        this._renderStatItem('Grow Slots', property.currentSlots || property.growSlots || 0),
                        this._renderStatItem('Max Slots', property.maxSlots || 10),
                        this._renderStatItem('Climate', property.climate || 'Indoor'),
                        this._renderStatItem('Bonus', property.climateBonusValue ? `+${Math.round(property.climateBonusValue * 100)}%` : 'None')
                    )
                )
            ),

            // Bonuses (from climate)
            owned && property.climateBonusValue > 0 && h('div', { class: 'cf-card mb-3' },
                h('div', { class: 'cf-card__header' },
                    h('h4', { class: 'cf-card__title' }, 'Climate Bonuses')
                ),
                h('div', { class: 'cf-card__body' },
                    h('div', { style: { display: 'flex', justifyContent: 'space-between', marginBottom: 'var(--space-1)' } },
                        h('span', {}, property.climateBonusType || 'Bonus'),
                        h('span', { style: { color: 'var(--color-success)' } }, `+${Math.round(property.climateBonusValue * 100)}%`)
                    )
                )
            ),

            // Purchase button (if not owned)
            !owned && h('div', { class: 'cf-card mb-3' },
                h('div', { class: 'cf-card__body' },
                    h('p', { class: 'text-sm text-muted mb-3 text-center' },
                        `Base: ${typeInfo.baseSlots} grow slots`
                    ),
                    h('button', {
                        class: `cf-btn cf-btn--lg cf-purchase-expansion ${canAfford ? 'cf-btn--primary' : ''}`,
                        dataset: { propertyId: property.id.toString() },
                        disabled: !canAfford,
                        style: { width: '100%' }
                    }, canAfford
                        ? `Purchase for ${formatCurrency(purchasePrice)}`
                        : `Need ${formatCurrency(purchasePrice)}`
                    )
                )
            ),

            // Upgrade section (if owned and can upgrade)
            owned && !isMaxSlots && h('div', { class: 'cf-card mb-3' },
                h('div', { class: 'cf-card__header' },
                    h('h4', { class: 'cf-card__title' }, 'Add Grow Slot')
                ),
                h('div', { class: 'cf-card__body' },
                    h('p', { class: 'text-sm text-muted mb-2' },
                        `${currentSlots} / ${maxSlots} slots`
                    ),
                    h('button', {
                        class: `cf-btn cf-btn--lg cf-upgrade-property ${canAfford ? 'cf-btn--primary' : ''}`,
                        disabled: !canAfford,
                        style: { width: '100%' }
                    }, canAfford
                        ? `+1 Slot for ${formatCurrency(upgradeCost)}`
                        : `Need ${formatCurrency(upgradeCost)}`
                    )
                )
            ),

            // Max slots reached
            owned && isMaxSlots && h('div', { class: 'cf-card mb-3' },
                h('div', { class: 'cf-card__body text-center' },
                    h('span', { style: { fontSize: '2rem' } }, '👑'),
                    h('p', { class: 'font-bold mt-2' }, 'Max Slots!'),
                    h('p', { class: 'text-sm text-muted' }, 'This property is fully upgraded')
                )
            ),

            // Set as primary
            owned && !property.isPrimary && h('button', {
                class: 'cf-btn cf-btn--ghost cf-set-primary',
                style: { width: '100%' }
            }, '⭐ Set as Primary Location')
        );
    }

    _renderStatItem(label, value) {
        return h('div', { class: 'text-center' },
            h('div', { class: 'font-bold' }, value),
            h('div', { class: 'text-xs text-muted' }, label)
        );
    }

    _getUpgradeCost(property) {
        // Use API-provided upgrade cost if available
        if (property.nextUpgradeCost) {
            return property.nextUpgradeCost;
        }
        // Fallback calculation
        const baseCost = property.slotUpgradeCost || property.price || 10000;
        return Math.floor(baseCost * Math.pow(1.5, property.level || 1));
    }

    _renderUpgradesTab() {
        // Properties that can still have slots added
        const upgradableProperties = this._properties.filter(p => {
            const currentSlots = p.currentSlots || p.baseSlots || 0;
            const maxSlots = p.maxSlots || 10;
            return currentSlots < maxSlots;
        });

        if (upgradableProperties.length === 0) {
            return h('div', { class: 'cf-empty' },
                h('p', { class: 'cf-empty__title' },
                    this._properties.length === 0
                        ? 'No Properties to Upgrade'
                        : 'All Properties Maxed!'
                ),
                h('p', { class: 'cf-empty__description' },
                    this._properties.length === 0
                        ? 'Purchase properties first'
                        : 'All your properties have maximum slots'
                )
            );
        }

        return h('div', { class: 'cf-expansion-upgrades' },
            h('p', { class: 'text-sm text-muted mb-3' },
                'Add grow slots to your properties'
            ),
            ...upgradableProperties.map(property => {
                const typeInfo = PROPERTY_TYPES[property.type || property.key] || {
                    icon: property.icon || '🏠',
                    color: 'var(--text-muted)'
                };
                const currentSlots = property.currentSlots || property.baseSlots || 0;
                const maxSlots = property.maxSlots || 10;
                const cost = property.nextUpgradeCost || this._getUpgradeCost(property);
                const player = this.getState('player') || {};
                const canAfford = (player.currency || 0) >= cost;

                return h('div', { class: 'cf-card mb-2', style: { borderLeft: `3px solid ${typeInfo.color}` } },
                    h('div', { class: 'cf-card__body' },
                        h('div', { style: { display: 'flex', alignItems: 'center', gap: 'var(--space-3)' } },
                            h('span', { style: { fontSize: '1.5rem' } }, property.icon || typeInfo.icon),
                            h('div', { style: { flex: 1 } },
                                h('div', { class: 'font-semibold' }, property.name),
                                h('div', { class: 'text-xs text-muted' },
                                    `${currentSlots}/${maxSlots} slots`
                                ),
                                h('div', { class: 'text-xs', style: { color: 'var(--color-success)' } },
                                    `+1 grow slot`
                                )
                            ),
                            h('button', {
                                class: `cf-btn cf-btn--sm cf-upgrade-property ${canAfford ? 'cf-btn--primary' : ''}`,
                                dataset: { propertyId: property.id.toString() },
                                disabled: !canAfford
                            }, formatCurrency(cost, true))
                        )
                    )
                );
            })
        );
    }
}

registerComponent('cf-expansions', CFExpansions);
export default CFExpansions;
