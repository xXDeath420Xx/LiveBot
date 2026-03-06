/**
 * Extraction Lab Component
 * Convert raw cannabis into concentrated products
 */

import { CFBaseComponent, registerComponent } from './base-component.js';
import { h } from '../utils/dom.js';
import { api } from '../api/client.js';
import { formatCurrency, formatTimeRemaining } from '../utils/format.js';

const PRODUCT_TYPES = {
    oil: { label: 'Oil', color: '#22c55e', icon: '💧' },
    wax: { label: 'Wax', color: '#f59e0b', icon: '🟡' },
    shatter: { label: 'Shatter', color: '#3b82f6', icon: '💎' },
    edible: { label: 'Edible', color: '#ec4899', icon: '🍬' },
    tincture: { label: 'Tincture', color: '#8b5cf6', icon: '🧪' }
};

class CFExtraction extends CFBaseComponent {
    constructor() {
        super();
        this._recipes = [];
        this._slots = [];
        this._products = [];
        this._loading = true;
        this._error = null;
        this._activeTab = 'lab';
        this._showStartModal = false;
        this._selectedSlot = null;
        this._selectedRecipe = null;
        this._inventory = [];
    }

    async onMount() {
        await this._loadLab();

        // Tab switching
        this.on('click', '.cf-tab-btn', (e) => {
            const tab = e.target.closest('.cf-tab-btn');
            if (!tab) return;
            this._activeTab = tab.dataset.tab;
            this.render();
        });

        // Start extraction
        this.on('click', '.cf-start-extraction', async (e) => {
            const btn = e.target.closest('.cf-start-extraction');
            if (!btn) return;
            const slotId = parseInt(btn.dataset.slotId, 10);
            this._selectedSlot = this._slots.find(s => s.id === slotId);
            this._showStartModal = true;
            await this._loadInventory();
            this.render();
        });

        // Select recipe
        this.on('click', '.cf-recipe-option', (e) => {
            const option = e.target.closest('.cf-recipe-option');
            if (!option) return;
            const recipeId = parseInt(option.dataset.recipeId, 10);
            this._selectedRecipe = this._recipes.find(r => r.id === recipeId);
            this.render();
        });

        // Select inventory item
        this.on('click', '.cf-inv-option', async (e) => {
            const option = e.target.closest('.cf-inv-option');
            if (!option) return;
            const inventoryId = parseInt(option.dataset.inventoryId, 10);
            await this._startExtraction(inventoryId);
        });

        // Claim extraction
        this.on('click', '.cf-claim-extraction', async (e) => {
            const btn = e.target.closest('.cf-claim-extraction');
            if (!btn) return;
            const slotId = parseInt(btn.dataset.slotId, 10);
            await this._claimExtraction(slotId);
        });

        // Sell product
        this.on('click', '.cf-sell-product', async (e) => {
            const btn = e.target.closest('.cf-sell-product');
            if (!btn) return;
            const productId = parseInt(btn.dataset.productId, 10);
            await this._sellProduct(productId);
        });

        // Close modal
        this.on('click', '.cf-modal-close, .cf-modal-backdrop', (e) => {
            if (e.target.classList.contains('cf-modal-backdrop') || e.target.classList.contains('cf-modal-close')) {
                this._showStartModal = false;
                this._selectedSlot = null;
                this._selectedRecipe = null;
                this.render();
            }
        });

        // Auto-refresh for timers
        this._refreshInterval = setInterval(() => {
            if (this._slots.some(s => s.status === 'processing')) {
                this.render();
            }
        }, 1000);
    }

    onUnmount() {
        if (this._refreshInterval) {
            clearInterval(this._refreshInterval);
        }
    }

    async _loadLab() {
        // Only show spinner on first load when we have no data
        const isFirstLoad = this._slots.length === 0 && this._recipes.length === 0;

        if (isFirstLoad) {
            this._loading = true;
            this._error = null;
            this.render();
        }

        try {
            const response = await api.getExtractionLab();
            if (response.success) {
                this._recipes = response.recipes || [];
                this._slots = response.slots || [];
                this._products = response.products || [];
            } else if (isFirstLoad) {
                this._error = response.error;
            }
        } catch (err) {
            if (isFirstLoad) {
                this._error = err.message;
            }
        }

        this._loading = false;
        this.scheduleRender();
    }

    async _loadInventory() {
        try {
            const response = await api.getInventory();
            if (response.success) {
                this._inventory = response.items || [];
            }
        } catch (err) {
            console.error('[Extraction] Failed to load inventory:', err);
        }
    }

    async _startExtraction(inventoryId) {
        if (!this._selectedSlot || !this._selectedRecipe) return;

        try {
            const response = await api.startExtraction(
                this._selectedSlot.id,
                this._selectedRecipe.id,
                inventoryId
            );

            if (response.success) {
                this.emit('notification', { type: 'success', message: response.message });
                this._showStartModal = false;
                this._selectedSlot = null;
                this._selectedRecipe = null;
                await this._loadLab();
            } else {
                this.emit('notification', { type: 'error', message: response.error });
            }
        } catch (err) {
            this.emit('notification', { type: 'error', message: err.message });
        }
    }

    async _claimExtraction(slotId) {
        const slot = this._slots.find(s => s.id === slotId);
        if (!slot) return;

        // Store original state for rollback
        const oldSlots = [...this._slots];

        try {
            const response = await api.claimExtraction(slotId);
            if (response.success) {
                this.emit('notification', {
                    type: 'success',
                    message: response.message || 'Product claimed!'
                });

                // Refresh lab data
                const labData = await api.getExtractionLab();
                if (labData.success !== false) {
                    this._slots = labData.slots || [];
                    this._products = labData.products || [];
                    this.scheduleRender();
                }
            } else {
                this.emit('notification', { type: 'error', message: response.error || 'Claim failed' });
            }
        } catch (err) {
            this.emit('notification', { type: 'error', message: err.message });
        }
    }

    async _sellProduct(productId) {
        const product = this._products.find(p => p.id === productId);
        if (!product) return;

        const expectedEarnings = (product.baseValue || 0) * (product.quantity || 1);

        // Optimistic update - remove product
        const oldProducts = [...this._products];
        this._products = this._products.filter(p => p.id !== productId);
        this.scheduleRender();

        this.emit('notification', {
            type: 'success',
            message: `Sold for ${formatCurrency(expectedEarnings)}!`
        });

        try {
            const response = await api.sellProduct(productId, product.quantity);
            if (response.success) {
                // Update currency from server
                if (response.newBalance !== undefined) {
                    this.setState('player.currency', response.newBalance);
                }
            } else {
                // Rollback
                this._products = oldProducts;
                this.scheduleRender();
                this.emit('notification', { type: 'error', message: response.error });
            }
        } catch (err) {
            // Rollback
            this._products = oldProducts;
            this.scheduleRender();
            this.emit('notification', { type: 'error', message: err.message });
        }
    }

    render() {
        this.className = 'cf-extraction';

        if (this._loading) {
            this.setContent(h('div', { class: 'cf-loading' }, h('div', { class: 'cf-spinner' })));
            return;
        }

        if (this._error) {
            this.setContent(
                h('div', { class: 'cf-error-message' },
                    h('p', {}, this._error),
                    h('button', { class: 'cf-btn cf-btn--primary', onclick: () => this._loadLab() }, 'Retry')
                )
            );
            return;
        }

        const content = [];

        // Header
        content.push(h('h2', { class: 'cf-section__title mb-4' }, 'Extraction Lab'));

        // Tabs
        content.push(
            h('div', { class: 'cf-tabs mb-3' },
                h('button', {
                    class: `cf-tab cf-tab-btn ${this._activeTab === 'lab' ? 'cf-tab--active' : ''}`,
                    dataset: { tab: 'lab' }
                }, 'Lab'),
                h('button', {
                    class: `cf-tab cf-tab-btn ${this._activeTab === 'products' ? 'cf-tab--active' : ''}`,
                    dataset: { tab: 'products' }
                }, `Products (${this._products.length})`),
                h('button', {
                    class: `cf-tab cf-tab-btn ${this._activeTab === 'recipes' ? 'cf-tab--active' : ''}`,
                    dataset: { tab: 'recipes' }
                }, 'Recipes')
            )
        );

        // Content
        if (this._activeTab === 'lab') {
            content.push(this._renderSlots());
        } else if (this._activeTab === 'products') {
            content.push(this._renderProducts());
        } else {
            content.push(this._renderRecipes());
        }

        // Start modal
        if (this._showStartModal) {
            content.push(this._renderStartModal());
        }

        this.setContent(...content);
    }

    _renderSlots() {
        return h('div', { class: 'cf-slots' },
            ...this._slots.map(slot => this._renderSlot(slot))
        );
    }

    _renderSlot(slot) {
        const typeInfo = PRODUCT_TYPES[slot.productType] || { label: 'Unknown', color: '#666', icon: '?' };
        // Recalculate timeRemaining live (slot.timeRemaining was computed at load time)
        const liveRemaining = slot.completesAt
            ? Math.max(0, new Date(slot.completesAt).getTime() - Date.now())
            : slot.timeRemaining;
        const isReady = slot.status === 'processing' && liveRemaining <= 0;
        const timeLeft = liveRemaining > 0 ? formatTimeRemaining(liveRemaining) : 'Ready!';

        return h('div', { class: 'cf-card mb-3' },
            h('div', { class: 'cf-card__body' },
                h('div', { class: 'font-semibold mb-2' }, `Slot ${slot.slotNumber}`),

                slot.status === 'empty' && h('div', {},
                    h('p', { class: 'text-muted mb-3' }, 'Slot empty'),
                    h('button', {
                        class: 'cf-btn cf-btn--primary cf-start-extraction',
                        dataset: { slotId: slot.id.toString() }
                    }, 'Start Extraction')
                ),

                slot.status === 'processing' && h('div', {},
                    h('div', { style: { display: 'flex', alignItems: 'center', gap: 'var(--space-2)', marginBottom: 'var(--space-2)' } },
                        h('span', { style: { fontSize: '24px' } }, typeInfo.icon),
                        h('div', {},
                            h('div', { class: 'font-medium' }, slot.recipeName),
                            h('div', { class: 'text-xs text-muted' }, `${slot.strainName || 'Unknown'} Q${slot.inputQuality}`)
                        )
                    ),
                    h('div', { class: 'cf-progress mb-2' },
                        h('div', {
                            class: 'cf-progress__bar',
                            style: {
                                width: isReady ? '100%' : (() => {
                                    const now = Date.now();
                                    const completesAt = slot.completesAt ? new Date(slot.completesAt).getTime() : now;
                                    const startedAt = slot.startedAt ? new Date(slot.startedAt).getTime() : now;
                                    const totalTime = completesAt - startedAt;
                                    const remaining = Math.max(0, completesAt - now);
                                    return totalTime > 0 ? `${Math.min(100, ((totalTime - remaining) / totalTime) * 100)}%` : '0%';
                                })(),
                                background: isReady ? 'var(--color-success)' : 'var(--color-primary)'
                            }
                        })
                    ),
                    h('div', { class: 'text-sm', style: { color: isReady ? 'var(--color-success)' : 'var(--text-muted)' } },
                        timeLeft
                    ),
                    isReady && h('button', {
                        class: 'cf-btn cf-btn--success cf-btn--sm cf-claim-extraction mt-2',
                        dataset: { slotId: slot.id.toString() }
                    }, 'Claim!')
                )
            )
        );
    }

    _renderProducts() {
        if (this._products.length === 0) {
            return h('div', { class: 'cf-empty' },
                h('p', { class: 'cf-empty__title' }, 'No products'),
                h('p', { class: 'cf-empty__description' }, 'Start extracting to create products!')
            );
        }

        return h('div', { class: 'cf-products' },
            ...this._products.map(product => {
                const typeInfo = PRODUCT_TYPES[product.productType] || { label: 'Unknown', icon: '?' };
                return h('div', { class: 'cf-card mb-2' },
                    h('div', {
                        class: 'cf-card__body',
                        style: { display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }
                    },
                        h('span', { style: { fontSize: '24px' } }, typeInfo.icon),
                        h('div', { style: { flex: 1 } },
                            h('div', { class: 'font-medium' }, product.productName),
                            h('div', { class: 'text-xs text-muted' },
                                `Q${product.quality} | x${product.quantity} | ${formatCurrency(product.baseValue)} each`
                            )
                        ),
                        h('button', {
                            class: 'cf-btn cf-btn--success cf-btn--sm cf-sell-product',
                            dataset: { productId: product.id.toString() }
                        }, `Sell ${formatCurrency(product.baseValue * product.quantity)}`)
                    )
                );
            })
        );
    }

    _renderRecipes() {
        return h('div', { class: 'cf-recipes' },
            ...this._recipes.map(recipe => {
                const typeInfo = PRODUCT_TYPES[recipe.productType] || { label: 'Unknown', icon: '?' };
                return h('div', { class: 'cf-card mb-2' },
                    h('div', { class: 'cf-card__body' },
                        h('div', { style: { display: 'flex', alignItems: 'center', gap: 'var(--space-2)', marginBottom: 'var(--space-2)' } },
                            h('span', { style: { fontSize: '20px' } }, typeInfo.icon),
                            h('span', { class: 'font-semibold' }, recipe.name)
                        ),
                        h('p', { class: 'text-sm text-muted mb-2' }, recipe.description),
                        h('div', { class: 'text-xs' },
                            h('span', { class: 'text-muted' }, `Input: ${recipe.inputQuantity} units | `),
                            h('span', { class: 'text-muted' }, `Output: ${recipe.outputQuantity} | `),
                            h('span', { class: 'text-muted' }, `Time: ${recipe.processTimeMinutes}m | `),
                            h('span', { style: { color: 'var(--color-success)' } }, `${recipe.valueMultiplier}x value`)
                        )
                    )
                );
            })
        );
    }

    _renderStartModal() {
        const slot = this._selectedSlot;
        const recipe = this._selectedRecipe;

        // Filter inventory for items with enough quantity
        const validItems = recipe
            ? this._inventory.filter(i => i.quantity >= recipe.inputQuantity)
            : [];

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
                    maxWidth: '400px', width: '90%', maxHeight: '80vh', overflow: 'hidden',
                    display: 'flex', flexDirection: 'column'
                }
            },
                // Header
                h('div', {
                    style: {
                        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                        padding: 'var(--space-4)', borderBottom: '1px solid var(--border-primary)'
                    }
                },
                    h('span', { class: 'font-semibold' }, `Start Extraction - Slot ${slot?.slotNumber}`),
                    h('button', { class: 'cf-modal-close cf-btn cf-btn--ghost' }, '×')
                ),

                // Step 1: Select recipe
                !recipe && h('div', { style: { padding: 'var(--space-4)', overflowY: 'auto' } },
                    h('div', { class: 'text-sm font-semibold mb-3' }, '1. Select Recipe'),
                    ...this._recipes.map(r => {
                        const typeInfo = PRODUCT_TYPES[r.productType] || { icon: '?' };
                        return h('div', {
                            class: 'cf-recipe-option cf-card',
                            dataset: { recipeId: r.id.toString() },
                            style: { marginBottom: 'var(--space-2)', cursor: 'pointer' }
                        },
                            h('div', {
                                class: 'cf-card__body',
                                style: { display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }
                            },
                                h('span', {}, typeInfo.icon),
                                h('div', { style: { flex: 1 } },
                                    h('div', { class: 'font-medium' }, r.name),
                                    h('div', { class: 'text-xs text-muted' },
                                        `${r.inputQuantity} in → ${r.outputQuantity} out | ${r.processTimeMinutes}m`
                                    )
                                ),
                                h('span', { style: { color: 'var(--color-primary)' } }, '→')
                            )
                        );
                    })
                ),

                // Step 2: Select material
                recipe && h('div', { style: { padding: 'var(--space-4)', overflowY: 'auto' } },
                    h('div', { class: 'mb-3' },
                        h('div', { class: 'text-sm font-semibold' }, `Recipe: ${recipe.name}`),
                        h('div', { class: 'text-xs text-muted' }, `Need ${recipe.inputQuantity} units`)
                    ),
                    h('div', { class: 'text-sm font-semibold mb-2' }, '2. Select Material'),
                    validItems.length === 0
                        ? h('p', { class: 'text-muted' }, `No items with ${recipe.inputQuantity}+ quantity`)
                        : validItems.map(item =>
                            h('div', {
                                class: 'cf-inv-option cf-card',
                                dataset: { inventoryId: item.id.toString() },
                                style: { marginBottom: 'var(--space-2)', cursor: 'pointer' }
                            },
                                h('div', {
                                    class: 'cf-card__body',
                                    style: { display: 'flex', justifyContent: 'space-between' }
                                },
                                    h('div', {},
                                        h('div', { class: 'font-medium' }, item.strainName || 'Unknown'),
                                        h('div', { class: 'text-xs text-muted' }, `Q${item.quality} | x${item.quantity}`)
                                    ),
                                    h('span', { style: { color: 'var(--color-primary)' } }, 'Use →')
                                )
                            )
                        )
                )
            )
        );
    }
}

registerComponent('cf-extraction', CFExtraction);
export default CFExtraction;
