// Centralized Utilities for JSB Fitness
// Phase 1: Launch Stabilization

window.utils = {
    /**
     * Format a number as currency (INR)
     * @param {number} amount - The amount to format
     * @returns {string} Formatted currency string
     */
    safeNumber: function(val, fallback = '0') {
        if (val === undefined || val === null || Number.isNaN(Number(val))) return fallback;
        return Number(val).toLocaleString('en-IN');
    },

    formatCurrency: function(amount) {
        if (amount === undefined || amount === null || Number.isNaN(Number(amount))) return '₹0';
        if (amount === undefined || amount === null) return '₹0';
        return new Intl.NumberFormat('en-IN', {
            style: 'currency',
            currency: 'INR',
            minimumFractionDigits: 0,
            maximumFractionDigits: 0
        }).format(amount);
    },

    /**
     * Format a date string into a standard readable format
     * @param {string|Date} dateString - The date to format
     * @returns {string} Formatted date (e.g., Nov 24, 2024)
     */
    formatDate: function(dateString) {
        if (!dateString) return 'N/A';
        const date = new Date(dateString);
        return new Intl.DateTimeFormat('en-IN', {
            year: 'numeric',
            month: 'short',
            day: 'numeric'
        }).format(date);
    },

    /**
     * Get initials from a full name (used for avatars)
     * @param {string} name - The full name
     * @returns {string} Up to 2 initials
     */
    getInitials: function(name) {
        if (!name) return '?';
        return name
            .split(' ')
            .map(n => n[0])
            .join('')
            .toUpperCase()
            .substring(0, 2);
    },

    /**
     * Determine risk level color class based on member attendance/engagement
     * @param {string} level - 'High', 'Medium', 'Low'
     * @returns {string} Tailwind text color class
     */
    getRiskColorClass: function(level) {
        switch((level || '').toLowerCase()) {
            case 'high': return 'text-error';
            case 'medium': return 'text-tertiary';
            case 'low': return 'text-primary';
            default: return 'text-on-surface-variant';
        }
    }
};

// SaaS Hydration
window.addEventListener('DOMContentLoaded', async () => {
    try {
        const res = await window.fetch('/api/v1/settings/public');
        if (res.ok) {
            const settings = await res.json();
            const gymName = settings.gym_name || 'Kinetic Enterprise';
            const supportPhone = settings.support_phone || '';
            const supportEmail = settings.support_email || '';
            const gymAddress = settings.address || '';
            const themeColor = settings.theme_color || '#16c8ee';
            
            // Override window.APP_CONFIG.brand
            if (window.APP_CONFIG && window.APP_CONFIG.brand) {
                window.APP_CONFIG.brand.name = gymName;
                if (settings.logo_url) window.APP_CONFIG.brand.logo_url = settings.logo_url;
            }

            // Set custom theme color CSS variables dynamically
            if (settings.theme_color) {
                document.documentElement.style.setProperty('--color-primary', themeColor);
                
                // Calculate contrast text color (black or white)
                const getContrastColor = (hex) => {
                    if (!hex) return '#041012';
                    hex = hex.replace('#', '');
                    if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
                    const r = parseInt(hex.substring(0, 2), 16);
                    const g = parseInt(hex.substring(2, 4), 16);
                    const b = parseInt(hex.substring(4, 6), 16);
                    const yiq = ((r * 299) + (g * 587) + (b * 114)) / 1000;
                    return (yiq >= 128) ? '#041012' : '#ffffff';
                };
                
                // Calculate primary container color (dark version)
                const getContainerColor = (hex) => {
                    if (!hex) return '#0a3d4a';
                    return hex + '25'; // Adds transparency
                };

                document.documentElement.style.setProperty('--color-on-primary', getContrastColor(themeColor));
                document.documentElement.style.setProperty('--color-primary-container', getContainerColor(themeColor));
            }

            // Update title safely
            if (document.title.includes(window.APP_CONFIG?.brand?.name || 'Kinetic SaaS')) {
                document.title = document.title.replace(window.APP_CONFIG?.brand?.name || 'Kinetic SaaS', gymName);
            }
            
            // Update DOM Elements immediately
            document.querySelectorAll('.logo-text').forEach(el => el.innerText = gymName);
            document.querySelectorAll('.dynamic-gym-name').forEach(el => el.innerText = gymName);
            document.querySelectorAll('.dynamic-support-phone').forEach(el => el.innerText = supportPhone);
            document.querySelectorAll('.dynamic-support-email').forEach(el => el.innerText = supportEmail);
            document.querySelectorAll('.dynamic-gym-address').forEach(el => el.innerText = gymAddress);

            // Update custom logo image if logo_url is present
            if (settings.logo_url) {
                // In login/signup/general pages
                document.querySelectorAll('.dynamic-logo').forEach(el => {
                    el.outerHTML = `<img src="${settings.logo_url}" class="h-12 w-12 object-contain rounded-lg shrink-0" onerror="this.outerHTML='<span class=\'material-symbols-outlined text-4xl text-primary\'>hexagon</span>'">`;
                });
                
                // In sidebar
                const sidebarLogo = document.querySelector('.desktop-sidebar .logo-container span.material-symbols-outlined');
                if (sidebarLogo) {
                    sidebarLogo.outerHTML = `<img src="${settings.logo_url}" class="h-8 w-8 object-contain rounded shrink-0 mr-1" onerror="this.outerHTML='<span class=\'material-symbols-outlined text-primary text-[28px]\'>${window.APP_CONFIG?.brand?.icon || 'fitness_center'}</span>'">`;
                }

                // In mobile header
                const headerLogo = document.querySelector('header span.material-symbols-outlined');
                if (headerLogo) {
                    headerLogo.outerHTML = `<img src="${settings.logo_url}" class="h-6 w-6 object-contain rounded shrink-0" onerror="this.outerHTML='<span class=\'material-symbols-outlined text-primary\'>${window.APP_CONFIG?.brand?.icon || 'fitness_center'}</span>'">`;
                }
            }
            
            // Specialized element overrides
            document.querySelectorAll('h1, h2, p, span, div').forEach(el => {
                if (el.childNodes.length === 1 && el.childNodes[0].nodeType === 3) {
                    if (el.innerText.includes(window.APP_CONFIG?.brand?.name || 'Kinetic SaaS')) {
                        el.innerText = el.innerText.replace(window.APP_CONFIG?.brand?.name || 'Kinetic SaaS', gymName);
                    }
                }
            });

            // Premium locking logic based on subscription plan
            const path = window.location.pathname;
            const plan = settings.subscription_plan || 'trial';
            if (['/marketing', '/lead-crm', '/bi'].includes(path)) {
                if (plan === 'trial' || plan === 'basic') {
                    let featureName = "Premium Feature";
                    if (path === '/marketing') featureName = "Marketing Campaigns & Automations";
                    if (path === '/lead-crm') featureName = "Lead CRM Pipeline Management";
                    if (path === '/bi') featureName = "Business Intelligence & Advanced Analytics";
                    
                    const overlayHtml = `
                        <div class="fixed inset-0 z-[9999] bg-[#0c0c0c]/95 backdrop-blur-xl flex items-center justify-center p-6 text-center select-none">
                          <div class="bg-surface-container/60 border border-outline-variant/30 max-w-md w-full p-8 rounded-xl shadow-2xl relative overflow-hidden flex flex-col items-center">
                            <div class="absolute inset-0 bg-gradient-to-br from-primary/10 to-transparent pointer-events-none"></div>
                            <div class="h-16 w-16 bg-primary/15 rounded-full border border-primary/40 flex items-center justify-center mb-6">
                              <span class="material-symbols-outlined text-4xl text-primary" style="font-variation-settings: 'FILL' 1;">lock</span>
                            </div>
                            <h3 class="font-headline-md text-headline-md text-on-surface mb-2">Unlock ${featureName}</h3>
                            <p class="font-body-md text-body-md text-on-surface-variant mb-6">
                              This premium module is locked on your current <strong>${plan.toUpperCase()}</strong> plan. Upgrade to Pro or Enterprise to get immediate access!
                            </p>
                            <button onclick="window.location.href='/settings?tab=subscription'" class="w-full bg-primary text-on-primary py-3.5 rounded-lg font-label-caps text-label-caps tracking-widest hover:bg-primary-fixed-dim transition-all shadow-lg shadow-primary/20 hover:scale-[0.98] active:scale-95 duration-200">
                              UPGRADE NOW
                            </button>
                            <button onclick="window.location.href='/dashboard'" class="mt-4 text-on-surface-variant hover:text-on-surface text-body-sm transition-colors">
                              Back to Dashboard
                            </button>
                          </div>
                        </div>
                    `;
                    document.body.insertAdjacentHTML('afterbegin', overlayHtml);
                    document.body.style.overflow = 'hidden';
                }
            }
        }
    } catch(e) {
        console.error('Failed to load SaaS settings', e);
    }
});
