/**
 * CertiFried Extension - Timers Component
 * Centralized view of all active timers and countdowns
 */

import { CFBaseComponent, registerComponent } from './base-component.js';
import { h } from '../utils/dom.js';
import { store } from '../state/store.js';

class CFTimers extends CFBaseComponent {
    constructor() {
        super();
        this._updateInterval = null;
    }

    _setupSubscriptions() {
        this.subscribe('garden');
        this.subscribe('breeding');
        this.subscribe('extraction');
        this.subscribe('workers');
        this.subscribe('bosses');
        this.subscribe('tournaments');
    }

    onMount() {
        // Update every second for accurate timers
        this._updateInterval = setInterval(() => {
            this.scheduleRender();
        }, 1000);
    }

    onUnmount() {
        if (this._updateInterval) {
            clearInterval(this._updateInterval);
        }
    }

    _getAllTimers() {
        const timers = [];
        const now = Date.now();

        // Garden timers
        const garden = this.getState('garden') || {};
        const plots = garden.plots || [];
        plots.forEach((plot, idx) => {
            if (plot.status === 'growing' && plot.harvestAt) {
                const endTime = new Date(plot.harvestAt).getTime();
                if (endTime > now) {
                    timers.push({
                        type: 'garden',
                        icon: '🌿',
                        name: plot.strainName || `Plot ${idx + 1}`,
                        endTime,
                        category: 'Growing',
                        action: 'garden'
                    });
                }
            }
        });

        // Breeding timers
        const breeding = this.getState('breeding') || {};
        const activeBreeding = breeding.inProgress || breeding.active;
        const breedingEndTime = activeBreeding?.readyAt || activeBreeding?.ready_at || activeBreeding?.completesAt || breeding.completesAt;
        if (activeBreeding && breedingEndTime) {
            const endTime = new Date(breedingEndTime).getTime();
            if (endTime > now) {
                timers.push({
                    type: 'breeding',
                    icon: '🧬',
                    name: 'Breeding',
                    endTime,
                    category: 'Breeding',
                    action: 'breeding'
                });
            }
        }

        // Extraction timers
        const extraction = this.getState('extraction') || {};
        const slots = extraction.slots || [];
        slots.forEach((slot, idx) => {
            if (slot.status === 'processing' && slot.completesAt) {
                const endTime = new Date(slot.completesAt).getTime();
                if (endTime > now) {
                    timers.push({
                        type: 'extraction',
                        icon: '🧪',
                        name: slot.recipeName || `Extraction ${idx + 1}`,
                        endTime,
                        category: 'Extraction',
                        action: 'extraction'
                    });
                }
            }
        });

        // Worker training timers
        const workers = this.getState('workers') || {};
        const workerList = workers.list || workers.workers || [];
        workerList.forEach(worker => {
            if (worker.trainingEndsAt) {
                const endTime = new Date(worker.trainingEndsAt).getTime();
                if (endTime > now) {
                    timers.push({
                        type: 'worker',
                        icon: '👷',
                        name: `${worker.name || 'Worker'} Training`,
                        endTime,
                        category: 'Training',
                        action: 'workers'
                    });
                }
            }
        });

        // Boss encounter timers
        const bosses = this.getState('bosses') || {};
        if (bosses.activeEncounter && bosses.activeEncounter.expiresAt) {
            const endTime = new Date(bosses.activeEncounter.expiresAt).getTime();
            if (endTime > now) {
                timers.push({
                    type: 'boss',
                    icon: '👹',
                    name: bosses.activeEncounter.bossName || 'Boss Encounter',
                    endTime,
                    category: 'Boss',
                    action: 'bosses'
                });
            }
        }

        // Tournament timers
        const tournaments = this.getState('tournaments') || {};
        const activeTournaments = (tournaments.list || []).filter(t => t.status === 'active');
        activeTournaments.forEach(tournament => {
            if (tournament.endsAt) {
                const endTime = new Date(tournament.endsAt).getTime();
                if (endTime > now) {
                    timers.push({
                        type: 'tournament',
                        icon: '🏆',
                        name: tournament.name || 'Tournament',
                        endTime,
                        category: 'Tournament',
                        action: 'tournaments'
                    });
                }
            }
        });

        // Cooldown timers (daily rewards, etc.)
        const player = this.getState('player') || {};
        if (player.nextDailyReward) {
            const endTime = new Date(player.nextDailyReward).getTime();
            if (endTime > now) {
                timers.push({
                    type: 'cooldown',
                    icon: '🎁',
                    name: 'Daily Reward',
                    endTime,
                    category: 'Cooldown',
                    action: 'daily-rewards'
                });
            }
        }

        // Sort by time remaining
        timers.sort((a, b) => a.endTime - b.endTime);

        return timers;
    }

    _formatTimeRemaining(endTime) {
        const now = Date.now();
        const diff = endTime - now;

        if (diff <= 0) return 'Ready!';

        const seconds = Math.floor(diff / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);
        const days = Math.floor(hours / 24);

        if (days > 0) {
            return `${days}d ${hours % 24}h`;
        }
        if (hours > 0) {
            return `${hours}h ${minutes % 60}m`;
        }
        if (minutes > 0) {
            return `${minutes}m ${seconds % 60}s`;
        }
        return `${seconds}s`;
    }

    _getProgressPercent(endTime, duration = null) {
        const now = Date.now();
        const remaining = endTime - now;

        if (remaining <= 0) return 100;

        // Estimate total duration if not provided (assume max 24 hours)
        const total = duration || Math.max(remaining, 24 * 60 * 60 * 1000);
        const elapsed = total - remaining;

        return Math.min(100, Math.max(0, (elapsed / total) * 100));
    }

    render() {
        this.className = 'cf-timers';
        const timers = this._getAllTimers();

        // Group by category
        const grouped = {};
        timers.forEach(timer => {
            if (!grouped[timer.category]) {
                grouped[timer.category] = [];
            }
            grouped[timer.category].push(timer);
        });

        this.setContent(
            h('h2', { class: 'cf-section__title mb-3' }, '⏱️ Active Timers'),

            timers.length === 0
                ? h('div', { class: 'cf-empty' },
                    h('p', { class: 'cf-empty__title' }, 'No Active Timers'),
                    h('p', { class: 'cf-empty__description' }, 'Start growing, breeding, or extracting!')
                )
                : h('div', { class: 'cf-timers-list' },
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
                                    h('div', { class: 'text-lg font-bold' }, timers.length),
                                    h('div', { class: 'text-xs text-muted' }, 'Active')
                                ),
                                h('div', {},
                                    h('div', { class: 'text-lg font-bold' },
                                        this._formatTimeRemaining(timers[0]?.endTime || Date.now())
                                    ),
                                    h('div', { class: 'text-xs text-muted' }, 'Next Ready')
                                )
                            )
                        )
                    ),

                    // Grouped timers
                    ...Object.entries(grouped).map(([category, categoryTimers]) =>
                        h('div', { class: 'mb-3' },
                            h('h4', { class: 'text-sm font-semibold text-muted mb-2' },
                                `${category} (${categoryTimers.length})`
                            ),
                            ...categoryTimers.map(timer => this._renderTimer(timer))
                        )
                    )
                )
        );
    }

    _renderTimer(timer) {
        const timeRemaining = this._formatTimeRemaining(timer.endTime);
        const isReady = timer.endTime <= Date.now();
        const progress = this._getProgressPercent(timer.endTime);

        return h('div', {
            class: 'cf-card mb-2',
            style: isReady ? { border: '1px solid var(--color-success)' } : {}
        },
            h('div', { class: 'cf-card__body' },
                h('div', { style: { display: 'flex', alignItems: 'center', gap: 'var(--space-3)' } },
                    h('div', { style: { fontSize: '1.25rem' } }, timer.icon),
                    h('div', { style: { flex: 1 } },
                        h('div', { class: 'font-semibold text-sm' }, timer.name),
                        h('div', { class: 'cf-progress mt-1', style: { height: '4px' } },
                            h('div', {
                                class: 'cf-progress__bar',
                                style: {
                                    width: `${progress}%`,
                                    background: isReady ? 'var(--color-success)' : 'var(--color-primary)'
                                }
                            })
                        )
                    ),
                    h('div', {
                        class: 'font-mono text-sm',
                        style: { color: isReady ? 'var(--color-success)' : 'var(--text-primary)' }
                    }, timeRemaining)
                )
            )
        );
    }
}

registerComponent('cf-timers', CFTimers);
export default CFTimers;
