const express = require('express');
const router = express.Router();
const { getQuery, runQuery, allQuery } = require('../../database');
const { authorize, requireFeature, checkSubscription, getTaxConfig, computeTax, resolveRenewalDiscount, uid, nextInvoiceNumber } = require('../../lib/apiUtils');
const { dispatchWhatsAppAsync } = require('../../services/whatsappJobs');

// Temporary aliases for missing dependencies
const { PLANS, isRazorpayConfigured, createOrder, verifyPaymentSignature, fetchOrder, cancelSubscription } = require('../../lib/razorpay');
const { getTodayString, getLastNDaysString, getNextNDaysString } = require('../../lib/dateUtils');
const engine = require('../../lib/membershipEngine');
const whatsappCloud = require('../../services/whatsappCloud.service');
const waSettings = require('../../services/whatsappSettings');
const waAutomations = require('../../services/whatsappAutomations');
const { PLAN_LIMITS, PLAN_PRICES, PURCHASABLE_PLANS, resolvePlan, getPlan } = require('../../lib/billingPlans');
const billing = require('../../lib/billingState');

// ---------------------------------------------------------------------------
// Group: marketing
// ---------------------------------------------------------------------------

// Marketing dashboard stats
router.get('/marketing/dashboard', async (req, res) => {
  try {
    const totalSent = await getQuery(`SELECT COUNT(*) as count FROM notifications WHERE recipient_phone IS NOT NULL AND recipient_phone != '' AND tenant_id = ? `, [req.tenant_id]);
    const delivered = await getQuery(`SELECT COUNT(*) as count FROM notifications WHERE delivery_status = 'Delivered' AND recipient_phone IS NOT NULL AND recipient_phone != '' AND tenant_id = ? `, [req.tenant_id]);
    const failed = await getQuery(`SELECT COUNT(*) as count FROM notifications WHERE delivery_status = 'Failed' AND recipient_phone IS NOT NULL AND recipient_phone != '' AND tenant_id = ? `, [req.tenant_id]);

    const expiryReminders = await getQuery(`SELECT COUNT(*) as count FROM notifications WHERE campaign_source = 'Auto Expiry Reminder' AND tenant_id = ? `, [req.tenant_id]);
    const inactiveReminders = await getQuery(`SELECT COUNT(*) as count FROM notifications WHERE campaign_source = 'Auto Absence Recovery' AND tenant_id = ? `, [req.tenant_id]);
    const paymentReminders = await getQuery(`SELECT COUNT(*) as count FROM notifications WHERE campaign_source = 'Auto Payment Collection' AND tenant_id = ? `, [req.tenant_id]);
    const welcomeMessages = await getQuery(`SELECT COUNT(*) as count FROM notifications WHERE (title LIKE 'WhatsApp: welcome%' OR (campaign_source = 'Direct Message' AND message LIKE '%welcome%')) AND tenant_id = ? `, [req.tenant_id]);

    const campaignStats = await getQuery(`
      SELECT campaign_source, COUNT(*) as count 
      FROM notifications 
      WHERE recipient_phone IS NOT NULL AND recipient_phone != ''
       AND tenant_id = ? GROUP BY campaign_source
    `, [req.tenant_id]);

    const activeCampaigns = await getQuery(`SELECT COUNT(*) as count FROM campaigns WHERE tenant_id = ? `, [req.tenant_id]);
    const recentBroadcasts = await allQuery(`SELECT * FROM campaigns  WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 5`, [req.tenant_id]);

    res.json({
      totalSent: totalSent.count || 0,
      delivered: delivered.count || 0,
      failed: failed.count || 0,
      expiryReminders: expiryReminders.count || 0,
      inactiveReminders: inactiveReminders.count || 0,
      paymentReminders: paymentReminders.count || 0,
      welcomeMessages: welcomeMessages.count || 0,
      campaignStats,
      activeCampaigns: activeCampaigns.count || 0,
      recentBroadcasts
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database query error.' });
  }
});

// Marketing logs outbox
router.get('/marketing/outbox', async (req, res) => {
  try {
    const logs = await allQuery(`
      SELECT * FROM notifications 
      WHERE recipient_phone IS NOT NULL AND recipient_phone != ''
       AND tenant_id = ? ORDER BY created_at DESC
    `, [req.tenant_id]);
    res.json(logs);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database query error.' });
  }
});

// Send WhatsApp message API
router.post('/whatsapp/send', async (req, res) => {
  const plan = req.subscription.subscription_plan || 'trial';
  const limits = PLAN_LIMITS[plan];

  if (!limits.allowWhatsApp) {
    return res.status(403).json({
      error: "WhatsApp Automation is a premium feature. Please upgrade to Pro or Enterprise plan to enable it."
    });
  }

  try {
    const sentCountRow = await getQuery(
      `SELECT COUNT(*) as count FROM notifications 
       WHERE tenant_id = ? AND recipient_phone IS NOT NULL AND recipient_phone != '' 
         AND strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now', 'localtime')`,
      [req.tenant_id]
    );
    const currentSent = sentCountRow.count || 0;
    if (currentSent >= limits.maxWhatsAppMessages) {
      return res.status(403).json({
        error: `Monthly WhatsApp message limit reached (${limits.maxWhatsAppMessages}/month). Please upgrade your plan to increase limits.`
      });
    }
  } catch (err) {
    return res.status(500).json({ error: 'Failed to verify WhatsApp limits.' });
  }
  const { member_id, template_id, custom_message, type } = req.body;

  if (!member_id || !template_id) {
    return res.status(400).json({ error: 'Member ID and Template ID are required.' });
  }

  try {
    const member = await getQuery(`SELECT * FROM members WHERE id = ? AND tenant_id = ? `, [member_id, req.tenant_id]);
    if (!member) {
      return res.status(404).json({ error: 'Member not found.' });
    }

    let messageText = '';
    const gymNameRow = await getQuery(`SELECT setting_value FROM settings WHERE setting_key = 'gym_name' AND tenant_id = ? `, [req.tenant_id]);
    const gymName = gymNameRow ? gymNameRow.setting_value : '${gymName}';

    if (custom_message) {
      messageText = custom_message;
    } else {
      if (template_id === 'welcome') {
        messageText = `Hello *${member.full_name}*, welcome to *${gymName}*! Your profile is set up. Let's crush those fitness goals! 💪`;
      } else if (template_id === 'expiry') {
        const ms = await getQuery(`SELECT * FROM memberships WHERE member_id = ?  AND tenant_id = ? ORDER BY created_at DESC LIMIT 1`, [member_id, req.tenant_id]);
        const endDate = ms ? ms.end_date : 'N/A';
        messageText = `Hi *${member.full_name}*, this is a friendly reminder from *${gymName}*. Your membership is expiring on *${endDate}*. Renew today to keep training! 🏋️‍♂️`;
      } else if (template_id === 'payment') {
        const inv = await getQuery(`SELECT * FROM invoices WHERE member_id = ? AND status = 'Unpaid'  AND tenant_id = ? ORDER BY created_at DESC LIMIT 1`, [member_id, req.tenant_id]);
        const amount = inv ? inv.total_amount : '0';
        const invNum = inv ? inv.invoice_number : 'N/A';
        messageText = `Hi *${member.full_name}*, you have a pending payment of *₹${amount}* for Invoice *${invNum}* at *${gymName}*. Please clear it at your earliest convenience. Thank you!`;
      } else if (template_id === 'inactive') {
        const lastAtt = await allQuery(`SELECT MAX(check_in) as last_visit FROM attendance WHERE member_id = ? AND tenant_id = ? `, [member_id, req.tenant_id]);
        let absenceDays = 5;
        if (lastAtt && lastAtt.last_visit) {
          absenceDays = Math.floor((new Date() - new Date(lastAtt.last_visit)) / (1000 * 60 * 60 * 24));
        } else {
          absenceDays = Math.floor((new Date() - new Date(member.created_at)) / (1000 * 60 * 60 * 24));
        }
        if (absenceDays < 0) absenceDays = 0;
        messageText = `Hello *${member.full_name}*, we missed you at *${gymName}*! You haven't checked in for *${absenceDays}* days. Is everything okay? Let us know if you need help getting back on track! 🤝`;
      } else if (template_id === 'festival') {
        messageText = `Dear *${member.full_name}*, warm greetings from *${gymName}*! Celebrate this festival season with a healthy lifestyle. Special 20% discount on annual renewals this week! 🌟`;
      } else {
        messageText = `Hello *${member.full_name}*, message from *${gymName}*!`;
      }
    }

    const normalizedPhone = whatsappCloud.validateAndNormalizePhone(member.phone);
    const ntId = 'nt' + Date.now() + Math.floor(Math.random() * 1000);
    
    if (!normalizedPhone) {
      // Log as failed immediately
      await runQuery(`
        INSERT INTO notifications (id, tenant_id, type, priority, title, message, is_read, recipient_name, recipient_phone, delivery_status, campaign_source)
        VALUES (?, ?, ?, 'Medium', ?, ?, 1, ?, ?, 'Failed', 'Direct Message')
      `, [ntId, req.tenant_id, type || 'Marketing', `WhatsApp: ${template_id}`, messageText, member.full_name, member.phone || '']);
      return res.status(400).json({ error: 'Invalid phone number format.' });
    }

    // Insert as Pending
    await runQuery(`
      INSERT INTO notifications (id, tenant_id, type, priority, title, message, is_read, recipient_name, recipient_phone, delivery_status, campaign_source)
      VALUES (?, ?, ?, 'Medium', ?, ?, 1, ?, ?, 'Pending', 'Direct Message')
    `, [ntId, req.tenant_id, type || 'Marketing', `WhatsApp: ${template_id}`, messageText, member.full_name, normalizedPhone]);

    // Send via the REAL WhatsApp background queue. It serializes/retries and writes the final
    // delivery_status + failure_reason + retry_count to the notification row itself.
    await dispatchWhatsAppAsync(req.tenant_id, normalizedPhone, messageText, ntId);
    const sendResult = { success: true }; // Queue accepted it

    if (type === 'Attendance') {
      const reId = 're' + Date.now();
      const outcome = sendResult.success ? 'Message Delivered' : 'Message Failed';
      await runQuery(`
        INSERT INTO retention_events (id, tenant_id, member_id, risk_level, absence_days, last_contacted_at, contact_channel, notes, outcome)
        VALUES (?, ?, ?, 'Medium', 10, ?, 'WhatsApp', ?, ?)
      `, [reId, req.tenant_id, member_id, getTodayString(), `Auto-sent WhatsApp template: ${template_id}`, outcome]);
    }

    if (sendResult.success) {
      res.json({
        success: true,
        message: 'WhatsApp message sent successfully via provider.',
        messageId: sendResult.messageId
      });
    } else {
      res.status(502).json({
        success: false,
        error: `Provider failed to send WhatsApp message: ${sendResult.error}`
      });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to process WhatsApp request.' });
  }
});

// ==========================================
// CAMPAIGNS API
// ==========================================
router.get('/campaigns', async (req, res) => {
  try {
    const campaigns = await allQuery(`SELECT * FROM campaigns  WHERE tenant_id = ? ORDER BY created_at DESC`, [req.tenant_id]);
    res.json(campaigns);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to retrieve campaigns.' });
  }
});

router.post('/campaigns', requireFeature('allowMarketing', 'Marketing campaigns'), async (req, res) => {
  const { name, channel, audience, message, poster_url, image_data } = req.body;
  const id = uid('cam_');

  try {
    let members = [];
    if (audience === 'Active Only' || audience === 'Active') {
      members = await allQuery(`SELECT * FROM members WHERE status = 'Active' AND tenant_id = ? `, [req.tenant_id]);
    } else if (audience === 'Expiring Soon') {
      members = await allQuery(`
        SELECT m.* 
        FROM members m 
        JOIN memberships ms ON m.id = ms.member_id 
        WHERE ms.status = 'Active' 
          AND date(ms.end_date) >= '${getTodayString()}' 
          AND date(ms.end_date) <= '${getNextNDaysString(7)}'
       AND m.tenant_id = ? `, [req.tenant_id]);
    } else if (audience === 'Inactive Members') {
      members = await allQuery(`
        SELECT m.* FROM members m 
        WHERE m.status = 'Expired' 
           OR m.id NOT IN (
             SELECT DISTINCT member_id FROM attendance 
             WHERE date(check_in) >= '${getLastNDaysString(5)}'
           )
       AND tenant_id = ? `, [req.tenant_id]);
    } else {
      members = await allQuery(`SELECT * FROM members WHERE tenant_id = ? `, [req.tenant_id]);
    }

    const sentCount = members.length;

    // WhatsApp campaigns need the centralized Cloud API to be configured on the
    // platform — fail fast with a clear message instead of recording a campaign
    // full of "Failed" rows.
    if ((channel || 'WhatsApp').toLowerCase().includes('whatsapp') && !whatsappCloud.isConfigured()) {
      return res.status(409).json({ error: 'WhatsApp messaging is not available yet — the platform WhatsApp service is being configured. Please try again later or contact support.' });
    }

    let actualSentCount = 0;
    for (const m of members) {
      const personalizedMsg = message.replace(/{name}/g, m.full_name);
      const ntIdOutbox = 'nt_out' + Date.now() + Math.floor(Math.random() * 10000);
      const normalizedPhone = whatsappCloud.validateAndNormalizePhone(m.phone);
      
      if (!normalizedPhone) {
        await runQuery(`
          INSERT INTO notifications (id, tenant_id, type, priority, title, message, is_read, recipient_name, recipient_phone, delivery_status, campaign_source)
          VALUES (?, ?, 'Marketing', 'Medium', ?, ?, 1, ?, ?, 'Failed', ?)
        `, [ntIdOutbox, req.tenant_id, `Campaign: ${name}`, personalizedMsg, m.full_name, m.phone || '', name]);
      } else {
        await runQuery(`
          INSERT INTO notifications (id, tenant_id, type, priority, title, message, is_read, recipient_name, recipient_phone, delivery_status, campaign_source)
          VALUES (?, ?, 'Marketing', 'Medium', ?, ?, 1, ?, ?, 'Pending', ?)
        `, [ntIdOutbox, req.tenant_id, `Campaign: ${name}`, personalizedMsg, m.full_name, normalizedPhone, name]);
        
        // Queue the real send (fire-and-forget). Per-recipient delivery status is
        // written to its notification row by the queue as it drains.
        await dispatchWhatsAppAsync(req.tenant_id, normalizedPhone, personalizedMsg, ntIdOutbox);
        actualSentCount++;
      }
    }

    await runQuery(`
      INSERT INTO campaigns (id, tenant_id, name, channel, audience_filter, message_body, poster_url, status, sent_count, open_rate_percent, conversion_rate_percent, image_data)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'Completed', ?, 0.0, 0.0, ?)
    `, [id, req.tenant_id, name, channel || 'WhatsApp', audience || 'All Members', message, poster_url || '', actualSentCount, image_data || '']);

    res.status(201).json({ message: 'Campaign dispatched successfully.', campaignId: id, sentCount: actualSentCount });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Campaign dispatch failure.' });
  }
});

// Templates CRUD APIs
router.get('/templates', async (req, res) => {
  try {
    const templates = await allQuery(`SELECT * FROM templates  WHERE tenant_id = ? ORDER BY created_at ASC`, [req.tenant_id]);
    res.json(templates);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to retrieve templates.' });
  }
});

router.put('/templates/:id', async (req, res) => {
  const { message_body } = req.body;
  try {
    await runQuery(`UPDATE templates SET message_body = ? WHERE id = ? AND tenant_id = ? `, [message_body, req.params.id, req.tenant_id]);
    res.json({ message: 'Template updated successfully.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update template.' });
  }
});

// 4. WhatsApp Communication Center History
router.get('/communications/history', async (req, res) => {
  try {
    const history = await allQuery(`
      SELECT id, type as category, title, message, recipient_name, recipient_phone, delivery_status as status, campaign_source, created_at
      FROM notifications
      WHERE recipient_name IS NOT NULL
       AND tenant_id = ? ORDER BY created_at DESC
    `, [req.tenant_id]);

    const stats = { Sent: 0, Delivered: 0, Read: 0, Failed: 0 };
    history.forEach((h) => {
      if (stats[h.status] !== undefined) stats[h.status]++;
    });

    res.json({ stats, history });
  } catch (err) {
    console.error('[communications/history] error:', err && err.message);
    res.status(500).json({ error: 'Failed to load communication history.' });
  }
});

module.exports = router;
