/**
 * CertiFried Extension - Breeding Component
 * Combine strains to create new genetics
 */

import { CFBaseComponent, registerComponent } from './base-component.js';
import { h } from '../utils/dom.js';
import { formatTimeRemaining, formatGene } from '../utils/format.js';
import { api } from '../api/client.js';

class CFBreeding extends CFBaseComponent {
    constructor() {
        super();
        this._selectedParent1 = null;
        this._selectedParent2 = null;
        this._seedStrains = [];
        this._strainsLoading = false;
    }

    _setupSubscriptions() {
        this.subscribe('breeding');
    }

    async onMount() {
        await this._loadSeedStrains();

        // Select parent strain
        this.on('click', '.cf-breeding-strain', (e) => {
            const strain = e.target.closest('.cf-breeding-strain');
            if (!strain) return;
            const strainId = parseInt(strain.dataset.strainId, 10);
            this._selectParent(strainId);
        });

        // Start breeding
        this.on('click', '#start-breeding-btn', async () => {
            await this._startBreeding();
        });

        // Claim breeding result
        this.on('click', '#claim-breeding-btn', async () => {
            await this._claimBreeding();
        });

        // Cancel breeding
        this.on('click', '#cancel-breeding-btn', async () => {
            await this._cancelBreeding();
        });
    }

    async _loadSeedStrains() {
        this._strainsLoading = true;
        this.scheduleRender();

        try {
            const result = await api.getAvailableStrains();
            this._seedStrains = (result.strains || []).map(s => ({
                strainId: s.id,
                strainName: s.name,
                rarity: s.rarity,
                seedsAvailable: s.seedsAvailable || 0
            }));
        } catch (err) {
            this._seedStrains = [];
        }

        this._strainsLoading = false;
        this.scheduleRender();
    }

    render() {
        const inProgress = this.getState('breeding.inProgress');
        const isLoading = this.getState('breeding.isLoading') || this._strainsLoading;

        this.className = 'cf-section cf-section--breeding';
        this.setContent(
            h('div', { class: 'cf-section__header' },
                h('h2', { class: 'cf-section__title' }, 'Breeding Lab')
            ),

            isLoading && h('div', { class: 'cf-loading' },
                h('div', { class: 'cf-spinner' })
            ),

            // Active breeding in progress
            !isLoading && inProgress && this._renderInProgress(inProgress),

            // Breeding selection UI
            !isLoading && !inProgress && this._renderBreedingUI(this._seedStrains)
        );
    }

    _renderInProgress(breeding) {
        // Support both camelCase (from API) and snake_case (fallback)
        const completeAt = breeding.completeAt || breeding.complete_at;
        const parent1Name = breeding.parent1Name || breeding.parent1_name || 'Parent 1';
        const parent2Name = breeding.parent2Name || breeding.parent2_name || 'Parent 2';
        // Handle both numeric timestamps and ISO date strings
        const parseTs = (val) => {
            const num = Number(val);
            return isNaN(num) ? new Date(val).getTime() : num;
        };
        const completeTimestamp = completeAt ? parseTs(completeAt) : null;
        const isComplete = completeTimestamp && completeTimestamp <= Date.now();

        // Calculate time remaining safely
        let timeDisplay = '--';
        if (completeTimestamp && !isNaN(completeTimestamp)) {
            const remaining = completeTimestamp - Date.now();
            timeDisplay = isComplete ? 'Ready!' : formatTimeRemaining(remaining, true);
        }

        return h('div', { class: 'cf-breeding-active' },
            h('div', { class: 'cf-breeding' },
                // Parent 1
                h('div', { class: 'cf-breeding__parent' },
                    this._renderPlantIcon(),
                    h('span', { class: 'text-xs' }, parent1Name)
                ),

                // Plus sign
                h('span', { class: 'cf-breeding__plus' }, '+'),

                // Parent 2
                h('div', { class: 'cf-breeding__parent' },
                    this._renderPlantIcon(),
                    h('span', { class: 'text-xs' }, parent2Name)
                ),

                // Arrow
                h('span', { class: 'cf-breeding__plus' }, '→'),

                // Result
                h('div', { class: 'cf-breeding__result' },
                    h('div', { class: 'cf-breeding__result-icon' },
                        isComplete ? this._renderPlantIcon() : '?'
                    ),
                    h('span', { class: 'text-xs' }, timeDisplay)
                )
            ),

            // Actions
            h('div', { class: 'cf-flex cf-flex--center cf-flex--gap-3 mt-4' },
                isComplete && h('button', {
                    id: 'claim-breeding-btn',
                    class: 'cf-btn cf-btn--primary'
                }, 'Claim Result'),
                h('button', {
                    id: 'cancel-breeding-btn',
                    class: 'cf-btn cf-btn--ghost'
                }, 'Cancel')
            )
        );
    }

    _renderBreedingUI(strains) {
        const canBreed = this._selectedParent1 && this._selectedParent2 &&
                         this._selectedParent1 !== this._selectedParent2;

        return h('div', { class: 'cf-breeding-select' },
            // Instruction
            h('p', { class: 'text-sm text-center text-muted mb-3' },
                'Select two parent strains to combine their genetics'
            ),

            // Parent selection display
            h('div', { class: 'cf-breeding mb-4' },
                // Parent 1
                h('div', {
                    class: `cf-breeding__parent ${this._selectedParent1 ? '' : 'cf-breeding__parent--empty'}`,
                    style: {
                        cursor: 'pointer',
                        border: '2px dashed var(--border-primary)',
                        borderRadius: 'var(--radius-lg)',
                        padding: 'var(--space-3)'
                    }
                },
                    this._selectedParent1
                        ? h('span', {}, this._getStrainName(strains, this._selectedParent1))
                        : h('span', { class: 'text-muted' }, 'Parent 1')
                ),

                h('span', { class: 'cf-breeding__plus' }, '+'),

                // Parent 2
                h('div', {
                    class: `cf-breeding__parent ${this._selectedParent2 ? '' : 'cf-breeding__parent--empty'}`,
                    style: {
                        cursor: 'pointer',
                        border: '2px dashed var(--border-primary)',
                        borderRadius: 'var(--radius-lg)',
                        padding: 'var(--space-3)'
                    }
                },
                    this._selectedParent2
                        ? h('span', {}, this._getStrainName(strains, this._selectedParent2))
                        : h('span', { class: 'text-muted' }, 'Parent 2')
                )
            ),

            // Strain list
            h('div', { class: 'cf-breeding-strains' },
                h('h3', { class: 'text-sm font-semibold mb-2' }, 'Available Seeds'),
                strains.length === 0
                    ? h('p', { class: 'text-xs text-muted' }, 'No seeds available. Buy seeds from the shop or earn them from quests.')
                    : h('div', { class: 'cf-grid cf-grid--2' },
                        ...strains.map(strain => this._renderStrainOption(strain))
                    )
            ),

            // Start button
            h('div', { class: 'text-center mt-4' },
                h('button', {
                    id: 'start-breeding-btn',
                    class: 'cf-btn cf-btn--primary cf-btn--lg',
                    disabled: !canBreed
                }, 'Start Breeding')
            )
        );
    }

    _renderStrainOption(strain) {
        const strainId = strain.strainId || strain.strain_id;
        const strainName = strain.strainName || strain.strain_name || 'Unknown';
        const seedCount = strain.seedsAvailable || strain.seeds_available || 0;
        const isSelected = strainId === this._selectedParent1 ||
                          strainId === this._selectedParent2;

        return h('div', {
            class: `cf-breeding-strain ${isSelected ? 'cf-breeding-strain--selected' : ''}`,
            dataset: { strainId: strainId?.toString() },
            style: {
                padding: 'var(--space-2)',
                background: isSelected ? 'var(--color-primary-600)' : 'var(--bg-secondary)',
                border: `1px solid ${isSelected ? 'var(--color-primary-500)' : 'var(--border-primary)'}`,
                borderRadius: 'var(--radius-md)',
                cursor: 'pointer',
                textAlign: 'center',
                fontSize: 'var(--font-size-xs)'
            }
        },
            h('span', {}, strainName),
            h('div', { class: 'text-xs text-muted', style: { marginTop: '2px' } }, `${seedCount} seed${seedCount !== 1 ? 's' : ''}`)
        );
    }

    _renderPlantIcon() {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('width', '32');
        svg.setAttribute('height', '32');
        svg.setAttribute('viewBox', '0 0 64 64');

        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', 'M32 8 C32 8 16 24 16 40 C16 56 32 56 32 56 C32 56 48 56 48 40 C48 24 32 8 32 8Z');
        path.setAttribute('fill', 'var(--color-primary-500)');
        svg.appendChild(path);

        return svg;
    }

    _getStrainName(strains, strainId) {
        const strain = strains.find(s => (s.strainId || s.strain_id) === strainId);
        return strain?.strainName || strain?.strain_name || 'Unknown';
    }

    _selectParent(strainId) {
        if (!this._selectedParent1) {
            this._selectedParent1 = strainId;
        } else if (this._selectedParent1 === strainId) {
            this._selectedParent1 = null;
        } else if (!this._selectedParent2) {
            this._selectedParent2 = strainId;
        } else if (this._selectedParent2 === strainId) {
            this._selectedParent2 = null;
        } else {
            // Both selected, replace parent 2
            this._selectedParent2 = strainId;
        }

        this.render();
    }

    async _startBreeding() {
        if (!this._selectedParent1 || !this._selectedParent2) return;

        const parent1 = this._selectedParent1;
        const parent2 = this._selectedParent2;
        const parent1Name = this._getStrainName(this._seedStrains, parent1);
        const parent2Name = this._getStrainName(this._seedStrains, parent2);

        // Clear selection immediately to prevent double-clicks
        this._selectedParent1 = null;
        this._selectedParent2 = null;
        this.render();

        try {
            const result = await api.startBreeding(parent1, parent2);

            // Update with actual server data - handle various response formats
            const breedingData = result.breeding || result.operation || result;
            if (breedingData) {
                this.setState('breeding.inProgress', {
                    id: breedingData.id || breedingData.operationId,
                    parent1Id: parent1,
                    parent2Id: parent2,
                    parent1Name: breedingData.parent1Name || parent1Name,
                    parent2Name: breedingData.parent2Name || parent2Name,
                    completeAt: breedingData.completeAt || breedingData.complete_at || breedingData.completesAt
                });
            }

            // Refresh seed strains (seeds were consumed)
            this._loadSeedStrains().catch(() => {});

            this.emit('notification', {
                type: 'success',
                message: 'Breeding started!'
            });

        } catch (error) {
            // Restore selection on failure
            this._selectedParent1 = parent1;
            this._selectedParent2 = parent2;
            this.scheduleRender();

            this.emit('notification', {
                type: 'error',
                message: error.message || 'Failed to start breeding'
            });
        }
    }

    async _claimBreeding() {
        const inProgress = this.getState('breeding.inProgress');
        if (!inProgress) return;

        // Optimistic update - clear breeding immediately
        const oldInProgress = inProgress;
        this.setState('breeding.inProgress', null);

        this.emit('notification', {
            type: 'success',
            message: 'Claiming breeding result...'
        });

        try {
            const result = await api.claimBreeding(oldInProgress.id);

            // Add result to history
            const history = this.getState('breeding.history') || [];
            this.setState('breeding.history', [result, ...history]);

            // Support both camelCase (from API) and snake_case (fallback)
            const strainName = result.strainName || result.strain_name ||
                               result.resultStrain?.name || 'new strain';
            this.emit('notification', {
                type: 'success',
                message: `New strain discovered: ${strainName}!`
            });

            // Refresh seed strains (new seeds may have been added)
            this._loadSeedStrains().catch(() => {});

            // Background refresh strains (non-blocking)
            api.getAvailableStrains().then(strainsData => {
                this.setState('player.unlockedStrains', strainsData.strains || []);
            }).catch(() => {});

            // Update XP if breeding gave XP bonus
            if (result.xpAwarded !== undefined) {
                const currentXp = this.getState('player.xp') || 0;
                this.setState('player.xp', currentXp + result.xpAwarded);
            }

        } catch (error) {
            // Rollback
            this.setState('breeding.inProgress', oldInProgress);

            this.emit('notification', {
                type: 'error',
                message: error.message || 'Failed to claim result'
            });
        }
    }

    async _cancelBreeding() {
        const inProgress = this.getState('breeding.inProgress');
        if (!inProgress) return;

        try {
            await api.cancelBreeding(inProgress.id);
            this.setState('breeding.inProgress', null);

            // Refresh seed strains (seeds may be returned)
            this._loadSeedStrains().catch(() => {});

        } catch (error) {
            this.emit('notification', {
                type: 'error',
                message: error.message || 'Failed to cancel breeding'
            });
        }
    }
}

registerComponent('cf-breeding', CFBreeding);
export default CFBreeding;
