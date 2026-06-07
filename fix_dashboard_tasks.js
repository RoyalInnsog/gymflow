const fs = require('fs');
let code = fs.readFileSync('dashboard_kinetic_enterprise/code.html', 'utf8');

// Find the "Today's Tasks Box"
const taskBoxStart = code.indexOf('<div class="p-4 space-y-3">');
if (taskBoxStart > -1) {
    const taskBoxEnd = code.indexOf('</div>\n<div class="p-4 border-t border-white/5 text-center mt-auto">', taskBoxStart);
    if (taskBoxEnd > -1) {
        code = code.substring(0, taskBoxStart + 27) + '\n<div id="tasks-container" class="space-y-3"></div>\n' + code.substring(taskBoxEnd);
    }
}

// Now inject fetch
const scriptInsertPoint = code.indexOf('} catch (e)');
if (scriptInsertPoint > -1) {
    const fetchTasks = `
      // Fetch Tasks
      const tasksRes = await window.api.fetch('/tasks');
      if (tasksRes.ok) {
        const tasks = await tasksRes.json();
        const container = document.getElementById('tasks-container');
        if (container) {
          if (tasks.length === 0) {
            container.innerHTML = '<p class="text-center text-on-surface-variant text-sm py-4">No tasks for today.</p>';
            document.querySelector('.bg-surface-variant.text-on-surface-variant.px-3.py-1').innerText = '0 Pending';
          } else {
            document.querySelector('.bg-surface-variant.text-on-surface-variant.px-3.py-1').innerText = tasks.length + ' Pending';
            container.innerHTML = tasks.slice(0, 5).map(t => \`
            <div class="group flex items-start gap-4 p-4 rounded-lg bg-surface-container/50 hover:bg-surface-container-high border border-transparent hover:border-white/10 transition-all cursor-pointer">
                <button class="mt-1 w-5 h-5 rounded border-2 border-outline-variant group-hover:border-primary flex items-center justify-center transition-colors" onclick="alert('Complete task function to be implemented')">
                    <span class="material-symbols-outlined text-[14px] text-transparent group-active:text-primary">check</span>
                </button>
                <div class="flex-1">
                    <div class="flex justify-between items-start mb-1">
                        <h4 class="font-body-lg text-body-lg font-medium text-on-surface">\${t.title}</h4>
                        <span class="text-xs px-2 py-1 rounded bg-tertiary/10 text-tertiary border border-tertiary/20">\${t.due_date ? new Date(t.due_date).toLocaleDateString() : 'N/A'}</span>
                    </div>
                    <p class="font-body-md text-body-md text-on-surface-variant line-clamp-1">\${t.description || ''}</p>
                </div>
            </div>
            \`).join('');
          }
        }
      }
    `;
    code = code.substring(0, scriptInsertPoint) + fetchTasks + "\n" + code.substring(scriptInsertPoint);
}

fs.writeFileSync('dashboard_kinetic_enterprise/code.html', code);
console.log('Fixed tasks in dashboard');
