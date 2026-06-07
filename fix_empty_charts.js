const fs = require('fs');
let code = fs.readFileSync('dashboard_kinetic_enterprise/code.html', 'utf8');

code = code.replace(
  '<canvas id="revenueChart"></canvas>',
  `<canvas id="revenueChart"></canvas>
          <div id="revenueChart-empty" class="absolute inset-0 flex flex-col items-center justify-center bg-surface-container-high/80 rounded-xl hidden z-10 backdrop-blur-sm">
            <span class="material-symbols-outlined text-4xl text-on-surface-variant mb-2">monitoring</span>
            <p class="font-body-md text-on-surface-variant">No revenue data available</p>
          </div>`
);

code = code.replace(
  'const values = data.trend.map(t => t.revenue);',
  `const values = data.trend.map(t => t.revenue);
    const chartEmptyDiv = document.getElementById('revenueChart-empty');
    if (chartEmptyDiv) {
      if (!values || values.length === 0 || values.every(v => v === 0)) {
        chartEmptyDiv.classList.remove('hidden');
      } else {
        chartEmptyDiv.classList.add('hidden');
      }
    }`
);

fs.writeFileSync('dashboard_kinetic_enterprise/code.html', code);
console.log('Fixed revenue chart empty state');
