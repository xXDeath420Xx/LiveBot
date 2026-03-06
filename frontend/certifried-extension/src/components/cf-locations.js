/**
 * Locations Component
 * Multiple grow locations with different climates and bonuses
 */

import { CFBaseComponent, registerComponent } from './base-component.js';
import { h } from '../utils/dom.js';
import { api } from '../api/client.js';
import { formatCurrency } from '../utils/format.js';

const CLIMATE_INFO = {
    indoor: { name: 'Indoor', icon: '🏠', color: '#8b5cf6' },
    greenhouse: { name: 'Greenhouse', icon: '🏡', color: '#22c55e' },
    outdoor_temperate: { name: 'Temperate', icon: '🌲', color: '#3b82f6' },
    outdoor_tropical: { name: 'Tropical', icon: '🌴', color: '#f59e0b' },
    outdoor_arid: { name: 'Arid', icon: '🏜️', color: '#ef4444' }
};

const BONUS_LABELS = {
    heat_reduction: 'Heat Reduction',
    yield_bonus: 'Yield',
    quality_bonus: 'Quality',
    grow_speed: 'Grow Speed',
    sale_bonus: 'Sale Bonus',
    all_bonus: 'All Stats'
};

class CFLocations extends CFBaseComponent {
    constructor() {
        super();
        this._locations = [];
        this._primaryLocation = null;
        this._stats = { total: 0, owned: 0, totalSlots: 0 };
        this._player = { cash: 0, level: 1 };
        this._loading = true;
        this._error = null;
    }

    async onMount() {
        await this._loadLocations();

        // Buy location
        this.on('click', '.cf-buy-location', async (e) => {
            const btn = e.target.closest('.cf-buy-location');
            if (!btn || btn.disabled) return;
            await this._buyLocation(parseInt(btn.dataset.id, 10));
        });

        // Upgrade location
        this.on('click', '.cf-upgrade-location', async (e) => {
            const btn = e.target.closest('.cf-upgrade-location');
            if (!btn || btn.disabled) return;
            await this._upgradeLocation(parseInt(btn.dataset.id, 10));
        });

        // Set primary
        this.on('click', '.cf-set-primary', async (e) => {
            const btn = e.target.closest('.cf-set-primary');
            if (!btn) return;
            await this._setPrimary(parseInt(btn.dataset.id, 10));
        });
    }

    async _loadLocations() {
        // Only show spinner on first load when we have no data
        const isFirstLoad = this._locations.length === 0;

        if (isFirstLoad) {
            this._loading = true;
            this._error = null;
            this.render();
        }

        try {
            const response = await api.getLocations();
            if (response.success) {
                this._locations = response.locations || [];
                this._primaryLocation = response.primaryLocation;
                this._stats = response.stats || { total: 0, owned: 0, totalSlots: 0 };
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

    async _buyLocation(locationId) {
        try {
            const response = await api.buyLocation(locationId);
            if (response.success) {
                this.emit('notification', { type: 'success', message: response.message });
                await this._loadLocations();
            } else {
                this.emit('notification', { type: 'error', message: response.error });
            }
        } catch (err) {
            this.emit('notification', { type: 'error', message: err.message });
        }
    }

    async _upgradeLocation(locationId) {
        try {
            const response = await api.upgradeLocation(locationId);
            if (response.success) {
                this.emit('notification', { type: 'success', message: response.message });
                await this._loadLocations();
            } else {
                this.emit('notification', { type: 'error', message: response.error });
            }
        } catch (err) {
            this.emit('notification', { type: 'error', message: err.message });
        }
    }

    async _setPrimary(locationId) {
        try {
            const response = await api.setPrimaryLocation(locationId);
            if (response.success) {
                this.emit('notification', { type: 'success', message: response.message });
                await this._loadLocations();
            } else {
                this.emit('notification', { type: 'error', message: response.error });
            }
        } catch (err) {
            this.emit('notification', { type: 'error', message: err.message });
        }
    }

    render() {
        this.className = 'cf-locations';

        if (this._loading) {
            this.setContent(h('div', { class: 'cf-loading' }, h('div', { class: 'cf-spinner' })));
            return;
        }

        if (this._error) {
            this.setContent(
                h('div', { class: 'cf-error-message' },
                    h('p', {}, this._error),
                    h('button', { class: 'cf-btn cf-btn--primary', onclick: () => this._loadLocations() }, 'Retry')
                )
            );
            return;
        }

        const content = [];

        // Header
        content.push(
            h('div', { style: { marginBottom: 'var(--space-4)' } },
                h('h2', { class: 'cf-section__title' }, 'Grow Locations'),
                h('p', { class: 'text-sm text-muted' },
                    `Owned ${this._stats.owned}/${this._stats.total} | Total Slots: ${this._stats.totalSlots}`
                )
            )
        );

        // Primary location banner
        if (this._primaryLocation) {
            const climateInfo = CLIMATE_INFO[this._primaryLocation.climate] || { icon: '🏠', color: '#666' };
            content.push(
                h('div', {
                    class: 'cf-card mb-4',
                    style: { borderLeft: `3px solid ${climateInfo.color}`, background: 'var(--bg-secondary)' }
                },
                    h('div', { class: 'cf-card__body' },
                        h('div', { class: 'text-xs text-muted mb-1' }, 'Primary Location'),
                        h('div', { style: { display: 'flex', alignItems: 'center', gap: 'var(--space-2)' } },
                            h('span', { style: { fontSize: '1.5rem' } }, this._primaryLocation.icon),
                            h('div', {},
                                h('div', { class: 'font-semibold' }, this._primaryLocation.name),
                                h('div', { class: 'text-xs text-muted' },
                                    `${this._primaryLocation.currentSlots} slots | ${climateInfo.name}`
                                )
                            )
                        )
                    )
                )
            );
        }

        // Owned locations
        const ownedLocations = this._locations.filter(l => l.isOwned);
        if (ownedLocations.length > 0) {
            content.push(h('h3', { class: 'text-sm font-semibold text-muted mb-2' }, 'Your Locations'));
            content.push(
                h('div', { class: 'cf-locations-list mb-4' },
                    ...ownedLocations.map(loc => this._renderLocation(loc, true))
                )
            );
        }

        // Available for purchase
        const availableLocations = this._locations.filter(l => !l.isOwned && !l.isStarter);
        if (availableLocations.length > 0) {
            content.push(h('h3', { class: 'text-sm font-semibold text-muted mb-2' }, 'Available Locations'));
            content.push(
                h('div', { class: 'cf-locations-list' },
                    ...availableLocations.map(loc => this._renderLocation(loc, false))
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

    _renderLocation(loc, isOwned) {
        const climateInfo = CLIMATE_INFO[loc.climate] || { name: 'Unknown', icon: '❓', color: '#666' };
        const bonusLabel = BONUS_LABELS[loc.climateBonusType] || loc.climateBonusType;

        return h('div', {
            class: 'cf-card cf-location-card',
            style: {
                marginBottom: 'var(--space-2)',
                opacity: !isOwned && !loc.meetsResearch ? 0.5 : 1,
                borderLeft: `3px solid ${climateInfo.color}`
            }
        },
            h('div', { class: 'cf-card__body' },
                // Header
                h('div', { style: { display: 'flex', alignItems: 'flex-start', gap: 'var(--space-2)', marginBottom: 'var(--space-2)' } },
                    h('span', { style: { fontSize: '1.5rem' } }, loc.icon),
                    h('div', { style: { flex: 1 } },
                        h('div', { style: { display: 'flex', alignItems: 'center', gap: 'var(--space-2)' } },
                            h('span', { class: 'font-semibold' }, loc.name),
                            loc.isPrimary && h('span', {
                                class: 'text-xs',
                                style: {
                                    background: 'var(--color-primary)',
                                    color: 'white',
                                    padding: '0 var(--space-1)',
                                    borderRadius: 'var(--radius-sm)'
                                }
                            }, 'Primary')
                        ),
                        h('div', { class: 'text-xs', style: { color: climateInfo.color } }, climateInfo.name)
                    ),
                    !isOwned && h('div', { class: 'text-right' },
                        h('div', { class: 'font-semibold' }, formatCurrency(loc.purchasePrice)),
                        (loc.requiredLevel || 0) > 1 && h('div', { class: 'text-xs text-muted' }, `Lv.${loc.requiredLevel}`)
                    )
                ),

                // Description
                h('p', { class: 'text-xs text-muted mb-2' }, loc.description),

                // Stats
                h('div', { class: 'text-xs mb-2', style: { display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap' } },
                    isOwned
                        ? h('span', {}, `${loc.currentSlots}/${loc.maxSlots} slots`)
                        : h('span', {}, `${loc.baseSlots} base slots (max ${loc.maxSlots})`),
                    loc.climateBonusType && h('span', { style: { color: 'var(--color-success)' } },
                        `+${Math.round(loc.climateBonusValue * 100)}% ${bonusLabel}`
                    ),
                    loc.heatModifier !== 1.0 && h('span', {
                        style: { color: loc.heatModifier < 1 ? 'var(--color-success)' : 'var(--color-danger)' }
                    }, `${Math.round((1 - loc.heatModifier) * 100)}% heat ${loc.heatModifier < 1 ? 'reduction' : 'increase'}`)
                ),

                // Requirements (if not owned)
                !isOwned && loc.requiredResearch && h('div', {
                    class: 'text-xs mb-2',
                    style: { color: loc.meetsResearch ? 'var(--color-success)' : 'var(--color-danger)' }
                },
                    loc.meetsResearch ? '✓ Research complete' : `Requires: ${loc.requiredResearch}`
                ),

                // Actions
                isOwned
                    ? h('div', { style: { display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' } },
                        // Upgrade button
                        loc.currentSlots < loc.maxSlots && h('button', {
                            class: `cf-btn cf-btn--sm cf-upgrade-location ${loc.canUpgrade ? 'cf-btn--primary' : ''}`,
                            dataset: { id: loc.id.toString() },
                            disabled: !loc.canUpgrade
                        }, `+1 Slot (${formatCurrency(loc.nextUpgradeCost)})`),

                        // Set primary button
                        !loc.isPrimary && h('button', {
                            class: 'cf-btn cf-btn--sm cf-btn--secondary cf-set-primary',
                            dataset: { id: loc.id.toString() }
                        }, 'Set as Primary'),

                        // Max slots indicator
                        loc.currentSlots >= loc.maxSlots && h('span', {
                            class: 'text-xs text-muted',
                            style: { alignSelf: 'center' }
                        }, '✓ Max slots reached')
                    )
                    : h('button', {
                        class: `cf-btn cf-btn--sm cf-buy-location ${loc.canPurchase ? 'cf-btn--primary' : ''}`,
                        dataset: { id: loc.id.toString() },
                        disabled: !loc.canPurchase,
                        style: { width: '100%' }
                    }, loc.canPurchase ? 'Purchase' : (
                        !loc.meetsResearch ? 'Research Locked' :
                        !loc.meetsLevel ? `Lv.${loc.requiredLevel || '?'} Required` :
                        'Cannot Afford'
                    ))
            )
        );
    }
}

registerComponent('cf-locations', CFLocations);
export default CFLocations;
