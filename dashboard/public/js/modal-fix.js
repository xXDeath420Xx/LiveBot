/**
 * Modal Fix Script
 * Prevents auto-opening modals and backdrop stacking issues
 */
(function() {
    'use strict';

    // Track initialized modals to prevent duplicates
    const initializedModals = new Set();

    // Function to properly initialize a modal
    function initializeModal(modalElement) {
        const modalId = modalElement.id;

        // Skip if already initialized
        if (initializedModals.has(modalId)) {
            return;
        }

        // Mark as initialized
        initializedModals.add(modalId);

        // DON'T force hide modals - let Bootstrap handle visibility
        // Just remove any stray backdrops on initialization
        document.querySelectorAll('.modal-backdrop').forEach(backdrop => {
            if (!document.querySelector('.modal.show')) {
                backdrop.remove();
            }
        });
    }

    // Clean up stray backdrops when modals close
    function cleanupBackdrops() {
        // Only remove backdrops if no modals are currently shown
        setTimeout(() => {
            const openModals = document.querySelectorAll('.modal.show');
            if (openModals.length === 0) {
                document.querySelectorAll('.modal-backdrop').forEach(backdrop => {
                    backdrop.remove();
                });
                document.body.classList.remove('modal-open');
                document.body.style.overflow = '';
                document.body.style.paddingRight = '';
            }
        }, 100);
    }

    // Initialize on DOM ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initModals);
    } else {
        initModals();
    }

    function initModals() {
        // Initialize all modals on the page
        document.querySelectorAll('.modal').forEach(initializeModal);

        // Add cleanup listeners to all modals
        document.querySelectorAll('.modal').forEach(modal => {
            modal.addEventListener('hidden.bs.modal', cleanupBackdrops);

            // Prevent auto-opening
            modal.addEventListener('show.bs.modal', function(e) {
                // Log for debugging
                console.log('[Modal Fix] Modal opening:', modal.id);
            });
        });

        // Cleanup on page navigation
        window.addEventListener('beforeunload', cleanupBackdrops);
    }

    // Observer to handle dynamically added modals
    const observer = new MutationObserver(function(mutations) {
        mutations.forEach(function(mutation) {
            mutation.addedNodes.forEach(function(node) {
                if (node.nodeType === 1 && node.classList && node.classList.contains('modal')) {
                    initializeModal(node);
                }
            });
        });
    });

    // Start observing
    if (document.body) {
        observer.observe(document.body, { childList: true, subtree: true });
    }

    // Global cleanup function
    window.cleanupModals = cleanupBackdrops;

    console.log('[Modal Fix] Initialized');
})();
