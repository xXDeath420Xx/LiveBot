/**
 * Vault Component
 * Manage secure storage for cash and items
 */

import { CFBaseComponent } from './base-component.js';
import { h } from '../utils/dom.js';
import { api } from '../api/client.js';

class CFVault extends CFBaseComponent {
    constructor() {
        super();
        this.attachShadow({ mode: 'open' });
        this._vault = null;
        this._raidStatus = null;
        this._loading = true;
        this._error = null;
        this._depositAmount = '';
        this._withdrawAmount = '';
        this._playerInventory = [];
        this._showInventoryPanel = false;
    }

    _setupSubscriptions() {
        // Subscribe to raid status changes
        this.subscribe('game.raidStatus', (value) => {
            this._raidStatus = value;
            this.scheduleRender();
        });
    }

    async onMount() {
        // Get initial raid status from store
        this._raidStatus = this.getState('game.raidStatus');
        await this._loadVault();
    }

    async _loadVault() {
        // Only show spinner on first load when we have no data
        const isFirstLoad = !this._vault;

        if (isFirstLoad) {
            this._loading = true;
            this._error = null;
            this.render();
        }

        try {
            const response = await api.getVault();
            if (response.success) {
                this._vault = response.vault;
            } else {
                this._error = response.error || 'Failed to load vault';
            }
        } catch (err) {
            this._error = err.message;
        }

        this._loading = false;
        this.render();
    }

    async _depositCash(amount) {
        const numAmount = parseFloat(amount);

        // Optimistic update
        const oldVaultCash = this._vault.cash;
        this._vault.cash += numAmount;
        this.render();

        try {
            const response = await api.depositToVault(numAmount);
            if (response.success) {
                this.emit('notification', { type: 'success', message: `Deposited $${numAmount.toLocaleString()}` });
                // Update both cash and currency to keep state consistent across components
                this.setState('player.cash', response.newPlayerCash);
                this.setState('player.currency', response.newPlayerCash);
                // Background refresh for accurate state
                this._loadVault();
            } else {
                // Rollback on failure
                this._vault.cash = oldVaultCash;
                this.render();
                this.emit('notification', { type: 'error', message: response.error });
            }
        } catch (err) {
            // Rollback on error
            this._vault.cash = oldVaultCash;
            this.render();
            this.emit('notification', { type: 'error', message: err.message });
        }
    }

    async _withdrawCash(amount) {
        const numAmount = parseFloat(amount);

        // Optimistic update
        const oldVaultCash = this._vault.cash;
        this._vault.cash -= numAmount;
        this.render();

        try {
            const response = await api.withdrawFromVault(numAmount);
            if (response.success) {
                this.emit('notification', { type: 'success', message: `Withdrew $${numAmount.toLocaleString()}` });
                // Update both cash and currency to keep state consistent across components
                this.setState('player.cash', response.newPlayerCash);
                this.setState('player.currency', response.newPlayerCash);
                // Background refresh for accurate state
                this._loadVault();
            } else {
                // Rollback on failure
                this._vault.cash = oldVaultCash;
                this.render();
                this.emit('notification', { type: 'error', message: response.error });
            }
        } catch (err) {
            // Rollback on error
            this._vault.cash = oldVaultCash;
            this.render();
            this.emit('notification', { type: 'error', message: err.message });
        }
    }

    async _upgradeVault() {
        try {
            const response = await api.upgradeVault();
            if (response.success) {
                this.emit('notification', {
                    type: 'success',
                    message: `Vault upgraded to Level ${response.newLevel}!`
                });
                await this._loadVault();
            } else {
                this.emit('notification', { type: 'error', message: response.error });
            }
        } catch (err) {
            this.emit('notification', { type: 'error', message: err.message });
        }
    }

    async _loadPlayerInventory() {
        try {
            const response = await api.getInventory();
            if (response.success) {
                this._playerInventory = response.items || [];
            }
        } catch (err) {
            console.error('[CFVault] Failed to load inventory:', err);
        }
        this.render();
    }

    async _depositItem(inventoryId, quantity = 1) {
        try {
            const response = await api.depositItemToVault(inventoryId, quantity);
            if (response.success) {
                this.emit('notification', { type: 'success', message: `Deposited ${response.deposited || quantity} items to vault` });
                await Promise.all([this._loadVault(), this._loadPlayerInventory()]);
            } else {
                this.emit('notification', { type: 'error', message: response.error });
            }
        } catch (err) {
            this.emit('notification', { type: 'error', message: err.message });
        }
    }

    async _depositAll() {
        let deposited = 0;
        for (const item of [...this._playerInventory]) {
            try {
                const response = await api.depositItemToVault(item.id, item.quantity);
                if (response.success) deposited += response.deposited || item.quantity;
            } catch (err) {
                break; // Vault likely full
            }
        }
        if (deposited > 0) {
            this.emit('notification', { type: 'success', message: `Deposited ${deposited} items to vault` });
        }
        await Promise.all([this._loadVault(), this._loadPlayerInventory()]);
    }

    async _withdrawItem(vaultItemId, quantity = 1) {
        try {
            const response = await api.withdrawItemFromVault(vaultItemId, quantity);
            if (response.success) {
                this.emit('notification', { type: 'success', message: 'Item moved to inventory' });
                await this._loadVault();
            } else {
                this.emit('notification', { type: 'error', message: response.error });
            }
        } catch (err) {
            this.emit('notification', { type: 'error', message: err.message });
        }
    }

    _toggleInventoryPanel() {
        this._showInventoryPanel = !this._showInventoryPanel;
        if (this._showInventoryPanel && this._playerInventory.length === 0) {
            this._loadPlayerInventory();
        } else {
            this.render();
        }
    }

    _createVaultIcon() {
        // Create SVG with proper namespace (h() doesn't work for SVG)
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'currentColor');
        svg.setAttribute('stroke-width', '2');
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('stroke-linecap', 'round');
        path.setAttribute('stroke-linejoin', 'round');
        path.setAttribute('d', 'M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z');
        svg.appendChild(path);
        return svg;
    }

    render() {
        console.log('[CFVault] Rendering:', { loading: this._loading, error: this._error, vault: !!this._vault });

        const style = h('style', {}, `
            :host {
                display: block;
                padding: 16px;
                color: #f9fafb;
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            }
            .vault-header {
                display: flex;
                align-items: center;
                gap: 12px;
                margin-bottom: 20px;
            }
            .vault-icon {
                width: 48px;
                height: 48px;
                background: linear-gradient(135deg, #4f46e5, #7c3aed);
                border-radius: 12px;
                display: flex;
                align-items: center;
                justify-content: center;
            }
            .vault-icon svg {
                width: 28px;
                height: 28px;
                color: white;
            }
            .vault-title {
                font-size: 20px;
                font-weight: 700;
            }
            .vault-subtitle {
                font-size: 12px;
                color: #9ca3af;
            }
            .section {
                background: rgba(255,255,255,0.05);
                border-radius: 12px;
                padding: 16px;
                margin-bottom: 16px;
            }
            .section-title {
                font-size: 14px;
                font-weight: 600;
                margin-bottom: 12px;
                color: #9ca3af;
            }
            .cash-display {
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 16px;
            }
            .cash-amount {
                font-size: 24px;
                font-weight: 700;
                color: #22c55e;
            }
            .cash-capacity {
                font-size: 12px;
                color: #6b7280;
            }
            .progress-bar {
                height: 8px;
                background: rgba(255,255,255,0.1);
                border-radius: 4px;
                overflow: hidden;
                margin-bottom: 16px;
            }
            .progress-fill {
                height: 100%;
                background: linear-gradient(90deg, #22c55e, #16a34a);
                transition: width 0.3s;
            }
            .input-group {
                display: flex;
                gap: 8px;
                margin-bottom: 8px;
            }
            .input-group input {
                flex: 1;
                padding: 10px 12px;
                background: rgba(0,0,0,0.3);
                border: 1px solid rgba(255,255,255,0.1);
                border-radius: 8px;
                color: white;
                font-size: 14px;
            }
            .input-group input:focus {
                outline: none;
                border-color: #4f46e5;
            }
            .btn {
                padding: 10px 16px;
                border-radius: 8px;
                font-size: 14px;
                font-weight: 600;
                cursor: pointer;
                border: none;
                transition: all 0.2s;
            }
            .btn-primary {
                background: linear-gradient(135deg, #4f46e5, #7c3aed);
                color: white;
            }
            .btn-primary:hover {
                transform: translateY(-1px);
                box-shadow: 0 4px 12px rgba(79, 70, 229, 0.4);
            }
            .btn-secondary {
                background: rgba(255,255,255,0.1);
                color: white;
            }
            .btn-secondary:hover {
                background: rgba(255,255,255,0.15);
            }
            .upgrade-card {
                background: linear-gradient(135deg, rgba(79, 70, 229, 0.2), rgba(124, 58, 237, 0.2));
                border: 1px solid rgba(79, 70, 229, 0.3);
                border-radius: 12px;
                padding: 16px;
                display: flex;
                justify-content: space-between;
                align-items: center;
            }
            .upgrade-info h4 {
                font-size: 14px;
                font-weight: 600;
                margin-bottom: 4px;
            }
            .upgrade-info p {
                font-size: 12px;
                color: #9ca3af;
            }
            .heat-status {
                display: flex;
                align-items: center;
                gap: 12px;
                padding: 12px;
                border-radius: 8px;
                margin-bottom: 12px;
            }
            .heat-cold { background: rgba(34, 197, 94, 0.1); border: 1px solid rgba(34, 197, 94, 0.3); }
            .heat-warm { background: rgba(234, 179, 8, 0.1); border: 1px solid rgba(234, 179, 8, 0.3); }
            .heat-hot { background: rgba(249, 115, 22, 0.1); border: 1px solid rgba(249, 115, 22, 0.3); }
            .heat-scorching { background: rgba(239, 68, 68, 0.1); border: 1px solid rgba(239, 68, 68, 0.3); }
            .heat-inferno { background: rgba(220, 38, 38, 0.1); border: 1px solid rgba(220, 38, 38, 0.3); }
            .loading {
                text-align: center;
                padding: 40px;
                color: #9ca3af;
            }
            .error {
                color: #ef4444;
                padding: 12px;
                background: rgba(239, 68, 68, 0.1);
                border-radius: 8px;
                margin-bottom: 16px;
            }
        `);

        let content;

        if (this._loading) {
            content = h('div', { class: 'loading' }, 'Loading vault...');
        } else if (this._error) {
            content = h('div', { class: 'error' }, this._error);
        } else if (this._vault) {
            const v = this._vault;
            const cashPercent = v.maxCash > 0 ? (v.cash / v.maxCash) * 100 : 0;
            const heat = this._raidStatus?.heat;

            // Build content sections
            const sections = [];

            // Heat Status
            if (heat) {
                sections.push(h('div', { class: `heat-status heat-${heat.status}` },
                    h('span', {}, `Heat Level: ${heat.current}`),
                    h('span', {}, `Status: ${heat.status.toUpperCase()}`),
                    h('span', {}, `Raid Risk: ${Math.round((heat.actualChance || 0) * 100)}%`)
                ));
            }

            // Cash Section - build children array
            const cashChildren = [
                h('div', { class: 'section-title' }, 'Protected Cash'),
                h('div', { class: 'cash-display' },
                    h('span', { class: 'cash-amount' }, `$${v.cash.toLocaleString()}`),
                    h('span', { class: 'cash-capacity' }, `/ $${v.maxCash.toLocaleString()}`)
                ),
                h('div', { class: 'progress-bar' },
                    h('div', { class: 'progress-fill', style: `width: ${cashPercent}%` })
                )
            ];

            if (v.maxCash > 0) {
                cashChildren.push(
                    h('div', { class: 'input-group' },
                        h('input', {
                            type: 'number',
                            placeholder: 'Amount to deposit',
                            id: 'deposit-input'
                        }),
                        h('button', {
                            class: 'btn btn-primary',
                            onclick: () => {
                                const input = this.shadowRoot.getElementById('deposit-input');
                                if (input.value) this._depositCash(input.value);
                            }
                        }, 'Deposit')
                    ),
                    h('div', { class: 'input-group' },
                        h('input', {
                            type: 'number',
                            placeholder: 'Amount to withdraw',
                            id: 'withdraw-input'
                        }),
                        h('button', {
                            class: 'btn btn-secondary',
                            onclick: () => {
                                const input = this.shadowRoot.getElementById('withdraw-input');
                                if (input.value) this._withdrawCash(input.value);
                            }
                        }, 'Withdraw')
                    )
                );
            } else {
                cashChildren.push(h('p', { style: 'color: #9ca3af; font-size: 12px;' }, 'Purchase a vault to protect your cash'));
            }

            const cashSection = h('div', { class: 'section' }, ...cashChildren);
            sections.push(cashSection);

            // Inventory Section
            const invChildren = [
                h('div', { style: 'display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;' },
                    h('div', { class: 'section-title', style: 'margin-bottom: 0;' }, `Protected Items (${v.usedSlots}/${v.maxSlots} slots)`),
                    h('button', {
                        class: 'btn btn-secondary',
                        style: 'font-size: 12px; padding: 6px 12px;',
                        onclick: () => this._toggleInventoryPanel()
                    }, this._showInventoryPanel ? 'Hide Inventory' : 'Add Items')
                )
            ];
            if (v.inventory.length > 0) {
                v.inventory.forEach(item => {
                    invChildren.push(h('div', { style: 'display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid rgba(255,255,255,0.05);' },
                        h('span', {}, `${item.strainName} (Q${item.quality})`),
                        h('div', { style: 'display: flex; align-items: center; gap: 8px;' },
                            h('span', { style: 'color: #9ca3af;' }, `x${item.quantity}`),
                            h('button', {
                                class: 'btn btn-secondary',
                                style: 'font-size: 11px; padding: 4px 8px;',
                                onclick: () => this._withdrawItem(item.id, item.quantity)
                            }, `Take ${item.quantity > 1 ? 'x' + item.quantity : ''}`)
                        )
                    ));
                });
            } else {
                invChildren.push(h('p', { style: 'color: #6b7280; font-size: 12px;' }, 'No items in vault'));
            }

            // Add inventory panel if visible
            if (this._showInventoryPanel) {
                if (this._playerInventory.length > 0) {
                    invChildren.push(h('div', { style: 'margin-top: 12px; padding-top: 12px; border-top: 1px solid rgba(255,255,255,0.1);' },
                        h('div', { style: 'display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;' },
                            h('span', { style: 'font-size: 12px; color: #9ca3af;' }, 'Your Inventory:'),
                            h('button', {
                                class: 'btn btn-primary',
                                style: 'font-size: 11px; padding: 4px 12px;',
                                onclick: () => this._depositAll()
                            }, 'Store All')
                        ),
                        ...this._playerInventory.map(item =>
                            h('div', { style: 'display: flex; justify-content: space-between; align-items: center; padding: 6px 0;' },
                                h('span', { style: 'font-size: 13px;' }, `${item.strainName || item.strain_name} (Q${item.quality})`),
                                h('div', { style: 'display: flex; align-items: center; gap: 8px;' },
                                    h('span', { style: 'color: #9ca3af; font-size: 12px;' }, `x${item.quantity}`),
                                    h('button', {
                                        class: 'btn btn-primary',
                                        style: 'font-size: 11px; padding: 4px 8px;',
                                        onclick: () => this._depositItem(item.id, item.quantity)
                                    }, `Store ${item.quantity > 1 ? 'x' + item.quantity : ''}`)
                                )
                            )
                        )
                    ));
                } else {
                    invChildren.push(h('p', { style: 'color: #6b7280; font-size: 12px; margin-top: 12px;' }, 'No items in your inventory'));
                }
            }
            sections.push(h('div', { class: 'section' }, ...invChildren));

            // Upgrade Section
            if (v.nextUpgrade) {
                sections.push(h('div', { class: 'upgrade-card' },
                    h('div', { class: 'upgrade-info' },
                        h('h4', {}, `Upgrade to Level ${v.nextUpgrade.level}`),
                        h('p', {}, `$${v.nextUpgrade.cashCapacity.toLocaleString()} capacity, ${v.nextUpgrade.slotCapacity} slots`)
                    ),
                    h('button', {
                        class: 'btn btn-primary',
                        onclick: () => this._upgradeVault()
                    }, `$${v.nextUpgrade.cost.toLocaleString()}`)
                ));
            } else {
                sections.push(h('p', { style: 'text-align: center; color: #9ca3af;' }, 'Vault at maximum level'));
            }

            content = h('div', { class: 'vault-content' }, ...sections);
        }

        // Clear and render
        while (this.shadowRoot.firstChild) {
            this.shadowRoot.removeChild(this.shadowRoot.firstChild);
        }

        this.shadowRoot.appendChild(style);
        // Build vault icon container
        const iconContainer = h('div', { class: 'vault-icon' });
        iconContainer.appendChild(this._createVaultIcon());

        this.shadowRoot.appendChild(
            h('div', {},
                h('div', { class: 'vault-header' },
                    iconContainer,
                    h('div', {},
                        h('div', { class: 'vault-title' }, `Vault Level ${this._vault?.level || 0}`),
                        h('div', { class: 'vault-subtitle' }, 'Protected from DEA raids')
                    )
                ),
                content
            )
        );
    }
}

customElements.define('cf-vault', CFVault);
export default CFVault;
