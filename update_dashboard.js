const fs = require('fs');
let code = fs.readFileSync('dashboard_kinetic_enterprise/code.html', 'utf8');

const alertWidget = `
  <!-- ═══════════════════════════════════════════════════════ -->
  <!-- BUSINESS ALERTS ENGINE -->
  <!-- ═══════════════════════════════════════════════════════ -->
  <div class="glass-card p-6 rounded-xl border border-outline-variant/30 flex flex-col mb-6">
    <div class="flex justify-between items-center mb-6">
      <div class="flex items-center gap-2">
        <span class="material-symbols-outlined text-error text-[24px]">notifications_active</span>
        <h3 class="font-title-lg text-title-lg text-on-surface">Business Alerts</h3>
      </div>
      <span class="px-2 py-0.5 rounded-full bg-error/10 text-error border border-error/20 font-label-sm text-label-sm animate-pulse" id="alert-count-badge">0 Active</span>
    </div>
    <div class="flex flex-col gap-3" id="alerts-container">
      <p class="font-body-md text-body-md text-on-surface-variant text-center py-4">Scanning business health...</p>
    </div>
  </div>
`;

// Insert the widget before the main chart area
const insertPoint = code.indexOf('<!-- ═══════════════════════════════════════════════════════ -->\n  <!-- MAIN CHART AREA & BREAKDOWNS -->');
if (insertPoint !== -1) {
    code = code.substring(0, insertPoint) + alertWidget + '\n  ' + code.substring(insertPoint);
} else {
    // Fallback: append after KPI bar
    const kpiEnd = code.indexOf('<!-- KPI 8: ARPU -->');
    const kpiContainerEnd = code.indexOf('</div>', kpiEnd) + 6;
    code = code.substring(0, kpiContainerEnd) + '\n\n' + alertWidget + code.substring(kpiContainerEnd);
}

// Add the script to fetch alerts
const scriptStart = code.indexOf('<script>');
const scriptAdd = `
    async function loadAlerts() {
        try {
            const res = await window.api.fetch('/analytics/alerts');
            const alerts = await res.json();
            const container = document.getElementById('alerts-container');
            const badge = document.getElementById('alert-count-badge');
            
            if (alerts.length === 0) {
                badge.innerText = '0 Active';
                badge.className = 'px-2 py-0.5 rounded-full bg-[#81c995]/10 text-[#81c995] border border-[#81c995]/20 font-label-sm text-label-sm';
                container.innerHTML = '<div class="flex items-center gap-2 justify-center py-4 text-[#81c995]"><span class="material-symbols-outlined text-[20px]">check_circle</span><p class="font-body-md text-body-md">All systems healthy. No critical alerts.</p></div>';
                return;
            }
            
            badge.innerText = alerts.length + ' Active';
            container.innerHTML = '';
            alerts.forEach(a => {
                let colorClass = a.type === 'error' ? 'error' : (a.type === 'warning' ? 'tertiary' : 'primary');
                let icon = a.type === 'error' ? 'error' : (a.type === 'warning' ? 'warning' : 'info');
                
                container.innerHTML += \`
                    <div class="flex items-start gap-3 p-3 rounded-lg border border-\${colorClass}/20 bg-\${colorClass}/5 hover:bg-\${colorClass}/10 transition-colors">
                        <span class="material-symbols-outlined text-\${colorClass} shrink-0 mt-0.5" style="font-variation-settings: 'FILL' 1;">\${icon}</span>
                        <div>
                            <h4 class="font-label-md text-label-md text-on-surface font-bold">\${a.title}</h4>
                            <p class="font-body-sm text-body-sm text-on-surface-variant mt-0.5">\${a.message}</p>
                        </div>
                    </div>
                \`;
            });
        } catch(err) { console.error(err); }
    }
    loadAlerts();
`;
const initIndex = code.indexOf('loadDashboardData(1);');
code = code.substring(0, initIndex + 21) + '\n' + scriptAdd + code.substring(initIndex + 21);

fs.writeFileSync('dashboard_kinetic_enterprise/code.html', code);
console.log('Inserted Alert Center widget.');
