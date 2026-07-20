const { runQuery, allQuery } = require('../database');
const { uid } = require('../lib/apiUtils');

class BackgroundQueue {
  constructor() {
    this.handlers = {};
    this.isPolling = false;
    this.pollInterval = 5000;
    this.maxAttempts = 3;
  }
  register(type, handler) { this.handlers[type] = handler; }
  async enqueue(tenantId, type, payload) {
    const id = uid('job_');
    await runQuery("INSERT INTO background_jobs (id, tenant_id, type, payload, status) VALUES (?, ?, ?, ?, 'pending')", [id, tenantId, type, JSON.stringify(payload)]);
    return id;
  }
  start() {
    if (this.isPolling) return;
    this.isPolling = true;
    console.log('[Queue] Started background polling.');
    this.poll();
  }
  async poll() {
    if (!this.isPolling) return;
    try {
      const jobs = await allQuery("SELECT * FROM background_jobs WHERE status IN ('pending', 'failed') AND attempts < ? ORDER BY created_at ASC LIMIT 10", [this.maxAttempts]);
      for (const job of jobs) {
        await runQuery("UPDATE background_jobs SET status = 'processing', attempts = attempts + 1, locked_at = datetime('now') WHERE id = ?", [job.id]);
        try {
          const handler = this.handlers[job.type];
          if (!handler) throw new Error('No handler registered for job type: ' + job.type);
          const payload = JSON.parse(job.payload || '{}');
          await handler(job.tenant_id, payload, job);
          await runQuery("UPDATE background_jobs SET status = 'completed' WHERE id = ?", [job.id]);
        } catch (err) {
          console.error('[Queue] Job ' + job.id + ' failed:', err);
          const newStatus = (job.attempts + 1 >= this.maxAttempts) ? 'permanently_failed' : 'failed';
          await runQuery("UPDATE background_jobs SET status = ?, error = ? WHERE id = ?", [newStatus, String(err.message || err), job.id]);
        }
      }
    } catch (err) { console.error('[Queue] Poller error:', err); }
    setTimeout(() => this.poll(), this.pollInterval);
  }
}
module.exports = new BackgroundQueue();
