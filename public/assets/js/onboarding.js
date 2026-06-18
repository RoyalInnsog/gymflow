class GymOnboarding {
  constructor() {
    this.session = null;
    this.tourSteps = [
      { id: 'nav-dashboard', title: 'Dashboard', text: "Get a bird's-eye view of your gym's health, revenue, and alerts here." },
      { id: 'nav-members', title: 'Members', text: 'Manage all your members, view profiles, and track their active plans.' },
      { id: 'nav-attendance', title: 'Attendance', text: 'Track daily check-ins and identify your most active members.' },
      { id: 'nav-plans', title: 'Membership Plans', text: 'Create and configure your pricing plans and durations.' },
      { id: 'nav-finance', title: 'Payments', text: 'Process payments, send invoices, and track outstanding dues.' },
      { id: 'nav-staff', title: 'Staff Management', text: 'Manage trainers and employees, track performance, and handle payroll.' },
      { id: 'nav-reports', title: 'Reports', text: 'Generate detailed analytics on revenue, churn, and engagement.' },
      { id: 'nav-settings', title: 'Settings', text: 'Configure your gym profile, branding, and billing preferences.' }
    ];
    this.currentStep = 0;
    this.init();
  }

  async init() {
    try {
      const res = await window.api.fetch('/auth/session');
      this.session = await res.json();
      
      const { tour_completed, onboarding_completed } = this.session.tenant;

      if (!onboarding_completed) {
        setTimeout(() => this.startSetupWizard(), 500);
      } else if (!tour_completed && window.location.pathname.includes('/dashboard')) {
        setTimeout(() => this.startTour(), 1000);
      } else {
        // Initialize Global Trial Countdown
        this.initTrialCountdown();
      }
    } catch (err) {
      console.error('Failed to init onboarding:', err);
    }
  }

  // ==========================================
  // PHASE 1: PRODUCT TOUR
  // ==========================================
  startTour() {
    // Create Tour Container
    this.tourOverlay = document.createElement('div');
    this.tourOverlay.className = 'fixed inset-0 z-[99998] bg-background/80 backdrop-blur-sm transition-opacity duration-300';
    document.body.appendChild(this.tourOverlay);

    this.spotlight = document.createElement('div');
    this.spotlight.className = 'fixed z-[99999] rounded-xl border-2 border-primary shadow-[0_0_0_9999px_rgba(0,0,0,0.5)] transition-all duration-500 pointer-events-none flex items-center justify-center';
    this.spotlight.innerHTML = '<div class="absolute inset-0 rounded-xl bg-primary/10 animate-pulse"></div>';
    document.body.appendChild(this.spotlight);

    this.tooltip = document.createElement('div');
    this.tooltip.className = 'fixed z-[100000] w-80 glass-panel border border-primary/30 rounded-xl p-5 shadow-2xl transition-all duration-500 opacity-0 scale-95 flex flex-col gap-3';
    document.body.appendChild(this.tooltip);

    this.currentStep = 0;
    this.renderTourStep();
  }

  renderTourStep() {
    if (this.currentStep >= this.tourSteps.length) {
      return this.finishTour();
    }

    const step = this.tourSteps[this.currentStep];
    
    // Find element
    let el = null;
    document.querySelectorAll('a, button, div').forEach(node => {
      if (node.id === step.id || (node.href && node.href.includes(step.id.replace('nav-', '')))) {
        el = node;
      }
    });

    if (!el) {
      // Element not found, skip step
      this.currentStep++;
      return this.renderTourStep();
    }

    // Scroll to element
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });

    // Position Spotlight
    const rect = el.getBoundingClientRect();
    this.spotlight.style.top = `${rect.top - 8}px`;
    this.spotlight.style.left = `${rect.left - 8}px`;
    this.spotlight.style.width = `${rect.width + 16}px`;
    this.spotlight.style.height = `${rect.height + 16}px`;

    // Make element interactive above overlay
    el.classList.add('relative', 'z-[100000]', 'pointer-events-none');

    // Position Tooltip (right of the element usually)
    let ttLeft = rect.right + 24;
    let ttTop = rect.top;
    if (ttLeft + 320 > window.innerWidth) {
      ttLeft = rect.left - 340;
    }

    this.tooltip.style.top = `${ttTop}px`;
    this.tooltip.style.left = `${ttLeft}px`;
    this.tooltip.style.opacity = '1';
    this.tooltip.style.transform = 'scale(1)';

    // Render Tooltip Content
    this.tooltip.innerHTML = `
      <div class="flex justify-between items-start mb-1">
        <span class="text-[10px] font-label-caps text-primary uppercase tracking-wider">Step ${this.currentStep + 1} of ${this.tourSteps.length}</span>
        <button class="text-on-surface-variant hover:text-on-surface p-1" onclick="window.onboarding.finishTour()">
          <span class="material-symbols-outlined text-[16px]">close</span>
        </button>
      </div>
      <h3 class="font-title-lg text-title-lg text-on-surface">${step.title}</h3>
      <p class="font-body-md text-body-md text-on-surface-variant">${step.text}</p>
      <div class="flex items-center justify-between mt-3 pt-3 border-t border-white/10">
        <button class="text-sm font-medium text-on-surface-variant hover:text-on-surface transition-colors" onclick="window.onboarding.skipTour()">Skip Tour</button>
        <div class="flex gap-2">
          ${this.currentStep > 0 ? `<button class="px-3 py-1.5 rounded-lg border border-outline text-sm text-on-surface hover:bg-surface-container" onclick="window.onboarding.prevTour()">Back</button>` : ''}
          <button class="px-4 py-1.5 rounded-lg bg-primary text-on-primary text-sm font-medium hover:bg-primary/90" onclick="window.onboarding.nextTour()">${this.currentStep === this.tourSteps.length - 1 ? 'Finish' : 'Next'}</button>
        </div>
      </div>
    `;

    // Cleanup previous element z-index if exists
    if (this.lastEl && this.lastEl !== el) {
      this.lastEl.classList.remove('relative', 'z-[100000]', 'pointer-events-none');
    }
    this.lastEl = el;
  }

  nextTour() {
    this.currentStep++;
    this.renderTourStep();
  }

  prevTour() {
    this.currentStep--;
    this.renderTourStep();
  }

  async skipTour() {
    await this.finishTour();
  }

  async finishTour() {
    if (this.lastEl) this.lastEl.classList.remove('relative', 'z-[100000]', 'pointer-events-none');
    if (this.tourOverlay) this.tourOverlay.remove();
    if (this.spotlight) this.spotlight.remove();
    if (this.tooltip) this.tooltip.remove();

    try {
      await window.api.fetch('/onboarding/complete-tour', { method: 'POST' });
      this.initTrialCountdown();
    } catch (err) {
      console.error(err);
    }
  }

  // ==========================================
  // PHASE 2-4: SETUP WIZARD & RECOMMENDATION
  // ==========================================
  startSetupWizard() {
    this.wizardOverlay = document.createElement('div');
    this.wizardOverlay.className = 'fixed inset-0 z-[100000] bg-background/95 backdrop-blur-md flex items-center justify-center p-4 overflow-y-auto';
    
    this.wizardOverlay.innerHTML = `
      <div class="glass-panel w-full max-w-2xl rounded-2xl flex flex-col overflow-hidden shadow-2xl border border-white/20 animate-in fade-in zoom-in-95 duration-300">
        <div class="p-6 border-b border-white/10 flex justify-between items-center bg-surface-container-low/50">
          <div>
            <h2 class="font-headline-md text-headline-md text-on-surface" id="wizard-title">Welcome to Gym Flow</h2>
            <p class="text-on-surface-variant text-sm mt-1" id="wizard-subtitle">Let's set up your workspace</p>
          </div>
          <div class="flex items-center gap-2" id="wizard-progress">
            <div class="w-2 h-2 rounded-full bg-primary"></div>
            <div class="w-2 h-2 rounded-full bg-surface-variant"></div>
            <div class="w-2 h-2 rounded-full bg-surface-variant"></div>
            <div class="w-2 h-2 rounded-full bg-surface-variant"></div>
            <div class="w-2 h-2 rounded-full bg-surface-variant"></div>
          </div>
        </div>
        
        <div class="p-8" id="wizard-content">
          <!-- Wizard steps injected here -->
        </div>

        <div class="p-6 border-t border-white/10 bg-surface-container-low/50 flex justify-between items-center" id="wizard-footer">
          <button class="px-5 py-2 rounded-xl text-on-surface-variant hover:bg-surface-container transition-colors hidden" id="wizard-back" onclick="window.onboarding.wizardBack()">Back</button>
          <div class="ml-auto">
            <button class="px-5 py-2 rounded-xl bg-primary text-on-primary font-medium hover:bg-primary/90 transition-colors shadow-lg shadow-primary/20" id="wizard-next" onclick="window.onboarding.wizardNext()">Continue</button>
          </div>
        </div>
      </div>
    `;
    
    document.body.appendChild(this.wizardOverlay);
    this.wizardStep = 1;
    this.wizardData = {};
    this.renderWizardStep();
  }

  renderWizardStep() {
    const content = document.getElementById('wizard-content');
    const title = document.getElementById('wizard-title');
    const subtitle = document.getElementById('wizard-subtitle');
    const backBtn = document.getElementById('wizard-back');
    const nextBtn = document.getElementById('wizard-next');
    const progress = document.getElementById('wizard-progress');

    // Update Progress
    if (progress) {
      Array.from(progress.children).forEach((dot, index) => {
        dot.className = `w-2 h-2 rounded-full ${index < this.wizardStep ? 'bg-primary scale-110' : 'bg-surface-variant'}`;
      });
    }

    backBtn.classList.toggle('hidden', this.wizardStep === 1 || this.wizardStep > 4);
    
    if (this.wizardStep === 1) {
      title.innerText = "Gym Profile";
      subtitle.innerText = "Basic details about your business";
      content.innerHTML = `
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div class="md:col-span-2">
            <label class="block text-xs font-label-caps text-on-surface-variant uppercase tracking-wider mb-2">Gym Name</label>
            <input type="text" id="w-gym-name" value="${this.session?.tenant?.gym_name || ''}" class="w-full bg-surface-container border border-outline-variant/30 rounded-xl px-4 py-3 text-on-surface focus:border-primary outline-none">
          </div>
          <div class="md:col-span-2">
            <label class="block text-xs font-label-caps text-on-surface-variant uppercase tracking-wider mb-2">Address</label>
            <input type="text" id="w-address" class="w-full bg-surface-container border border-outline-variant/30 rounded-xl px-4 py-3 text-on-surface focus:border-primary outline-none">
          </div>
          <div>
            <label class="block text-xs font-label-caps text-on-surface-variant uppercase tracking-wider mb-2">Support Phone</label>
            <input type="text" id="w-phone" class="w-full bg-surface-container border border-outline-variant/30 rounded-xl px-4 py-3 text-on-surface focus:border-primary outline-none">
          </div>
          <div>
            <label class="block text-xs font-label-caps text-on-surface-variant uppercase tracking-wider mb-2">Support Email</label>
            <input type="email" id="w-email" class="w-full bg-surface-container border border-outline-variant/30 rounded-xl px-4 py-3 text-on-surface focus:border-primary outline-none">
          </div>
          <div class="md:col-span-2 mt-2">
            <label class="block text-xs font-label-caps text-on-surface-variant uppercase tracking-wider mb-2">Gym Logo URL</label>
            <input type="text" id="w-logo" placeholder="https://example.com/logo.png" class="w-full bg-surface-container border border-outline-variant/30 rounded-xl px-4 py-3 text-on-surface focus:border-primary outline-none">
          </div>
        </div>
      `;
    } 
    else if (this.wizardStep === 2) {
      title.innerText = "Business Setup";
      subtitle.innerText = "Configure your financials and operations";
      content.innerHTML = `
        <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div>
            <label class="block text-xs font-label-caps text-on-surface-variant uppercase tracking-wider mb-2">Currency</label>
            <select id="w-currency" class="w-full bg-surface-container border border-outline-variant/30 rounded-xl px-4 py-3 text-on-surface focus:border-primary outline-none">
              <option value="₹">INR (₹)</option>
              <option value="$">USD ($)</option>
              <option value="€">EUR (€)</option>
              <option value="£">GBP (£)</option>
            </select>
          </div>
          <div>
            <label class="block text-xs font-label-caps text-on-surface-variant uppercase tracking-wider mb-2">Tax Percentage (%)</label>
            <input type="number" id="w-tax" value="18" class="w-full bg-surface-container border border-outline-variant/30 rounded-xl px-4 py-3 text-on-surface focus:border-primary outline-none">
          </div>
          <div>
            <label class="block text-xs font-label-caps text-on-surface-variant uppercase tracking-wider mb-2">Opening Time</label>
            <input type="time" id="w-open" value="06:00" class="w-full bg-surface-container border border-outline-variant/30 rounded-xl px-4 py-3 text-on-surface focus:border-primary outline-none">
          </div>
          <div>
            <label class="block text-xs font-label-caps text-on-surface-variant uppercase tracking-wider mb-2">Closing Time</label>
            <input type="time" id="w-close" value="22:00" class="w-full bg-surface-container border border-outline-variant/30 rounded-xl px-4 py-3 text-on-surface focus:border-primary outline-none">
          </div>
          <div class="md:col-span-2">
            <label class="block text-xs font-label-caps text-on-surface-variant uppercase tracking-wider mb-2">Payment Methods</label>
            <div class="flex gap-4">
              <label class="flex items-center gap-2 text-on-surface"><input type="checkbox" id="w-pay-cash" value="cash" checked class="accent-primary"> Cash</label>
              <label class="flex items-center gap-2 text-on-surface"><input type="checkbox" id="w-pay-upi" value="upi" checked class="accent-primary"> UPI</label>
              <label class="flex items-center gap-2 text-on-surface"><input type="checkbox" id="w-pay-card" value="card" checked class="accent-primary"> Card</label>
              <label class="flex items-center gap-2 text-on-surface"><input type="checkbox" id="w-pay-bank" value="bank_transfer" class="accent-primary"> Bank Transfer</label>
            </div>
          </div>
        </div>
      `;
    }
    else if (this.wizardStep === 3) {
      title.innerText = "Membership Setup";
      subtitle.innerText = "Create your first membership plan";
      content.innerHTML = `
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div class="md:col-span-2">
            <label class="block text-xs font-label-caps text-on-surface-variant uppercase tracking-wider mb-2">Plan Name</label>
            <input type="text" id="w-plan-name" placeholder="e.g. Monthly Standard" class="w-full bg-surface-container border border-outline-variant/30 rounded-xl px-4 py-3 text-on-surface focus:border-primary outline-none">
          </div>
          <div>
            <label class="block text-xs font-label-caps text-on-surface-variant uppercase tracking-wider mb-2">Duration (Months)</label>
            <input type="number" id="w-plan-duration" value="1" class="w-full bg-surface-container border border-outline-variant/30 rounded-xl px-4 py-3 text-on-surface focus:border-primary outline-none">
          </div>
          <div>
            <label class="block text-xs font-label-caps text-on-surface-variant uppercase tracking-wider mb-2">Duration (Days)</label>
            <input type="number" id="w-plan-duration-days" value="0" class="w-full bg-surface-container border border-outline-variant/30 rounded-xl px-4 py-3 text-on-surface focus:border-primary outline-none">
          </div>
          <div>
            <label class="block text-xs font-label-caps text-on-surface-variant uppercase tracking-wider mb-2">Base Price (Renewal)</label>
            <input type="number" id="w-plan-price" placeholder="1500" class="w-full bg-surface-container border border-outline-variant/30 rounded-xl px-4 py-3 text-on-surface focus:border-primary outline-none">
          </div>
          <div>
            <label class="block text-xs font-label-caps text-on-surface-variant uppercase tracking-wider mb-2">Joining Fee (One-Time)</label>
            <input type="number" id="w-plan-joining" placeholder="500" value="0" class="w-full bg-surface-container border border-outline-variant/30 rounded-xl px-4 py-3 text-on-surface focus:border-primary outline-none">
          </div>
        </div>
      `;
      nextBtn.innerText = "Complete Setup";
    }
    else if (this.wizardStep === 4) {
      document.getElementById('wizard-footer').classList.add('hidden');
      document.getElementById('wizard-progress').classList.add('hidden');
      
      title.innerText = "Saving Configuration...";
      subtitle.innerText = "Preparing your workspace";
      content.innerHTML = `
        <div class="flex flex-col items-center justify-center py-12">
          <div class="w-16 h-16 border-4 border-primary border-t-transparent rounded-full animate-spin mb-6"></div>
          <p class="text-lg text-on-surface font-medium animate-pulse">Applying settings and creating plans...</p>
        </div>
      `;
      setTimeout(() => this.saveAndRedirect(), 1000);
    }
  }

  wizardNext() {
    // Save current step data
    if (this.wizardStep === 1) {
      this.wizardData.gym_name = document.getElementById('w-gym-name')?.value;
      this.wizardData.address = document.getElementById('w-address')?.value;
      this.wizardData.support_phone = document.getElementById('w-phone')?.value;
      this.wizardData.support_email = document.getElementById('w-email')?.value;
      this.wizardData.logo_url = document.getElementById('w-logo')?.value;
    } else if (this.wizardStep === 2) {
      this.wizardData.currency = document.getElementById('w-currency')?.value;
      this.wizardData.tax_rate_percent = document.getElementById('w-tax')?.value;
      this.wizardData.opening_time = document.getElementById('w-open')?.value;
      this.wizardData.closing_time = document.getElementById('w-close')?.value;
      const methods = [];
      if (document.getElementById('w-pay-cash')?.checked) methods.push('cash');
      if (document.getElementById('w-pay-upi')?.checked) methods.push('upi');
      if (document.getElementById('w-pay-card')?.checked) methods.push('card');
      if (document.getElementById('w-pay-bank')?.checked) methods.push('bank_transfer');
      this.wizardData.payment_methods = methods;
    } else if (this.wizardStep === 3) {
      this.wizardData.plans = [{
        name: document.getElementById('w-plan-name')?.value,
        duration_months: parseInt(document.getElementById('w-plan-duration')?.value || '0'),
        duration_days: parseInt(document.getElementById('w-plan-duration-days')?.value || '0'),
        price: parseFloat(document.getElementById('w-plan-price')?.value || '0'),
        joining_fee: parseFloat(document.getElementById('w-plan-joining')?.value || '0')
      }];
    }
    
    this.wizardStep++;
    this.renderWizardStep();
  }

  wizardBack() {
    this.wizardStep--;
    this.renderWizardStep();
  }

  async saveAndRedirect() {
    const content = document.getElementById('wizard-content');
    const title = document.getElementById('wizard-title');
    const subtitle = document.getElementById('wizard-subtitle');

    try {
      await window.api.fetch('/onboarding/complete-setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(this.wizardData)
      });

      title.innerText = "🎉 Setup Complete!";
      subtitle.innerText = "Time to add your first member.";
      content.innerHTML = `
        <div class="flex flex-col items-center justify-center text-center py-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
          <div class="w-24 h-24 rounded-full bg-[#81c995]/20 text-[#81c995] flex items-center justify-center mb-6">
            <span class="material-symbols-outlined text-[48px]">person_add</span>
          </div>
          <h3 class="text-xl font-bold text-on-surface mb-2">Workspace Ready</h3>
          <p class="text-on-surface-variant mb-8 max-w-md">Your gym profile, settings, and first membership plan have been created successfully. Let's add your first member to the system!</p>
          <button class="px-8 py-3 rounded-xl bg-primary text-on-primary font-bold hover:bg-primary/90 transition-colors shadow-lg shadow-primary/20" onclick="window.location.href='/add-member'">
            Take Me to Add Member
          </button>
        </div>
      `;
    } catch (err) {
      console.error(err);
      content.innerHTML = `<p class="text-error text-center py-8">Failed to save setup. Please try again.</p>`;
    }
  }

  // ==========================================
  // PHASE 5 & 6: GLOBAL COUNTDOWN & CONVERSION
  // ==========================================
  initTrialCountdown() {
    if (!this.session || !this.session.tenant) return;
    if (this.session.tenant.subscription_status !== 'trial') return;

    const trialEnd = new Date(this.session.tenant.trial_end);
    const now = new Date();
    const diffTime = trialEnd - now;
    const daysLeft = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

    if (daysLeft < 0) {
      // Trial expired logic
      this.showTrialExpired();
      return;
    }

    // Determine Color
    let colorClass = 'bg-[#81c995]/20 text-[#81c995] border-[#81c995]/30'; // Green
    if (daysLeft <= 10 && daysLeft >= 6) {
      colorClass = 'bg-[#ffb95f]/20 text-[#ffb95f] border-[#ffb95f]/30'; // Yellow
    } else if (daysLeft <= 5) {
      colorClass = 'bg-error/20 text-error border-error/30 animate-pulse'; // Red
    }

    // Inject Banner into Header
    const header = document.querySelector('header') || document.querySelector('.pt-16'); // fallback to padding-top container
    if (header) {
      const banner = document.createElement('div');
      banner.className = `fixed top-0 left-0 right-0 md:left-[280px] z-[50] flex items-center justify-center px-4 py-1.5 border-b backdrop-blur-md cursor-pointer transition-colors ${colorClass}`;
      banner.innerHTML = `
        <span class="material-symbols-outlined text-[16px] mr-2">timer</span>
        <span class="text-xs font-bold uppercase tracking-wide">Free Trial • ${daysLeft} Days Left</span>
        <span class="material-symbols-outlined text-[16px] ml-2 opacity-50">arrow_forward</span>
      `;
      banner.onclick = () => window.location.href = '/settings#subscription';
      document.body.appendChild(banner);
      
      // Adjust body padding to accommodate banner
      document.body.style.paddingTop = 'calc(4rem + 32px)';
    }

    // Phase 6 logic: Modal Reminders
    const lastReminder = localStorage.getItem('trial_reminder_shown');
    const today = new Date().toDateString();

    if (daysLeft <= 5 && lastReminder !== today) {
      setTimeout(() => this.showTrialReminder(daysLeft), 2000);
      localStorage.setItem('trial_reminder_shown', today);
    }
  }

  showTrialReminder(daysLeft) {
    const modal = document.createElement('div');
    modal.className = 'fixed inset-0 z-[100000] bg-background/80 backdrop-blur-sm flex items-center justify-center p-4';
    modal.innerHTML = `
      <div class="glass-panel w-full max-w-md rounded-2xl p-8 text-center shadow-2xl border border-error/30 animate-in zoom-in-95 duration-300">
        <div class="w-16 h-16 rounded-full bg-error/20 text-error flex items-center justify-center mx-auto mb-4">
          <span class="material-symbols-outlined text-[32px]">warning</span>
        </div>
        <h3 class="text-2xl font-bold text-on-surface mb-2">${daysLeft} Days Left</h3>
        <p class="text-on-surface-variant mb-6">Your free trial is ending soon. Subscribe now to ensure uninterrupted access to Gym Flow and keep your business running smoothly.</p>
        <div class="flex gap-3">
          <button class="flex-1 py-2 rounded-xl text-on-surface-variant hover:bg-surface-container" onclick="this.closest('.fixed').remove()">Later</button>
          <button class="flex-1 py-2 rounded-xl bg-primary text-on-primary font-bold hover:bg-primary/90" onclick="window.location.href='/settings#subscription'">Upgrade Now</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
  }

  showTrialExpired() {
    const modal = document.createElement('div');
    modal.className = 'fixed inset-0 z-[100000] bg-background backdrop-blur-xl flex items-center justify-center p-4';
    modal.innerHTML = `
      <div class="glass-panel w-full max-w-lg rounded-2xl p-10 text-center shadow-2xl border border-error/50">
        <div class="w-20 h-20 rounded-full bg-error/20 text-error flex items-center justify-center mx-auto mb-6">
          <span class="material-symbols-outlined text-[40px]">lock</span>
        </div>
        <h3 class="text-3xl font-bold text-on-surface mb-3">Trial Expired</h3>
        <p class="text-on-surface-variant mb-8 text-lg">Your 21-day free trial has concluded. Please choose a subscription plan to regain access to your workspace and member data.</p>
        <button class="w-full py-4 rounded-xl bg-primary text-on-primary font-bold text-lg hover:bg-primary/90 shadow-lg shadow-primary/20" onclick="window.location.href='/settings#subscription'">
          View Subscription Plans
        </button>
      </div>
    `;
    document.body.appendChild(modal);
  }
}

// Initialize on load
document.addEventListener('DOMContentLoaded', () => {
  window.onboarding = new GymOnboarding();
});
