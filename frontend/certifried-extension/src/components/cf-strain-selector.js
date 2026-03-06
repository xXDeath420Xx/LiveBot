/**
 * CertiFried Extension - Strain Selector Component
 * Modal for selecting a strain to plant
 */

import { CFBaseComponent, registerComponent } from './base-component.js';
import { h } from '../utils/dom.js';
import { formatTimeRemaining, formatRarity } from '../utils/format.js';
import { api } from '../api/client.js';

class CFStrainSelector extends CFBaseComponent {
    constructor() {
        super();
        this._slotNumber = null;
        this._boundOpenHandler = this._handleOpen.bind(this);
    }

    static get observedAttributes() {
        return ['slot-number'];
    }

    _setupSubscriptions() {
        this.subscribe('player.unlockedStrains');
    }

    _handleOpen(e) {
        this._slotNumber = e.detail.slotNumber;
        this.setAttribute('open', '');
        this.render();
    }

    onMount() {
        // Listen for open event
        document.addEventListener('open-strain-selector', this._boundOpenHandler);

        // Select strain
        // Note: Arrow functions don't receive 'this' from .call(), so use e.target.closest()
        this.on('click', '.cf-strain-option', async (e) => {
            const strainOption = e.target.closest('.cf-strain-option');
            if (!strainOption) return;
            const strainId = parseInt(strainOption.dataset.strainId, 10);
            await this._selectStrain(strainId);
        });

        // Close on backdrop
        this.on('click', (e) => {
            if (e.target === this) {
                this._close();
            }
        });
    }

    render() {
        const isOpen = this.hasAttribute('open');
        const strains = this.getState('player.unlockedStrains') || [];

        if (!isOpen) {
            this.style.display = 'none';
            this.setContent();
            return;
        }

        this.className = 'cf-modal-backdrop';
        this.style.display = 'flex';

        this.setContent(
            h('div', { class: 'cf-modal' },
                // Header
                h('div', { class: 'cf-modal__header' },
                    h('h3', { class: 'cf-modal__title' }, 'Select Strain'),
                    h('button', {
                        class: 'cf-modal__close',
                        onClick: () => this._close()
                    }, this._renderCloseIcon())
                ),

                // Body - strain list
                h('div', { class: 'cf-modal__body' },
                    strains.length === 0
                        ? h('div', { class: 'cf-empty' },
                            h('p', { class: 'cf-empty__title' }, 'No seeds available'),
                            h('p', { class: 'cf-empty__description' },
                                'Visit the shop to buy seeds!'
                            )
                        )
                        : h('div', { class: 'cf-strain-list' },
                            ...strains.filter(s => s.seedsAvailable > 0).map(strain => this._renderStrainOption(strain))
                        )
                )
            )
        );
    }

    _renderStrainOption(strain) {
        const rarityInfo = formatRarity(strain.rarity || 'common');
        // baseGrowTimeMs is already in milliseconds from backend
        const growTime = formatTimeRemaining(strain.baseGrowTimeMs || 300000, true);
        const seedCount = strain.seedsAvailable || 0;

        return h('div', {
            class: 'cf-strain-option cf-strain-card',
            dataset: { strainId: strain.id?.toString() }
        },
            // Icon
            h('div', { class: 'cf-strain-card__icon' },
                this._renderPlantIcon()
            ),

            // Info
            h('div', { class: 'cf-strain-card__info' },
                h('div', { class: 'cf-strain-card__name' }, strain.name),
                h('div', { class: 'cf-strain-card__stats' },
                    h('span', {
                        class: 'cf-badge',
                        style: { background: rarityInfo.color, fontSize: '10px' }
                    }, rarityInfo.name),
                    h('span', {}, `${growTime} grow`),
                    h('span', {
                        class: 'cf-badge',
                        style: { background: 'var(--color-success-500)', fontSize: '10px' }
                    }, `${seedCount} seed${seedCount !== 1 ? 's' : ''}`)
                )
            ),

            // Arrow
            h('div', { style: { color: 'var(--text-muted)' } }, '→')
        );
    }

    _renderPlantIcon() {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('width', '40');
        svg.setAttribute('height', '40');
        svg.setAttribute('viewBox', '0 0 64 64');

        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', 'M32 8 C32 8 16 24 16 40 C16 56 32 56 32 56 C32 56 48 56 48 40 C48 24 32 8 32 8Z');
        path.setAttribute('fill', 'var(--color-primary-500)');
        svg.appendChild(path);

        return svg;
    }

    _renderCloseIcon() {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('width', '20');
        svg.setAttribute('height', '20');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'currentColor');
        svg.setAttribute('stroke-width', '2');

        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', 'M6 18L18 6M6 6l12 12');
        svg.appendChild(path);

        return svg;
    }

    onUnmount() {
        document.removeEventListener('open-strain-selector', this._boundOpenHandler);
    }

    async _selectStrain(strainId) {
        if (this._slotNumber === null) return;

        const slotNumber = this._slotNumber;
        const strains = this.getState('player.unlockedStrains') || [];
        const selectedStrain = strains.find(s => s.id === strainId);
        const strainName = selectedStrain?.name || 'seed';
        const plots = this.getState('garden.plots') || [];

        // Save state for rollback
        const oldPlots = [...plots];
        const oldStrains = [...strains];

        // Create optimistic plot data
        const now = Date.now();
        const growTime = selectedStrain?.baseGrowTimeMs || 300000;
        const optimisticPlot = {
            slotNumber,
            strainId,
            strainName,
            status: 'growing',
            plantedAt: now,
            readyAt: now + growTime,
            quality: 50
        };

        // Optimistic update immediately
        const existingIndex = plots.findIndex(p => p.slotNumber === slotNumber);
        let updatedPlots;
        if (existingIndex >= 0) {
            updatedPlots = [...plots];
            updatedPlots[existingIndex] = { ...plots[existingIndex], ...optimisticPlot };
        } else {
            updatedPlots = [...plots, optimisticPlot];
        }
        this.setState('garden.plots', updatedPlots);

        // Decrement seed count immediately
        const updatedStrains = strains.map(s =>
            s.id === strainId
                ? { ...s, seedsAvailable: Math.max(0, (s.seedsAvailable || 0) - 1) }
                : s
        ).filter(s => s.seedsAvailable > 0);
        this.setState('player.unlockedStrains', updatedStrains);

        // Close modal immediately for snappy feel
        this._close();

        this.emit('notification', {
            type: 'success',
            message: `Planted ${strainName}!`
        });

        try {
            const result = await api.plantSeed(strainId, slotNumber);

            // Update with actual server data
            const currentPlots = this.getState('garden.plots') || [];
            const idx = currentPlots.findIndex(p => p.slotNumber === slotNumber);
            if (idx >= 0) {
                const serverPlot = result.slot || result;
                const finalPlots = [...currentPlots];
                finalPlots[idx] = serverPlot;
                this.setState('garden.plots', finalPlots);
            }

        } catch (error) {
            // Rollback on failure
            this.setState('garden.plots', oldPlots);
            this.setState('player.unlockedStrains', oldStrains);

            this.emit('notification', {
                type: 'error',
                message: error.message || 'Failed to plant'
            });
        }
    }

    _close() {
        this.removeAttribute('open');
        this._slotNumber = null;
        this.render();
    }
}

registerComponent('cf-strain-selector', CFStrainSelector);
export default CFStrainSelector;
