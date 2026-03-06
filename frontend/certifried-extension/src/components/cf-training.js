/**
 * CertiFried Extension - Training Component
 * Worker training, skill development, and trait management
 */

import { CFBaseComponent, registerComponent } from './base-component.js';
import { h } from '../utils/dom.js';
import { formatTimeRemaining, formatCurrency } from '../utils/format.js';
import { api } from '../api/client.js';

// Training programs
const TRAINING_PROGRAMS = {
    basic: {
        name: 'Basic Training',
        icon: '📖',
        duration: 300000, // 5 min
        description: 'Fundamental skills for new workers',
        color: 'var(--text-muted)'
    },
    advanced: {
        name: 'Advanced Training',
        icon: '📚',
        duration: 900000, // 15 min
        description: 'Specialized techniques and methods',
        color: 'var(--color-success)'
    },
    expert: {
        name: 'Expert Training',
        icon: '🎓',
        duration: 1800000, // 30 min
        description: 'Master-level skill development',
        color: 'var(--color-rare)'
    },
    specialized: {
        name: 'Specialization',
        icon: '⭐',
        duration: 3600000, // 1 hour
        description: 'Unlock unique traits and abilities',
        color: 'var(--color-epic)'
    },
    legendary: {
        name: 'Legendary Training',
        icon: '👑',
        duration: 7200000, // 2 hours
        description: 'Transform into an elite worker',
        color: 'var(--color-legendary)'
    }
};

// Trait categories
const TRAIT_CATEGORIES = {
    efficiency: { name: 'Efficiency', icon: '⚡', color: 'var(--color-warning)' },
    quality: { name: 'Quality', icon: '💎', color: 'var(--color-primary)' },
    speed: { name: 'Speed', icon: '🏃', color: 'var(--color-success)' },
    special: { name: 'Special', icon: '✨', color: 'var(--color-legendary)' }
};

class CFTraining extends CFBaseComponent {
    constructor() {
        super();
        this._workers = [];
        this._trainingSlots = [];
        this._availableTraits = [];
        this._completedTraining = [];
        this._loading = true;
        this._error = null;
        this._activeTab = 'active'; // 'active' | 'workers' | 'traits' | 'history'
        this._selectedWorker = null;
        this._showTrainingModal = false;
        this._timerInterval = null;
    }

    _setupSubscriptions() {
        this.subscribe('player');
    }

    async onMount() {
        await this._loadTrainingData();

        // Update timers every second
        this._timerInterval = setInterval(() => {
            if (this._trainingSlots.some(s => s.inProgress)) {
                this.scheduleRender();
            }
        }, 1000);

        // Tab switching
        this.on('click', '.cf-tab-btn', (e) => {
            const tab = e.target.closest('.cf-tab-btn');
            if (!tab) return;
            this._activeTab = tab.dataset.tab;
            this.render();
        });

        // Select worker for training
        this.on('click', '.cf-worker-select', (e) => {
            const card = e.target.closest('.cf-worker-select');
            if (!card) return;
            const workerId = parseInt(card.dataset.workerId, 10);
            this._selectedWorker = this._workers.find(w => w.id === workerId);
            this._showTrainingModal = true;
            this.render();
        });

        // Close modal
        this.on('click', '.cf-modal-close, .cf-modal-backdrop', (e) => {
            if (e.target.classList.contains('cf-modal-backdrop') ||
                e.target.classList.contains('cf-modal-close')) {
                this._showTrainingModal = false;
                this._selectedWorker = null;
                this.render();
            }
        });

        // Start training
        this.on('click', '.cf-start-training', async (e) => {
            const btn = e.target.closest('.cf-start-training');
            if (!btn || btn.disabled) return;
            const traitId = parseInt(btn.dataset.traitId, 10);
            await this._startTraining(traitId);
        });

        // Claim training
        this.on('click', '.cf-claim-training', async (e) => {
            const btn = e.target.closest('.cf-claim-training');
            if (!btn) return;
            const slotId = parseInt(btn.dataset.slotId, 10);
            await this._claimTraining(slotId);
        });

        // Cancel training
        this.on('click', '.cf-cancel-training', async (e) => {
            const btn = e.target.closest('.cf-cancel-training');
            if (!btn) return;
            const slotId = parseInt(btn.dataset.slotId, 10);
            if (confirm('Cancel this training? Progress will be lost.')) {
                await this._cancelTraining(slotId);
            }
        });

        // Learn trait
        this.on('click', '.cf-learn-trait', async (e) => {
            const btn = e.target.closest('.cf-learn-trait');
            if (!btn || btn.disabled) return;
            const traitId = parseInt(btn.dataset.traitId, 10);
            const workerId = parseInt(btn.dataset.workerId, 10);
            await this._learnTrait(workerId, traitId);
        });
    }

    onUnmount() {
        if (this._timerInterval) {
            clearInterval(this._timerInterval);
        }
    }

    async _loadTrainingData() {
        const isFirstLoad = this._workers.length === 0;

        if (isFirstLoad) {
            this._loading = true;
            this._error = null;
            this.render();
        }

        try {
            const [workersResponse, traitsResponse] = await Promise.all([
                api.getEnhancedWorkers(),
                api.getWorkerTraits()
            ]);

            this._workers = workersResponse.workers || [];
            this._availableTraits = traitsResponse.traits || [];
            this._completedTraining = workersResponse.trainingHistory || [];

            // Map active training from backend into training slot format
            const activeTraining = workersResponse.activeTraining || [];
            if (activeTraining.length > 0) {
                this._trainingSlots = activeTraining.map((t, idx) => ({
                    id: t.id || idx + 1,
                    inProgress: true,
                    worker: this._workers.find(w => w.id === t.workerId) || { id: t.workerId, name: t.workerName || 'Worker' },
                    traitName: t.traitName,
                    programKey: 'advanced',
                    startedAt: t.startedAt ? new Date(t.startedAt).getTime() : Date.now(),
                    completeAt: t.completesAt ? new Date(t.completesAt).getTime() : Date.now() + 3600000
                }));
                // Add empty slots for remaining capacity
                const maxSlots = 3;
                while (this._trainingSlots.length < maxSlots) {
                    this._trainingSlots.push({
                        id: this._trainingSlots.length + 1,
                        inProgress: false,
                        worker: null,
                        locked: this._trainingSlots.length >= 2
                    });
                }
            } else {
                this._trainingSlots = this._generateMockSlots();
            }
        } catch (err) {
            this._error = err.message;
        }

        this._loading = false;
        this.scheduleRender();
    }

    _generateMockSlots() {
        return [
            { id: 1, inProgress: false, worker: null },
            { id: 2, inProgress: false, worker: null },
            { id: 3, inProgress: false, worker: null, locked: true, unlockLevel: 10 }
        ];
    }

    async _startTraining(traitId) {
        if (!this._selectedWorker) return;

        const trait = this._availableTraits.find(t => t.id === traitId);
        if (!trait) {
            this.emit('notification', { type: 'error', message: 'Trait not found' });
            return;
        }

        const player = this.getState('player') || {};
        const cost = trait.trainingCostBase || 1000;

        if ((player.currency || 0) < cost) {
            this.emit('notification', { type: 'error', message: 'Not enough cash' });
            return;
        }

        try {
            const result = await api.trainWorkerTrait(this._selectedWorker.id, traitId);
            if (result.success) {
                this.emit('notification', {
                    type: 'success',
                    message: `${this._selectedWorker.name} started training "${trait.name}"!`
                });
                this._showTrainingModal = false;
                this._selectedWorker = null;
                await this._loadTrainingData();
            } else {
                throw new Error(result.error);
            }
        } catch (err) {
            this.emit('notification', { type: 'error', message: err.message });
        }
    }

    async _claimTraining(slotId) {
        const slot = this._trainingSlots.find(s => s.id === slotId);
        if (!slot || !slot.inProgress) return;

        try {
            const result = await api.claimWorkerTraining(slot.worker.id);
            if (result.success) {
                this.emit('notification', {
                    type: 'success',
                    message: result.message || 'Training complete!'
                });
                await this._loadTrainingData();
            }
        } catch (err) {
            this.emit('notification', { type: 'error', message: err.message });
        }
    }

    async _cancelTraining(slotId) {
        const slot = this._trainingSlots.find(s => s.id === slotId);
        if (!slot) return;

        try {
            // API would handle cancellation
            slot.inProgress = false;
            slot.worker = null;
            this.emit('notification', { type: 'info', message: 'Training cancelled' });
            this.scheduleRender();
        } catch (err) {
            this.emit('notification', { type: 'error', message: err.message });
        }
    }

    async _learnTrait(workerId, traitId) {
        try {
            const result = await api.trainWorkerTrait(workerId, traitId);
            if (result.success) {
                this.emit('notification', { type: 'success', message: 'Trait learned!' });
                await this._loadTrainingData();
            }
        } catch (err) {
            this.emit('notification', { type: 'error', message: err.message });
        }
    }

    _getTrainingCost(programKey) {
        const costs = {
            basic: 500,
            advanced: 2000,
            expert: 5000,
            specialized: 15000,
            legendary: 50000
        };
        return costs[programKey] || 1000;
    }

    render() {
        this.className = 'cf-training';

        if (this._loading) {
            this.setContent(h('div', { class: 'cf-loading' }, h('div', { class: 'cf-spinner' })));
            return;
        }

        if (this._error) {
            this.setContent(
                h('div', { class: 'cf-error-message' },
                    h('p', {}, this._error),
                    h('button', { class: 'cf-btn cf-btn--primary', onclick: () => this._loadTrainingData() }, 'Retry')
                )
            );
            return;
        }

        const activeTraining = this._trainingSlots.filter(s => s.inProgress);

        this.setContent(
            h('h2', { class: 'cf-section__title mb-3' }, '🎓 Training Center'),

            // Quick stats
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
                            h('div', { class: 'text-lg font-bold' }, this._workers.length),
                            h('div', { class: 'text-xs text-muted' }, 'Workers')
                        ),
                        h('div', {},
                            h('div', { class: 'text-lg font-bold', style: { color: 'var(--color-warning)' } },
                                activeTraining.length
                            ),
                            h('div', { class: 'text-xs text-muted' }, 'Training')
                        ),
                        h('div', {},
                            h('div', { class: 'text-lg font-bold', style: { color: 'var(--color-epic)' } },
                                this._workers.reduce((sum, w) => sum + (w.traits?.length || 0), 0)
                            ),
                            h('div', { class: 'text-xs text-muted' }, 'Traits')
                        )
                    )
                )
            ),

            // Tabs
            h('div', { class: 'cf-tabs mb-3' },
                h('button', {
                    class: `cf-tab cf-tab-btn ${this._activeTab === 'active' ? 'cf-tab--active' : ''}`,
                    dataset: { tab: 'active' }
                }, `Active (${activeTraining.length})`),
                h('button', {
                    class: `cf-tab cf-tab-btn ${this._activeTab === 'workers' ? 'cf-tab--active' : ''}`,
                    dataset: { tab: 'workers' }
                }, 'Workers'),
                h('button', {
                    class: `cf-tab cf-tab-btn ${this._activeTab === 'traits' ? 'cf-tab--active' : ''}`,
                    dataset: { tab: 'traits' }
                }, 'Traits'),
                h('button', {
                    class: `cf-tab cf-tab-btn ${this._activeTab === 'history' ? 'cf-tab--active' : ''}`,
                    dataset: { tab: 'history' }
                }, 'History')
            ),

            // Tab content
            this._activeTab === 'active' && this._renderActiveTab(),
            this._activeTab === 'workers' && this._renderWorkersTab(),
            this._activeTab === 'traits' && this._renderTraitsTab(),
            this._activeTab === 'history' && this._renderHistoryTab(),

            // Training modal
            this._showTrainingModal && this._renderTrainingModal()
        );
    }

    _renderActiveTab() {
        const activeSlots = this._trainingSlots.filter(s => !s.locked);
        const hasActive = activeSlots.some(s => s.inProgress);

        if (!hasActive && activeSlots.every(s => !s.inProgress)) {
            return h('div', { class: 'cf-empty' },
                h('p', { class: 'cf-empty__title' }, 'No Active Training'),
                h('p', { class: 'cf-empty__description' },
                    'Select a worker from the Workers tab to start training'
                )
            );
        }

        return h('div', { class: 'cf-training-active' },
            ...this._trainingSlots.map(slot => this._renderTrainingSlot(slot))
        );
    }

    _renderTrainingSlot(slot) {
        if (slot.locked) {
            return h('div', { class: 'cf-card mb-2', style: { opacity: 0.5 } },
                h('div', { class: 'cf-card__body text-center' },
                    h('span', { style: { fontSize: '1.5rem' } }, '🔒'),
                    h('p', { class: 'text-sm text-muted mt-1' },
                        `Unlock at level ${slot.unlockLevel}`
                    )
                )
            );
        }

        if (!slot.inProgress) {
            return h('div', { class: 'cf-card mb-2' },
                h('div', { class: 'cf-card__body text-center' },
                    h('span', { style: { fontSize: '1.5rem', opacity: 0.3 } }, '👤'),
                    h('p', { class: 'text-sm text-muted mt-1' }, 'Training Slot Available'),
                    h('p', { class: 'text-xs text-muted' }, 'Select a worker to train')
                )
            );
        }

        const worker = slot.worker || {};
        const program = TRAINING_PROGRAMS[slot.programKey] || TRAINING_PROGRAMS.basic;
        const now = Date.now();
        const endTime = slot.completeAt || (now + 60000);
        const remaining = Math.max(0, endTime - now);
        const isComplete = remaining <= 0;
        const progress = slot.startedAt
            ? Math.min(100, ((now - slot.startedAt) / (endTime - slot.startedAt)) * 100)
            : 0;

        return h('div', {
            class: 'cf-card mb-2',
            style: { borderLeft: `3px solid ${program.color}` }
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
                    }, program.icon),
                    h('div', { style: { flex: 1 } },
                        h('div', { class: 'font-semibold' }, worker.name || 'Worker'),
                        h('div', { class: 'text-xs text-muted' }, program.name),
                        h('div', { class: 'cf-progress mt-1', style: { height: '4px' } },
                            h('div', {
                                class: 'cf-progress__bar',
                                style: { width: `${progress}%`, background: program.color }
                            })
                        ),
                        h('div', { class: 'text-xs text-muted mt-1' },
                            isComplete ? 'Ready to claim!' : formatTimeRemaining(remaining)
                        )
                    ),
                    h('div', {},
                        isComplete
                            ? h('button', {
                                class: 'cf-btn cf-btn--success cf-btn--sm cf-claim-training',
                                dataset: { slotId: slot.id.toString() }
                            }, 'Claim')
                            : h('button', {
                                class: 'cf-btn cf-btn--ghost cf-btn--sm cf-cancel-training',
                                dataset: { slotId: slot.id.toString() }
                            }, '✕')
                    )
                )
            )
        );
    }

    _renderWorkersTab() {
        const availableWorkers = this._workers.filter(w =>
            !this._trainingSlots.some(s => s.inProgress && s.worker?.id === w.id)
        );

        if (availableWorkers.length === 0) {
            return h('div', { class: 'cf-empty' },
                h('p', { class: 'cf-empty__title' }, 'No Available Workers'),
                h('p', { class: 'cf-empty__description' },
                    this._workers.length === 0
                        ? 'Hire workers from the Workers page first'
                        : 'All workers are currently training'
                )
            );
        }

        return h('div', { class: 'cf-training-workers' },
            h('p', { class: 'text-sm text-muted mb-3' },
                'Select a worker to begin training'
            ),
            ...availableWorkers.map(worker => this._renderWorkerCard(worker))
        );
    }

    _renderWorkerCard(worker) {
        const tier = worker.tier || 1;
        const traits = worker.traits || [];

        return h('div', {
            class: 'cf-card cf-worker-select mb-2',
            dataset: { workerId: worker.id.toString() },
            style: { cursor: 'pointer' }
        },
            h('div', { class: 'cf-card__body' },
                h('div', { style: { display: 'flex', alignItems: 'center', gap: 'var(--space-3)' } },
                    h('div', {
                        style: {
                            width: '40px',
                            height: '40px',
                            background: 'var(--bg-tertiary)',
                            borderRadius: 'var(--radius-full)',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center'
                        }
                    }, '👤'),
                    h('div', { style: { flex: 1 } },
                        h('div', { class: 'font-semibold' }, worker.name || 'Worker'),
                        h('div', { class: 'text-xs text-muted' },
                            `${worker.type || 'General'} • Tier ${tier}`
                        ),
                        traits.length > 0 && h('div', { style: { display: 'flex', gap: 'var(--space-1)', marginTop: 'var(--space-1)' } },
                            ...traits.slice(0, 3).map(trait =>
                                h('span', {
                                    class: 'text-xs',
                                    style: {
                                        background: 'var(--bg-tertiary)',
                                        padding: '2px 6px',
                                        borderRadius: 'var(--radius-sm)'
                                    }
                                }, trait.name)
                            )
                        )
                    ),
                    h('span', { style: { color: 'var(--text-muted)' } }, '→')
                )
            )
        );
    }

    _renderTraitsTab() {
        if (this._availableTraits.length === 0) {
            return h('div', { class: 'cf-empty' },
                h('p', { class: 'cf-empty__title' }, 'No Traits Discovered'),
                h('p', { class: 'cf-empty__description' },
                    'Complete training to unlock new traits'
                )
            );
        }

        // Group by category
        const grouped = {};
        this._availableTraits.forEach(trait => {
            const cat = trait.category || 'special';
            if (!grouped[cat]) grouped[cat] = [];
            grouped[cat].push(trait);
        });

        return h('div', { class: 'cf-training-traits' },
            ...Object.entries(grouped).map(([category, traits]) => {
                const catInfo = TRAIT_CATEGORIES[category] || TRAIT_CATEGORIES.special;
                return h('div', { class: 'mb-4' },
                    h('h3', { class: 'text-sm font-semibold mb-2', style: { color: catInfo.color } },
                        h('span', { style: { marginRight: 'var(--space-1)' } }, catInfo.icon),
                        catInfo.name
                    ),
                    ...traits.map(trait => this._renderTraitCard(trait))
                );
            })
        );
    }

    _renderTraitCard(trait) {
        return h('div', { class: 'cf-card mb-2' },
            h('div', { class: 'cf-card__body' },
                h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
                    h('div', {},
                        h('div', { class: 'font-semibold' }, trait.name),
                        h('div', { class: 'text-xs text-muted' }, trait.description),
                        trait.effect && h('div', {
                            class: 'text-xs mt-1',
                            style: { color: 'var(--color-success)' }
                        }, trait.effect)
                    ),
                    trait.rarity && h('span', {
                        class: 'text-xs',
                        style: {
                            padding: '2px 8px',
                            background: this._getRarityColor(trait.rarity),
                            borderRadius: 'var(--radius-sm)'
                        }
                    }, trait.rarity)
                )
            )
        );
    }

    _getRarityColor(rarity) {
        const colors = {
            common: 'var(--text-muted)',
            uncommon: 'var(--color-success)',
            rare: 'var(--color-rare)',
            epic: 'var(--color-epic)',
            legendary: 'var(--color-legendary)'
        };
        return colors[rarity?.toLowerCase()] || colors.common;
    }

    _renderHistoryTab() {
        if (this._completedTraining.length === 0) {
            return h('div', { class: 'cf-empty' },
                h('p', { class: 'cf-empty__title' }, 'No Training History'),
                h('p', { class: 'cf-empty__description' },
                    'Complete training sessions to see history here'
                )
            );
        }

        return h('div', { class: 'cf-training-history' },
            ...this._completedTraining.slice(0, 20).map(entry => {
                const program = TRAINING_PROGRAMS[entry.programKey] || TRAINING_PROGRAMS.basic;
                return h('div', { class: 'cf-card mb-2' },
                    h('div', { class: 'cf-card__body' },
                        h('div', { style: { display: 'flex', alignItems: 'center', gap: 'var(--space-2)' } },
                            h('span', {}, program.icon),
                            h('div', { style: { flex: 1 } },
                                h('div', { class: 'text-sm font-semibold' }, entry.workerName),
                                h('div', { class: 'text-xs text-muted' }, program.name)
                            ),
                            entry.traitUnlocked && h('span', {
                                class: 'text-xs',
                                style: { color: 'var(--color-success)' }
                            }, `+${entry.traitUnlocked}`)
                        )
                    )
                );
            })
        );
    }

    _renderTrainingModal() {
        if (!this._selectedWorker) return null;

        const worker = this._selectedWorker;
        const player = this.getState('player') || {};

        // Filter traits that are compatible with this worker type
        const compatibleTraits = this._availableTraits.filter(trait => {
            // If trait has no worker restrictions, it's available to all
            if (!trait.compatibleWorkers) return true;
            // Check if worker type is in compatible list
            return trait.compatibleWorkers.includes(worker.typeKey);
        });

        // Get existing trait levels for this worker
        const workerTraitLevels = worker.traits || [];

        return h('div', {
            class: 'cf-modal-backdrop',
            style: {
                position: 'fixed',
                inset: 0,
                background: 'rgba(0,0,0,0.7)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                zIndex: 1000
            }
        },
            h('div', {
                class: 'cf-modal',
                style: {
                    background: 'var(--bg-primary)',
                    borderRadius: 'var(--radius-lg)',
                    padding: 'var(--space-4)',
                    maxWidth: '350px',
                    width: '90%',
                    maxHeight: '80vh',
                    overflow: 'auto'
                }
            },
                h('div', { style: { display: 'flex', justifyContent: 'space-between', marginBottom: 'var(--space-3)' } },
                    h('h3', { class: 'font-semibold' }, `Train ${worker.name}`),
                    h('button', {
                        class: 'cf-modal-close',
                        style: { background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)' }
                    }, '✕')
                ),

                h('p', { class: 'text-sm text-muted mb-3' },
                    'Select a trait to train'
                ),

                compatibleTraits.length === 0
                    ? h('div', { class: 'text-sm text-muted text-center py-3' },
                        'No traits available. Complete research to unlock worker training.'
                    )
                    : compatibleTraits.map(trait => {
                        const existingLevel = workerTraitLevels.find(t => t.id === trait.id);
                        const currentLevel = existingLevel?.currentLevel || 0;
                        const isMaxed = currentLevel >= trait.maxLevel;
                        const targetLevel = currentLevel + 1;
                        const cost = (trait.trainingCostBase || 1000) * targetLevel;
                        const canAfford = (player.currency || 0) >= cost;
                        const trainingHours = (trait.trainingTimeBaseHours || 1) * targetLevel;
                        const catInfo = TRAIT_CATEGORIES[trait.category] || TRAIT_CATEGORIES.special;

                        return h('div', {
                            class: 'cf-card mb-2',
                            style: {
                                borderLeft: `3px solid ${catInfo.color}`,
                                opacity: (canAfford && !isMaxed && trait.isUnlocked) ? 1 : 0.6
                            }
                        },
                            h('div', { class: 'cf-card__body' },
                                h('div', { style: { display: 'flex', alignItems: 'center', gap: 'var(--space-2)' } },
                                    h('span', { style: { fontSize: '1.25rem' } }, catInfo.icon),
                                    h('div', { style: { flex: 1 } },
                                        h('div', { class: 'font-semibold' }, trait.name),
                                        h('div', { class: 'text-xs text-muted' }, trait.description),
                                        h('div', { class: 'text-xs', style: { color: catInfo.color } },
                                            isMaxed
                                                ? `Level ${currentLevel}/${trait.maxLevel} (MAX)`
                                                : `Level ${currentLevel} → ${targetLevel} (${trainingHours.toFixed(1)}h)`
                                        ),
                                        !trait.isUnlocked && h('div', { class: 'text-xs', style: { color: 'var(--color-warning)' } },
                                            `Requires: ${trait.unlockResearch}`
                                        )
                                    ),
                                    h('button', {
                                        class: `cf-btn cf-btn--sm cf-start-training ${canAfford && !isMaxed && trait.isUnlocked ? 'cf-btn--primary' : ''}`,
                                        dataset: { traitId: trait.id.toString() },
                                        disabled: !canAfford || isMaxed || !trait.isUnlocked
                                    }, isMaxed ? 'MAX' : formatCurrency(cost, true))
                                )
                            )
                        );
                    })
            )
        );
    }
}

registerComponent('cf-training', CFTraining);
export default CFTraining;
