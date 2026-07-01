/**
 * WhatsApp Outbound Queue
 * -----------------------------------------------------------------------------
 * Guarantees messages are sent ONE AT A TIME per tenant (never simultaneously),
 * with a configurable delay between sends and automatic retry of transient
 * failures. Every job updates its `notifications` row so the outbox reflects the
 * real delivery state (Delivered / Failed / Pending-retry), the failure reason,
 * and the retry count.
 *
 *   enqueue -> [job, job, job] -> send -> wait(SEND_DELAY_MS) -> next
 *
 * If the tenant's WhatsApp drops mid-drain, the queue PAUSES and resumes itself
 * automatically once the service reconnects (service.onReady).
 */

const service = require('./whatsapp.service');
const session = require('./whatsapp.session');
const { runQuery } = require('../database');

const queues = new Map(); // tenantId -> { jobs: [], processing: bool, paused: bool }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Failures that will never succeed on retry — fail the job immediately.
const NON_RETRYABLE = new Set(['INVALID_PHONE', 'NOT_ON_WHATSAPP']);

function q(tenantId) {
  let queue = queues.get(tenantId);
  if (!queue) {
    queue = { jobs: [], processing: false, paused: false };
    queues.set(tenantId, queue);
  }
  return queue;
}

async function updateLog(notificationId, tenantId, status, reason, retryCount) {
  if (!notificationId) return;
  try {
    await runQuery(
      `UPDATE notifications SET delivery_status = ?, failure_reason = ?, retry_count = ?
         WHERE id = ? AND tenant_id = ?`,
      [status, reason || null, retryCount || 0, notificationId, tenantId]
    );
  } catch (e) {
    console.error('[whatsapp.queue] log update failed:', e.message);
  }
}

/**
 * Add a message to a tenant's outbound queue.
 * @returns {Promise<{success:boolean, messageId?:string, error?:string, retries:number}>}
 *   Resolves when this specific message reaches a terminal state. Callers that
 *   want fire-and-forget behaviour (cron, campaigns) can simply not await it.
 */
function enqueue(tenantId, { phone, message, notificationId }) {
  return new Promise((resolve) => {
    const queue = q(tenantId);
    queue.jobs.push({ phone, message, notificationId, attempts: 0, resolve });
    drain(tenantId);
  });
}

async function drain(tenantId) {
  const queue = q(tenantId);
  if (queue.processing) return;
  queue.processing = true;
  queue.paused = false;

  while (queue.jobs.length) {
    // No live connection — hold the queue and wait for service.onReady to resume.
    if (!service.isConnected(tenantId)) {
      queue.processing = false;
      queue.paused = true;
      return;
    }

    const job = queue.jobs[0];
    try {
      const res = await service.sendMessageNow(tenantId, job.phone, job.message);
      queue.jobs.shift();
      await updateLog(job.notificationId, tenantId, 'Delivered', null, job.attempts);
      job.resolve({ success: true, messageId: res.messageId, retries: job.attempts });
    } catch (err) {
      const code = err.code;

      // Connection dropped mid-send: pause and let reconnect resume us. Keep the
      // job at the head of the queue so nothing is lost.
      if (code === 'NOT_CONNECTED') {
        queue.processing = false;
        queue.paused = true;
        return;
      }

      const canRetry = !NON_RETRYABLE.has(code) && job.attempts < session.MAX_RETRIES;
      if (canRetry) {
        job.attempts += 1;
        await updateLog(job.notificationId, tenantId, 'Pending', 'Retry ' + job.attempts + ': ' + err.message, job.attempts);
        await sleep(session.RETRY_DELAY_MS);
        continue; // retry the same job (still at head)
      }

      // Terminal failure.
      queue.jobs.shift();
      await updateLog(job.notificationId, tenantId, 'Failed', err.message, job.attempts);
      job.resolve({ success: false, error: err.message, retries: job.attempts });
    }

    // Throttle between distinct messages so we never send simultaneously.
    if (queue.jobs.length) await sleep(session.SEND_DELAY_MS);
  }

  queue.processing = false;
}

// Resume a paused queue when the tenant reconnects.
function resume(tenantId) {
  const queue = queues.get(tenantId);
  if (queue && queue.paused && queue.jobs.length) {
    console.log(`[whatsapp.queue][${tenantId}] Connection restored — resuming ${queue.jobs.length} queued message(s).`);
    drain(tenantId);
  }
}

// Wire the service -> queue resume hook.
service.onReady = (tenantId) => resume(tenantId);

function pendingCount(tenantId) {
  const queue = queues.get(tenantId);
  return queue ? queue.jobs.length : 0;
}

module.exports = { enqueue, resume, pendingCount };
