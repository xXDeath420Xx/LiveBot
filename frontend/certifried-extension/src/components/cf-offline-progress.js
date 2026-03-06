/**
 * CertiFried Extension - Offline Progress Component
 * Shows what happened while the player was away
 */

import { CFBaseComponent, registerComponent } from './base-component.js';
import { h } from '../utils/dom.js';
import { formatCurrency } from '../utils/format.js';
import { api } from '../api/client.js';
import { store } from '../state/store.js';

class CFOfflineProgress extends CFBaseComponent {
    constructor() {
        super();
        this._summary = null;
        this._isLoading = false;  // Start hidden, not loading
        this._isDismissing = false;
        this._hasLoaded = false;
    }

    onMount() {
        // Hide by default
        this.style.display = 'none';

        // Wait for authentication before loading
        this.subscribe('auth.isAuthenticated', (isAuth) => {
            if (isAuth && !this._hasLoaded) {
                this._hasLoaded = true;
                this._loadOfflineProgress();
            }
        });

        // Check if already authenticated
        if (store.get('auth.isAuthenticated') && !this._hasLoaded) {
            this._hasLoaded = true;
            this._loadOfflineProgress();
        }

        this.on('click', '.cf-offline__dismiss-btn', async () => {
            await this._dismiss();
        });
    }

    async _loadOfflineProgress() {
        try {
            // Don't show loading state - just load silently
            const data = await api.getOfflineProgress();

            if (data.hasOfflineProgress && data.summary) {
                this._summary = data.summary;
                this.render();  // Only render if we have something to show
            }

        } catch (error) {
            console.error('Failed to load offline progress:', error);
            // Silently fail - don't block the UI
        }
    }

    async _dismiss() {
        if (this._isDismissing || !this._summary) return;

        try {
            this._isDismissing = true;
            this.render();

            await api.dismissOfflineProgress(this._summary.recordIds);
            this._summary = null;
            this.emit('offline-progress-dismissed');

        } catch (error) {
            console.error('Failed to dismiss offline progress:', error);
        } finally {
            this._isDismissing = false;
            this.render();
        }
    }

    render() {
        this.className = 'cf-offline-progress';

        if (!this._summary) {
            // Nothing to show - hide component
            this.style.display = 'none';
            return;
        }

        this.style.display = 'block';
        const s = this._summary;

        // Format offline time
        const timeStr = s.offlineHours >= 1
            ? `${s.offlineHours} hours`
            : `${s.offlineMinutes} minutes`;

        this.setContent(
            h('div', { class: 'cf-offline__modal' },
                // Header
                h('div', { class: 'cf-offline__header' },
                    h('h2', {}, 'Welcome Back!'),
                    h('p', { class: 'text-muted' }, `You were away for ${timeStr}`)
                ),

                // Summary items
                h('div', { class: 'cf-offline__items' },
                    // Workers earnings
                    s.workersCashEarned > 0 && this._renderItem(
                        '💰',
                        'Workers Earned',
                        formatCurrency(s.workersCashEarned),
                        'Your workers were busy!'
                    ),

                    // Plants harvested by workers
                    s.workersPlantsHarvested > 0 && this._renderItem(
                        '🌿',
                        'Auto-Harvested',
                        `${s.workersPlantsHarvested} plants`,
                        'Trimmer got to work'
                    ),

                    // Seeds planted by workers
                    s.workersSeedsPlanted > 0 && this._renderItem(
                        '🌱',
                        'Auto-Planted',
                        `${s.workersSeedsPlanted} seeds`,
                        'Propagation tech kept planting'
                    ),

                    // Plants ready
                    s.plantsReady > 0 && this._renderItem(
                        '✅',
                        'Ready to Harvest',
                        `${s.plantsReady} plants`,
                        'Check your garden!'
                    ),

                    // Plants withered (sad)
                    s.plantsWithered > 0 && this._renderItem(
                        '💀',
                        'Plants Withered',
                        `${s.plantsWithered} plants`,
                        'They needed attention...',
                        'warning'
                    )
                ),

                // Dismiss button
                h('div', { class: 'cf-offline__actions' },
                    h('button', {
                        class: 'cf-offline__dismiss-btn cf-btn cf-btn--primary',
                        disabled: this._isDismissing
                    }, this._isDismissing ? 'Closing...' : 'Got it!')
                )
            )
        );
    }

    _renderItem(icon, label, value, description, variant = 'default') {
        return h('div', { class: `cf-offline__item cf-offline__item--${variant}` },
            h('span', { class: 'cf-offline__item-icon' }, icon),
            h('div', { class: 'cf-offline__item-content' },
                h('span', { class: 'cf-offline__item-label' }, label),
                h('span', { class: 'cf-offline__item-value' }, value),
                h('span', { class: 'cf-offline__item-desc text-xs text-muted' }, description)
            )
        );
    }
}

registerComponent('cf-offline-progress', CFOfflineProgress);
export default CFOfflineProgress;
