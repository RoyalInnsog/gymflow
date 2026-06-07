const fs = require('fs');
let code = fs.readFileSync('notifications_kinetic_enterprise/code.html', 'utf8');

// Change page title
code = code.replace(/<title>JSB Fitness - Notifications<\/title>/, '<title>JSB Fitness - Communication Center</title>');
code = code.replace(/<div id="jsb-header" data-page-title="Notifications"><\/div>/, '<div id="jsb-header" data-page-title="Communication Center"></div>');
code = code.replace(/<h2 class="font-headline-lg.*Notifications<\/h2>/, '<h2 class="font-headline-lg text-headline-lg-mobile md:text-headline-lg text-on-surface mb-unit">Communication Center</h2>');
code = code.replace(/<p class="font-body-md text-body-md text-on-surface-variant">Manage your facility alerts and system updates.<\/p>/, '<p class="font-body-md text-body-md text-on-surface-variant">Manage alerts and track outgoing member communications.</p>');

// Add Outbox Tab
code = code.replace(/<button class="whitespace-nowrap px-4 py-2 rounded-full bg-primary text-on-primary font-label-md text-label-md transition-colors">All<\/button>/, '<button class="whitespace-nowrap px-4 py-2 rounded-full bg-primary text-on-primary font-label-md text-label-md transition-colors">Internal Alerts</button>\n<button class="whitespace-nowrap px-4 py-2 rounded-full bg-surface-container border border-white/10 text-on-surface hover:bg-surface-variant transition-colors font-label-md text-label-md" id="tab-outbox">WhatsApp Outbox</button>');

// Add Outbox Container (Hidden by default)
const bentoGridIndex = code.indexOf('<!-- Bento Grid Layout -->');
code = code.substring(0, bentoGridIndex) + `
<!-- Communication Outbox (Hidden by default) -->
<div id="outbox-container" class="hidden flex-col gap-gutter">
  <div class="grid grid-cols-2 md:grid-cols-4 gap-gutter mb-6">
    <div class="glass-card p-4 rounded-xl text-center">
        <p class="font-label-md text-label-md text-on-surface-variant uppercase">Sent</p>
        <p class="font-title-lg text-title-lg text-on-surface mt-1" id="stat-sent">0</p>
    </div>
    <div class="glass-card p-4 rounded-xl text-center">
        <p class="font-label-md text-label-md text-on-surface-variant uppercase">Delivered</p>
        <p class="font-title-lg text-title-lg text-tertiary mt-1" id="stat-delivered">0</p>
    </div>
    <div class="glass-card p-4 rounded-xl text-center">
        <p class="font-label-md text-label-md text-on-surface-variant uppercase">Read</p>
        <p class="font-title-lg text-title-lg text-[#81c995] mt-1" id="stat-read">0</p>
    </div>
    <div class="glass-card p-4 rounded-xl text-center border-error/50 bg-error/5">
        <p class="font-label-md text-label-md text-on-surface-variant uppercase">Failed</p>
        <p class="font-title-lg text-title-lg text-error mt-1" id="stat-failed">0</p>
    </div>
  </div>
  <div class="bg-surface-container-lowest rounded-xl border border-outline-variant/30 overflow-hidden">
    <div class="overflow-x-auto">
      <table class="w-full text-left border-collapse text-sm">
        <thead>
          <tr class="border-b border-white/10 text-on-surface-variant font-medium bg-surface-container/50">
            <th class="py-3 px-4 font-label-md text-label-md">Timestamp</th>
            <th class="py-3 px-4 font-label-md text-label-md">Recipient</th>
            <th class="py-3 px-4 font-label-md text-label-md">Type</th>
            <th class="py-3 px-4 font-label-md text-label-md">Message</th>
            <th class="py-3 px-4 font-label-md text-label-md text-right">Status</th>
          </tr>
        </thead>
        <tbody id="outbox-table-body" class="divide-y divide-white/5 text-on-surface">
        </tbody>
      </table>
    </div>
  </div>
</div>
` + code.substring(bentoGridIndex);

// Update Script to handle tab switching
const scriptIndex = code.indexOf("let currentFilter = 'All';");
code = code.substring(0, scriptIndex) + `
    const bentoGrid = document.querySelector(".grid.grid-cols-1.lg\\\\:grid-cols-12.gap-gutter");
    const outboxContainer = document.getElementById("outbox-container");
` + code.substring(scriptIndex);

code = code.replace(/currentFilter = btn\.innerText;\n\s*loadNotifications\(\);/g, `
            currentFilter = btn.innerText;
            if (currentFilter === 'WhatsApp Outbox') {
                bentoGrid.classList.add('hidden');
                outboxContainer.classList.remove('hidden');
                outboxContainer.classList.add('flex');
                loadOutbox();
            } else {
                outboxContainer.classList.remove('flex');
                outboxContainer.classList.add('hidden');
                bentoGrid.classList.remove('hidden');
                loadNotifications();
            }
`);

const loadFuncIndex = code.indexOf('async function loadNotifications()');
code = code.substring(0, loadFuncIndex) + `
    async function loadOutbox() {
        try {
            const res = await window.api.fetch('/communications/history');
            const data = await res.json();
            
            document.getElementById('stat-sent').innerText = data.stats.Sent || 0;
            document.getElementById('stat-delivered').innerText = data.stats.Delivered || 0;
            document.getElementById('stat-read').innerText = data.stats.Read || 0;
            document.getElementById('stat-failed').innerText = data.stats.Failed || 0;
            
            const tbody = document.getElementById('outbox-table-body');
            tbody.innerHTML = '';
            
            if (data.history.length === 0) {
                tbody.innerHTML = '<tr><td colspan="5" class="py-8 text-center text-on-surface-variant">No communication history found.</td></tr>';
                return;
            }
            
            data.history.forEach(h => {
                const tr = document.createElement('tr');
                let statusColor = "text-on-surface";
                if (h.status === 'Delivered') statusColor = "text-tertiary";
                else if (h.status === 'Read') statusColor = "text-[#81c995]";
                else if (h.status === 'Failed') statusColor = "text-error";
                
                tr.innerHTML = "<td class='py-3 px-4 font-body-sm'>" + new Date(h.created_at).toLocaleString() + "</td>" +
                               "<td class='py-3 px-4 font-body-sm'>" + h.recipient_name + "<br><span class='text-xs text-on-surface-variant'>" + (h.recipient_phone || '') + "</span></td>" +
                               "<td class='py-3 px-4 font-body-sm'>" + (h.category || 'Auto') + "</td>" +
                               "<td class='py-3 px-4 font-body-sm max-w-xs truncate' title='" + h.message.replace(/'/g, "&#39;") + "'>" + h.message + "</td>" +
                               "<td class='py-3 px-4 font-label-sm text-right " + statusColor + "'>" + h.status + "</td>";
                tbody.appendChild(tr);
            });
        } catch(err) { console.error(err); }
    }
` + code.substring(loadFuncIndex);

fs.writeFileSync('notifications_kinetic_enterprise/code.html', code);
console.log('Updated notifications page to include Communication Center');
