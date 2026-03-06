/**
 * CertiFried Extension - Inventory Component
 * Displays harvested strains and owned shop items (boosters, etc.)
 */

import { CFBaseComponent, registerComponent } from './base-component.js';
import { h } from '../utils/dom.js';
import { formatCurrency, formatQualityTier } from '../utils/format.js';
import { api } from '../api/client.js';

class CFInventory extends CFBaseComponent {
    constructor() {
        super();
        this._ownedItems = [];
        this._itemsLoading = false;
    }

    _setupSubscriptions() {
        // Throttle inventory updates to avoid excessive re-renders during batch sales
        this.subscribe('inventory', null, { throttle: 100 });
    }

    onMount() {
        // Sell button for harvested items (sells selected quantity)
        this.on('click', '.cf-inventory-item__sell', async (e) => {
            const item = e.target.closest('.cf-inventory-item');
            if (!item) return;
            const inventoryId = parseInt(item.dataset.inventoryId, 10);
            const qtyInput = item.querySelector('.cf-sell-qty-input');
            const quantity = qtyInput ? parseInt(qtyInput.value, 10) : 1;
            await this._quickSell(inventoryId, quantity);
        });

        // Sell All button
        this.on('click', '.cf-inventory-item__sell-all', async (e) => {
            const item = e.target.closest('.cf-inventory-item');
            if (!item) return;
            const inventoryId = parseInt(item.dataset.inventoryId, 10);
            const maxQty = parseInt(item.dataset.maxQty, 10) || 1;
            await this._quickSell(inventoryId, maxQty);
        });

        // Quantity decrease button
        this.on('click', '.cf-qty-minus', (e) => {
            const item = e.target.closest('.cf-inventory-item');
            if (!item) return;
            const input = item.querySelector('.cf-sell-qty-input');
            if (input) {
                const current = parseInt(input.value, 10) || 1;
                input.value = Math.max(1, current - 1);
            }
        });

        // Quantity increase button
        this.on('click', '.cf-qty-plus', (e) => {
            const item = e.target.closest('.cf-inventory-item');
            if (!item) return;
            const input = item.querySelector('.cf-sell-qty-input');
            const maxQty = parseInt(item.dataset.maxQty, 10) || 1;
            if (input) {
                const current = parseInt(input.value, 10) || 1;
                input.value = Math.min(maxQty, current + 1);
            }
        });

        // Validate quantity input on change
        this.on('change', '.cf-sell-qty-input', (e) => {
            const input = e.target;
            const item = input.closest('.cf-inventory-item');
            if (!item) return;
            const maxQty = parseInt(item.dataset.maxQty, 10) || 1;
            let value = parseInt(input.value, 10) || 1;
            value = Math.max(1, Math.min(maxQty, value));
            input.value = value;
        });

        // List on Market button
        this.on('click', '.cf-inventory-item__list', async (e) => {
            const item = e.target.closest('.cf-inventory-item');
            if (!item) return;
            const inventoryId = parseInt(item.dataset.inventoryId, 10);
            const qtyInput = item.querySelector('.cf-sell-qty-input');
            const quantity = qtyInput ? parseInt(qtyInput.value, 10) : 1;
            await this._listOnMarket(inventoryId, quantity);
        });

        // Use button for boosters/items
        this.on('click', '.cf-item__use-btn', async (e) => {
            const btn = e.target.closest('.cf-item__use-btn');
            if (!btn || btn.disabled) return;
            const itemId = parseInt(btn.dataset.itemId, 10);
            await this._useItem(itemId);
        });

        // Load owned items
        this._loadOwnedItems();
    }

    async _loadOwnedItems() {
        // Only show spinner on first load when we have no data
        const isFirstLoad = this._ownedItems.length === 0;

        if (isFirstLoad) {
            this._itemsLoading = true;
            this.scheduleRender();
        }

        try {
            const data = await api.getOwnedItems();
            this._ownedItems = data.items || [];

        } catch (error) {
            console.error('Failed to load owned items:', error);
            this._ownedItems = [];
        } finally {
            this._itemsLoading = false;
            this.scheduleRender();
        }
    }

    async _useItem(itemId) {
        try {
            const result = await api.useBooster(itemId);

            this.emit('notification', {
                type: 'success',
                message: result.message || 'Item activated!'
            });

            // Reload owned items to reflect changes
            await this._loadOwnedItems();

        } catch (error) {
            this.emit('notification', {
                type: 'error',
                message: error.message || 'Failed to use item'
            });
        }
    }

    render() {
        const items = this.getState('inventory.items') || [];
        const isLoading = this.getState('inventory.isLoading');

        // Group by strain, then quality
        const grouped = this._groupItems(items);

        // Filter owned items - boosters that can be used
        const usableItems = this._ownedItems.filter(i =>
            i.type === 'booster' &&
            (i.usesRemaining === null || i.usesRemaining > 0) &&
            (!i.expiresAt || new Date(i.expiresAt) > new Date())
        );

        this.className = 'cf-section';
        this.setContent(
            h('div', { class: 'cf-section__header' },
                h('h2', { class: 'cf-section__title' }, 'Inventory'),
                h('span', { class: 'text-xs text-muted' },
                    `${items.reduce((sum, i) => sum + i.quantity, 0)} harvested`
                )
            ),

            isLoading && h('div', { class: 'cf-loading' },
                h('div', { class: 'cf-spinner' })
            ),

            // Owned Items / Boosters section
            usableItems.length > 0 && h('div', { class: 'cf-inventory__items-section mb-4' },
                h('h3', { class: 'text-sm font-semibold text-muted mb-2' }, 'Boosters & Items'),
                h('div', { class: 'cf-items-grid' },
                    ...usableItems.map(item => this._renderOwnedItem(item))
                )
            ),

            // Harvested strains section
            !isLoading && items.length > 0 && h('div', { class: 'cf-inventory__harvest-section' },
                h('h3', { class: 'text-sm font-semibold text-muted mb-2' }, 'Harvested'),
                h('div', { class: 'cf-inventory-list' },
                    ...grouped.map(item => this._renderItem(item))
                )
            ),

            !isLoading && items.length === 0 && usableItems.length === 0 && h('div', { class: 'cf-empty' },
                this._renderEmptyIcon(),
                h('p', { class: 'cf-empty__title' }, 'No items yet'),
                h('p', { class: 'cf-empty__description' }, 'Harvest plants or buy boosters from the shop')
            )
        );
    }

    _renderOwnedItem(item) {
        // Active if: (1) time-based booster with valid expiresAt, OR (2) uses-based booster that's activated
        const isTimeActive = item.expiresAt && new Date(item.expiresAt) > new Date();
        const isUsesActive = item.activated && item.usesRemaining !== null && item.usesRemaining > 0;
        const isActive = isTimeActive || isUsesActive;
        const itemName = this._getItemName(item.itemId);
        const effectDesc = this._getEffectDescription(item);

        return h('div', { class: `cf-owned-item ${isActive ? 'cf-owned-item--active' : ''}` },
            h('div', { class: 'cf-owned-item__icon' }, this._renderBoosterIcon(item.effect)),
            h('div', { class: 'cf-owned-item__info' },
                h('div', { class: 'cf-owned-item__name' }, itemName),
                h('div', { class: 'cf-owned-item__effect text-xs text-muted' }, effectDesc),
                item.usesRemaining !== null && h('div', { class: 'cf-owned-item__uses text-xs' },
                    `${item.usesRemaining} uses left`
                ),
                isActive && h('div', { class: 'cf-owned-item__status cf-badge cf-badge--success' }, 'Active')
            ),
            !isActive && h('button', {
                class: 'cf-item__use-btn cf-btn cf-btn--primary cf-btn--sm',
                dataset: { itemId: item.id.toString() }
            }, 'Use')
        );
    }

    _getItemName(itemId) {
        const names = {
            'boost_speed_1': 'Quick Grow Tonic',
            'boost_speed_2': 'Rapid Growth Elixir',
            'boost_yield_1': 'Harvest Boost',
            'boost_yield_2': 'Mega Harvest',
            'boost_xp_1': 'Experience Tea',
            'boost_quality_1': 'Quality Nutrients'
        };
        return names[itemId] || itemId;
    }

    _getEffectDescription(item) {
        const mult = parseFloat(item.multiplier) || 1;
        const bonus = item.bonus || 0;

        switch (item.effect) {
            case 'speed': return `+${Math.round((mult - 1) * 100)}% growth speed`;
            case 'yield': return `+${Math.round((mult - 1) * 100)}% harvest yield`;
            case 'xp': return `+${Math.round((mult - 1) * 100)}% XP gain`;
            case 'quality': return `+${bonus}% quality`;
            default: return item.effect || 'Effect';
        }
    }

    _renderBoosterIcon(effect) {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('width', '24');
        svg.setAttribute('height', '24');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'var(--color-accent-500)');
        svg.setAttribute('stroke-width', '2');

        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');

        // Different icons based on effect type
        switch (effect) {
            case 'speed':
                path.setAttribute('d', 'M13 2L3 14h9l-1 8 10-12h-9l1-8z'); // Lightning bolt
                break;
            case 'yield':
                path.setAttribute('d', 'M12 2v6m0 0l3-3m-3 3l-3-3M5 12h14m-7 10v-6m0 0l-3 3m3-3l3 3'); // Expand
                break;
            case 'xp':
                path.setAttribute('d', 'M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z'); // Star
                break;
            case 'quality':
                path.setAttribute('d', 'M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2zm0 18a8 8 0 1 1 8-8 8 8 0 0 1-8 8zm4-8a4 4 0 1 1-4-4 4 4 0 0 1 4 4z'); // Target
                break;
            default:
                path.setAttribute('d', 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z'); // Shield
        }

        svg.appendChild(path);
        return svg;
    }

    _groupItems(items) {
        // Items already grouped by strainId + quality from API
        return items.sort((a, b) => {
            // Sort by name, then quality descending (use camelCase from backend)
            const nameA = a.strainName || a.strain_name || '';
            const nameB = b.strainName || b.strain_name || '';
            if (nameA !== nameB) {
                return nameA.localeCompare(nameB);
            }
            return (b.quality || 0) - (a.quality || 0);
        });
    }

    _renderItem(item) {
        const qualityInfo = formatQualityTier(item.quality || 50);
        // Support both camelCase (from API) and snake_case (fallback)
        const strainId = item.strainId || item.strain_id;
        const strainName = item.strainName || item.strain_name || 'Unknown';
        const quantity = item.quantity || 1;

        return h('div', {
            class: 'cf-inventory-item cf-strain-card',
            dataset: {
                inventoryId: item.id?.toString() || '0',
                strainId: strainId?.toString() || '0',
                quality: (item.quality || 50).toString(),
                maxQty: quantity.toString()
            }
        },
            // Plant icon
            h('div', { class: 'cf-strain-card__icon' },
                this._renderPlantIcon()
            ),

            // Info
            h('div', { class: 'cf-strain-card__info' },
                h('div', { class: 'cf-strain-card__name' }, strainName),
                h('div', { class: 'cf-strain-card__stats' },
                    h('span', {
                        class: 'cf-badge',
                        style: { background: qualityInfo.color, fontSize: '10px', padding: '2px 6px' }
                    }, `${item.quality}% ${qualityInfo.name}`),
                    h('span', {}, `x${quantity}`)
                )
            ),

            // Actions with quantity selector
            h('div', { class: 'cf-strain-card__actions cf-sell-controls' },
                // Quantity input
                h('div', { class: 'cf-sell-qty-wrap' },
                    h('button', {
                        class: 'cf-qty-btn cf-qty-minus',
                        dataset: { action: 'decrease' }
                    }, '−'),
                    h('input', {
                        type: 'number',
                        class: 'cf-sell-qty-input',
                        value: '1',
                        min: '1',
                        max: quantity.toString(),
                        dataset: { inventoryId: item.id?.toString() || '0' }
                    }),
                    h('button', {
                        class: 'cf-qty-btn cf-qty-plus',
                        dataset: { action: 'increase' }
                    }, '+')
                ),
                // Sell buttons
                h('div', { class: 'cf-sell-btns' },
                    h('button', {
                        class: 'cf-inventory-item__sell cf-btn cf-btn--secondary cf-btn--sm',
                        dataset: { sellType: 'qty' }
                    }, 'Sell'),
                    quantity > 1 && h('button', {
                        class: 'cf-inventory-item__sell-all cf-btn cf-btn--primary cf-btn--sm',
                        dataset: { sellType: 'all' }
                    }, 'All'),
                    h('button', {
                        class: 'cf-inventory-item__list cf-btn cf-btn--sm',
                        style: { background: 'var(--color-epic)', color: '#fff' }
                    }, 'Market')
                )
            )
        );
    }

    _renderEmptyIcon() {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('class', 'cf-empty__icon');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'currentColor');
        svg.setAttribute('stroke-width', '1.5');

        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', 'M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4');
        svg.appendChild(path);

        return svg;
    }

    _renderPlantIcon() {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 48 48');
        svg.setAttribute('width', '48');
        svg.setAttribute('height', '48');

        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', 'M24 6 C24 6 12 18 12 30 C12 42 24 42 24 42 C24 42 36 42 36 30 C36 18 24 6 24 6Z');
        path.setAttribute('fill', 'var(--color-primary-500)');
        svg.appendChild(path);

        return svg;
    }

    async _listOnMarket(inventoryId, quantity = 1) {
        const items = this.getState('inventory.items') || [];
        const item = items.find(i => i.id === inventoryId);
        if (!item) return;

        const sellQty = Math.min(quantity, item.quantity);
        if (sellQty <= 0) return;

        const strainName = item.strainName || item.strain_name || 'item';

        // Get market price for this strain to suggest a price
        let suggestedPrice = Math.round((item.quality || 50) * 2);
        try {
            const prices = await api.getMarketPrices();
            const strainPrice = (prices.prices || []).find(p =>
                (p.strainId || p.strain_id) === (item.strainId || item.strain_id)
            );
            if (strainPrice) {
                suggestedPrice = Math.round(parseFloat(strainPrice.currentPrice || strainPrice.current_price || suggestedPrice));
            }
        } catch (e) {}

        // Show inline price input modal (prompt() doesn't work in iframes)
        const pricePerUnit = await this._showPriceModal(strainName, sellQty, item.quality, suggestedPrice);
        if (!pricePerUnit) return;

        try {
            const result = await api.createListing(inventoryId, sellQty, pricePerUnit);
            if (result.success || result.listing) {
                // Remove from local inventory
                const updatedItems = items.map(i => {
                    if (i.id === inventoryId) return { ...i, quantity: i.quantity - sellQty };
                    return i;
                }).filter(i => i.quantity > 0);
                this.setState('inventory.items', updatedItems);

                this.emit('notification', {
                    type: 'success',
                    message: `Listed ${sellQty}x ${strainName} at ${formatCurrency(pricePerUnit)}/ea on the market!`
                });
            } else {
                throw new Error(result.error || 'Listing failed');
            }
        } catch (err) {
            this.emit('notification', { type: 'error', message: err.message || 'Failed to list on market' });
        }
    }

    _showPriceModal(strainName, qty, quality, suggestedPrice) {
        return new Promise((resolve) => {
            const overlay = h('div', {
                style: {
                    position: 'fixed', inset: '0', background: 'rgba(0,0,0,0.7)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: '9999'
                }
            },
                h('div', {
                    style: {
                        background: 'var(--bg-primary, #1a1a2e)', borderRadius: 'var(--radius-lg, 8px)',
                        padding: 'var(--space-4, 16px)', width: '280px', maxWidth: '90vw'
                    }
                },
                    h('h3', { style: { marginBottom: '8px', fontSize: '1rem' } }, 'List on Market'),
                    h('p', { style: { fontSize: '0.85rem', color: 'var(--text-muted, #999)', marginBottom: '12px' } },
                        `${qty}x ${strainName} (${quality}% quality)`
                    ),
                    h('label', { style: { fontSize: '0.8rem', display: 'block', marginBottom: '4px' } }, 'Price per unit ($)'),
                    h('input', {
                        type: 'number', min: '1', value: suggestedPrice.toString(),
                        class: 'cf-market-price-input',
                        style: {
                            width: '100%', padding: '8px', fontSize: '1rem',
                            background: 'var(--bg-secondary, #222)', color: 'var(--text-primary, #fff)',
                            border: '1px solid var(--border-color, #444)', borderRadius: '4px',
                            marginBottom: '12px'
                        }
                    }),
                    h('div', { style: { display: 'flex', gap: '8px' } },
                        h('button', {
                            class: 'cf-btn cf-btn--sm cf-market-modal-cancel',
                            style: { flex: '1' }
                        }, 'Cancel'),
                        h('button', {
                            class: 'cf-btn cf-btn--sm cf-btn--primary cf-market-modal-confirm',
                            style: { flex: '1' }
                        }, 'List')
                    )
                )
            );

            const cleanup = () => { if (overlay.parentNode) overlay.remove(); };
            const input = overlay.querySelector('.cf-market-price-input');

            overlay.querySelector('.cf-market-modal-cancel').addEventListener('click', () => { cleanup(); resolve(null); });
            overlay.querySelector('.cf-market-modal-confirm').addEventListener('click', () => {
                const val = parseInt(input.value, 10);
                cleanup();
                if (isNaN(val) || val < 1) {
                    this.emit('notification', { type: 'error', message: 'Invalid price' });
                    resolve(null);
                } else {
                    resolve(val);
                }
            });
            overlay.addEventListener('click', (e) => { if (e.target === overlay) { cleanup(); resolve(null); } });

            document.body.appendChild(overlay);
            input.focus();
            input.select();
        });
    }

    async _quickSell(inventoryId, quantity = 1) {
        const items = this.getState('inventory.items') || [];
        const item = items.find(i => i.id === inventoryId);

        if (!item) return;

        // Clamp quantity to available stock
        const sellQty = Math.min(quantity, item.quantity);
        if (sellQty <= 0) return;

        const strainName = item.strainName || item.strain_name || 'item';

        // Calculate optimistic inventory update
        const optimisticItems = items.map(i => {
            if (i.id === inventoryId) {
                return { ...i, quantity: i.quantity - sellQty };
            }
            return i;
        }).filter(i => i.quantity > 0);

        await this.optimistic({
            // Immediately update inventory
            optimisticUpdate: () => {
                this.setState('inventory.items', optimisticItems);
            },
            rollbackPaths: { 'inventory.items': items },
            apiCall: () => api.quickSell(inventoryId, sellQty),
            onSuccess: (result) => {
                // Update currency
                const newCash = result.newCash || result.new_balance;
                if (newCash !== undefined) {
                    this.setState('player.currency', newCash);
                }

                const earnings = result.totalPrice || result.cashAwarded || result.amount_earned || 0;
                this.emit('notification', {
                    type: 'success',
                    message: `Sold ${sellQty}x ${strainName} for ${formatCurrency(earnings)}!`
                });
            }
        }).catch(() => {}); // Error already handled
    }
}

registerComponent('cf-inventory', CFInventory);
export default CFInventory;
