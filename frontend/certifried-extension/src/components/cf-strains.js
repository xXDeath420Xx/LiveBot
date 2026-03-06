/**
 * CertiFried Extension - Strain Collection Component
 * Visual encyclopedia of discovered strains
 */

import { CFBaseComponent, registerComponent } from './base-component.js';
import { h } from '../utils/dom.js';
import { api } from '../api/client.js';

const RARITY_COLORS = {
    common: '#9ca3af',
    uncommon: '#22c55e',
    rare: '#3b82f6',
    epic: '#a855f7',
    legendary: '#f59e0b'
};

const RARITY_ORDER = ['common', 'uncommon', 'rare', 'epic', 'legendary'];

class CFStrains extends CFBaseComponent {
    constructor() {
        super();
        this._strains = [];
        this._discovered = new Set();
        this._isLoading = true;
        this._activeFilter = 'all';
        this._selectedStrain = null;
        this._stats = { totalStrains: 0, discovered: 0, completionPercent: 0 };
    }

    onMount() {
        this._loadStrains();

        // Filter tabs
        this.on('click', '.cf-strains__filter', (e) => {
            const filter = e.target.closest('.cf-strains__filter');
            if (!filter) return;
            this._activeFilter = filter.dataset.filter;
            this.render();
        });

        // Strain click for details
        this.on('click', '.cf-strain-card-mini', (e) => {
            const card = e.target.closest('.cf-strain-card-mini');
            if (!card) return;
            const strainId = parseInt(card.dataset.strainId, 10);
            this._selectedStrain = this._strains.find(s => s.id === strainId);
            this.render();
        });

        // Close detail modal
        this.on('click', '.cf-strain-detail__close', () => {
            this._selectedStrain = null;
            this.render();
        });

        this.on('click', '.cf-strain-detail-overlay', (e) => {
            if (e.target.classList.contains('cf-strain-detail-overlay')) {
                this._selectedStrain = null;
                this.render();
            }
        });
    }

    async _loadStrains() {
        // Only show spinner on first load when we have no data
        const isFirstLoad = this._strains.length === 0;

        if (isFirstLoad) {
            this._isLoading = true;
            this.render();
        }

        try {
            // Get full strain collection with discovery status
            const collection = await api.getStrainCollection();
            const allStrains = collection.strains || [];

            // Build discovered set from strains marked as discovered
            this._discovered = new Set(
                allStrains.filter(s => s.isDiscovered).map(s => s.id)
            );

            // Store all strains for display (discovered ones show details, undiscovered are silhouettes)
            this._strains = allStrains;

            // Store stats from the response
            this._stats = collection.stats || {
                totalStrains: allStrains.length,
                discovered: this._discovered.size,
                completionPercent: 0
            };

        } catch (error) {
            console.error('Failed to load strains:', error);
        } finally {
            this._isLoading = false;
            this.scheduleRender();
        }
    }

    render() {
        const totalStrains = this._strains.length;
        const discoveredCount = this._discovered.size;
        const percentage = totalStrains > 0 ? Math.round((discoveredCount / totalStrains) * 100) : 0;

        // Group by rarity
        const byRarity = {};
        for (const strain of this._strains) {
            const rarity = strain.rarity || 'common';
            if (!byRarity[rarity]) byRarity[rarity] = [];
            byRarity[rarity].push(strain);
        }

        // Filter strains
        let displayStrains = this._strains;
        if (this._activeFilter !== 'all') {
            displayStrains = this._strains.filter(s => s.rarity === this._activeFilter);
        }

        this.className = 'cf-section cf-strains';
        this.setContent(
            // Header with progress
            h('div', { class: 'cf-section__header' },
                h('h2', { class: 'cf-section__title' }, 'Strain Collection'),
                h('span', { class: 'cf-badge cf-badge--primary' },
                    `${discoveredCount}/${totalStrains} (${percentage}%)`
                )
            ),

            // Progress bar
            h('div', { class: 'cf-progress mb-4' },
                h('div', {
                    class: 'cf-progress__bar',
                    style: { width: `${percentage}%`, background: 'var(--color-primary-500)' }
                })
            ),

            // Rarity filters
            h('div', { class: 'cf-strains__filters mb-3' },
                this._renderFilter('all', 'All'),
                ...RARITY_ORDER.map(r => this._renderFilter(r, this._capitalize(r), byRarity[r]?.length || 0))
            ),

            // Loading
            this._isLoading && h('div', { class: 'cf-loading' },
                h('div', { class: 'cf-spinner' })
            ),

            // Empty state
            !this._isLoading && displayStrains.length === 0 && h('div', { class: 'cf-empty' },
                h('p', { class: 'cf-empty__title' }, 'No strains discovered'),
                h('p', { class: 'cf-empty__description' }, 'Plant and harvest to discover new strains!')
            ),

            // Strain grid
            !this._isLoading && displayStrains.length > 0 && h('div', { class: 'cf-strains__grid' },
                ...displayStrains.map(strain => this._renderStrainCard(strain))
            ),

            // Detail modal
            this._selectedStrain && this._renderStrainDetail(this._selectedStrain)
        );
    }

    _renderFilter(filter, label, count) {
        const isActive = this._activeFilter === filter;
        const color = filter !== 'all' ? RARITY_COLORS[filter] : '#9ca3af';

        return h('button', {
            class: `cf-strains__filter ${isActive ? 'cf-strains__filter--active' : ''}`,
            dataset: { filter },
            style: isActive ? { borderColor: color, color: color } : {}
        },
            label,
            count !== undefined && h('span', { class: 'text-xs ml-1' }, `(${count})`)
        );
    }

    _renderStrainCard(strain) {
        const isDiscovered = this._discovered.has(strain.id);
        const rarityColor = RARITY_COLORS[strain.rarity] || RARITY_COLORS.common;

        return h('div', {
            class: `cf-strain-card-mini ${isDiscovered ? '' : 'cf-strain-card-mini--locked'}`,
            dataset: { strainId: strain.id.toString() },
            style: { borderColor: rarityColor }
        },
            // Rarity indicator
            h('div', {
                class: 'cf-strain-card-mini__rarity',
                style: { background: rarityColor }
            }),

            // Icon
            h('div', { class: 'cf-strain-card-mini__icon' },
                this._renderPlantIcon(isDiscovered, rarityColor)
            ),

            // Name
            h('div', { class: 'cf-strain-card-mini__name text-xs text-center' },
                isDiscovered ? strain.name : '???'
            ),

            // Lock overlay
            !isDiscovered && h('div', { class: 'cf-strain-card-mini__lock' },
                this._renderLockIcon()
            )
        );
    }

    _renderStrainDetail(strain) {
        const rarityColor = RARITY_COLORS[strain.rarity] || RARITY_COLORS.common;
        const genetics = strain.genetics || {};

        return h('div', { class: 'cf-strain-detail-overlay' },
            h('div', { class: 'cf-strain-detail' },
                // Header
                h('div', { class: 'cf-strain-detail__header', style: { borderColor: rarityColor } },
                    h('div', { class: 'cf-strain-detail__icon' },
                        this._renderPlantIcon(true, rarityColor)
                    ),
                    h('div', { class: 'cf-strain-detail__title' },
                        h('h3', {}, strain.name),
                        h('span', {
                            class: 'cf-badge',
                            style: { background: rarityColor }
                        }, this._capitalize(strain.rarity))
                    ),
                    h('button', { class: 'cf-strain-detail__close' }, '\u00D7')
                ),

                // Stats
                h('div', { class: 'cf-strain-detail__stats' },
                    this._renderStatBar('THC', genetics.thc || 50, '#22c55e'),
                    this._renderStatBar('CBD', genetics.cbd || 30, '#3b82f6'),
                    this._renderStatBar('Yield', genetics.yield || 50, '#f59e0b'),
                    this._renderStatBar('Speed', genetics.speed || 50, '#a855f7'),
                    this._renderStatBar('Quality', genetics.quality || 50, '#ef4444'),
                    this._renderStatBar('Resilience', genetics.resilience || 50, '#06b6d4')
                ),

                // Info
                strain.effects && h('div', { class: 'cf-strain-detail__section' },
                    h('h4', {}, 'Effects'),
                    h('p', { class: 'text-sm text-muted' },
                        Array.isArray(strain.effects) ? strain.effects.join(', ') : strain.effects
                    )
                ),

                strain.flavors && h('div', { class: 'cf-strain-detail__section' },
                    h('h4', {}, 'Flavors'),
                    h('p', { class: 'text-sm text-muted' },
                        Array.isArray(strain.flavors) ? strain.flavors.join(', ') : strain.flavors
                    )
                ),

                // Base stats
                h('div', { class: 'cf-strain-detail__section' },
                    h('h4', {}, 'Base Stats'),
                    h('div', { class: 'cf-strain-detail__info-grid' },
                        h('div', {},
                            h('span', { class: 'text-muted' }, 'Base Price: '),
                            h('span', {}, `$${strain.basePrice || strain.base_price || 100}`)
                        ),
                        h('div', {},
                            h('span', { class: 'text-muted' }, 'Grow Time: '),
                            h('span', {}, this._formatGrowTime(strain.growDurationMs || strain.grow_time || 300000))
                        ),
                        h('div', {},
                            h('span', { class: 'text-muted' }, 'Base Yield: '),
                            h('span', {}, `${strain.baseYieldMin || 1}-${strain.baseYieldMax || 3}`)
                        )
                    )
                )
            )
        );
    }

    _renderStatBar(label, value, color) {
        return h('div', { class: 'cf-stat-bar' },
            h('div', { class: 'cf-stat-bar__label' },
                h('span', {}, label),
                h('span', { class: 'text-muted' }, `${value}%`)
            ),
            h('div', { class: 'cf-stat-bar__track' },
                h('div', {
                    class: 'cf-stat-bar__fill',
                    style: { width: `${value}%`, background: color }
                })
            )
        );
    }

    _renderPlantIcon(isDiscovered, color) {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 48 48');
        svg.setAttribute('width', '32');
        svg.setAttribute('height', '32');

        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', 'M24 6 C24 6 12 18 12 30 C12 42 24 42 24 42 C24 42 36 42 36 30 C36 18 24 6 24 6Z');
        path.setAttribute('fill', isDiscovered ? color : '#4b5563');
        svg.appendChild(path);

        return svg;
    }

    _renderLockIcon() {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('width', '16');
        svg.setAttribute('height', '16');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'currentColor');
        svg.setAttribute('stroke-width', '2');

        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', 'M19 11H5a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2zM7 11V7a5 5 0 0 1 10 0v4');
        svg.appendChild(path);

        return svg;
    }

    _capitalize(str) {
        return str ? str.charAt(0).toUpperCase() + str.slice(1) : '';
    }

    _formatGrowTime(ms) {
        const mins = Math.floor(ms / 60000);
        if (mins < 60) return `${mins}m`;
        const hours = Math.floor(mins / 60);
        const remainMins = mins % 60;
        return remainMins > 0 ? `${hours}h ${remainMins}m` : `${hours}h`;
    }
}

registerComponent('cf-strains', CFStrains);
export default CFStrains;
