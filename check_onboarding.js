const { getQuery, allQuery } = require('./database');

async function check() {
  const tenants = await allQuery(`SELECT id, gym_name, onboarding_completed FROM tenants`);
  console.log('Tenants:', tenants);
  for (const t of tenants) {
    console.log(`Tenant ${t.id} (${t.gym_name}): onboarding_completed = ${t.onboarding_completed}`);
  }
}

check().catch(console.error);