const fs = require('fs');
let code = fs.readFileSync('expiry_management_kinetic_enterprise/code.html', 'utf8');

// Update tabs
code = code.replace(/<button class=\"whitespace-nowrap.*Expiring Today.*<\/button>\n\s*<button.*Within 3 Days.*<\/button>\n\s*<button.*Within 7 Days.*<\/button>\n\s*<button.*Expired.*<\/button>/g,
`<button class="whitespace-nowrap px-4 py-2 rounded-full bg-tertiary-container/20 text-tertiary border border-tertiary/30 font-label-md text-label-md hover:bg-tertiary-container/30 transition-colors" data-filter="3">Within 3 Days</button>
<button class="whitespace-nowrap px-4 py-2 rounded-full glass-panel text-on-surface hover:bg-surface-variant/50 transition-colors font-label-md text-label-md" data-filter="7">Within 7 Days</button>
<button class="whitespace-nowrap px-4 py-2 rounded-full glass-panel text-on-surface hover:bg-surface-variant/50 transition-colors font-label-md text-label-md" data-filter="15">Within 15 Days</button>
<button class="whitespace-nowrap px-4 py-2 rounded-full glass-panel text-on-surface hover:bg-surface-variant/50 transition-colors font-label-md text-label-md" data-filter="30">Within 30 Days</button>
<button class="whitespace-nowrap px-4 py-2 rounded-full glass-panel text-error hover:bg-error-container/20 transition-colors font-label-md text-label-md" data-filter="Expired">Expired</button>`);

// Update the top stat card to 'Total Revenue At Risk'
code = code.replace(/Expected Renewal Revenue/g, 'Total Revenue At Risk');
code = code.replace(/<span class=\"font-display-lg text-display-lg break-words min-w-0 text-primary text-glow\">₹ 4.25L<\/span>/g, '<span id="revenue-at-risk-val" class="font-display-lg text-display-lg break-words min-w-0 text-primary text-glow">₹ 0</span>');
code = code.replace(/<span class=\"font-display-lg text-display-lg break-words min-w-0 text-on-surface\">142<\/span>/g, '<span id="total-expiring-val" class="font-display-lg text-display-lg break-words min-w-0 text-on-surface">0</span>');

// Replace the javascript logic
const scriptStart = code.indexOf('<script>');
const scriptEnd = code.indexOf('</script>') + 9;
const newScript = `<script>
document.addEventListener("DOMContentLoaded", function() {
    const tabs = document.querySelectorAll("main .flex.overflow-x-auto button");
    const container = document.querySelector(".grid.grid-cols-1.lg\\\\:grid-cols-2.xl\\\\:grid-cols-3.gap-stack-md");
    const sectionTitle = document.querySelector("main h3.font-title-lg");
    let membersList = [];
    let currentFilter = "3";

    tabs.forEach((tab) => {
        tab.addEventListener("click", () => {
            tabs.forEach(t => t.className = "whitespace-nowrap px-4 py-2 rounded-full glass-panel text-on-surface hover:bg-surface-variant/50 transition-colors font-label-md text-label-md");
            if (tab.innerText.includes("Expired")) {
                tab.className = "whitespace-nowrap px-4 py-2 rounded-full bg-error/20 text-error border border-error/30 font-label-md text-label-md";
            } else {
                tab.className = "whitespace-nowrap px-4 py-2 rounded-full bg-tertiary-container/20 text-tertiary border border-tertiary/30 font-label-md text-label-md hover:bg-tertiary-container/30 transition-colors";
            }
            
            currentFilter = tab.getAttribute('data-filter');
            if (sectionTitle) sectionTitle.innerText = tab.innerText.replace(/ \\(.*\\)/, '');
            renderCards();
        });
    });

    async function loadData() {
        try {
            const res = await window.api.fetch("/analytics/renewal-queue");
            const data = await res.json();
            membersList = data.queue;
            
            const atRiskElem = document.getElementById('revenue-at-risk-val');
            if(atRiskElem) atRiskElem.innerText = '₹ ' + data.totalRevenueAtRisk.toLocaleString();
            
            updateTabs();
            renderCards();
        } catch (err) {
            console.error(err);
        }
    }

    function updateTabs() {
        const within3 = membersList.filter(m => m.status === 'Active' && m.daysLeft <= 3 && m.daysLeft >= 0);
        const within7 = membersList.filter(m => m.status === 'Active' && m.daysLeft <= 7 && m.daysLeft >= 0);
        const within15 = membersList.filter(m => m.status === 'Active' && m.daysLeft <= 15 && m.daysLeft >= 0);
        const within30 = membersList.filter(m => m.status === 'Active' && m.daysLeft <= 30 && m.daysLeft >= 0);
        const expired = membersList.filter(m => m.status === 'Expired');

        if (tabs.length >= 5) {
            tabs[0].innerText = \`Within 3 Days (\${within3.length})\`;
            tabs[1].innerText = \`Within 7 Days (\${within7.length})\`;
            tabs[2].innerText = \`Within 15 Days (\${within15.length})\`;
            tabs[3].innerText = \`Within 30 Days (\${within30.length})\`;
            tabs[4].innerText = \`Expired (\${expired.length})\`;
        }

        const expVal = document.getElementById('total-expiring-val');
        if (expVal) expVal.innerText = within7.length;
    }

    function renderCards() {
        if (!container) return;
        container.innerHTML = "";

        let filtered = [];
        if (currentFilter === "3") filtered = membersList.filter(m => m.status === 'Active' && m.daysLeft <= 3 && m.daysLeft >= 0);
        else if (currentFilter === "7") filtered = membersList.filter(m => m.status === 'Active' && m.daysLeft <= 7 && m.daysLeft >= 0);
        else if (currentFilter === "15") filtered = membersList.filter(m => m.status === 'Active' && m.daysLeft <= 15 && m.daysLeft >= 0);
        else if (currentFilter === "30") filtered = membersList.filter(m => m.status === 'Active' && m.daysLeft <= 30 && m.daysLeft >= 0);
        else if (currentFilter === "Expired") filtered = membersList.filter(m => m.status === 'Expired');

        filtered.forEach(m => {
            const card = document.createElement("div");
            card.className = "glass-panel rounded-xl p-stack-md flex flex-col gap-stack-md relative overflow-hidden group hover:border-tertiary/40 transition-colors mt-4";
            
            let barColor = "bg-tertiary";
            let alertPulse = "animate-pulse";
            if (m.status === 'Expired') {
                barColor = "bg-error";
                alertPulse = "";
            }

            const photo = m.photo_url || "https://via.placeholder.com/150";
            const planName = m.plan_name || "Pro Annual";
            const probColor = m.renewalProbability === 'High' ? 'text-secondary' : (m.renewalProbability === 'Medium' ? 'text-tertiary' : 'text-error');

            card.innerHTML = \`
                <div class="absolute top-0 left-0 w-1 h-full \${barColor}"></div>
                <div class="flex items-center gap-stack-md pl-2">
                    <img class="w-16 h-16 rounded-full object-cover border border-white/10 shadow-lg" src="\${photo}"/>
                    <div class="flex-1">
                        <h4 class="font-headline-md text-headline-md text-on-surface">\${m.full_name}</h4>
                        <div class="flex items-center gap-2 mt-1">
                            <span class="px-2 py-0.5 rounded bg-surface-variant text-on-surface-variant font-label-md text-label-md uppercase text-[10px]">\${planName}</span>
                            <span class="px-2 py-0.5 rounded bg-tertiary-container/20 text-tertiary border border-tertiary/20 font-label-md text-label-md uppercase text-[10px] \${alertPulse}">\${m.daysLeft < 0 ? Math.abs(m.daysLeft) + ' Days Ago' : m.daysLeft + ' Days Left'}</span>
                        </div>
                    </div>
                </div>
                <div class="grid grid-cols-2 gap-y-stack-sm gap-x-4 py-stack-sm border-t border-b border-white/5 pl-2">
                    <div>
                        <p class="font-label-md text-label-md text-on-surface-variant">Renewal Prob</p>
                        <p class="font-body-md text-body-md \${probColor}">\${m.renewalProbability}</p>
                    </div>
                    <div>
                        <p class="font-label-md text-label-md text-on-surface-variant">Expected Rev</p>
                        <p class="font-body-md text-body-md text-primary font-medium">₹ \${(m.expectedRevenue || 0).toLocaleString()}</p>
                    </div>
                </div>
                <div class="flex items-center gap-stack-sm pl-2">
                    <button class="flex-1 bg-primary/10 text-primary border border-primary/30 font-label-md text-label-md py-2.5 rounded-lg hover:bg-primary hover:text-on-primary transition-all duration-300 renew-btn" data-id="\${m.member_id}">Renew</button>
                    <button class="w-10 h-10 flex items-center justify-center border border-white/10 rounded-lg text-on-surface-variant hover:text-secondary hover:border-secondary/50 hover:bg-secondary/10 transition-colors" title="Call">
                        <span class="material-symbols-outlined text-[20px]">call</span>
                    </button>
                    <button class="w-10 h-10 flex items-center justify-center border border-white/10 rounded-lg text-on-surface-variant hover:text-secondary hover:border-secondary/50 hover:bg-secondary/10 transition-colors" title="WhatsApp">
                        <span class="material-symbols-outlined text-[20px]">chat</span>
                    </button>
                </div>
            \`;

            card.querySelector(".renew-btn").onclick = () => {
                window.location.href = \`/renew?id=\${m.member_id}\`;
            };

            container.appendChild(card);
        });
    }

    loadData();
});
</script>`;

code = code.substring(0, scriptStart) + newScript + code.substring(scriptEnd);
fs.writeFileSync('expiry_management_kinetic_enterprise/code.html', code);
console.log('Updated expiry_management_kinetic_enterprise/code.html');
