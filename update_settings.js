const fs = require('fs');
let code = fs.readFileSync('settings_kinetic_enterprise/code.html', 'utf8');

const backupWidget = `
<!-- Backup & Restore -->
<div class="glass-panel p-stack-md rounded-xl border border-white/10 flex flex-col gap-stack-sm mb-6" id="backup-center-section">
    <div class="flex items-center gap-2 border-b border-white/5 pb-2">
        <span class="material-symbols-outlined text-tertiary">cloud_sync</span>
        <h3 class="font-title-lg text-title-lg text-on-surface">Data Backup & Recovery</h3>
    </div>
    <p class="font-body-md text-body-md text-on-surface-variant mb-4">Create snapshots of your database to protect against data loss.</p>
    
    <div class="flex gap-4 mb-4">
        <button id="btn-create-backup" class="px-4 py-2 bg-primary text-on-primary rounded font-label-md text-label-md hover:bg-primary/90 transition-colors flex items-center gap-2">
            <span class="material-symbols-outlined text-[18px]">backup</span> Create Backup
        </button>
    </div>

    <div class="bg-surface-container-lowest rounded-xl border border-outline-variant/30 overflow-hidden">
      <div class="overflow-x-auto">
        <table class="w-full text-left border-collapse text-sm">
          <thead>
            <tr class="border-b border-white/10 text-on-surface-variant font-medium bg-surface-container/50">
              <th class="py-3 px-4 font-label-md text-label-md">Filename</th>
              <th class="py-3 px-4 font-label-md text-label-md">Date</th>
              <th class="py-3 px-4 font-label-md text-label-md">Size</th>
              <th class="py-3 px-4 font-label-md text-label-md text-right">Action</th>
            </tr>
          </thead>
          <tbody id="backup-list-body" class="divide-y divide-white/5 text-on-surface">
            <tr>
                <td colspan="4" class="py-6 text-center text-on-surface-variant">Loading backups...</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
</div>
`;

// Insert the widget in the main settings grid (maybe at the end of the left column or right column)
// We'll append it before the close of the grid
const gridEnd = code.lastIndexOf('</div>\n</main>');
if (gridEnd !== -1) {
    code = code.substring(0, gridEnd) + '\n' + backupWidget + code.substring(gridEnd);
} else {
    // Fallback: append before </main>
    const mainEnd = code.indexOf('</main>');
    code = code.substring(0, mainEnd) + '\n' + backupWidget + '\n' + code.substring(mainEnd);
}

// Add Javascript logic for backups
const scriptEnd = code.lastIndexOf('</script>');
const scriptAdd = `
    async function loadBackups() {
        try {
            const res = await window.api.fetch('/api/v1/backup/list');
            if (!res.ok) return;
            const files = await res.json();
            const tbody = document.getElementById('backup-list-body');
            tbody.innerHTML = '';
            
            if (files.length === 0) {
                tbody.innerHTML = '<tr><td colspan="4" class="py-6 text-center text-on-surface-variant">No backups available.</td></tr>';
                return;
            }
            
            files.forEach(f => {
                const tr = document.createElement('tr');
                tr.innerHTML = \`
                    <td class="py-3 px-4 font-body-sm font-mono text-xs">\${f.name}</td>
                    <td class="py-3 px-4 font-body-sm">\${new Date(f.created).toLocaleString()}</td>
                    <td class="py-3 px-4 font-body-sm">\${f.size}</td>
                    <td class="py-3 px-4 text-right">
                        <button class="px-3 py-1 bg-surface-variant text-on-surface hover:bg-surface-container-highest rounded-lg transition-colors font-label-sm text-label-sm download-backup-btn" data-file="\${f.name}">Download</button>
                    </td>
                \`;
                tbody.appendChild(tr);
            });
            
            document.querySelectorAll('.download-backup-btn').forEach(btn => {
                btn.onclick = () => {
                    const file = btn.getAttribute('data-file');
                    window.location.href = '/api/v1/backup/download/' + file;
                };
            });
        } catch(e) { console.error(e); }
    }
    
    setTimeout(loadBackups, 1000);
    
    const createBtn = document.getElementById('btn-create-backup');
    if (createBtn) {
        createBtn.onclick = async () => {
            createBtn.disabled = true;
            createBtn.innerText = 'Creating...';
            try {
                const res = await window.api.fetch('/api/v1/backup/create', { method: 'POST' });
                const data = await res.json();
                if (data.success) {
                    alert('Backup created successfully!');
                    loadBackups();
                } else {
                    alert('Failed to create backup.');
                }
            } catch(e) {
                console.error(e);
            }
            createBtn.innerText = 'Create Backup';
            createBtn.disabled = false;
        };
    }
`;

code = code.substring(0, scriptEnd) + '\n' + scriptAdd + '\n' + code.substring(scriptEnd);
fs.writeFileSync('settings_kinetic_enterprise/code.html', code);
console.log('Inserted Backup UI into settings');
