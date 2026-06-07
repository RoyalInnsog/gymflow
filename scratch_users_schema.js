const { getQuery } = require('./database');
(async () => {
  const row = await getQuery("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'");
  console.log(row.sql);
})();
