/**
 * Market Alerts Component
 * Set price alerts for strains
 */

import { CFBaseComponent, registerComponent } from './base-component.js';
import { h } from '../utils/dom.js';
import { api } from '../api/client.js';
import { formatCurrency, formatRarity } from '../utils/format.js';

const ALERT_TYPES = {
    price_above: { label: 'Price Above', icon: '↑', description: 'Alert when price goes above threshold' },
    price_below: { label: 'Price Below', icon: '↓', description: 'Alert when price drops below threshold' },
    price_change_percent: { label: 'Price Change %', icon: '±', description: 'Alert on significant price change' }
};

class CFMarketAlerts extends CFBaseComponent {
    constructor() {
        super();
        this._alerts = [];
        this._maxAlerts = 10;
        this._loading = true;
        this._error = null;
        this._showCreateModal = false;
        this._availableStrains = [];
        this._newAlert = {
            strainId: null,
            strainName: '',
            alertType: 'price_below',
            thresholdValue: ''
        };
    }

    async onMount() {
        await this._loadAlerts();

        // Open create modal
        this.on('click', '.cf-create-alert-btn', async () => {
            await this._loadStrains();
            this._showCreateModal = true;
            this.render();
        });

        // Close modal
        this.on('click', '.cf-modal-backdrop', (e) => {
            if (e.target.classList.contains('cf-modal-backdrop')) {
                this._showCreateModal = false;
                this._resetNewAlert();
                this.render();
            }
        });

        this.on('click', '.cf-modal-close', () => {
            this._showCreateModal = false;
            this._resetNewAlert();
            this.render();
        });

        // Select strain
        this.on('click', '.cf-alert-strain-option', (e) => {
            const option = e.target.closest('.cf-alert-strain-option');
            if (!option) return;
            this._newAlert.strainId = parseInt(option.dataset.strainId, 10);
            this._newAlert.strainName = option.dataset.strainName;
            this.render();
        });

        // Select alert type
        this.on('click', '.cf-alert-type-option', (e) => {
            const option = e.target.closest('.cf-alert-type-option');
            if (!option) return;
            this._newAlert.alertType = option.dataset.alertType;
            this.render();
        });

        // Threshold input
        this.on('input', '.cf-alert-threshold', (e) => {
            this._newAlert.thresholdValue = e.target.value;
        });

        // Create alert
        this.on('click', '.cf-submit-alert-btn', async () => {
            await this._createAlert();
        });

        // Toggle alert
        this.on('change', '.cf-alert-toggle', async (e) => {
            const alertId = parseInt(e.target.dataset.alertId, 10);
            await this._toggleAlert(alertId, e.target.checked);
        });

        // Delete alert
        this.on('click', '.cf-delete-alert', async (e) => {
            const btn = e.target.closest('.cf-delete-alert');
            if (!btn) return;
            const alertId = parseInt(btn.dataset.alertId, 10);
            await this._deleteAlert(alertId);
        });
    }

    _resetNewAlert() {
        this._newAlert = {
            strainId: null,
            strainName: '',
            alertType: 'price_below',
            thresholdValue: ''
        };
    }

    async _loadAlerts() {
        // Only show spinner on first load when we have no data
        const isFirstLoad = this._alerts.length === 0;

        if (isFirstLoad) {
            this._loading = true;
            this._error = null;
            this.render();
        }

        try {
            const response = await api.getMarketAlerts();
            if (response.success) {
                this._alerts = response.alerts || [];
                this._maxAlerts = response.maxAlerts || 10;
            } else {
                this._error = response.error;
            }
        } catch (err) {
            this._error = err.message;
        }

        this._loading = false;
        this.scheduleRender();
    }

    async _loadStrains() {
        try {
            const response = await api.getStrainCollection();
            if (response.success) {
                this._availableStrains = response.strains || [];
            }
        } catch (err) {
            console.error('[MarketAlerts] Failed to load strains:', err);
        }
    }

    async _createAlert() {
        if (!this._newAlert.strainId || !this._newAlert.thresholdValue) {
            this.emit('notification', { type: 'error', message: 'Please select a strain and enter a threshold' });
            return;
        }

        try {
            const response = await api.createMarketAlert(
                this._newAlert.strainId,
                this._newAlert.alertType,
                parseFloat(this._newAlert.thresholdValue)
            );

            if (response.success) {
                this.emit('notification', { type: 'success', message: response.message });
                this._showCreateModal = false;
                this._resetNewAlert();
                await this._loadAlerts();
            } else {
                this.emit('notification', { type: 'error', message: response.error });
            }
        } catch (err) {
            this.emit('notification', { type: 'error', message: err.message });
        }
    }

    async _toggleAlert(alertId, isActive) {
        try {
            const response = await api.updateMarketAlert(alertId, { isActive });
            if (!response.success) {
                this.emit('notification', { type: 'error', message: response.error });
                await this._loadAlerts();
            }
        } catch (err) {
            this.emit('notification', { type: 'error', message: err.message });
            await this._loadAlerts();
        }
    }

    async _deleteAlert(alertId) {
        try {
            const response = await api.deleteMarketAlert(alertId);
            if (response.success) {
                this.emit('notification', { type: 'success', message: 'Alert deleted' });
                await this._loadAlerts();
            } else {
                this.emit('notification', { type: 'error', message: response.error });
            }
        } catch (err) {
            this.emit('notification', { type: 'error', message: err.message });
        }
    }

    render() {
        this.className = 'cf-market-alerts';

        if (this._loading) {
            this.setContent(h('div', { class: 'cf-loading' }, h('div', { class: 'cf-spinner' })));
            return;
        }

        if (this._error) {
            this.setContent(
                h('div', { class: 'cf-error-message' },
                    h('p', {}, this._error),
                    h('button', { class: 'cf-btn cf-btn--primary', onclick: () => this._loadAlerts() }, 'Retry')
                )
            );
            return;
        }

        const content = [];

        // Header
        content.push(
            h('div', {
                style: {
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    marginBottom: 'var(--space-4)'
                }
            },
                h('h2', { class: 'cf-section__title' }, 'Market Alerts'),
                h('span', { class: 'text-sm text-muted' }, `${this._alerts.length}/${this._maxAlerts}`)
            )
        );

        // Alert list
        if (this._alerts.length === 0) {
            content.push(
                h('div', { class: 'cf-empty' },
                    h('p', { class: 'cf-empty__title' }, 'No alerts set'),
                    h('p', { class: 'cf-empty__description' },
                        'Create price alerts to get notified when strain prices change!'
                    )
                )
            );
        } else {
            content.push(
                h('div', { class: 'cf-alerts-list' },
                    ...this._alerts.map(alert => this._renderAlert(alert))
                )
            );
        }

        // Create button
        if (this._alerts.length < this._maxAlerts) {
            content.push(
                h('button', {
                    class: 'cf-btn cf-btn--primary cf-create-alert-btn',
                    style: { width: '100%', marginTop: 'var(--space-3)' }
                }, '+ Create Alert')
            );
        }

        // Create modal
        if (this._showCreateModal) {
            content.push(this._renderCreateModal());
        }

        this.setContent(...content);
    }

    _renderAlert(alert) {
        const typeInfo = ALERT_TYPES[alert.alertType] || {};
        const rarityInfo = formatRarity(alert.strainRarity || 'common');

        return h('div', {
            class: 'cf-card cf-alert-item',
            style: { marginBottom: 'var(--space-2)', opacity: alert.isActive ? 1 : 0.6 }
        },
            h('div', {
                class: 'cf-card__body',
                style: { display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }
            },
                // Type indicator
                h('div', {
                    style: {
                        width: '36px',
                        height: '36px',
                        background: alert.alertType === 'price_below' ? 'var(--color-success)' :
                            alert.alertType === 'price_above' ? 'var(--color-warning)' : 'var(--color-info)',
                        borderRadius: 'var(--radius-md)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: '18px',
                        color: 'white'
                    }
                }, typeInfo.icon || '?'),

                // Info
                h('div', { style: { flex: 1 } },
                    h('div', { class: 'font-semibold' }, alert.strainName),
                    h('div', { class: 'text-xs text-muted' },
                        `${typeInfo.label}: ${alert.alertType === 'price_change_percent'
                            ? `${alert.thresholdValue}%`
                            : formatCurrency(alert.thresholdValue)}`
                    ),
                    alert.triggerCount > 0 && h('div', { class: 'text-xs text-muted' },
                        `Triggered ${alert.triggerCount} time${alert.triggerCount > 1 ? 's' : ''}`
                    )
                ),

                // Toggle
                h('label', { class: 'cf-switch' },
                    h('input', {
                        type: 'checkbox',
                        class: 'cf-alert-toggle',
                        dataset: { alertId: alert.id.toString() },
                        checked: alert.isActive
                    }),
                    h('span', { class: 'cf-switch__slider' })
                ),

                // Delete
                h('button', {
                    class: 'cf-btn cf-btn--ghost cf-btn--sm cf-delete-alert',
                    dataset: { alertId: alert.id.toString() },
                    style: { color: 'var(--color-danger)' }
                }, '×')
            )
        );
    }

    _renderCreateModal() {
        return h('div', {
            class: 'cf-modal-backdrop',
            style: {
                position: 'fixed',
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                background: 'rgba(0,0,0,0.7)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                zIndex: 1000
            }
        },
            h('div', {
                style: {
                    background: 'var(--bg-primary)',
                    borderRadius: 'var(--radius-lg)',
                    maxWidth: '400px',
                    width: '90%',
                    maxHeight: '80vh',
                    overflow: 'hidden',
                    display: 'flex',
                    flexDirection: 'column'
                }
            },
                // Header
                h('div', {
                    style: {
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        padding: 'var(--space-4)',
                        borderBottom: '1px solid var(--border-primary)'
                    }
                },
                    h('h3', { class: 'font-semibold' }, 'Create Alert'),
                    h('button', { class: 'cf-modal-close cf-btn cf-btn--ghost' }, '×')
                ),

                // Body
                h('div', { style: { padding: 'var(--space-4)', overflowY: 'auto', flex: 1 } },
                    // Step 1: Select strain
                    h('div', { class: 'mb-4' },
                        h('div', { class: 'text-sm font-semibold mb-2' }, '1. Select Strain'),
                        this._newAlert.strainId
                            ? h('div', {
                                class: 'cf-card',
                                style: { padding: 'var(--space-2)', background: 'var(--bg-tertiary)' }
                            },
                                h('span', {}, this._newAlert.strainName),
                                h('button', {
                                    class: 'cf-btn cf-btn--ghost cf-btn--xs',
                                    style: { marginLeft: 'var(--space-2)' },
                                    onclick: () => { this._newAlert.strainId = null; this._newAlert.strainName = ''; this.render(); }
                                }, 'Change')
                            )
                            : h('div', {
                                style: { maxHeight: '150px', overflowY: 'auto' }
                            },
                                ...this._availableStrains.slice(0, 20).map(strain =>
                                    h('div', {
                                        class: 'cf-alert-strain-option cf-card',
                                        dataset: { strainId: strain.id.toString(), strainName: strain.name },
                                        style: { marginBottom: 'var(--space-1)', cursor: 'pointer', padding: 'var(--space-2)' }
                                    }, strain.name)
                                )
                            )
                    ),

                    // Step 2: Select type
                    this._newAlert.strainId && h('div', { class: 'mb-4' },
                        h('div', { class: 'text-sm font-semibold mb-2' }, '2. Alert Type'),
                        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' } },
                            ...Object.entries(ALERT_TYPES).map(([type, info]) =>
                                h('div', {
                                    class: `cf-alert-type-option cf-card ${this._newAlert.alertType === type ? 'cf-card--selected' : ''}`,
                                    dataset: { alertType: type },
                                    style: {
                                        padding: 'var(--space-2)',
                                        cursor: 'pointer',
                                        border: this._newAlert.alertType === type ? '2px solid var(--color-primary)' : '1px solid var(--border-primary)'
                                    }
                                },
                                    h('div', { class: 'font-medium' }, `${info.icon} ${info.label}`),
                                    h('div', { class: 'text-xs text-muted' }, info.description)
                                )
                            )
                        )
                    ),

                    // Step 3: Set threshold
                    this._newAlert.strainId && h('div', { class: 'mb-4' },
                        h('div', { class: 'text-sm font-semibold mb-2' }, '3. Threshold Value'),
                        h('input', {
                            type: 'number',
                            class: 'cf-input cf-alert-threshold',
                            placeholder: this._newAlert.alertType === 'price_change_percent' ? 'e.g., 10 for 10%' : 'e.g., 500',
                            value: this._newAlert.thresholdValue,
                            style: { width: '100%' }
                        }),
                        h('div', { class: 'text-xs text-muted mt-1' },
                            this._newAlert.alertType === 'price_change_percent'
                                ? 'Enter percentage (e.g., 10 for 10% change)'
                                : 'Enter price value'
                        )
                    )
                ),

                // Footer
                h('div', {
                    style: {
                        padding: 'var(--space-4)',
                        borderTop: '1px solid var(--border-primary)'
                    }
                },
                    h('button', {
                        class: 'cf-btn cf-btn--primary cf-submit-alert-btn',
                        style: { width: '100%' },
                        disabled: !this._newAlert.strainId || !this._newAlert.thresholdValue
                    }, 'Create Alert')
                )
            )
        );
    }
}

registerComponent('cf-market-alerts', CFMarketAlerts);
export default CFMarketAlerts;
