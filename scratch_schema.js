const { getQuery } = require('./database');
(async () => {
  const row = await getQuery("SELECT sql FROM sqlite_master WHERE type='table' AND name='settings'");
  console.log(row.sql);
})();
