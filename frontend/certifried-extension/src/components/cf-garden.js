/**
 * CertiFried Extension - Garden Component
 * Main growing area with plant plots
 */

import { CFBaseComponent, registerComponent } from './base-component.js';
import { h } from '../utils/dom.js';
import { formatTimeRemaining } from '../utils/format.js';
import { api } from '../api/client.js';
import { store } from '../state/store.js';

class CFGarden extends CFBaseComponent {
    constructor() {
        super();
        this._updateTimer = null;
        this._activeBoosters = [];
    }

    _setupSubscriptions() {
        // Throttle garden updates - timers update separately
        this.subscribe('garden', null, { throttle: 150 });
        this.subscribe('player.maxPlots');
        this.subscribe('player.facilityLevel');
    }

    async _loadActiveBoosters() {
        try {
            const data = await api.getActiveBoosters();
            this._activeBoosters = data.boosters || [];
            this.scheduleRender();
        } catch (e) {
            // Boosters endpoint may not exist
            this._activeBoosters = [];
        }
    }

    onMount() {
        // Update timers every second
        this._updateTimer = setInterval(() => this._updateTimers(), 1000);

        // Load active boosters
        this._loadActiveBoosters();

        // Click handlers
        // Note: Use e.target.closest() since arrow functions don't receive 'this' from delegation
        this.on('click', '.cf-plot', (e) => {
            const plot = e.target.closest('.cf-plot');
            if (!plot) return;
            const slotNumber = parseInt(plot.dataset.slotNumber, 10);
            this._handlePlotClick(slotNumber);
        });

        this.on('click', '.cf-plot__harvest-btn', async (e) => {
            e.stopPropagation();
            const plot = e.target.closest('.cf-plot');
            if (!plot) return;
            const slotNumber = parseInt(plot.dataset.slotNumber, 10);
            await this._harvestSlot(slotNumber);
        });

        this.on('click', '#harvest-all-btn', async () => {
            await this._harvestAll();
        });
    }

    onUnmount() {
        if (this._updateTimer) {
            clearInterval(this._updateTimer);
        }
    }

    render() {
        const plots = this.getState('garden.plots') || [];
        const maxPlots = this.getState('player.maxPlots') || 2;
        const isLoading = this.getState('garden.isLoading');

        // Create plot grid - backend uses slotNumber (1-indexed)
        const plotElements = [];
        for (let i = 1; i <= maxPlots; i++) {
            const plot = plots.find(p => p.slotNumber === i);
            plotElements.push(this._renderPlot(plot, i));
        }

        // Check for ready plants
        const readyCount = plots.filter(p => this._isReady(p)).length;

        this.className = 'cf-section';
        this.setContent(
            // Active boosters status (if any)
            this._activeBoosters.length > 0 && this._renderBoosterStatus(),

            // Section header
            h('div', { class: 'cf-section__header' },
                h('h2', { class: 'cf-section__title' }, 'Your Garden'),
                readyCount > 0 && h('button', {
                    id: 'harvest-all-btn',
                    class: 'cf-btn cf-btn--primary cf-btn--sm'
                }, `Harvest All (${readyCount})`)
            ),

            // Loading state
            isLoading && h('div', { class: 'cf-loading' },
                h('div', { class: 'cf-spinner' })
            ),

            // Plot grid
            !isLoading && h('div', { class: 'cf-garden-grid' }, ...plotElements),

            // Quick stats
            !isLoading && h('div', { class: 'cf-garden-stats mt-3' },
                h('span', { class: 'text-xs text-muted' },
                    `${plots.length}/${maxPlots} plots in use`
                )
            )
        );
    }

    _renderBoosterStatus() {
        return h('div', { class: 'cf-active-boosters mb-3' },
            h('div', { class: 'cf-active-boosters__label text-xs text-muted mb-1' }, 'Active Boosters:'),
            h('div', { class: 'cf-active-boosters__list' },
                ...this._activeBoosters.map(b => this._renderBoosterChip(b))
            )
        );
    }

    _renderBoosterChip(booster) {
        const effectText = this._getBoosterEffectText(booster);
        const remaining = booster.remainingUses != null
            ? `${booster.remainingUses} uses`
            : booster.expiresAt
                ? formatTimeRemaining(new Date(booster.expiresAt) - Date.now())
                : '';

        return h('div', { class: 'cf-booster-chip' },
            h('span', { class: 'cf-booster-chip__name' }, booster.name || booster.itemName),
            effectText && h('span', { class: 'cf-booster-chip__effect' }, effectText),
            remaining && h('span', { class: 'cf-booster-chip__remaining text-xs text-muted' }, remaining)
        );
    }

    _getBoosterEffectText(booster) {
        const value = booster.effectValue || booster.effect_value;
        const type = booster.effectType || booster.effect_type;
        if (!type || !value) return '';

        const effects = {
            growth_speed: `+${Math.round(value * 100)}% speed`,
            yield_bonus: `+${Math.round(value * 100)}% yield`,
            xp_bonus: `+${Math.round(value * 100)}% XP`,
            quality_bonus: `+${Math.round(value * 100)}% quality`,
            cash_bonus: `+${Math.round(value * 100)}% cash`
        };

        return effects[type] || `+${Math.round(value * 100)}%`;
    }

    _renderPlot(plot, slotNumber) {
        // Check if slot is empty or has no plant
        if (!plot || plot.status === 'empty') {
            // Empty plot
            return h('div', {
                class: 'cf-plot',
                dataset: { slotNumber: slotNumber.toString() }
            },
                this._renderPlusIcon()
            );
        }

        const isReady = this._isReady(plot);
        const isWithered = plot.status === 'withered' || plot.status === 'withering';
        const progress = this._calculateProgress(plot);

        let statusClass = 'cf-plot--planted';
        if (isReady || plot.status === 'ready') statusClass = 'cf-plot--ready';
        if (isWithered) statusClass = 'cf-plot--withered';

        return h('div', {
            class: `cf-plot ${statusClass}`,
            dataset: { slotNumber: slotNumber.toString(), plotId: plot.id?.toString() }
        },
            // Plant visual
            h('div', { class: 'cf-plant' },
                this._renderPlantIcon(isReady, isWithered),

                // Progress bar (if growing)
                !isReady && !isWithered && h('div', { class: 'cf-plant__progress' },
                    h('div', {
                        class: 'cf-plant__progress-bar',
                        style: { width: `${progress}%` }
                    })
                ),

                // Timer or status
                h('div', {
                    class: 'cf-plant__timer',
                    dataset: { readyAt: plot.readyAt }
                },
                    isWithered ? 'Withered!' :
                    isReady ? 'Ready!' :
                    this._formatTimeUntil(plot.readyAt)
                ),

                // Strain name
                h('div', { class: 'text-xs text-center mt-1' },
                    plot.strainName || 'Unknown'
                )
            ),

            // Harvest button overlay (if ready)
            isReady && h('button', {
                class: 'cf-plot__harvest-btn cf-btn cf-btn--primary cf-btn--sm',
                dataset: { plotId: plot.id?.toString() },
                style: {
                    position: 'absolute',
                    bottom: '8px',
                    left: '50%',
                    transform: 'translateX(-50%)'
                }
            }, 'Harvest')
        );
    }

    _renderPlusIcon() {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('class', 'cf-plot__empty-icon');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'currentColor');
        svg.setAttribute('stroke-width', '2');

        const line1 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line1.setAttribute('x1', '12');
        line1.setAttribute('y1', '5');
        line1.setAttribute('x2', '12');
        line1.setAttribute('y2', '19');
        svg.appendChild(line1);

        const line2 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line2.setAttribute('x1', '5');
        line2.setAttribute('y1', '12');
        line2.setAttribute('x2', '19');
        line2.setAttribute('y2', '12');
        svg.appendChild(line2);

        return svg;
    }

    _renderPlantIcon(isReady, isWithered) {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('class', 'cf-plant__icon');
        svg.setAttribute('viewBox', '0 0 64 64');

        // Simple plant/leaf shape
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', 'M32 8 C32 8 16 24 16 40 C16 56 32 56 32 56 C32 56 48 56 48 40 C48 24 32 8 32 8Z');
        path.setAttribute('fill', isWithered ? '#6b7280' : (isReady ? '#22c55e' : '#16a34a'));
        svg.appendChild(path);

        // Stem
        const stem = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        stem.setAttribute('x1', '32');
        stem.setAttribute('y1', '20');
        stem.setAttribute('x2', '32');
        stem.setAttribute('y2', '52');
        stem.setAttribute('stroke', isWithered ? '#4b5563' : '#15803d');
        stem.setAttribute('stroke-width', '3');
        svg.appendChild(stem);

        return svg;
    }

    _isReady(plot) {
        if (plot?.status === 'ready') return true;
        if (!plot?.readyAt) return false;
        return new Date(plot.readyAt) <= new Date();
    }

    _calculateProgress(plot) {
        // Use accumulated growth if available (more accurate for offline catch-up)
        if (plot?.accumulatedGrowthMs !== undefined && plot?.growDurationMs) {
            return Math.min(100, Math.max(0, (plot.accumulatedGrowthMs / plot.growDurationMs) * 100));
        }

        // Fallback to time-based calculation
        if (!plot?.plantedAt || !plot?.readyAt) return 0;

        // Handle both numeric timestamps and ISO date strings
        const parseTs = (val) => {
            const num = Number(val);
            return isNaN(num) ? new Date(val).getTime() : num;
        };
        const planted = parseTs(plot.plantedAt);
        const ready = parseTs(plot.readyAt);
        const now = Date.now();

        const total = ready - planted;
        const elapsed = now - planted;

        return Math.min(100, Math.max(0, (elapsed / total) * 100));
    }

    _formatTimeUntil(readyAt) {
        if (!readyAt) return '--';
        // Handle both numeric timestamps and ISO date strings
        const num = Number(readyAt);
        const timestamp = isNaN(num) ? new Date(readyAt).getTime() : num;
        if (isNaN(timestamp)) return '--';
        const ms = timestamp - Date.now();
        return formatTimeRemaining(ms, true);
    }

    _updateTimers() {
        // Update all timer elements
        const timers = this.$$('[data-ready-at]');
        let anyReady = false;

        for (const timer of timers) {
            const readyAt = timer.dataset.readyAt;
            if (!readyAt) continue;

            // Handle both numeric timestamps and ISO date strings
            const num = Number(readyAt);
            const timestamp = isNaN(num) ? new Date(readyAt).getTime() : num;
            if (isNaN(timestamp)) {
                timer.textContent = '--';
                continue;
            }

            const ms = timestamp - Date.now();

            if (ms <= 0) {
                timer.textContent = 'Ready!';
                anyReady = true;
            } else {
                timer.textContent = formatTimeRemaining(ms, true);
            }
        }

        // Trigger re-render if any plants became ready
        if (anyReady) {
            this.scheduleRender();
            // Check for auto-harvest
            this._checkAutoHarvest();
        }
    }

    async _checkAutoHarvest() {
        // Check if auto-harvest is enabled in settings
        const settings = store.get('settings') || {};
        if (!settings.autoHarvest) return;

        // Debounce auto-harvest checks
        if (this._autoHarvestPending) return;
        this._autoHarvestPending = true;

        // Small delay to batch multiple ready plants
        setTimeout(async () => {
            this._autoHarvestPending = false;

            const plots = this.getState('garden.plots') || [];
            const readyPlots = plots.filter(p => this._isReady(p));

            if (readyPlots.length > 0) {
                console.log(`[CFX] Auto-harvesting ${readyPlots.length} ready plots`);
                await this._harvestAll();
            }
        }, 1000);
    }

    async _handlePlotClick(slotNumber) {
        const plots = this.getState('garden.plots') || [];
        const plot = plots.find(p => p.slotNumber === slotNumber);

        if (!plot || plot.status === 'empty') {
            // Empty slot - show strain selector
            this.emit('open-strain-selector', { slotNumber });
        } else if (this._isReady(plot)) {
            // Ready - harvest
            await this._harvestSlot(slotNumber);
        } else if (plot.status === 'withered' || plot.status === 'withering') {
            // Withered - remove
            await this._removeSlot(slotNumber);
        }
        // Otherwise, growing - show info?
    }

    async _harvestSlot(slotNumber) {
        const plots = this.getState('garden.plots') || [];
        const plot = plots.find(p => p.slotNumber === slotNumber);
        const strainName = plot?.strainName || 'plant';

        await this.optimistic({
            // Optimistically set slot to empty immediately
            optimisticUpdate: () => {
                this.setState('garden.plots', plots.map(p =>
                    p.slotNumber === slotNumber ? { ...p, status: 'empty', strainId: null, strainName: null } : p
                ));
            },
            // Rollback path if API fails
            rollbackPaths: { 'garden.plots': plots },
            // API call
            apiCall: () => api.harvestPlot(slotNumber),
            // On success, update XP and refresh inventory
            onSuccess: async (result) => {
                // Update player XP/level
                store.merge('player', {
                    level: result.newLevel || store.get('player.level'),
                    xp: result.newXp || store.get('player.xp'),
                    xpInLevel: result.xpInLevel,
                    xpToNextLevel: result.xpToNextLevel
                });

                // Refresh inventory from server (background, non-blocking)
                api.getInventory().then(data => {
                    this.setState('inventory.items', data.items || []);
                }).catch(() => {});

                this.emit('notification', {
                    type: 'success',
                    message: `Harvested ${result.yield || 1}x ${result.strainName || strainName}! +${result.xpAwarded || 0} XP`
                });
            }
        }).catch(() => {}); // Error already handled by optimistic
    }

    async _harvestAll() {
        const plots = this.getState('garden.plots') || [];
        const readySlotNumbers = plots.filter(p => this._isReady(p)).map(p => p.slotNumber);

        if (readySlotNumbers.length === 0) {
            return; // Nothing to harvest
        }

        await this.optimistic({
            // Optimistically set all ready slots to empty
            optimisticUpdate: () => {
                this.setState('garden.plots', plots.map(p =>
                    readySlotNumbers.includes(p.slotNumber)
                        ? { ...p, status: 'empty', strainId: null, strainName: null }
                        : p
                ));
            },
            rollbackPaths: { 'garden.plots': plots },
            apiCall: () => api.harvestAll(),
            onSuccess: async (result) => {
                // Update player XP/level
                store.merge('player', {
                    level: result.newLevel || store.get('player.level'),
                    xp: result.newXp || store.get('player.xp'),
                    xpInLevel: result.xpInLevel,
                    xpToNextLevel: result.xpToNextLevel
                });

                // Refresh inventory from server (background)
                api.getInventory().then(data => {
                    this.setState('inventory.items', data.items || []);
                }).catch(() => {});

                this.emit('notification', {
                    type: 'success',
                    message: `Harvested ${result.harvested?.length || 0} plants! +${result.xpAwarded || 0} XP`
                });
            }
        }).catch(() => {});
    }

    // _addToInventory removed - now using server refresh instead to avoid ID mismatch issues

    async _removeSlot(slotNumber) {
        try {
            await api.removePlot(slotNumber);

            const plots = this.getState('garden.plots') || [];
            this.setState('garden.plots', plots.map(p =>
                p.slotNumber === slotNumber ? { ...p, status: 'empty', strainId: null, strainName: null } : p
            ));

        } catch (error) {
            this.emit('notification', {
                type: 'error',
                message: error.message || 'Remove failed'
            });
        }
    }
}

registerComponent('cf-garden', CFGarden);
export default CFGarden;
