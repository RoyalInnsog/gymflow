const queue = require('./backgroundQueue');
const whatsappCloud = require('./whatsappCloud.service');
const billing = require('../lib/billingState');
const { runQuery } = require('../database');

// Recovered dispatchWhatsApp logic
async function handleWhatsAppDispatch(tenantId, payload, job) {
  const { normalizedPhone, message, notificationId, media } = payload;
  
  // Note: quota was originally checked in synchronous route. 
  // We check again in background to ensure they didn't run out.
  const state = await billing.getBillingState(tenantId);
  if (!state.limits.allowWhatsApp || (state.allowance + state.extraCredits) <= 0) {
    await runQuery("UPDATE notifications SET delivery_status = 'Failed', failure_reason = ? WHERE id = ? AND tenant_id = ?",
      ['WhatsApp messaging is a Pro feature.', notificationId, tenantId]);
    return;
  }
  if (!whatsappCloud.isConfigured()) {
    await runQuery("UPDATE notifications SET delivery_status = 'Failed', failure_reason = ? WHERE id = ? AND tenant_id = ?",
      ['WhatsApp service is not configured.', notificationId, tenantId]);
    return;
  }

  const result = (media && media.link)
    ? await whatsappCloud.sendDocument(normalizedPhone, media.link, media.filename, media.caption || message)
    : await whatsappCloud.sendText(normalizedPhone, message);
    
  if (result.success) {
    await runQuery("UPDATE notifications SET delivery_status = 'Delivered', provider_message_id = ?, failure_reason = NULL WHERE id = ? AND tenant_id = ?",
      [result.messageId || null, notificationId, tenantId]);
    try { await billing.consumeWhatsAppCredit(tenantId, 1); } catch (e) {}
  } else {
    await runQuery("UPDATE notifications SET delivery_status = 'Failed', failure_reason = ? WHERE id = ? AND tenant_id = ?",
      [result.error || 'Send failed.', notificationId, tenantId]);
    throw new Error(result.error || 'WhatsApp send failed.');
  }
}

queue.register('whatsapp_dispatch', handleWhatsAppDispatch);

module.exports = {
  dispatchWhatsAppAsync: async (tenantId, normalizedPhone, message, notificationId, media = null) => {
    return queue.enqueue(tenantId, 'whatsapp_dispatch', { normalizedPhone, message, notificationId, media });
  }
};
const { getTodayString } = require('../lib/dateUtils');
const { resolveTemplate, escapeLike } = require('../lib/apiUtils');

const waSettings = require('./whatsappSettings');
const { allQuery, getQuery } = require('../database');

async function handleAutomationScan(tenantId, payload, job) {
  const feeReminderOn = await waSettings.isFeatureEnabled(tenantId, 'fee_reminder');

  try {
    const activeMemberships = await allQuery(
      "SELECT ms.id as membership_id, ms.member_id, ms.end_date, m.full_name, m.phone FROM memberships ms JOIN members m ON ms.member_id = m.id WHERE ms.status = 'Active' AND ms.tenant_id = ?",
      [tenantId]
    );

    const todayForScan = new Date().toISOString().split('T')[0];

    for (const ms of activeMemberships) {
      // Simplistic difference in days
      const d1 = new Date(ms.end_date);
      const d2 = new Date(todayForScan);
      const daysLeft = Math.floor((d1 - d2) / 86400000);

      if (daysLeft < 0) {
        await runQuery("UPDATE memberships SET status = 'Expired' WHERE id = ? AND tenant_id = ?", [ms.membership_id, tenantId]);
        await runQuery("UPDATE members SET status = 'Expired' WHERE id = ? AND tenant_id = ?", [ms.member_id, tenantId]);

        const alertExists = await getQuery("SELECT id FROM notifications WHERE type = 'Membership' AND title = 'Membership Expired' AND message LIKE ? AND tenant_id = ?", ['%' + ms.member_id + '%', tenantId]);
        if (!alertExists) {
          const ntId = 'nt' + Date.now() + Math.floor(Math.random() * 1000);
          await runQuery(
            "INSERT INTO notifications (id, tenant_id, type, priority, title, message, is_read) VALUES (?, ?, 'Membership', 'Critical', 'Membership Expired', ?, 0)",
            [ntId, tenantId, `Membership for ${ms.full_name} (${ms.member_id}) expired on ${ms.end_date}.`]
          );

          if (feeReminderOn) {
            const whatsappMsg = await resolveTemplate('whatsapp_expiry', { member_name: ms.full_name, end_date: ms.end_date }, tenantId);
            const normalizedPhone = whatsappCloud.validateAndNormalizePhone(ms.phone);
            const ntIdOutbox = 'nt_out' + Date.now() + Math.floor(Math.random() * 1000);

            if (!normalizedPhone) {
              await runQuery(
                "INSERT INTO notifications (id, tenant_id, type, priority, title, message, is_read, recipient_name, recipient_phone, delivery_status, campaign_source) VALUES (?, ?, 'Membership', 'Critical', 'WhatsApp: Membership Expired', ?, 1, ?, ?, 'Failed', 'Auto Expiry Reminder')",
                [ntIdOutbox, tenantId, whatsappMsg, ms.full_name, ms.phone || '']
              );
            } else {
              await runQuery(
                "INSERT INTO notifications (id, tenant_id, type, priority, title, message, is_read, recipient_name, recipient_phone, delivery_status, campaign_source) VALUES (?, ?, 'Membership', 'Critical', 'WhatsApp: Membership Expired', ?, 1, ?, ?, 'Pending', 'Auto Expiry Reminder')",
                [ntIdOutbox, tenantId, whatsappMsg, ms.full_name, normalizedPhone]
              );
              // Dispatch async
              await module.exports.dispatchWhatsAppAsync(tenantId, normalizedPhone, whatsappMsg, ntIdOutbox);
            }
          }
        }
      }
    }
  } catch(e) {
    console.error('[AutomationScan] error:', e);
  }
}

queue.register('automation_scan', handleAutomationScan);

module.exports.enqueueAutomationScan = (tenantId) => {
  return queue.enqueue(tenantId, 'automation_scan', {});
};
