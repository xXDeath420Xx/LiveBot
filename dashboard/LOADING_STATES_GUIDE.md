# Loading States Implementation Guide

This guide explains how to use the loading states system in the CertiFried Dashboard.

## Files Created

1. **CSS File**: `/dashboard/public/css/loading-states.css`
   - Contains all animations and styling for loading states
   - Skeleton screens, spinners, overlays, and transitions

2. **EJS Partial**: `/dashboard/views/partials/loading.ejs`
   - Contains template definitions for all loading components
   - Includes page overlay, skeletons, spinners, and data loading templates

3. **JavaScript Manager**: `/dashboard/public/js/loading-manager.js`
   - Centralized loading state management
   - Handles all loading state logic and UI updates

## Integration

The loading system is integrated into:
- `/dashboard/views/servers.ejs` - Server list page
- `/dashboard/views/manage.ejs` - Manage page with forms

## Usage Examples

### 1. Page Loading Overlay

Show a full-page loading overlay (useful for navigation):

```javascript
// Show overlay
loadingManager.showPageLoading('Loading server configuration...');

// Hide overlay
loadingManager.hidePageLoading();
```

### 2. Server List Skeleton Loading

Show skeleton screens for server list:

```javascript
const container = document.getElementById('servers-container');

// Show loading skeletons
loadingManager.showServerListSkeleton(container, 3); // 3 cards

// Hide loading skeletons
loadingManager.hideServerListSkeleton(container);
```

### 3. Form Loading State

Show loading state on form submission:

```javascript
const form = document.querySelector('form');

// Show loading state
loadingManager.showFormLoading(form);

// Hide loading state
loadingManager.hideFormLoading(form);
```

The form will:
- Disable all inputs
- Add opacity/overlay effect
- Animate the submit button

### 4. Data Loading Indicator

Show loading indicator while fetching data:

```javascript
const container = document.getElementById('data-container');

// Show data loading
loadingManager.showDataLoading(container, 'Fetching data...');

// Hide data loading
loadingManager.hideDataLoading(container);
```

### 5. Toast Notifications

Show toast notifications for feedback:

```javascript
// Success toast
loadingManager.showToast('Server saved successfully!', 'success');

// Error toast
loadingManager.showToast('An error occurred', 'error');

// Warning toast
loadingManager.showToast('Please check the form', 'warning');

// Info toast (default)
loadingManager.showToast('Loading data...', 'info');

// With custom duration (in milliseconds)
loadingManager.showToast('Done!', 'success', 5000);
```

### 6. API Calls with Loading

Wrap fetch calls with automatic loading state:

```javascript
// Simple API call with loading indicator
loadingManager.fetchWithLoading(
    '/api/data',
    { method: 'GET' },
    document.getElementById('data-container')
)
.then(data => {
    console.log('Data loaded:', data);
})
.catch(error => {
    console.error('Failed to load:', error);
});
```

### 7. Async Operations with Loading

Wrap any async operation with loading state:

```javascript
loadingManager.withLoading(
    async () => {
        const response = await fetch('/api/endpoint');
        return response.json();
    },
    document.getElementById('container'),
    'Processing...'
)
.then(result => {
    console.log('Result:', result);
})
.catch(error => {
    console.error('Error:', error);
});
```

### 8. Form Submission with Loading

Simplified form submission handling:

```javascript
const form = document.querySelector('form');

form.addEventListener('submit', async (e) => {
    e.preventDefault();

    await loadingManager.submitForm(form, async () => {
        const formData = new FormData(form);
        const response = await fetch(form.action, {
            method: form.method,
            body: formData
        });

        if (!response.ok) {
            throw new Error('Submission failed');
        }

        loadingManager.showToast('Form submitted successfully!', 'success');
    });
});
```

## CSS Classes

### Skeleton Animation

```html
<div class="skeleton"></div>
<div class="skeleton skeleton-text lg"></div>
<div class="skeleton skeleton-avatar"></div>
```

### Spinners

```html
<!-- Regular spinner -->
<div class="spinner md"></div>

<!-- Spinner sizes: sm, md, lg -->
<div class="spinner sm"></div>
<div class="spinner lg"></div>

<!-- Spinner with text -->
<div class="spinner-text">
    <div class="spinner sm"></div>
    <span>Loading...</span>
</div>

<!-- Bouncing dots -->
<div class="spinner-dots">
    <div></div>
    <div></div>
    <div></div>
</div>
```

### Loading Indicators

```html
<!-- Form loading overlay -->
<form class="form-loading">
    <!-- form content -->
</form>

<!-- Button with loading animation -->
<button class="btn btn-loading">Loading...</button>

<!-- Data loading container -->
<div class="data-loading">
    <!-- loading indicator added automatically -->
</div>
```

## Advanced Features

### 1. Intercept All Fetch Calls

The loading manager automatically shows a loading bar for all fetch calls:

```javascript
// This will automatically show/hide the loading bar
fetch('/api/data')
    .then(res => res.json())
    .then(data => console.log(data));
```

### 2. Global Loading State

Check if anything is loading:

```javascript
if (loadingManager.getLoadingState()) {
    console.log('Something is loading...');
}
```

### 3. Clear All Loading States

Reset all loading states:

```javascript
loadingManager.clearAll();
```

### 4. Delay Utility

Built-in delay function for testing/demo:

```javascript
await loadingManager.delay(1000); // Wait 1 second
```

## Accessibility Features

- **Reduced Motion Support**: Animations are disabled for users with `prefers-reduced-motion`
- **ARIA Labels**: Loading indicators have proper ARIA attributes
- **Keyboard Navigation**: All loading states don't interfere with keyboard access
- **Color Contrast**: All spinners and indicators meet WCAG standards

## Animation Details

### Skeleton Shimmer
- Duration: 2 seconds
- Creates a shimmer effect across skeleton elements
- Infinite loop

### Spinner
- Duration: 1 second per rotation
- Smooth linear animation
- Color: Brand color (#7289da)

### Bouncing Dots
- Duration: 1.4 seconds
- Staggered animation for 3 dots
- Ease-in-out timing

### Page Transitions
- Slide-in animation: 0.3s
- Fade-out animation: 0.3s
- Smooth opacity and transform transitions

## Integration with Existing Code

The loading manager is already integrated into:

1. **servers.ejs**: Server card navigation triggers page loading overlay
2. **manage.ejs**: Form submission, navigation, and page transitions

To integrate with other pages:

1. Include the loading partial: `<%- include('partials/loading') %>`
2. Include the CSS: `<link rel="stylesheet" href="/css/loading-states.css">`
3. Include the JS: `<script src="/js/loading-manager.js"></script>`
4. Use `loadingManager` API in your scripts

## Browser Support

- Chrome/Edge: Full support
- Firefox: Full support
- Safari: Full support (iOS 12+)
- IE 11: Partial support (no animations)

## Performance Considerations

- Animations use GPU acceleration for smooth performance
- Skeleton screens are lightweight and fast to render
- Loading manager is optimized for mobile devices
- CSS animations are hardware-accelerated

## Customization

### Change Brand Color

Edit `/dashboard/public/css/loading-states.css`:

```css
--spinner-color: #your-color;
```

Update the CSS variables:

```css
.spinner {
    border-top: 3px solid #your-color;
}

.loading-bar {
    background: linear-gradient(90deg, #your-color, ...);
}
```

### Adjust Animation Speed

```css
.skeleton {
    animation: skeleton-shimmer 3s infinite ease-in-out; /* Changed from 2s */
}

.spinner {
    animation: spin 2s linear infinite; /* Changed from 1s */
}
```

### Custom Loading Messages

```javascript
loadingManager.showPageLoading('Your custom message here');
loadingManager.showDataLoading(container, 'Custom data loading message');
```

## Troubleshooting

### Loading states not showing

1. Ensure `loading-states.css` is included in the page
2. Ensure `loading-manager.js` is loaded after DOM ready
3. Check browser console for errors
4. Verify the container element exists

### Animations not smooth

1. Check `prefers-reduced-motion` is not enabled
2. Verify hardware acceleration is enabled in browser
3. Check for conflicting CSS animations

### Forms not responding to loading state

1. Ensure form has a submit button with `type="submit"`
2. Check that form ID or selector is correct
3. Verify `data-no-loading` attribute is not present on form

## Examples

### Complete Form with Loading

```html
<form id="settings-form" action="/api/save-settings" method="POST">
    <div class="form-group">
        <label for="setting1">Setting 1</label>
        <input type="text" id="setting1" name="setting1" required>
    </div>
    <button type="submit" class="btn btn-primary">Save Settings</button>
</form>

<script>
document.getElementById('settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();

    const form = e.target;

    try {
        loadingManager.showFormLoading(form);

        const response = await fetch(form.action, {
            method: form.method,
            body: new FormData(form)
        });

        if (!response.ok) throw new Error('Save failed');

        loadingManager.hideFormLoading(form);
        loadingManager.showToast('Settings saved successfully!', 'success');
    } catch (error) {
        loadingManager.hideFormLoading(form);
        loadingManager.showToast('Failed to save settings', 'error');
    }
});
</script>
```

### Data List with Skeleton Loading

```html
<div id="data-list"></div>

<script>
async function loadDataList() {
    const container = document.getElementById('data-list');

    try {
        // Show skeletons while loading
        loadingManager.showDataLoading(container, 'Loading data...');

        // Simulate API call
        await loadingManager.delay(2000);

        const response = await fetch('/api/data-list');
        const data = await response.json();

        // Hide loading and render data
        loadingManager.hideDataLoading(container);
        container.innerHTML = data.map(item => `
            <div class="list-item">${item.name}</div>
        `).join('');
    } catch (error) {
        loadingManager.hideDataLoading(container);
        loadingManager.showToast('Failed to load data', 'error');
    }
}

loadDataList();
</script>
```

## API Reference

See `/dashboard/public/js/loading-manager.js` for complete method documentation and JSDoc comments.
