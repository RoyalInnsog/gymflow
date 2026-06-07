const { runQuery } = require('./database');
(async () => {
  try {
    await runQuery("DROP TABLE IF EXISTS settings");
    await runQuery(`
      CREATE TABLE IF NOT EXISTS settings (
        setting_key TEXT,
        tenant_id TEXT,
        setting_value TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (setting_key, tenant_id)
      )
    `);
    console.log("Settings table recreated with correct composite primary key.");
  } catch (err) {
    console.error(err);
  }
})();
