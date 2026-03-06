/**
 * CertiFried Extension - Enhanced Workers Component
 * Full worker management with hiring, upgrades, traits, and training
 */

import { CFBaseComponent, registerComponent } from './base-component.js';
import { h } from '../utils/dom.js';
import { formatCurrency, formatTimeRemaining } from '../utils/format.js';
import { api } from '../api/client.js';
import { store } from '../state/store.js';

const WORKER_ICONS = {
    trimmer: 'M6 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM20 4L8.12 15.88M14.47 14.48L20 20M8.12 8.12L12 12',
    propagation_tech: 'M12 10a4 4 0 0 0 4-4V2H8v4a4 4 0 0 0 4 4zM12 10v12M8 22h8',
    sales_rep: 'M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6',
    quality_inspector: 'M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z',
    logistics_coordinator: 'M20 7h-9M14 17H5M17 17a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM7 7a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
    research_assistant: 'M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 1 1 7.072 0l-.548.547A3.374 3.374 0 0 0 14 18.469V19a2 2 0 1 1-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z',
    extraction_specialist: 'M19.428 15.428a2 2 0 0 0-1.022-.547l-2.387-.477a6 6 0 0 0-3.86.517l-.318.158a6 6 0 0 1-3.86.517L6.05 15.21a2 2 0 0 1-1.806-1.741l-.267-2.938a2 2 0 0 1 1.741-2.206l2.938-.267M7 12l5-3 5 3v6l-5 3-5-3z',
    dispensary_manager: 'M3 21h18M3 7v1a3 3 0 0 0 6 0V7m0 1a3 3 0 0 0 6 0V7m0 1a3 3 0 0 0 6 0V7M5 21V11.5M19 21V11.5M9 21V15h6v6',
    default: 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z'
};

const TIER_COLORS = {
    1: '#9ca3af', // gray
    2: '#22c55e', // green
    3: '#3b82f6', // blue
    4: '#a855f7', // purple
    5: '#f59e0b'  // gold
};

const TIER_NAMES = ['', 'Novice', 'Skilled', 'Expert', 'Master', 'Legendary'];

class CFWorkers extends CFBaseComponent {
    constructor() {
        super();
        this._workers = [];
        this._workerTypes = [];
        this._traits = [];
        this._activeTraining = [];
        this._playerLevel = 1;
        this._isLoading = true;
        this._activeTab = 'workforce'; // 'workforce' | 'hire' | 'training' | 'config'
        this._selectedWorker = null;
        this._showUpgradeModal = false;
        this._showTrainModal = false;
        this._upgradeInfo = null;
        this._config = {
            autoReplantEnabled: false,
            autoReplantStrainId: null,
            autoReplantUseFavorite: false,
            selectedStrain: null
        };
        this._availableStrains = [];
        this._showStrainPicker = false;
    }

    onMount() {
        this._loadEnhancedWorkerData();
        this._loadConfig();

        // Tab switching
        this.on('click', '.cf-workers__tab', (e) => {
            const tab = e.target.closest('.cf-workers__tab');
            if (!tab) return;
            this._activeTab = tab.dataset.tab;
            this.render();
        });

        // Hire worker
        this.on('click', '.cf-hire-btn', async (e) => {
            const btn = e.target.closest('.cf-hire-btn');
            if (!btn || btn.disabled) return;
            const typeId = parseInt(btn.dataset.typeId, 10);
            await this._hireWorker(typeId);
        });

        // Select worker for details
        this.on('click', '.cf-worker-card', (e) => {
            const card = e.target.closest('.cf-worker-card');
            if (!card) return;
            const workerId = parseInt(card.dataset.workerId, 10);
            this._selectedWorker = this._workers.find(w => w.id === workerId);
            this.render();
        });

        // Upgrade button
        this.on('click', '.cf-upgrade-btn', async (e) => {
            const workerId = parseInt(e.target.dataset.workerId, 10);
            await this._showUpgradeInfo(workerId);
        });

        // Confirm upgrade
        this.on('click', '.cf-confirm-upgrade', async () => {
            if (this._selectedWorker) {
                await this._upgradeWorker(this._selectedWorker.id);
            }
        });

        // Train button
        this.on('click', '.cf-train-btn', async (e) => {
            const workerId = parseInt(e.target.dataset.workerId, 10);
            this._selectedWorker = this._workers.find(w => w.id === workerId);
            await this._loadTraits();
            this._showTrainModal = true;
            this.render();
        });

        // Select trait to train
        this.on('click', '.cf-trait-option', async (e) => {
            const option = e.target.closest('.cf-trait-option');
            if (!option || option.classList.contains('disabled')) return;
            const traitId = parseInt(option.dataset.traitId, 10);
            await this._startTraining(traitId);
        });

        // Claim training
        this.on('click', '.cf-claim-training', async (e) => {
            const workerId = parseInt(e.target.dataset.workerId, 10);
            await this._claimTraining(workerId);
        });

        // Toggle worker
        this.on('change', '.cf-worker-toggle', async (e) => {
            const workerId = parseInt(e.target.dataset.workerId, 10);
            const enabled = e.target.checked;
            await this._toggleWorker(workerId, enabled);
        });

        // Close modals
        this.on('click', '.cf-modal-close', () => {
            this._showUpgradeModal = false;
            this._showTrainModal = false;
            this._upgradeInfo = null;
            this.render();
        });

        // Back to list
        this.on('click', '.cf-back-btn', () => {
            this._selectedWorker = null;
            this.render();
        });

        // Auto-replant toggle
        this.on('change', '.cf-autoreplant-toggle', async (e) => {
            this._config.autoReplantEnabled = e.target.checked;
            await this._saveConfig();
        });

        // Use favorite toggle
        this.on('change', '.cf-autoreplant-favorite', async (e) => {
            this._config.autoReplantUseFavorite = e.target.checked;
            if (e.target.checked) {
                this._config.autoReplantStrainId = null;
                this._config.selectedStrain = null;
            }
            await this._saveConfig();
        });

        // Open strain picker
        this.on('click', '.cf-select-strain-btn', async () => {
            await this._loadStrains();
            this._showStrainPicker = true;
            this.render();
        });

        // Select strain
        this.on('click', '.cf-strain-pick-option', async (e) => {
            const option = e.target.closest('.cf-strain-pick-option');
            if (!option) return;
            const strainId = parseInt(option.dataset.strainId, 10);
            const strainName = option.dataset.strainName;
            this._config.autoReplantStrainId = strainId;
            this._config.autoReplantUseFavorite = false;
            this._config.selectedStrain = { id: strainId, name: strainName };
            this._showStrainPicker = false;
            await this._saveConfig();
        });

        // Close strain picker
        this.on('click', '.cf-picker-close', () => {
            this._showStrainPicker = false;
            this.render();
        });

        // Update countdown timers
        this._timerInterval = setInterval(() => this._updateTimers(), 1000);
    }

    onUnmount() {
        if (this._timerInterval) {
            clearInterval(this._timerInterval);
        }
    }

    _updateTimers() {
        const timers = this.querySelectorAll('.cf-countdown');
        timers.forEach(timer => {
            const completesAt = timer.dataset.completesAt;
            if (completesAt) {
                const remaining = new Date(completesAt) - new Date();
                if (remaining <= 0) {
                    timer.textContent = 'Ready to claim!';
                    timer.classList.add('text-success');
                } else {
                    timer.textContent = this._formatDuration(remaining);
                }
            }
        });
    }

    async _loadEnhancedWorkerData() {
        // Only show loading on first load
        const isFirstLoad = this._workers.length === 0 && this._workerTypes.length === 0;

        if (isFirstLoad) {
            this._isLoading = true;
            this.render();
        }

        try {
            const response = await api.getEnhancedWorkers();
            if (response.success) {
                this._workers = response.workers || [];
                this._workerTypes = response.workerTypes || [];
                this._activeTraining = response.activeTraining || [];
                this._playerLevel = response.playerLevel || 1;
            }
        } catch (error) {
            console.error('[Workers] Failed to load enhanced data:', error);
            // Fallback to basic worker loading for backward compatibility
            if (isFirstLoad) {
                await this._loadLegacyWorkers();
            }
        } finally {
            this._isLoading = false;
            this.scheduleRender();
        }
    }

    async _loadLegacyWorkers() {
        try {
            const ownedData = await api.getOwnedItems();
            const ownedItems = ownedData.items || [];
            this._workers = ownedItems.filter(item =>
                item.itemId?.includes('worker_') || item.type === 'worker'
            ).map(w => ({
                id: w.id || 0,
                typeKey: w.itemId?.replace('worker_', '') || w.workerType,
                typeName: w.name || w.itemId,
                tier: 1,
                maxTier: 1,
                isEnabled: true,
                traits: [],
                isLegacy: true
            }));
        } catch (err) {
            console.error('[Workers] Legacy load failed:', err);
        }
    }

    async _loadConfig() {
        try {
            const response = await api.getWorkerConfig();
            if (response.success) {
                this._config = response.config;
            }
        } catch (err) {
            console.error('[Workers] Failed to load config:', err);
        }
        this.render();
    }

    async _saveConfig() {
        try {
            await api.updateWorkerConfig({
                autoReplantEnabled: this._config.autoReplantEnabled,
                autoReplantStrainId: this._config.autoReplantStrainId,
                autoReplantUseFavorite: this._config.autoReplantUseFavorite
            });
            // Keep store in sync (other components read autoReplant from store)
            store.set('settings.autoReplant', this._config.autoReplantEnabled);
            store._persistSettings();
            this.emit('notification', { type: 'success', message: 'Configuration saved' });
        } catch (err) {
            this.emit('notification', { type: 'error', message: err.message });
        }
        this.render();
    }

    async _loadStrains() {
        try {
            const response = await api.getStrainCollection();
            if (response.success) {
                this._availableStrains = response.strains || [];
            }
        } catch (err) {
            console.error('[Workers] Failed to load strains:', err);
        }
    }

    async _loadTraits() {
        try {
            const response = await api.getWorkerTraits();
            if (response.success) {
                this._traits = response.traits || [];
            }
        } catch (err) {
            console.error('[Workers] Failed to load traits:', err);
        }
    }

    async _hireWorker(typeId) {
        const workerType = this._workerTypes.find(t => t.id === typeId);
        if (!workerType) return;

        // Optimistic update - increment owned count
        const oldWorkerTypes = JSON.parse(JSON.stringify(this._workerTypes));
        const typeIndex = this._workerTypes.findIndex(t => t.id === typeId);
        if (typeIndex !== -1) {
            this._workerTypes[typeIndex].ownedCount = (this._workerTypes[typeIndex].ownedCount || 0) + 1;
        }
        this.scheduleRender();

        this.emit('notification', { type: 'success', message: `Hired ${workerType.name}!` });

        try {
            const response = await api.hireWorker(typeId);
            if (response.success) {
                // Refresh workers in background
                api.getEnhancedWorkers().then(data => {
                    if (data.success) {
                        this._workers = data.workers || [];
                        this._workerTypes = data.workerTypes || [];
                        this.scheduleRender();
                    }
                }).catch(() => {});
            } else {
                // Rollback
                this._workerTypes = oldWorkerTypes;
                this.scheduleRender();
                this.emit('notification', { type: 'error', message: response.error });
            }
        } catch (err) {
            // Rollback
            this._workerTypes = oldWorkerTypes;
            this.scheduleRender();
            this.emit('notification', { type: 'error', message: err.message });
        }
    }

    async _showUpgradeInfo(workerId) {
        try {
            const response = await api.getWorkerUpgradeInfo(workerId);
            if (response.success) {
                this._upgradeInfo = response;
                this._showUpgradeModal = true;
                this.render();
            }
        } catch (err) {
            this.emit('notification', { type: 'error', message: err.message });
        }
    }

    async _upgradeWorker(workerId) {
        try {
            const response = await api.upgradeWorker(workerId);
            if (response.success) {
                this.emit('notification', { type: 'success', message: response.message });
                this._showUpgradeModal = false;
                this._upgradeInfo = null;
                await this._loadEnhancedWorkerData();
            } else {
                this.emit('notification', { type: 'error', message: response.error });
            }
        } catch (err) {
            this.emit('notification', { type: 'error', message: err.message });
        }
    }

    async _startTraining(traitId) {
        if (!this._selectedWorker) return;
        try {
            const response = await api.trainWorkerTrait(this._selectedWorker.id, traitId);
            if (response.success) {
                this.emit('notification', { type: 'success', message: response.message });
                this._showTrainModal = false;
                await this._loadEnhancedWorkerData();
            } else {
                this.emit('notification', { type: 'error', message: response.error });
            }
        } catch (err) {
            this.emit('notification', { type: 'error', message: err.message });
        }
    }

    async _claimTraining(workerId) {
        try {
            const response = await api.claimWorkerTraining(workerId);
            if (response.success) {
                this.emit('notification', { type: 'success', message: response.message });
                await this._loadEnhancedWorkerData();
            } else {
                this.emit('notification', { type: 'error', message: response.error });
            }
        } catch (err) {
            this.emit('notification', { type: 'error', message: err.message });
        }
    }

    async _toggleWorker(workerId, enabled) {
        try {
            const response = await api.toggleEnhancedWorker(workerId, enabled);
            if (response.success) {
                this.emit('notification', { type: 'info', message: response.message });
                const worker = this._workers.find(w => w.id === workerId);
                if (worker) worker.isEnabled = enabled;
                this.render();
            }
        } catch (err) {
            this.emit('notification', { type: 'error', message: err.message });
        }
    }

    render() {
        this.className = 'cf-section cf-workers';
        this.setContent(
            // Header
            h('div', { class: 'cf-section__header' },
                h('h2', { class: 'cf-section__title' }, 'Workers'),
                this._workers.length > 0 && h('span', { class: 'cf-badge cf-badge--success' },
                    `${this._workers.filter(w => w.isEnabled).length}/${this._workers.length} Active`
                )
            ),

            // Active training banner
            this._activeTraining.length > 0 && this._renderTrainingBanner(),

            // Tabs
            h('div', { class: 'cf-tabs mb-3' },
                this._renderTab('workforce', `Workforce (${this._workers.length})`),
                this._renderTab('hire', 'Hire'),
                this._renderTab('training', 'Traits'),
                this._renderTab('config', 'Config')
            ),

            // Loading
            this._isLoading && h('div', { class: 'cf-loading' },
                h('div', { class: 'cf-spinner' })
            ),

            // Content based on tab
            !this._isLoading && this._activeTab === 'workforce' && this._renderWorkforce(),
            !this._isLoading && this._activeTab === 'hire' && this._renderHire(),
            !this._isLoading && this._activeTab === 'training' && this._renderTrainingTab(),
            !this._isLoading && this._activeTab === 'config' && this._renderConfig(),

            // Modals
            this._showUpgradeModal && this._renderUpgradeModal(),
            this._showTrainModal && this._renderTrainModal(),
            this._showStrainPicker && this._renderStrainPicker()
        );
    }

    _renderTab(tab, label) {
        return h('button', {
            class: `cf-tab cf-workers__tab ${this._activeTab === tab ? 'cf-tab--active' : ''}`,
            dataset: { tab }
        }, label);
    }

    _renderTrainingBanner() {
        const training = this._activeTraining[0];
        if (!training) return null;

        const remaining = new Date(training.completesAt) - new Date();
        const isReady = remaining <= 0;

        return h('div', {
            class: `cf-training-banner mb-3 ${isReady ? 'cf-training-banner--ready' : ''}`,
            style: {
                padding: 'var(--space-3)',
                background: isReady ? 'var(--bg-success)' : 'var(--bg-secondary)',
                borderRadius: 'var(--radius-md)',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center'
            }
        },
            h('div', {},
                h('div', { class: 'font-semibold text-sm' },
                    `${training.workerName} training: ${training.traitName}`
                ),
                h('div', {
                    class: `cf-countdown text-xs ${isReady ? 'text-success' : 'text-muted'}`,
                    dataset: { completesAt: training.completesAt }
                }, isReady ? 'Ready to claim!' : this._formatDuration(remaining))
            ),
            isReady && h('button', {
                class: 'cf-btn cf-btn--success cf-btn--sm cf-claim-training',
                dataset: { workerId: training.workerId.toString() }
            }, 'Claim')
        );
    }

    _renderWorkforce() {
        if (this._selectedWorker) {
            return this._renderWorkerDetail(this._selectedWorker);
        }

        if (this._workers.length === 0) {
            return h('div', { class: 'cf-empty' },
                this._renderEmptyIcon(),
                h('p', { class: 'cf-empty__title' }, 'No Workers'),
                h('p', { class: 'cf-empty__description' }, 'Hire workers from the Hire tab to automate your empire!'),
                h('button', {
                    class: 'cf-btn cf-btn--primary mt-3',
                    onclick: () => { this._activeTab = 'hire'; this.render(); }
                }, 'Hire Workers')
            );
        }

        return h('div', { class: 'cf-worker-list' },
            ...this._workers.map(worker => this._renderWorkerCard(worker))
        );
    }

    _renderWorkerCard(worker) {
        const tierColor = TIER_COLORS[worker.tier] || TIER_COLORS[1];
        const isTraining = worker.isTraining && worker.trainingCompletesAt;
        const trainingReady = isTraining && new Date(worker.trainingCompletesAt) <= new Date();

        return h('div', {
            class: `cf-worker-card ${!worker.isEnabled ? 'cf-worker-card--disabled' : ''}`,
            dataset: { workerId: worker.id.toString() },
            style: {
                borderLeft: `4px solid ${tierColor}`
            }
        },
            // Icon
            h('div', {
                class: 'cf-worker-card__icon',
                style: { background: tierColor }
            }, this._renderIcon(worker.typeKey)),

            // Info
            h('div', { class: 'cf-worker-card__info', style: { flex: 1 } },
                h('div', { class: 'cf-worker-card__name' },
                    worker.name,
                    h('span', {
                        class: 'cf-tier-badge',
                        style: {
                            marginLeft: 'var(--space-2)',
                            fontSize: '10px',
                            padding: '2px 6px',
                            borderRadius: 'var(--radius-sm)',
                            background: tierColor,
                            color: 'white'
                        }
                    }, TIER_NAMES[worker.tier])
                ),
                h('div', { class: 'cf-worker-card__type text-xs text-muted' }, worker.typeName),
                isTraining && h('div', {
                    class: `cf-worker-card__training text-xs mt-1 ${trainingReady ? 'text-success' : 'text-warning'}`
                },
                    trainingReady
                        ? '⭐ Training complete!'
                        : h('span', {},
                            '📚 Training: ',
                            h('span', {
                                class: 'cf-countdown',
                                dataset: { completesAt: worker.trainingCompletesAt }
                            }, this._formatDuration(new Date(worker.trainingCompletesAt) - new Date()))
                        )
                )
            ),

            // Toggle
            h('label', {
                class: 'cf-switch',
                onclick: (e) => e.stopPropagation()
            },
                h('input', {
                    type: 'checkbox',
                    class: 'cf-worker-toggle',
                    dataset: { workerId: worker.id.toString() },
                    checked: worker.isEnabled,
                    disabled: worker.isLegacy
                }),
                h('span', { class: 'cf-switch__slider' })
            )
        );
    }

    _renderWorkerDetail(worker) {
        const tierColor = TIER_COLORS[worker.tier] || TIER_COLORS[1];
        const canUpgrade = worker.tier < worker.maxTier;
        const isTraining = worker.isTraining;

        return h('div', { class: 'cf-worker-detail' },
            // Back button
            h('button', { class: 'cf-btn cf-btn--ghost cf-back-btn mb-3' },
                '← Back to list'
            ),

            // Header
            h('div', {
                class: 'cf-worker-detail__header',
                style: {
                    display: 'flex',
                    gap: 'var(--space-3)',
                    marginBottom: 'var(--space-4)'
                }
            },
                h('div', {
                    style: {
                        width: '64px',
                        height: '64px',
                        borderRadius: 'var(--radius-lg)',
                        background: tierColor,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center'
                    }
                }, this._renderIcon(worker.typeKey, 32)),
                h('div', { style: { flex: 1 } },
                    h('h3', { style: { margin: 0 } }, worker.name),
                    h('div', { class: 'text-muted text-sm' }, worker.typeName),
                    h('div', {
                        style: {
                            display: 'inline-block',
                            marginTop: 'var(--space-1)',
                            padding: '2px 8px',
                            borderRadius: 'var(--radius-sm)',
                            background: tierColor,
                            color: 'white',
                            fontSize: '12px'
                        }
                    }, `${TIER_NAMES[worker.tier]} (Tier ${worker.tier}/${worker.maxTier})`)
                )
            ),

            // Stats
            h('div', { class: 'cf-card mb-3' },
                h('div', { class: 'cf-card__header' }, h('span', {}, 'Stats')),
                h('div', { class: 'cf-card__body' },
                    h('div', { class: 'cf-stat-grid' },
                        this._renderStat('Interval', `${Math.round(worker.intervalMs / 1000)}s`, '#3b82f6'),
                        this._renderStat('Efficiency', `${Math.round(worker.efficiency * 100)}%`, '#22c55e'),
                        this._renderStat('Capacity', worker.capacity.toString(), '#a855f7'),
                        this._renderStat('Quality', `+${Math.round(worker.qualityBonus * 100)}%`, '#f59e0b')
                    ),
                    h('div', { class: 'text-xs text-muted mt-2', style: { textAlign: 'center' } },
                        `Total Actions: ${worker.totalActions.toLocaleString()} • XP: ${worker.experience}`
                    )
                )
            ),

            // Traits
            h('div', { class: 'cf-card mb-3' },
                h('div', {
                    class: 'cf-card__header',
                    style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' }
                },
                    h('span', {}, 'Trained Traits'),
                    !isTraining && h('button', {
                        class: 'cf-btn cf-btn--sm cf-btn--primary cf-train-btn',
                        dataset: { workerId: worker.id.toString() }
                    }, '+ Train')
                ),
                h('div', { class: 'cf-card__body' },
                    worker.traits.length === 0
                        ? h('p', { class: 'text-muted text-sm' }, 'No traits trained yet. Train traits to boost this worker\'s abilities!')
                        : worker.traits.map(trait =>
                            h('div', {
                                class: 'cf-trait-item',
                                style: {
                                    display: 'flex',
                                    justifyContent: 'space-between',
                                    alignItems: 'center',
                                    padding: 'var(--space-2)',
                                    background: 'var(--bg-tertiary)',
                                    borderRadius: 'var(--radius-sm)',
                                    marginBottom: 'var(--space-2)'
                                }
                            },
                                h('div', {},
                                    h('div', { class: 'font-medium text-sm' }, trait.name),
                                    h('div', { class: 'text-xs text-muted' }, trait.description)
                                ),
                                h('div', {
                                    class: 'cf-trait-level',
                                    style: {
                                        background: '#3b82f6',
                                        color: 'white',
                                        padding: '2px 8px',
                                        borderRadius: 'var(--radius-sm)',
                                        fontSize: '12px'
                                    }
                                }, `Lv ${trait.currentLevel}/${trait.maxLevel}`)
                            )
                        )
                )
            ),

            // Actions
            h('div', { class: 'cf-worker-actions', style: { display: 'flex', gap: 'var(--space-2)' } },
                canUpgrade && h('button', {
                    class: 'cf-btn cf-btn--primary cf-upgrade-btn',
                    dataset: { workerId: worker.id.toString() },
                    style: { flex: 1 }
                }, `Upgrade to ${TIER_NAMES[worker.tier + 1]}`),
                h('button', {
                    class: `cf-btn ${worker.isEnabled ? 'cf-btn--danger' : 'cf-btn--success'}`,
                    onclick: () => this._toggleWorker(worker.id, !worker.isEnabled),
                    style: { flex: 1 }
                }, worker.isEnabled ? 'Disable' : 'Enable')
            )
        );
    }

    _renderHire() {
        const availableTypes = this._workerTypes.filter(t => t.isUnlocked);
        const lockedTypes = this._workerTypes.filter(t => !t.isUnlocked);

        return h('div', { class: 'cf-hire-panel' },
            h('p', { class: 'text-muted text-sm mb-3' },
                'Hire workers to automate various tasks in your operation.'
            ),

            // Available workers
            availableTypes.length > 0 && h('div', { class: 'mb-4' },
                h('h4', { class: 'mb-2' }, 'Available Workers'),
                ...availableTypes.map(type => this._renderWorkerType(type, true))
            ),

            // Locked workers
            lockedTypes.length > 0 && h('div', {},
                h('h4', { class: 'mb-2 text-muted' }, 'Locked Workers'),
                ...lockedTypes.map(type => this._renderWorkerType(type, false))
            )
        );
    }

    _renderWorkerType(type, isUnlocked) {
        const owned = type.ownedCount > 0;

        return h('div', {
            class: `cf-worker-type-card cf-card mb-2 ${!isUnlocked ? 'cf-worker-type-card--locked' : ''}`,
            style: { opacity: isUnlocked ? 1 : 0.6 }
        },
            h('div', { class: 'cf-card__body', style: { display: 'flex', gap: 'var(--space-3)' } },
                h('div', {
                    style: {
                        width: '48px',
                        height: '48px',
                        borderRadius: 'var(--radius-md)',
                        background: isUnlocked ? '#3b82f6' : '#6b7280',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        flexShrink: 0
                    }
                }, this._renderIcon(type.key, 24)),

                h('div', { style: { flex: 1 } },
                    h('div', { class: 'font-semibold' },
                        type.name,
                        owned && h('span', { class: 'text-success text-xs ml-2' }, `(${type.ownedCount} owned)`)
                    ),
                    h('div', { class: 'text-xs text-muted' }, type.description),
                    !isUnlocked && h('div', { class: 'text-xs text-warning mt-1' },
                        type.unlockLevel > this._playerLevel
                            ? `Requires Level ${type.unlockLevel}`
                            : `Requires Research: ${type.unlockResearch}`
                    )
                ),

                h('div', { style: { textAlign: 'right', flexShrink: 0 } },
                    h('div', { class: 'font-semibold' }, formatCurrency(type.baseCost)),
                    isUnlocked && h('button', {
                        class: 'cf-btn cf-btn--primary cf-btn--sm cf-hire-btn mt-2',
                        dataset: { typeId: type.id.toString() }
                    }, 'Hire')
                )
            )
        );
    }

    _renderTrainingTab() {
        const trainableWorkers = this._workers.filter(w => !w.isTraining && !w.isLegacy);

        return h('div', { class: 'cf-training-panel' },
            h('p', { class: 'text-muted text-sm mb-3' },
                'Train your workers to improve their abilities. Each trait level provides permanent bonuses.'
            ),

            // Active training
            this._activeTraining.length > 0 && h('div', { class: 'mb-4' },
                h('h4', { class: 'mb-2' }, 'Currently Training'),
                ...this._activeTraining.map(t => {
                    const remaining = new Date(t.completesAt) - new Date();
                    const isReady = remaining <= 0;
                    return h('div', {
                        class: 'cf-card mb-2',
                        style: { borderLeft: isReady ? '4px solid var(--color-success)' : '4px solid var(--color-warning)' }
                    },
                        h('div', {
                            class: 'cf-card__body',
                            style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' }
                        },
                            h('div', {},
                                h('div', { class: 'font-semibold' }, t.workerName),
                                h('div', { class: 'text-sm text-muted' },
                                    `Training: ${t.traitName} → Level ${t.targetLevel}`
                                )
                            ),
                            isReady
                                ? h('button', {
                                    class: 'cf-btn cf-btn--success cf-btn--sm cf-claim-training',
                                    dataset: { workerId: t.workerId.toString() }
                                }, 'Claim')
                                : h('div', {
                                    class: 'cf-countdown text-muted',
                                    dataset: { completesAt: t.completesAt }
                                }, this._formatDuration(remaining))
                        )
                    );
                })
            ),

            // Available workers for training
            trainableWorkers.length > 0
                ? h('div', {},
                    h('h4', { class: 'mb-2' }, 'Train a Worker'),
                    ...trainableWorkers.map(worker =>
                        h('div', { class: 'cf-card mb-2' },
                            h('div', {
                                class: 'cf-card__body',
                                style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' }
                            },
                                h('div', {},
                                    h('div', { class: 'font-semibold' }, worker.name),
                                    h('div', { class: 'text-xs text-muted' },
                                        `${worker.traits.length} traits trained`
                                    )
                                ),
                                h('button', {
                                    class: 'cf-btn cf-btn--primary cf-btn--sm cf-train-btn',
                                    dataset: { workerId: worker.id.toString() }
                                }, 'Select Trait')
                            )
                        )
                    )
                )
                : h('div', { class: 'cf-empty' },
                    h('p', { class: 'text-muted' },
                        this._workers.length === 0
                            ? 'Hire workers first to train them.'
                            : 'All workers are currently training or unavailable.'
                    )
                )
        );
    }

    _renderConfig() {
        const hasPropagationTech = this._workers.some(w =>
            w.typeKey === 'propagation_tech' || w.typeKey === 'planter'
        );

        if (!hasPropagationTech) {
            return h('div', { class: 'cf-empty' },
                h('p', { class: 'cf-empty__title' }, 'Propagation Tech Required'),
                h('p', { class: 'cf-empty__description' },
                    'Hire the Propagation Tech worker to enable auto-replant configuration.'
                )
            );
        }

        return h('div', { class: 'cf-config-panel' },
            // Enable toggle
            h('div', { class: 'cf-card mb-3' },
                h('div', {
                    class: 'cf-card__body',
                    style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' }
                },
                    h('div', {},
                        h('div', { class: 'font-semibold' }, 'Auto-Replant'),
                        h('div', { class: 'text-xs text-muted' },
                            'Automatically plant seeds after harvesting'
                        )
                    ),
                    h('label', { class: 'cf-switch' },
                        h('input', {
                            type: 'checkbox',
                            class: 'cf-autoreplant-toggle',
                            checked: this._config.autoReplantEnabled
                        }),
                        h('span', { class: 'cf-switch__slider' })
                    )
                )
            ),

            // Strain selection
            this._config.autoReplantEnabled && h('div', { class: 'cf-card' },
                h('div', { class: 'cf-card__body' },
                    h('div', { class: 'font-semibold mb-3' }, 'Strain Selection'),

                    h('label', {
                        class: 'cf-checkbox-label mb-3',
                        style: { display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }
                    },
                        h('input', {
                            type: 'checkbox',
                            class: 'cf-autoreplant-favorite',
                            checked: this._config.autoReplantUseFavorite
                        }),
                        h('span', {}, 'Use first favorite strain')
                    ),

                    !this._config.autoReplantUseFavorite && h('div', {},
                        h('div', {
                            style: {
                                display: 'flex', alignItems: 'center', gap: 'var(--space-2)',
                                margin: 'var(--space-3) 0', color: 'var(--text-muted)'
                            }
                        },
                            h('div', { style: { flex: 1, height: '1px', background: 'var(--border-primary)' } }),
                            h('span', { class: 'text-xs' }, 'OR'),
                            h('div', { style: { flex: 1, height: '1px', background: 'var(--border-primary)' } })
                        ),

                        h('div', { class: 'text-sm text-muted mb-2' }, 'Select specific strain:'),
                        this._config.selectedStrain
                            ? h('div', {
                                style: {
                                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                                    padding: 'var(--space-2)', background: 'var(--bg-tertiary)',
                                    borderRadius: 'var(--radius-md)'
                                }
                            },
                                h('span', { class: 'font-medium' }, this._config.selectedStrain.name),
                                h('button', { class: 'cf-btn cf-btn--ghost cf-btn--sm cf-select-strain-btn' }, 'Change')
                            )
                            : h('button', {
                                class: 'cf-btn cf-btn--secondary cf-select-strain-btn',
                                style: { width: '100%' }
                            }, 'Select Strain')
                    )
                )
            )
        );
    }

    _renderUpgradeModal() {
        if (!this._upgradeInfo || !this._selectedWorker) return null;

        const { requirements, playerHas, canUpgrade, improvements, isMaxTier } = this._upgradeInfo;

        if (isMaxTier) {
            return this._renderModal('Max Tier Reached',
                h('p', { class: 'text-muted' }, this._upgradeInfo.message)
            );
        }

        return this._renderModal(
            `Upgrade to ${TIER_NAMES[this._upgradeInfo.nextTier]}`,
            h('div', {},
                // Requirements
                h('div', { class: 'mb-4' },
                    h('h4', { class: 'mb-2' }, 'Requirements'),
                    this._renderRequirement('Cash', formatCurrency(requirements.cash), formatCurrency(playerHas.cash), playerHas.cash >= requirements.cash),
                    this._renderRequirement('XP', requirements.xp.toString(), playerHas.xp.toString(), playerHas.xp >= requirements.xp),
                    this._renderRequirement('Actions', requirements.actions.toString(), playerHas.actions.toString(), playerHas.actions >= requirements.actions),
                    requirements.research && this._renderRequirement('Research', requirements.research, playerHas.researchMet ? '✓' : '✗', playerHas.researchMet)
                ),

                // Improvements
                h('div', { class: 'mb-4' },
                    h('h4', { class: 'mb-2' }, 'Improvements'),
                    h('div', { class: 'text-sm' },
                        h('div', {}, `Speed: -${improvements.intervalReduction} action time`),
                        h('div', {}, `Efficiency: ${improvements.efficiencyBonus}`),
                        h('div', {}, `Capacity: ${improvements.capacityBonus}`),
                        h('div', {}, `Quality: ${improvements.qualityBonus}`)
                    )
                ),

                // Upgrade button
                h('button', {
                    class: `cf-btn cf-btn--primary cf-confirm-upgrade`,
                    style: { width: '100%' },
                    disabled: !canUpgrade
                }, canUpgrade ? 'Confirm Upgrade' : 'Requirements Not Met')
            )
        );
    }

    _renderRequirement(label, required, has, met) {
        return h('div', {
            style: {
                display: 'flex', justifyContent: 'space-between',
                padding: 'var(--space-1) 0',
                color: met ? 'var(--text-primary)' : 'var(--color-danger)'
            }
        },
            h('span', {}, label),
            h('span', {}, `${has} / ${required} ${met ? '✓' : '✗'}`)
        );
    }

    _renderTrainModal() {
        if (!this._selectedWorker) return null;

        const workerTraitIds = new Set(this._selectedWorker.traits.map(t => t.id));
        const availableTraits = this._traits.filter(t => {
            if (!t.isUnlocked) return false;
            if (t.compatibleWorkers && !t.compatibleWorkers.includes(this._selectedWorker.typeKey)) return false;
            const existingTrait = this._selectedWorker.traits.find(wt => wt.id === t.id);
            if (existingTrait && existingTrait.currentLevel >= t.maxLevel) return false;
            return true;
        });

        return this._renderModal(
            `Train ${this._selectedWorker.name}`,
            h('div', {},
                availableTraits.length === 0
                    ? h('p', { class: 'text-muted' }, 'No traits available for training. Unlock more through research.')
                    : availableTraits.map(trait => {
                        const existingTrait = this._selectedWorker.traits.find(t => t.id === trait.id);
                        const currentLevel = existingTrait?.currentLevel || 0;
                        const nextLevel = currentLevel + 1;
                        const cost = trait.trainingCostBase * nextLevel;

                        return h('div', {
                            class: 'cf-trait-option cf-card mb-2',
                            dataset: { traitId: trait.id.toString() },
                            style: { cursor: 'pointer' }
                        },
                            h('div', { class: 'cf-card__body' },
                                h('div', { style: { display: 'flex', justifyContent: 'space-between' } },
                                    h('div', {},
                                        h('div', { class: 'font-semibold' }, trait.name),
                                        h('div', { class: 'text-xs text-muted' }, trait.description)
                                    ),
                                    h('div', { style: { textAlign: 'right' } },
                                        h('div', { class: 'text-sm' }, `Lv ${currentLevel} → ${nextLevel}`),
                                        h('div', { class: 'text-xs text-muted' }, formatCurrency(cost))
                                    )
                                ),
                                h('div', { class: 'text-xs text-muted mt-1' },
                                    `+${Math.round(trait.effectValuePerLevel * 100)}% ${trait.effectType.replace('_', ' ')} per level • ${trait.trainingTimeBaseHours * nextLevel}h training`
                                )
                            )
                        );
                    })
            )
        );
    }

    _renderModal(title, content) {
        return h('div', {
            class: 'cf-modal-backdrop',
            style: {
                position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
                background: 'rgba(0,0,0,0.7)', display: 'flex',
                alignItems: 'center', justifyContent: 'center', zIndex: 1000
            }
        },
            h('div', {
                style: {
                    background: 'var(--bg-primary)', borderRadius: 'var(--radius-lg)',
                    maxWidth: '400px', width: '90%', maxHeight: '70vh', overflow: 'hidden',
                    display: 'flex', flexDirection: 'column'
                }
            },
                h('div', {
                    style: {
                        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                        padding: 'var(--space-3)', borderBottom: '1px solid var(--border-primary)'
                    }
                },
                    h('span', { class: 'font-semibold' }, title),
                    h('button', { class: 'cf-btn cf-btn--ghost cf-modal-close' }, '×')
                ),
                h('div', { style: { overflowY: 'auto', padding: 'var(--space-3)' } }, content)
            )
        );
    }

    _renderStrainPicker() {
        return h('div', {
            class: 'cf-modal-backdrop',
            style: {
                position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
                background: 'rgba(0,0,0,0.7)', display: 'flex',
                alignItems: 'center', justifyContent: 'center', zIndex: 1000
            }
        },
            h('div', {
                style: {
                    background: 'var(--bg-primary)', borderRadius: 'var(--radius-lg)',
                    maxWidth: '400px', width: '90%', maxHeight: '70vh', overflow: 'hidden',
                    display: 'flex', flexDirection: 'column'
                }
            },
                h('div', {
                    style: {
                        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                        padding: 'var(--space-3)', borderBottom: '1px solid var(--border-primary)'
                    }
                },
                    h('span', { class: 'font-semibold' }, 'Select Strain'),
                    h('button', { class: 'cf-btn cf-btn--ghost cf-picker-close' }, '×')
                ),
                h('div', { style: { overflowY: 'auto', padding: 'var(--space-3)' } },
                    this._availableStrains.length === 0
                        ? h('p', { class: 'text-muted text-center' }, 'No strains available')
                        : this._availableStrains.map(strain =>
                            h('div', {
                                class: 'cf-strain-pick-option cf-card',
                                dataset: { strainId: strain.id.toString(), strainName: strain.name },
                                style: { marginBottom: 'var(--space-2)', cursor: 'pointer' }
                            },
                                h('div', {
                                    class: 'cf-card__body',
                                    style: { display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }
                                },
                                    h('span', { class: 'font-medium', style: { flex: 1 } }, strain.name),
                                    h('span', { class: 'text-xs text-muted' }, strain.rarity)
                                )
                            )
                        )
                )
            )
        );
    }

    _renderStat(label, value, color) {
        return h('div', { class: 'cf-stat' },
            h('div', { class: 'cf-stat__value', style: { color } }, value),
            h('div', { class: 'cf-stat__label' }, label)
        );
    }

    _renderIcon(type, size = 20) {
        const pathD = WORKER_ICONS[type] || WORKER_ICONS.default;
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('width', size.toString());
        svg.setAttribute('height', size.toString());
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'white');
        svg.setAttribute('stroke-width', '2');

        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', pathD);
        svg.appendChild(path);
        return svg;
    }

    _renderEmptyIcon() {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('class', 'cf-empty__icon');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'currentColor');
        svg.setAttribute('stroke-width', '1.5');

        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', 'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 7a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75');
        svg.appendChild(path);

        return svg;
    }

    _formatDuration(ms) {
        if (ms <= 0) return 'Ready!';
        const hours = Math.floor(ms / 3600000);
        const minutes = Math.floor((ms % 3600000) / 60000);
        const seconds = Math.floor((ms % 60000) / 1000);

        if (hours > 0) return `${hours}h ${minutes}m`;
        if (minutes > 0) return `${minutes}m ${seconds}s`;
        return `${seconds}s`;
    }
}

registerComponent('cf-workers', CFWorkers);
export default CFWorkers;
