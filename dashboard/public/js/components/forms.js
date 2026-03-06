/**
 * Form Utilities and Components
 * Handles form validation, submission, and dynamic field updates
 */

class FormHandler {
    constructor(formElement, options = {}) {
        this.form = typeof formElement === 'string' ? document.querySelector(formElement) : formElement;
        if (!this.form) {
            console.error('[FormHandler] Form not found');
            return;
        }

        this.options = {
            ajax: true,
            resetOnSuccess: false,
            validateOnBlur: true,
            showToast: true,
            onSuccess: null,
            onError: null,
            ...options
        };

        this.isSubmitting = false;
        this.init();
    }

    init() {
        // Form submission
        this.form.addEventListener('submit', (e) => this.handleSubmit(e));

        // Validate on blur
        if (this.options.validateOnBlur) {
            this.form.querySelectorAll('input, select, textarea').forEach(field => {
                field.addEventListener('blur', () => this.validateField(field));
            });
        }

        // Track changes
        this.form.addEventListener('change', () => {
            this.form.dataset.changed = 'true';
        });

        // Warn on navigation if unsaved changes
        window.addEventListener('beforeunload', (e) => {
            if (this.form.dataset.changed === 'true') {
                e.preventDefault();
                e.returnValue = '';
            }
        });
    }

    async handleSubmit(e) {
        if (this.options.ajax) {
            e.preventDefault();
        }

        if (this.isSubmitting) return;

        // Validate all fields
        if (!this.validateForm()) {
            return;
        }

        this.isSubmitting = true;
        this.setLoadingState(true);

        try {
            const formData = new FormData(this.form);
            const data = this.formDataToObject(formData);

            const response = await fetch(this.form.action, {
                method: this.form.method || 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Requested-With': 'XMLHttpRequest'
                },
                body: JSON.stringify(data)
            });

            const result = await response.json();

            if (response.ok && !result.error) {
                this.form.dataset.changed = 'false';

                if (this.options.showToast) {
                    showToast('success', result.message || 'Settings saved successfully');
                }

                if (this.options.resetOnSuccess) {
                    this.form.reset();
                }

                if (this.options.onSuccess) {
                    this.options.onSuccess(result);
                }
            } else {
                throw new Error(result.error || 'Failed to save');
            }
        } catch (error) {
            console.error('[FormHandler] Submit error:', error);

            if (this.options.showToast) {
                showToast('error', error.message || 'Failed to save settings');
            }

            if (this.options.onError) {
                this.options.onError(error);
            }
        } finally {
            this.isSubmitting = false;
            this.setLoadingState(false);
        }
    }

    validateForm() {
        let isValid = true;
        this.form.querySelectorAll('[required], [data-validate]').forEach(field => {
            if (!this.validateField(field)) {
                isValid = false;
            }
        });
        return isValid;
    }

    validateField(field) {
        const value = field.value.trim();
        let isValid = true;
        let errorMessage = '';

        // Required validation
        if (field.required && !value) {
            isValid = false;
            errorMessage = 'This field is required';
        }

        // Pattern validation
        if (isValid && field.pattern && value) {
            const regex = new RegExp(field.pattern);
            if (!regex.test(value)) {
                isValid = false;
                errorMessage = field.dataset.patternError || 'Invalid format';
            }
        }

        // Min/Max length
        if (isValid && value) {
            if (field.minLength && value.length < field.minLength) {
                isValid = false;
                errorMessage = `Minimum ${field.minLength} characters required`;
            }
            if (field.maxLength && value.length > field.maxLength) {
                isValid = false;
                errorMessage = `Maximum ${field.maxLength} characters allowed`;
            }
        }

        // Custom validation
        const customValidate = field.dataset.validate;
        if (isValid && customValidate && value) {
            const result = this.customValidators[customValidate]?.(value, field);
            if (result !== true) {
                isValid = false;
                errorMessage = result || 'Invalid value';
            }
        }

        this.setFieldError(field, isValid ? '' : errorMessage);
        return isValid;
    }

    setFieldError(field, message) {
        const wrapper = field.closest('.form-group') || field.parentElement;
        let errorEl = wrapper.querySelector('.form-error');

        if (message) {
            field.classList.add('border-accent-red');
            field.classList.remove('border-dark-400');

            if (!errorEl) {
                errorEl = document.createElement('p');
                errorEl.className = 'form-error text-xs text-accent-red mt-1';
                wrapper.appendChild(errorEl);
            }
            errorEl.textContent = message;
        } else {
            field.classList.remove('border-accent-red');
            field.classList.add('border-dark-400');

            if (errorEl) {
                errorEl.remove();
            }
        }
    }

    setLoadingState(isLoading) {
        const submitBtn = this.form.querySelector('[type="submit"]');
        if (!submitBtn) return;

        if (isLoading) {
            submitBtn.disabled = true;
            submitBtn.dataset.originalText = submitBtn.innerHTML;
            submitBtn.innerHTML = `
                <svg class="animate-spin h-4 w-4 mr-2" fill="none" viewBox="0 0 24 24">
                    <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                    <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
                Saving...
            `;
        } else {
            submitBtn.disabled = false;
            submitBtn.innerHTML = submitBtn.dataset.originalText || 'Save';
        }
    }

    formDataToObject(formData) {
        const obj = {};
        for (const [key, value] of formData.entries()) {
            // Handle arrays (multiple selects, checkboxes)
            if (key.endsWith('[]')) {
                const arrayKey = key.slice(0, -2);
                if (!obj[arrayKey]) obj[arrayKey] = [];
                obj[arrayKey].push(value);
            }
            // Handle checkboxes
            else if (this.form.querySelector(`[name="${key}"][type="checkbox"]`)) {
                obj[key] = value === 'on' || value === 'true' || value === '1';
            }
            // Handle numbers
            else if (this.form.querySelector(`[name="${key}"][type="number"]`)) {
                obj[key] = value === '' ? null : Number(value);
            }
            // Regular fields
            else {
                obj[key] = value;
            }
        }

        // Add unchecked checkboxes as false
        this.form.querySelectorAll('input[type="checkbox"]').forEach(cb => {
            if (!formData.has(cb.name)) {
                obj[cb.name] = false;
            }
        });

        return obj;
    }

    // Custom validators registry
    customValidators = {
        discordId: (value) => /^\d{17,19}$/.test(value) || 'Invalid Discord ID',
        hexColor: (value) => /^#[0-9A-Fa-f]{6}$/.test(value) || 'Invalid hex color',
        url: (value) => {
            try {
                new URL(value);
                return true;
            } catch {
                return 'Invalid URL';
            }
        }
    };
}

/**
 * Toggle Switch Component
 */
class ToggleSwitch {
    constructor(element) {
        this.element = typeof element === 'string' ? document.querySelector(element) : element;
        if (!this.element) return;

        this.checkbox = this.element.querySelector('input[type="checkbox"]');
        this.init();
    }

    init() {
        this.element.addEventListener('click', (e) => {
            if (e.target !== this.checkbox) {
                this.toggle();
            }
        });

        this.updateVisual();
        this.checkbox.addEventListener('change', () => this.updateVisual());
    }

    toggle() {
        this.checkbox.checked = !this.checkbox.checked;
        this.checkbox.dispatchEvent(new Event('change', { bubbles: true }));
    }

    updateVisual() {
        if (this.checkbox.checked) {
            this.element.classList.add('active');
        } else {
            this.element.classList.remove('active');
        }
    }
}

/**
 * Channel/Role Select Component with search
 */
class EnhancedSelect {
    constructor(element, options = {}) {
        this.element = typeof element === 'string' ? document.querySelector(element) : element;
        if (!this.element) return;

        this.options = {
            searchable: true,
            placeholder: 'Select an option',
            allowClear: false,
            ...options
        };

        this.isOpen = false;
        this.selectedValue = this.element.value;
        this.init();
    }

    init() {
        // Create wrapper
        this.wrapper = document.createElement('div');
        this.wrapper.className = 'enhanced-select relative';
        this.element.parentNode.insertBefore(this.wrapper, this.element);
        this.wrapper.appendChild(this.element);

        // Hide original select
        this.element.style.display = 'none';

        // Create custom UI
        this.createUI();
        this.bindEvents();
    }

    createUI() {
        // Display button
        this.display = document.createElement('button');
        this.display.type = 'button';
        this.display.className = 'form-select w-full text-left';
        this.display.innerHTML = this.getSelectedText();

        // Dropdown
        this.dropdown = document.createElement('div');
        this.dropdown.className = 'absolute w-full mt-1 bg-dark-600 border border-dark-400 rounded-lg shadow-lg z-50 hidden max-h-60 overflow-hidden';

        // Search input
        if (this.options.searchable) {
            this.searchInput = document.createElement('input');
            this.searchInput.type = 'text';
            this.searchInput.placeholder = 'Search...';
            this.searchInput.className = 'w-full px-3 py-2 bg-dark-700 border-b border-dark-400 text-white focus:outline-none';
            this.dropdown.appendChild(this.searchInput);
        }

        // Options list
        this.optionsList = document.createElement('div');
        this.optionsList.className = 'overflow-y-auto max-h-48';
        this.dropdown.appendChild(this.optionsList);

        this.renderOptions();

        this.wrapper.appendChild(this.display);
        this.wrapper.appendChild(this.dropdown);
    }

    renderOptions(filter = '') {
        this.optionsList.innerHTML = '';
        const filterLower = filter.toLowerCase();

        Array.from(this.element.options).forEach(opt => {
            if (filter && !opt.text.toLowerCase().includes(filterLower)) return;

            const optEl = document.createElement('div');
            optEl.className = 'px-3 py-2 cursor-pointer hover:bg-dark-500 transition-colors';
            optEl.dataset.value = opt.value;
            optEl.textContent = opt.text;

            if (opt.value === this.selectedValue) {
                optEl.classList.add('bg-primary-500/20', 'text-primary-400');
            }

            optEl.addEventListener('click', () => this.selectOption(opt.value, opt.text));
            this.optionsList.appendChild(optEl);
        });
    }

    bindEvents() {
        this.display.addEventListener('click', () => this.toggle());

        if (this.searchInput) {
            this.searchInput.addEventListener('input', (e) => {
                this.renderOptions(e.target.value);
            });
        }

        // Close on outside click
        document.addEventListener('click', (e) => {
            if (!this.wrapper.contains(e.target)) {
                this.close();
            }
        });
    }

    toggle() {
        this.isOpen ? this.close() : this.open();
    }

    open() {
        this.isOpen = true;
        this.dropdown.classList.remove('hidden');
        this.dropdown.classList.add('animate-fade-in');
        if (this.searchInput) {
            this.searchInput.focus();
            this.searchInput.value = '';
            this.renderOptions();
        }
    }

    close() {
        this.isOpen = false;
        this.dropdown.classList.add('hidden');
    }

    selectOption(value, text) {
        this.selectedValue = value;
        this.element.value = value;
        this.display.innerHTML = text || this.options.placeholder;
        this.element.dispatchEvent(new Event('change', { bubbles: true }));
        this.close();
    }

    getSelectedText() {
        const selected = this.element.options[this.element.selectedIndex];
        return selected ? selected.text : this.options.placeholder;
    }
}

// Auto-initialize on DOM ready
document.addEventListener('DOMContentLoaded', () => {
    // Initialize toggles
    document.querySelectorAll('.toggle').forEach(el => new ToggleSwitch(el));

    // Initialize enhanced selects
    document.querySelectorAll('[data-enhanced-select]').forEach(el => new EnhancedSelect(el));
});

// Export for module usage
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { FormHandler, ToggleSwitch, EnhancedSelect };
}
