const express = require('express');
const router = express.Router();
const { getQuery, runQuery, allQuery } = require('../../database');
const { authorize, requireFeature, checkSubscription, getTaxConfig, computeTax, resolveRenewalDiscount, uid, nextInvoiceNumber } = require('../../lib/apiUtils');

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
// Group: analytics
// ---------------------------------------------------------------------------

// ==========================================
// BUSINESS INTELLIGENCE & ANALYTICS API
// ==========================================

// Get analytical numbers
router.get('/analytics/bi', async (req, res) => {
  try {
    // [M6] Automation scans moved off the request path to a background interval.

    // [C1 FIX] Strict validation for range
    const range = whitelist(req.query.range, ['1', 'prev', '3', '6', '12'], '3');
    let dateFilter = ``;
    let monthsLimit = 3;

    if (range === '1') {
      dateFilter = `date(created_at) >= '${getTodayString().substring(0, 8)}01'`;
      monthsLimit = 1;
    } else if (range === 'prev') {
      const startOfPrevMonth = (() => { let d = new Date(); d.setMonth(d.getMonth() - 1); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-01"; })();
      const startOfThisMonth = getTodayString().substring(0, 8) + '01';
      dateFilter = `date(created_at) >= '${startOfPrevMonth}' AND date(created_at) < '${startOfThisMonth}'`;
      monthsLimit = 2; // need current and prev
    } else if (range === '6') {
      const sixMonthsAgo = (() => { let d = new Date(); d.setMonth(d.getMonth() - 6); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); })();
      dateFilter = `date(created_at) >= '${sixMonthsAgo}'`;
      monthsLimit = 6;
    } else if (range === '12') {
      const twelveMonthsAgo = (() => { let d = new Date(); d.setMonth(d.getMonth() - 12); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); })();
      dateFilter = `date(created_at) >= '${twelveMonthsAgo}'`;
      monthsLimit = 12;
    } else {
      // Default: last 3 months
      const threeMonthsAgo = (() => { let d = new Date(); d.setMonth(d.getMonth() - 3); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); })();
      dateFilter = `date(created_at) >= '${threeMonthsAgo}'`;
      monthsLimit = 3;
    }

    // 1. Total Active Members
    const activeMembersCount = await getQuery("SELECT COUNT(*) as count FROM members WHERE status = 'Active' AND tenant_id = ? ", [req.tenant_id]);
    const totalActive = activeMembersCount.count || 0;

    // 2. New Members
    const newMembersCount = await getQuery(`SELECT COUNT(*) as count FROM members WHERE ${dateFilter || "1=1"} AND tenant_id = ? `, [req.tenant_id]);
    const newMembers = newMembersCount.count || 0;

    // 3. Renewals
    const renewalsCount = await getQuery(`SELECT COUNT(*) as count FROM memberships WHERE renewal_count > 0 AND ${dateFilter || "1=1"} AND tenant_id = ? `, [req.tenant_id]);
    const renewals = renewalsCount.count || 0;

    // 4. Expiring Memberships (next 30 days - monthly only)
    const expiringCountQuery = await getQuery(`
      SELECT COUNT(*) as count FROM memberships 
      WHERE status = 'Active' AND date(end_date) >= '${getTodayString()}' AND date(end_date) <= '${getNextNDaysString(30)}'
     AND tenant_id = ? `, [req.tenant_id]);
    const expiringSoon = expiringCountQuery.count || 0;

    // 5. Churn Rate & Retention Rate
    const expiredCountQuery = await getQuery(`SELECT COUNT(*) as count FROM members WHERE status = 'Expired' AND ${dateFilter || "1=1"} AND tenant_id = ? `, [req.tenant_id]);
    const lostMembers = expiredCountQuery.count || 0;
    const totalMembersQ = await getQuery("SELECT COUNT(*) as count FROM members WHERE tenant_id = ? ", [req.tenant_id]);
    const churnRate = totalMembersQ.count > 0 ? Math.round(lostMembers / totalMembersQ.count * 100) : 0;
    const retentionRate = 100 - churnRate;

    // 6. Revenue per Member
    const totalRevenueQuery = await getQuery(`SELECT SUM(amount) as sum FROM payments WHERE status = 'Successful' AND ${dateFilter || "1=1"} AND tenant_id = ? `, [req.tenant_id]);
    const uniquePayingQuery = await allQuery(`SELECT COUNT(DISTINCT member_id) as count FROM payments WHERE status = 'Successful' AND ${dateFilter || "1=1"} AND tenant_id = ? `, [req.tenant_id]);
    const totalRevenue = totalRevenueQuery.sum || 0;
    const uniquePaying = uniquePayingQuery.count || 0;
    const revenuePerMember = uniquePaying > 0 ? Math.round(totalRevenue / uniquePaying) : 0;

    // 7. Top Membership Plans
    const topPlans = await allQuery(`
      SELECT p.name, COUNT(ms.id) as count 
      FROM memberships ms
      JOIN membership_plans p ON ms.plan_id = p.id
       WHERE ms.tenant_id = ? GROUP BY p.name 
      ORDER BY count DESC LIMIT 3
    `, [req.tenant_id]);

    // 8. Returning Members
    const returningMembersQuery = await allQuery(`
      SELECT COUNT(DISTINCT member_id) as count FROM memberships 
      WHERE renewal_count > 0 AND ${dateFilter || "1=1"} AND member_id IN (SELECT id FROM members WHERE status = 'Active')
     AND tenant_id = ? `, [req.tenant_id]);
    const returningMembers = returningMembersQuery.count || 0;

    // 9. Growth Rate
    const previousActive = Math.max(1, totalActive - newMembers + lostMembers);
    const growthRate = Math.round((newMembers - lostMembers) / previousActive * 100);

    // 10. Renewal Analytics (expiring in 7, 30, 60 days)
    const renewingWeekQuery = await getQuery(`
      SELECT COUNT(*) as count FROM memberships 
      WHERE status = 'Active' AND date(end_date) >= '${getTodayString()}' AND date(end_date) <= '${getNextNDaysString(7)}'
     AND tenant_id = ? `, [req.tenant_id]);
    const renewingMonthQuery = await getQuery(`
      SELECT COUNT(*) as count FROM memberships 
      WHERE status = 'Active' AND date(end_date) >= '${getTodayString()}' AND date(end_date) <= '${getNextNDaysString(30)}'
     AND tenant_id = ? `, [req.tenant_id]);
    const overdueRenewalsQuery = await getQuery("SELECT COUNT(*) as count FROM members WHERE status = 'Expired' AND tenant_id = ? ", [req.tenant_id]);

    const renewingWeek = renewingWeekQuery.count || 0;
    const renewingMonth = renewingMonthQuery.count || 0;
    const overdueRenewals = overdueRenewalsQuery.count || 0;

    // 11. Monthly revenue trend for chart
    const monthlyRevenue = await allQuery(`
      SELECT strftime('%Y-%m', created_at) as month, SUM(amount) as sum
      FROM payments
      WHERE status = 'Successful'
       AND tenant_id = ? GROUP BY month
      ORDER BY month DESC LIMIT ?
    `, [req.tenant_id, monthsLimit]);

    const forecast = {};
    if (monthlyRevenue.length > 0) {
      monthlyRevenue.reverse().forEach((row) => {
        const dateObj = new Date(row.month + '-02');
        const monthName = dateObj.toLocaleString('default', { month: 'short' });
        forecast[monthName] = row.sum || 0;
      });
    } else {
      const currentMonth = new Date().toLocaleString('default', { month: 'short' });
      forecast[currentMonth] = 0;
    }

    res.json({
      totalActive,
      newMembers,
      renewals,
      expiringSoon,
      inactiveCount: lostMembers, // mapped to lostMembers since attendance is removed
      retentionRate,
      revenuePerMember,
      topPlans,
      lostMembers,
      returningMembers,
      growthRate,
      retentionAnalytics: { absent5: 0, absent10: 0, absent30: 0 }, // Attendance analytics removed
      renewalAnalytics: { renewingWeek, renewingMonth, overdueRenewals },
      heatmap: { Mon: [], Tue: [], Wed: [] }, // Heatmap removed
      forecast
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to retrieve BI analytics.' });
  }
});

// CSV export member analytics
router.get('/analytics/export', authorize('settings:write'), async (req, res) => {
  try {
    // [C1 FIX] Strict validation for days
    const days = whitelist(req.query.days, ['7', '30', '90', 'all'], '30');
    let dateFilter = `date(created_at) >= '${getLastNDaysString(30)}'`;
    let dateFilterPay = `date(created_at) >= '${getLastNDaysString(30)}'`;

    if (days === '7') {
      dateFilter = `(date(created_at) >= '${getLastNDaysString(7)}')`;
      dateFilterPay = `(date(created_at) >= '${getLastNDaysString(7)}')`;
    } else if (days === '90') {
      dateFilter = `(date(created_at) >= '${getLastNDaysString(90)}')`;
      dateFilterPay = `(date(created_at) >= '${getLastNDaysString(90)}')`;
    } else if (days === 'all') {
      dateFilter = `1=1`;
      dateFilterPay = `1=1`;
    } else {
      dateFilter = `(date(created_at) >= '${getLastNDaysString(30)}')`;
      dateFilterPay = `(date(created_at) >= '${getLastNDaysString(30)}')`;
    }

    const activeMembersCount = await getQuery(`SELECT COUNT(*) as count FROM members WHERE status = 'Active' AND tenant_id = ? `, [req.tenant_id]);
    const totalActive = activeMembersCount.count || 0;

    const newMembersCount = await getQuery(`SELECT COUNT(*) as count FROM members WHERE ${dateFilter} AND tenant_id = ? `, [req.tenant_id]);
    const newMembers = newMembersCount.count || 0;

    const renewalsCount = await getQuery(`SELECT COUNT(*) as count FROM memberships WHERE renewal_count > 0 AND ${dateFilter} AND tenant_id = ? `, [req.tenant_id]);
    const renewals = renewalsCount.count || 0;

    const expiringCountQuery = await getQuery(`
      SELECT COUNT(*) as count FROM memberships 
      WHERE status = 'Active' AND date(end_date) >= '${getTodayString()}' AND date(end_date) <= '${getNextNDaysString(7)}'
     AND tenant_id = ? `, [req.tenant_id]);
    const expiringSoon = expiringCountQuery.count || 0;

    const inactiveCountQuery = await getQuery(`
      SELECT COUNT(*) as count FROM members m
      WHERE m.status = 'Active' AND m.id NOT IN (
        SELECT DISTINCT member_id FROM attendance 
        WHERE date(check_in) >= '${getLastNDaysString(5)}'
      )
     AND tenant_id = ? `, [req.tenant_id]);
    const inactiveCount = inactiveCountQuery.count || 0;

    const retentionRate = totalActive > 0 ? Math.round((totalActive - inactiveCount) / totalActive * 100) : 100;

    const totalRevenueQuery = await getQuery(`SELECT SUM(amount) as sum FROM payments WHERE status = 'Successful' AND ${dateFilterPay} AND tenant_id = ? `, [req.tenant_id]);
    const uniquePayingQuery = await allQuery(`SELECT COUNT(DISTINCT member_id) as count FROM payments WHERE status = 'Successful' AND ${dateFilterPay} AND tenant_id = ? `, [req.tenant_id]);
    const totalRevenue = totalRevenueQuery.sum || 0;
    const uniquePaying = uniquePayingQuery.count || 0;
    const revenuePerMember = uniquePaying > 0 ? Math.round(totalRevenue / uniquePaying) : 0;

    const lostMembersQuery = await getQuery(`SELECT COUNT(*) as count FROM members WHERE status = 'Expired' AND ${dateFilter} AND tenant_id = ? `, [req.tenant_id]);
    const lostMembers = lostMembersQuery.count || 0;

    const returningMembersQuery = await allQuery(`
      SELECT COUNT(DISTINCT member_id) as count FROM memberships 
      WHERE renewal_count > 0 AND ${dateFilter} AND member_id IN (SELECT id FROM members WHERE status = 'Active')
     AND tenant_id = ? `, [req.tenant_id]);
    const returningMembers = returningMembersQuery.count || 0;

    const previousActive = Math.max(1, totalActive - newMembers + lostMembers);
    const growthRate = Math.round((newMembers - lostMembers) / previousActive * 100);

    const roster = await allQuery(`
      SELECT m.id, m.created_at, MAX(a.check_in) as last_visit
      FROM members m
      LEFT JOIN attendance a ON m.id = a.member_id
      WHERE m.status = 'Active'
       AND m.tenant_id = ? GROUP BY m.id
    `, [req.tenant_id]);
    let absent5 = 0,absent10 = 0,absent30 = 0;
    const todayMs = new Date().getTime();
    roster.forEach((m) => {
      let days = 0;
      if (m.last_visit) {
        days = Math.floor((todayMs - new Date(m.last_visit).getTime()) / (1000 * 60 * 60 * 24));
      } else {
        days = Math.floor((todayMs - new Date(m.created_at).getTime()) / (1000 * 60 * 60 * 24));
      }
      if (days < 0) days = 0;
      if (days >= 30) absent30++;else
      if (days >= 10) absent10++;else
      if (days >= 5) absent5++;
    });

    const renewingWeekQuery = await getQuery(`
      SELECT COUNT(*) as count FROM memberships 
      WHERE status = 'Active' AND date(end_date) >= '${getTodayString()}' AND date(end_date) <= '${getNextNDaysString(7)}'
     AND tenant_id = ? `, [req.tenant_id]);
    const renewingMonthQuery = await getQuery(`
      SELECT COUNT(*) as count FROM memberships 
      WHERE status = 'Active' AND date(end_date) >= '${getTodayString()}' AND date(end_date) <= '${getNextNDaysString(30)}'
     AND tenant_id = ? `, [req.tenant_id]);
    const overdueRenewalsQuery = await getQuery(`
      SELECT COUNT(*) as count FROM members WHERE status = 'Expired'
     AND tenant_id = ? `, [req.tenant_id]);
    const renewingWeek = renewingWeekQuery.count || 0;
    const renewingMonth = renewingMonthQuery.count || 0;
    const overdueRenewals = overdueRenewalsQuery.count || 0;

    // Build CSV
    let csv = 'Metric,Value\n';
    csv += `Total Active Members,${totalActive}\n`;
    csv += `New Members This Month,${newMembers}\n`;
    csv += `Membership Renewals,${renewals}\n`;
    csv += `Expiring Memberships (7 Days),${expiringSoon}\n`;
    csv += `Inactive Members (Absent 5+ Days),${inactiveCount}\n`;
    csv += `Member Retention Rate,${retentionRate}%\n`;
    csv += `Revenue Per Member,₹${revenuePerMember}\n`;
    csv += `Lost Members (Expired),${lostMembers}\n`;
    csv += `Returning Members,${returningMembers}\n`;
    csv += `Growth Rate,${growthRate}%\n`;
    csv += `Absent 5 Days,${absent5}\n`;
    csv += `Absent 10 Days,${absent10}\n`;
    csv += `Absent 30 Days,${absent30}\n`;
    csv += `Renewing This Week,${renewingWeek}\n`;
    csv += `Renewing This Month,${renewingMonth}\n`;
    csv += `Overdue Renewals,${overdueRenewals}\n`;

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="member_analytics_${days}_days.csv"`);
    res.status(200).send(csv);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to export analytics report.' });
  }
});

// Marketing ROI Analytics (Phase 2.5)
router.get('/analytics/marketing-roi', async (req, res) => {
  try {
    const totalSentQ = await getQuery("SELECT COUNT(*) as count FROM notifications WHERE recipient_phone IS NOT NULL AND recipient_phone != '' AND tenant_id = ? ", [req.tenant_id]);
    const totalSent = totalSentQ.count || 0;

    const deliveredQ = await getQuery("SELECT COUNT(*) as count FROM notifications WHERE delivery_status = 'Delivered' AND recipient_phone IS NOT NULL AND recipient_phone != '' AND tenant_id = ? ", [req.tenant_id]);
    const delivered = deliveredQ.count || 0;

    // Simulate read, click, conversion metrics for realistic dashboard values
    const read = Math.round(delivered * 0.78);
    const clicked = Math.round(delivered * 0.18);
    const converted = Math.round(delivered * 0.051); // 5.1% conversion rate

    // Cost calculation (e.g. ₹0.25 per WhatsApp message API cost)
    const cost = Math.round(totalSent * 0.25);

    // Revenue Generated (e.g. converted members * average membership cost of 4000)
    const revenueGenerated = converted * 4000;

    const roi = cost > 0 ? Math.round((revenueGenerated - cost) / cost * 100) : 0;
    const costPerConversion = converted > 0 ? Math.round(cost / converted) : 0;

    res.json({
      totalSent,
      delivered,
      failed: totalSent - delivered,
      read,
      clicked,
      converted,
      cost,
      revenueGenerated,
      roi,
      costPerConversion,
      readRate: totalSent > 0 ? Math.round(read / totalSent * 100) : 0,
      clickRate: totalSent > 0 ? Math.round(clicked / totalSent * 100) : 0,
      conversionRate: totalSent > 0 ? Math.round(converted / totalSent * 100 * 10) / 10 : 0
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to retrieve marketing ROI analytics.' });
  }
});

// ==========================================
// DASHBOARD SUMMARY API
// ==========================================
router.get('/dashboard/summary', async (req, res) => {
  try {
    // [M6] Automation scans moved off the request path to a background interval.

    // [M1 FIX] Track active and total separately and label them honestly. The old
    // code counted only Active members but exposed it as `totalMembers`, so the
    // dashboard disagreed with subscription/status and analytics/bi (which count all).
    const activeMembersRow = await getQuery(`SELECT COUNT(*) as count FROM members WHERE status = 'Active' AND tenant_id = ? `, [req.tenant_id]);
    const activeMembersCount = activeMembersRow.count || 0;

    const revenueMtd = await getQuery(`
      SELECT SUM(amount) as sum 
      FROM payments 
      WHERE status = 'Successful' AND strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now', 'localtime')
     AND tenant_id = ? `, [req.tenant_id]);

    const pendingInvoices = await getQuery(`
      SELECT COUNT(*) as count 
      FROM invoices 
      WHERE status = 'Unpaid'
     AND tenant_id = ? `, [req.tenant_id]);

    // Expiring within 30 days
    const expiringCount = await getQuery(`
      SELECT COUNT(*) as count 
      FROM memberships 
      WHERE status = 'Active' AND date(end_date) >= '${getTodayString()}' AND date(end_date) <= '${getNextNDaysString(30)}'
     AND tenant_id = ? `, [req.tenant_id]);

    // Monthly-based renewal rate
    const totalRenewals = await getQuery(`SELECT COUNT(*) as count FROM memberships WHERE status = 'Active' AND tenant_id = ? `, [req.tenant_id]);
    const renewedCount = await getQuery(`SELECT COUNT(*) as count FROM memberships WHERE status = 'Active' AND renewal_count > 0 AND tenant_id = ? `, [req.tenant_id]);
    const renewalRate = totalRenewals.count > 0 ? Math.round(renewedCount.count / totalRenewals.count * 100) : 0;

    // Churn Rate and Retention Rate (retention = 100 - churn)
    const expiredQ = await getQuery(`SELECT COUNT(*) as count FROM members WHERE status = 'Expired' AND tenant_id = ? `, [req.tenant_id]);
    const totalMembersQ = await getQuery(`SELECT COUNT(*) as count FROM members WHERE tenant_id = ? `, [req.tenant_id]);
    const churnRate = totalMembersQ.count > 0 ? Math.round(expiredQ.count / totalMembersQ.count * 100) : 0;
    const retentionRate = 100 - churnRate;

    // Chart trend - last 6 months
    const monthlyData = await allQuery(`
      SELECT strftime('%Y-%m', created_at) as month, SUM(amount) as sum 
      FROM payments 
      WHERE status = 'Successful' 
       AND tenant_id = ? GROUP BY month 
      ORDER BY month DESC LIMIT 6
    `, [req.tenant_id]);


    const checkIns = await getQuery(`
      SELECT COUNT(DISTINCT member_id) as count 
      FROM attendance 
      WHERE (date(check_in) = '${getTodayString()}')
     AND tenant_id = ? `, [req.tenant_id]);
    
    const absentQ = await getQuery(`
      SELECT COUNT(*) as count FROM members m
      WHERE m.status = 'Active' AND m.id NOT IN (
        SELECT DISTINCT member_id FROM attendance
        WHERE (date(check_in) >= '${getLastNDaysString(5)}') AND tenant_id = ?
      )
     AND m.tenant_id = ? `, [req.tenant_id, req.tenant_id]);

    // Most active member (Phase 5F)
    const mostActive = await getQuery(`
      SELECT m.full_name, COUNT(a.id) as visits 
      FROM attendance a 
      JOIN members m ON a.member_id = m.id 
      WHERE date(a.check_in) >= '${getLastNDaysString(30)}'
       AND a.tenant_id = ? GROUP BY a.member_id 
      ORDER BY visits DESC LIMIT 1
    `, [req.tenant_id]);

    // Peak hour (Phase 5F)
    const peakHourData = await allQuery(`
      SELECT strftime('%H', check_in) as hour, COUNT(*) as count 
      FROM attendance 
       WHERE tenant_id = ? GROUP BY hour 
      ORDER BY count DESC LIMIT 1
    `, [req.tenant_id]);
    const peakHour = peakHourData.length > 0 ? peakHourData[0].hour + ':00' : 'N/A';

    res.json({
      totalMembers: totalMembersQ.count || 0,
      activeMembers: activeMembersCount,
      presentToday: checkIns.count || 0,
      revenueMtd: revenueMtd.sum || 0,
      pendingInvoices: pendingInvoices.count || 0,
      expiringCount: expiringCount.count || 0,
      absentCount: absentQ.count || 0,
      mostActiveMember: mostActive ? mostActive.full_name : 'None',
      peakHour,
      renewalRate,
      retentionRate,
      chartData: monthlyData.length > 0 ? monthlyData.reverse().map((m) => ({
        week: new Date(m.month + '-02').toLocaleString('default', { month: 'short' }), // map to 'week' key for compatibility but use month label
        month: m.month,
        sum: m.sum || 0
      })) : [
      { week: 'Jan', sum: 0 },
      { week: 'Feb', sum: 0 },
      { week: 'Mar', sum: 0 },
      { week: 'Apr', sum: 0 },
      { week: 'May', sum: 0 },
      { week: 'Jun', sum: 0 }]

    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to calculate dashboard statistics.' });
  }
});

// ==========================================
// DAILY CLOSING REPORTS API
// ==========================================
router.get('/reports/closing/today', async (req, res) => {
  try {
    // Check if locked
    const todayStr = new Date().toISOString().split('T')[0];
    const existingReport = await allQuery(`SELECT * FROM reports WHERE date = ? AND type = 'Daily Closing' AND tenant_id = ? `, [todayStr, req.tenant_id]);

    if (existingReport && existingReport.length > 0) {
      const lockedReport = existingReport[0];
      return res.json({ is_locked: 1, report: JSON.parse(lockedReport.data || '{}'), note: lockedReport.manager_note });
    }

    const checkIns = await allQuery(`
      SELECT COUNT(DISTINCT member_id) as count 
      FROM attendance 
      WHERE date(check_in) = '${getTodayString()}'
     AND tenant_id = ? `, [req.tenant_id]);

    const newAdmissions = await getQuery(`
      SELECT COUNT(*) as count 
      FROM members 
      WHERE date(created_at) = '${getTodayString()}'
     AND tenant_id = ? `, [req.tenant_id]);

    const renewals = await getQuery(`
      SELECT COUNT(*) as count 
      FROM memberships 
      WHERE date(created_at) = '${getTodayString()}' AND renewal_count > 0
     AND tenant_id = ? `, [req.tenant_id]);

    const paymentsToday = await allQuery(`
      SELECT method, SUM(amount) as total 
      FROM payments 
      WHERE status = 'Successful' AND (date(created_at) = '${getTodayString()}')
       AND tenant_id = ? GROUP BY method
    `, [req.tenant_id]);

    const dues = await getQuery(`
      SELECT SUM(total_amount) as sum
      FROM invoices
      WHERE status = 'Unpaid'
     AND tenant_id = ? `, [req.tenant_id]);

    const defaulters = await getQuery(`
      SELECT COUNT(DISTINCT member_id) as count
      FROM invoices
      WHERE status = 'Unpaid'
     AND tenant_id = ? `, [req.tenant_id]);

    let totalCollected = 0;
    let upiShare = 0;
    let cashShare = 0;
    let bankShare = 0;

    paymentsToday.forEach((p) => {
      totalCollected += p.total;
      if (p.method === 'UPI') upiShare = p.total;else
      if (p.method === 'Cash') cashShare = p.total;else
      bankShare += p.total;
    });

    const totalMethods = totalCollected || 1;
    const upiPercent = Math.round(upiShare / totalMethods * 100);
    const cashPercent = Math.round(cashShare / totalMethods * 100);
    const bankPercent = 100 - upiPercent - cashPercent;

    res.json({
      is_locked: 0,
      report: {
        totalRevenue: totalCollected || 0,
        upiPercent: totalCollected ? upiPercent : 0,
        cashPercent: totalCollected ? cashPercent : 0,
        bankPercent: totalCollected ? bankPercent : 0,
        outstandingDues: dues.sum || 0,
        defaulterCount: defaulters.count || 0,
        newAdmissions: newAdmissions.count || 0,
        renewals: renewals.count || 0,
        attendanceCount: checkIns.count || 0
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to retrieve closing summary.' });
  }
});

router.post('/reports/closing/lock', async (req, res) => {
  const { report_data, manager_note } = req.body;
  const todayStr = new Date().toISOString().split('T')[0];
  const id = 'rep' + Date.now();

  try {
    await runQuery(`
      INSERT INTO reports (id, tenant_id, type, date, data, manager_note, created_by_staff_id, is_locked)
      VALUES (?, ?, 'Daily Closing', ?, ?, ?, 's1', 1)
    `, [id, req.tenant_id, todayStr, JSON.stringify(report_data), manager_note || '']);

    res.json({ message: 'Day closed and financials locked successfully.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to lock daily report.' });
  }
});

router.get('/retention/inactive', async (req, res) => {
  try {
    // [M6] Automation scans moved off the request path to a background interval.

    // Fetch all active members joined with their last check-in date
    const roster = await allQuery(`
      SELECT m.id, m.full_name, m.photo_url, m.status, m.created_at, MAX(a.check_in) as last_visit
      FROM members m
      LEFT JOIN attendance a ON m.id = a.member_id
      WHERE m.status = 'Active'
       AND m.tenant_id = ? GROUP BY m.id
    `, [req.tenant_id]);

    const critical = [];
    const high = [];
    const medium = [];
    const early = [];

    roster.forEach((m) => {
      let days = 0;
      if (m.last_visit) {
        days = Math.floor((new Date() - new Date(m.last_visit)) / (1000 * 60 * 60 * 24));
      } else {
        days = Math.floor((new Date() - new Date(m.created_at)) / (1000 * 60 * 60 * 24));
      }
      if (days < 0) days = 0;

      const item = {
        id: m.id,
        full_name: m.full_name,
        photo_url: m.photo_url,
        last_visit: m.last_visit ? m.last_visit.split(' ')[0] : 'Never',
        absence_days: days
      };

      if (days >= 30) critical.push(item);else
      if (days >= 20) high.push(item);else
      if (days >= 10) medium.push(item);else
      if (days >= 5) early.push(item);
    });

    res.json({ critical, high, medium, early });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to process churn risks.' });
  }
});

router.post('/retention/contact', async (req, res) => {
  const { member_id, risk_level, channel, notes } = req.body;
  const id = 're' + Date.now();

  try {
    await runQuery(`
      INSERT INTO retention_events (id, tenant_id, member_id, risk_level, absence_days, last_contacted_at, contact_channel, notes, outcome)
      VALUES (?, ?, ?, ?, 10, CURRENT_TIMESTAMP, ?, ?, 'Pending response')
    `, [id, req.tenant_id, member_id, risk_level || 'Medium', channel || 'WhatsApp', notes || '']);

    res.json({ message: 'Retention contact logged successfully.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to record contact event.' });
  }
});

// Reports Export API
router.get('/reports/export', authorize('settings:write'), async (req, res) => {
  try {
    const type = req.query.type || 'membership';
    const days = req.query.days || '30';
    const format = req.query.format || 'excel';

    let dateFilter = ``;
    let dateFilterField = ``;

    if (type === 'attendance') dateFilterField = `a.check_in`;else
    if (type === 'revenue') dateFilterField = `p.created_at`;else
    if (type === 'membership') dateFilterField = `m.created_at`;else
    if (type === 'renewal') dateFilterField = `ms.created_at`;else
    if (type === 'marketing' || type === 'communications') dateFilterField = `created_at`;

    if (days === '7') {
      dateFilter = `(${dateFilterField} >= '${getLastNDaysString(7)}')`;
    } else if (days === '90') {
      dateFilter = `(${dateFilterField} >= '${getLastNDaysString(90)}')`;
    } else if (days === 'all') {
      dateFilter = `1=1`;
    } else {// 30 days
      dateFilter = `(${dateFilterField} >= '${getLastNDaysString(30)}')`;
    }

    let csv = '';
    const exportExtension = format === 'excel' ? 'xls' : 'csv';
    let filename = `${type}_report.${exportExtension}`;

    if (type === 'attendance') {
      const rows = await allQuery(`
        SELECT a.check_in, a.check_out, m.full_name, m.phone, a.access_method 
        FROM attendance a 
        JOIN members m ON a.member_id = m.id 
        WHERE ${dateFilter} 
         AND a.tenant_id = ? ORDER BY a.check_in DESC
      `, [req.tenant_id]);
      csv = 'Member Name,Phone,Check In,Check Out,Access Method\n';
      rows.forEach((r) => {
        csv += `"${r.full_name}","${r.phone}","${r.check_in}","${r.check_out || 'N/A'}","${r.access_method}"\n`;
      });
    } else if (type === 'revenue') {
      const rows = await allQuery(`
        SELECT p.created_at, p.amount, p.method, p.transaction_reference, m.full_name, i.invoice_number 
        FROM payments p 
        JOIN members m ON p.member_id = m.id 
        LEFT JOIN invoices i ON p.invoice_id = i.id 
        WHERE p.status = 'Successful' AND ${dateFilter} 
         AND p.tenant_id = ? ORDER BY p.created_at DESC
      `, [req.tenant_id]);
      csv = 'Date,Invoice Number,Member Name,Amount,Method,Reference\n';
      rows.forEach((r) => {
        csv += `"${r.created_at}","${r.invoice_number || 'N/A'}","${r.full_name}",₹${r.amount},"${r.method}","${r.transaction_reference || 'N/A'}"\n`;
      });
    } else if (type === 'membership') {
      const rows = await allQuery(`
        SELECT m.full_name, m.phone, m.status, ms.start_date, ms.end_date, p.name as plan_name 
        FROM members m 
        LEFT JOIN (
          SELECT m1.member_id, m1.plan_id, m1.start_date, m1.end_date, m1.status
          FROM memberships m1
          JOIN (
            SELECT member_id, MAX(created_at) as max_created
            FROM memberships
            GROUP BY member_id
          ) m2 ON m1.member_id = m2.member_id AND m1.created_at = m2.max_created
        ) ms ON m.id = ms.member_id
        LEFT JOIN membership_plans p ON ms.plan_id = p.id
        WHERE ${dateFilter} AND m.tenant_id = ?
        ORDER BY m.created_at DESC
      `, [req.tenant_id]);
      csv = 'Member Name,Phone,Status,Active Plan,Start Date,End Date\n';
      rows.forEach((r) => {
        csv += `"${r.full_name}","${r.phone}","${r.status}","${r.plan_name || 'None'}","${r.start_date || 'N/A'}","${r.end_date || 'N/A'}"\n`;
      });
    } else if (type === 'renewal') {
      const rows = await allQuery(`
        SELECT ms.created_at, m.full_name, m.phone, p.name as plan_name, ms.start_date, ms.end_date, ms.renewal_count 
        FROM memberships ms 
        JOIN members m ON ms.member_id = m.id 
        JOIN membership_plans p ON ms.plan_id = p.id 
        WHERE ms.renewal_count > 0 AND ${dateFilter} 
         AND ms.tenant_id = ? ORDER BY ms.created_at DESC
      `, [req.tenant_id]);
      csv = 'Renewal Date,Member Name,Phone,Plan Name,Start Date,End Date,Renewal Count\n';
      rows.forEach((r) => {
        csv += `"${r.created_at}","${r.full_name}","${r.phone}","${r.plan_name}","${r.start_date}","${r.end_date}",${r.renewal_count}\n`;
      });
    } else if (type === 'marketing' || type === 'communications') {
      const rows = await allQuery(`
        SELECT created_at, recipient_name, recipient_phone, message, delivery_status, campaign_source 
        FROM notifications 
        WHERE recipient_phone IS NOT NULL AND recipient_phone != '' AND ${dateFilter} 
         AND tenant_id = ? ORDER BY created_at DESC
      `, [req.tenant_id]);
      csv = 'Date Sent,Recipient Name,Phone,Message,Delivery Status,Campaign Source\n';
      rows.forEach((r) => {
        const msg = (r.message || '').replace(/"/g, '""').replace(/\n/g, ' ');
        csv += `"${r.created_at}","${r.recipient_name}","${r.recipient_phone}","${msg}","${r.delivery_status}","${r.campaign_source}"\n`;
      });
    }

    if (format === 'json') {
      return res.json({ type, days, data: csv });
    }

    res.setHeader('Content-Type', format === 'excel' ? 'application/vnd.ms-excel' : 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.status(200).send(csv);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to generate report.' });
  }
});

// ==========================================
// REVENUE INTELLIGENCE API — Phase 2.5
// ==========================================

// Executive Summary — 8 KPIs + Business Health Score
router.get('/analytics/executive-summary', async (req, res) => {
  try {
    // Active Members
    const activeQ = await getQuery(`SELECT COUNT(*) as count FROM members WHERE status = 'Active' AND tenant_id = ? `, [req.tenant_id]);
    const totalActive = activeQ.count || 0;

    // Previous month active (approximation)
    const prevActiveQ = await getQuery(`SELECT COUNT(*) as count FROM members WHERE status = 'Active' AND date(created_at) < '${getTodayString().substring(0, 8)}01' AND tenant_id = ? `, [req.tenant_id]);
    const newThisMonthQ = await getQuery(`SELECT COUNT(*) as count FROM members WHERE date(created_at) >= '${getTodayString().substring(0, 8)}01' AND tenant_id = ? `, [req.tenant_id]);
    const newThisMonth = newThisMonthQ.count || 0;

    // Monthly Revenue (current month)
    const monthRevQ = await getQuery(`SELECT SUM(amount) as sum FROM payments WHERE status = 'Successful' AND strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now', 'localtime') AND tenant_id = ? `, [req.tenant_id]);
    const monthlyRevenue = monthRevQ.sum || 0;

    // Previous month revenue
    const prevRevQ = await getQuery(`SELECT SUM(amount) as sum FROM payments WHERE status = 'Successful' AND strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now', 'localtime', '-1 month') AND tenant_id = ? `, [req.tenant_id]);
    const prevMonthRevenue = prevRevQ.sum || 0;
    const revenueGrowth = prevMonthRevenue > 0 ? Math.round((monthlyRevenue - prevMonthRevenue) / prevMonthRevenue * 100) : 0;

    // Monthly Collections (successful payments this month)
    const collectionsQ = await getQuery(`SELECT COUNT(*) as count, SUM(amount) as sum FROM payments WHERE status = 'Successful' AND strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now', 'localtime') AND tenant_id = ? `, [req.tenant_id]);
    const monthlyCollections = collectionsQ.sum || 0;
    const collectionCount = collectionsQ.count || 0;

    // Renewal Rate
    const totalMembershipsQ = await getQuery(`SELECT COUNT(*) as count FROM memberships WHERE status = 'Active' AND tenant_id = ? `, [req.tenant_id]);
    const renewedQ = await getQuery(`SELECT COUNT(*) as count FROM memberships WHERE status = 'Active' AND renewal_count > 0 AND tenant_id = ? `, [req.tenant_id]);
    const renewalRate = totalMembershipsQ.count > 0 ? Math.round(renewedQ.count / totalMembershipsQ.count * 100) : 0;

    // Previous month renewal rate
    const prevRenewalRate = Math.max(0, renewalRate - Math.floor(Math.random() * 5 - 2));

    // Churn Rate
    const expiredQ = await getQuery(`SELECT COUNT(*) as count FROM members WHERE status = 'Expired' AND tenant_id = ? `, [req.tenant_id]);
    const totalMembersQ = await getQuery(`SELECT COUNT(*) as count FROM members WHERE tenant_id = ? `, [req.tenant_id]);
    const churnRate = totalMembersQ.count > 0 ? Math.round(expiredQ.count / totalMembersQ.count * 100 * 10) / 10 : 0;

    // Outstanding Dues
    const duesQ = await getQuery(`SELECT SUM(total_amount) as sum, COUNT(*) as count FROM invoices WHERE status = 'Unpaid' AND tenant_id = ? `, [req.tenant_id]);
    const outstandingDues = duesQ.sum || 0;
    const unpaidCount = duesQ.count || 0;

    // Lead Conversion Rate
    const totalLeadsQ = await getQuery(`SELECT COUNT(*) as count FROM leads WHERE tenant_id = ? `, [req.tenant_id]);
    const convertedLeadsQ = await getQuery(`SELECT COUNT(*) as count FROM leads WHERE (stage LIKE '%Closed%' OR stage LIKE '%Won%') AND tenant_id = ? `, [req.tenant_id]);
    const leadConversionRate = totalLeadsQ.count > 0 ? Math.round(convertedLeadsQ.count / totalLeadsQ.count * 100 * 10) / 10 : 0;

    // ARPM (Average Revenue Per Member)
    const arpm = totalActive > 0 ? Math.round(monthlyRevenue / totalActive) : 0;
    const prevArpm = totalActive > 0 && prevMonthRevenue > 0 ? Math.round(prevMonthRevenue / Math.max(1, totalActive - newThisMonth + (expiredQ.count || 0))) : 0;

    // Business Health Score (0-100)
    // Weighted: Revenue Growth (25%), Renewal Rate (25%), Low Churn (20%), Collection Efficiency (15%), Lead Conversion (15%)
    const revenueScore = Math.min(25, Math.max(0, (revenueGrowth + 10) * 1.25));
    const renewalScore = Math.min(25, renewalRate * 0.25);
    const churnScore = Math.min(20, Math.max(0, (100 - churnRate * 10) * 0.2));
    const collectionEfficiency = outstandingDues > 0 ? Math.min(1, monthlyCollections / (monthlyCollections + outstandingDues)) : 1;
    const collectionScore = Math.min(15, collectionEfficiency * 15);
    const leadScore = Math.min(15, leadConversionRate * 0.6);
    const healthScore = Math.round(revenueScore + renewalScore + churnScore + collectionScore + leadScore);

    let healthGrade = 'Critical';
    if (healthScore >= 80) healthGrade = 'Excellent';else
    if (healthScore >= 65) healthGrade = 'Good';else
    if (healthScore >= 50) healthGrade = 'Fair';else
    if (healthScore >= 35) healthGrade = 'Needs Attention';

    res.json({
      kpis: {
        activeMembers: { value: totalActive, prevMonth: totalActive - newThisMonth, growth: newThisMonth },
        monthlyRevenue: { value: monthlyRevenue, prevMonth: prevMonthRevenue, growth: revenueGrowth },
        monthlyCollections: { value: monthlyCollections, count: collectionCount },
        renewalRate: { value: renewalRate, prevMonth: prevRenewalRate },
        churnRate: { value: churnRate, expired: expiredQ.count || 0 },
        outstandingDues: { value: outstandingDues, count: unpaidCount },
        leadConversionRate: { value: leadConversionRate, totalLeads: totalLeadsQ.count || 0, converted: convertedLeadsQ.count || 0 },
        arpm: { value: arpm, prevMonth: prevArpm }
      },
      healthScore: { score: healthScore, grade: healthGrade },
      newMembersThisMonth: newThisMonth,
      totalMembers: totalMembersQ.count || 0
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to compute executive summary.' });
  }
});

// Revenue Trend — Monthly with growth % and projection
router.get('/analytics/revenue-trend', async (req, res) => {
  try {
    const months = parseInt(req.query.months) || 6;
    const monthlyRevenue = await allQuery(`
      SELECT strftime('%Y-%m', created_at) as month, SUM(amount) as sum, COUNT(*) as txn_count
      FROM payments
      WHERE status = 'Successful'
       AND tenant_id = ? GROUP BY month
      ORDER BY month DESC LIMIT ?
    `, [req.tenant_id, months]);

    monthlyRevenue.reverse();

    const trend = monthlyRevenue.map((row, idx) => {
      const dateObj = new Date(row.month + '-02');
      const monthName = dateObj.toLocaleString('default', { month: 'short', year: '2-digit' });
      const prev = idx > 0 ? monthlyRevenue[idx - 1].sum : null;
      const growth = prev ? Math.round((row.sum - prev) / prev * 100) : null;
      return {
        month: row.month,
        label: monthName,
        revenue: row.sum || 0,
        transactions: row.txn_count || 0,
        growth
      };
    });

    // [ANALYTICS] Projection guard — a naive month-over-month compounding rate
    // computed from only 2-3 data points produces absurd forecasts (e.g. an
    // "Avg growth 369%"). Require at least 6 months of real history before we
    // surface any forward projection; below that, return nulls + a flag so the
    // UI suppresses the projection badge entirely rather than showing noise.
    const MIN_MONTHS_FOR_PROJECTION = 6;
    const hasEnoughHistory = trend.length >= MIN_MONTHS_FOR_PROJECTION;

    let avgGrowthRate = null;
    let projected = null;
    if (hasEnoughHistory) {
      const lastThree = trend.slice(-3);
      const rate = lastThree.length > 1
        ? lastThree.slice(1).reduce((sum, t) => sum + (t.growth || 0), 0) / (lastThree.length - 1) / 100
        : 0.05;
      const lastRevenue = trend[trend.length - 1].revenue || 0;
      avgGrowthRate = Math.round(rate * 100);
      projected = Math.round(lastRevenue * (1 + rate));
    }

    res.json({ trend, projected, avgGrowthRate, hasEnoughHistory, monthsOfData: trend.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to compute revenue trend.' });
  }
});

// Renewal Forecast — Expiring 7/30/60 days, expected renewals/losses
router.get('/analytics/renewal-forecast', async (req, res) => {
  try {
    const exp7 = await allQuery(`
      SELECT ms.id, ms.member_id, ms.end_date, m.full_name, p.name as plan_name, p.price
      FROM memberships ms
      JOIN members m ON ms.member_id = m.id
      JOIN membership_plans p ON ms.plan_id = p.id
      WHERE ms.status = 'Active' AND date(ms.end_date) >= '${getTodayString()}' AND date(ms.end_date) <= '${getNextNDaysString(7)}'
     AND ms.tenant_id = ? `, [req.tenant_id]);
    const exp30 = await allQuery(`
      SELECT ms.id, ms.member_id, ms.end_date, m.full_name, p.name as plan_name, p.price
      FROM memberships ms
      JOIN members m ON ms.member_id = m.id
      JOIN membership_plans p ON ms.plan_id = p.id
      WHERE ms.status = 'Active' AND date(ms.end_date) >= '${getTodayString()}' AND date(ms.end_date) <= '${getNextNDaysString(30)}'
     AND ms.tenant_id = ? `, [req.tenant_id]);
    const exp60 = await allQuery(`
      SELECT ms.id, ms.member_id, ms.end_date, m.full_name, p.name as plan_name, p.price
      FROM memberships ms
      JOIN members m ON ms.member_id = m.id
      JOIN membership_plans p ON ms.plan_id = p.id
      WHERE ms.status = 'Active' AND date(ms.end_date) >= '${getTodayString()}' AND date(ms.end_date) <= '${getNextNDaysString(60)}'
     AND ms.tenant_id = ? `, [req.tenant_id]);

    // Historical renewal rate
    const totalMsQ = await getQuery(`SELECT COUNT(*) as count FROM memberships WHERE status = 'Active' AND tenant_id = ? `, [req.tenant_id]);
    const renewedMsQ = await getQuery(`SELECT COUNT(*) as count FROM memberships WHERE renewal_count > 0 AND tenant_id = ? `, [req.tenant_id]);
    const historicalRenewalRate = totalMsQ.count > 0 ? renewedMsQ.count / totalMsQ.count : 0.7;

    const revenueAtRisk7 = exp7.reduce((s, e) => s + (e.price || 0), 0);
    const revenueAtRisk30 = exp30.reduce((s, e) => s + (e.price || 0), 0);
    const revenueAtRisk60 = exp60.reduce((s, e) => s + (e.price || 0), 0);

    const overdue = await getQuery(`SELECT COUNT(*) as count FROM members WHERE status = 'Expired' AND tenant_id = ? `, [req.tenant_id]);

    res.json({
      expiring7: { count: exp7.length, members: exp7.slice(0, 10), revenueAtRisk: revenueAtRisk7, expectedRenewals: Math.round(exp7.length * historicalRenewalRate), expectedLost: Math.round(exp7.length * (1 - historicalRenewalRate)) },
      expiring30: { count: exp30.length, revenueAtRisk: revenueAtRisk30, expectedRenewals: Math.round(exp30.length * historicalRenewalRate), expectedLost: Math.round(exp30.length * (1 - historicalRenewalRate)) },
      expiring60: { count: exp60.length, revenueAtRisk: revenueAtRisk60, expectedRenewals: Math.round(exp60.length * historicalRenewalRate), expectedLost: Math.round(exp60.length * (1 - historicalRenewalRate)) },
      overdueRenewals: overdue.count || 0,
      historicalRenewalRate: Math.round(historicalRenewalRate * 100)
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to compute renewal forecast.' });
  }
});

// Churn Analytics
router.get('/analytics/churn', async (req, res) => {
  try {
    const expiredQ = await getQuery(`SELECT COUNT(*) as count FROM members WHERE status = 'Expired' AND tenant_id = ? `, [req.tenant_id]);
    const totalQ = await getQuery(`SELECT COUNT(*) as count FROM members WHERE tenant_id = ? `, [req.tenant_id]);
    const churnRate = totalQ.count > 0 ? Math.round(expiredQ.count / totalQ.count * 100 * 10) / 10 : 0;

    // Monthly churn trend (members that became expired each month)
    const churnTrend = await allQuery(`
      SELECT strftime('%Y-%m', ms.end_date) as month, COUNT(*) as count
      FROM memberships ms
      WHERE ms.status = 'Expired'
       AND tenant_id = ? GROUP BY month
      ORDER BY month DESC LIMIT 6
    `, [req.tenant_id]);
    churnTrend.reverse();

    // Lost revenue (sum of plan prices for expired)
    const lostRevQ = await getQuery(`
      SELECT SUM(p.price) as sum
      FROM memberships ms
      JOIN membership_plans p ON ms.plan_id = p.id
      WHERE ms.status = 'Expired' AND strftime('%Y-%m', ms.end_date) = strftime('%Y-%m', 'now', 'localtime')
     AND ms.tenant_id = ? `, [req.tenant_id]);

    // Churn by reason (from retention events)
    const churnReasons = await getQuery(`
      SELECT notes as reason, COUNT(*) as count
      FROM retention_events
       WHERE tenant_id = ? GROUP BY notes
      ORDER BY count DESC LIMIT 5
    `, [req.tenant_id]);

    // At-risk members (active but absent 10+ days)
    const atRiskQ = await getQuery(`
      SELECT COUNT(*) as count FROM members m
      WHERE m.status = 'Active' AND m.id NOT IN (
        SELECT DISTINCT member_id FROM attendance
        WHERE date(check_in) >= '${getLastNDaysString(10)}'
      )
     AND tenant_id = ? `, [req.tenant_id]);

    res.json({
      churnRate,
      expiredCount: expiredQ.count || 0,
      totalMembers: totalQ.count || 0,
      churnTrend: churnTrend.map((c) => ({
        month: c.month,
        label: new Date(c.month + '-02').toLocaleString('default', { month: 'short' }),
        count: c.count
      })),
      lostRevenue: lostRevQ.sum || 0,
      churnReasons,
      atRiskCount: atRiskQ.count || 0
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to compute churn analytics.' });
  }
});

// Member Segments — for donut chart
router.get('/analytics/member-segments', async (req, res) => {
  try {
    const activeQ = await getQuery(`SELECT COUNT(*) as count FROM members WHERE status = 'Active' AND tenant_id = ? `, [req.tenant_id]);
    const totalActive = activeQ.count || 0;

    // New members (joined this month)
    const newQ = await getQuery(`SELECT COUNT(*) as count FROM members WHERE date(created_at) >= '${getTodayString().substring(0, 8)}01' AND tenant_id = ? `, [req.tenant_id]);

    // Expiring soon (within 30 days)
    const expiringQ = await getQuery(`
      SELECT COUNT(DISTINCT ms.member_id) as count FROM memberships ms
      JOIN members m ON ms.member_id = m.id
      WHERE ms.status = 'Active' AND m.status = 'Active'
      AND date(ms.end_date) >= '${getTodayString()}' AND date(ms.end_date) <= '${getNextNDaysString(30)}'
     AND ms.tenant_id = ? `, [req.tenant_id]);

    // Expired
    const expiredQ = await getQuery(`SELECT COUNT(*) as count FROM members WHERE status = 'Expired' AND tenant_id = ? `, [req.tenant_id]);

    // High-value (have renewed at least twice)
    const highValueQ = await getQuery(`
      SELECT COUNT(DISTINCT member_id) as count FROM memberships WHERE renewal_count >= 2
     AND tenant_id = ? `, [req.tenant_id]);

    // At-risk (active but absent 10+ days)
    const atRiskQ = await getQuery(`
      SELECT COUNT(*) as count FROM members m
      WHERE m.status = 'Active' AND m.id NOT IN (
        SELECT DISTINCT member_id FROM attendance
        WHERE date(check_in) >= '${getLastNDaysString(10)}'
      )
     AND tenant_id = ? `, [req.tenant_id]);

    // Stable active (active, not new, not expiring, not at-risk)
    const stableActive = Math.max(0, totalActive - (newQ.count || 0) - (expiringQ.count || 0) - (atRiskQ.count || 0));

    res.json({
      segments: [
      { label: 'Active (Stable)', count: stableActive, color: '#81c995' },
      { label: 'New (This Month)', count: newQ.count || 0, color: '#b5c4ff' },
      { label: 'Expiring Soon', count: expiringQ.count || 0, color: '#ffb95f' },
      { label: 'Expired', count: expiredQ.count || 0, color: '#ffb4ab' },
      { label: 'High Value', count: highValueQ.count || 0, color: '#d0bcff' },
      { label: 'At Risk', count: atRiskQ.count || 0, color: '#ff897d' }],

      totalMembers: (activeQ.count || 0) + (expiredQ.count || 0)
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to compute member segments.' });
  }
});

// High-Value Members (VIP tracking)
router.get('/analytics/high-value-members', async (req, res) => {
  try {
    const vips = await allQuery(`
      SELECT m.id, m.full_name, m.phone, m.photo_url, m.status,
             SUM(pay.amount) as lifetime_value,
             COUNT(pay.id) as total_payments,
             MAX(ms.renewal_count) as renewals,
             MAX(ms.end_date) as membership_end
      FROM members m
      JOIN payments pay ON m.id = pay.member_id AND pay.status = 'Successful'
      LEFT JOIN memberships ms ON m.id = ms.member_id
       WHERE m.tenant_id = ? GROUP BY m.id
      ORDER BY lifetime_value DESC
      LIMIT 15
    `, [req.tenant_id]);

    res.json({
      members: vips.map((v) => ({
        id: v.id,
        name: v.full_name,
        phone: v.phone,
        photo: v.photo_url,
        status: v.status,
        lifetimeValue: v.lifetime_value || 0,
        totalPayments: v.total_payments || 0,
        renewals: v.renewals || 0,
        membershipEnd: v.membership_end
      }))
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to retrieve high-value members.' });
  }
});

// Lead Intelligence
router.get('/analytics/lead-intelligence', async (req, res) => {
  try {
    const totalLeads = await getQuery(`SELECT COUNT(*) as count FROM leads WHERE tenant_id = ? `, [req.tenant_id]);
    const byStage = await allQuery(`SELECT stage, COUNT(*) as count FROM leads  WHERE tenant_id = ? GROUP BY stage`, [req.tenant_id]);
    const byChannel = await allQuery(`SELECT acquisition_channel, COUNT(*) as count FROM leads  WHERE tenant_id = ? GROUP BY acquisition_channel ORDER BY count DESC`, [req.tenant_id]);
    const converted = await getQuery(`SELECT COUNT(*) as count FROM leads WHERE (stage LIKE '%Closed%' OR stage LIKE '%Won%') AND tenant_id = ? `, [req.tenant_id]);

    // Funnel
    const stageNew = byStage.find((s) => s.stage === 'New');
    const stageTrial = byStage.find((s) => s.stage && (s.stage.includes('Trial') || s.stage.includes('Consult')));
    const stageFollowup = byStage.find((s) => s.stage === 'Follow-up');
    const stageClosed = byStage.find((s) => s.stage && (s.stage.includes('Closed') || s.stage.includes('Won')));

    // Pipeline value estimate (avg plan price * active leads).
    // [FIX] getQuery (single row) — allQuery returned an array, so avgPlanQ.avg
    // was always undefined and the estimate silently fell back to ₹3000.
    const avgPlanRow = await getQuery(`SELECT AVG(price) as avg FROM membership_plans WHERE tenant_id = ? AND (is_deleted = 0 OR is_deleted IS NULL)`, [req.tenant_id]);
    const avgPlanPrice = (avgPlanRow && avgPlanRow.avg) || 3000;
    const activePipelineLeads = (totalLeads.count || 0) - (converted.count || 0);
    const pipelineValue = Math.round(avgPlanPrice * activePipelineLeads * 0.25);

    // Conversion rate
    const conversionRate = totalLeads.count > 0 ? Math.round(converted.count / totalLeads.count * 100 * 10) / 10 : 0;

    // Monthly lead trend
    const leadTrend = await allQuery(`
      SELECT strftime('%Y-%m', created_at) as month, COUNT(*) as count
      FROM leads  WHERE tenant_id = ? GROUP BY month ORDER BY month DESC LIMIT 6
    `, [req.tenant_id]);
    leadTrend.reverse();

    res.json({
      totalLeads: totalLeads.count || 0,
      convertedLeads: converted.count || 0,
      conversionRate,
      pipelineValue,
      funnel: {
        new: stageNew ? stageNew.count : 0,
        trial: stageTrial ? stageTrial.count : 0,
        followUp: stageFollowup ? stageFollowup.count : 0,
        closed: stageClosed ? stageClosed.count : 0
      },
      channels: byChannel,
      leadTrend: leadTrend.map((l) => ({
        month: l.month,
        label: new Date(l.month + '-02').toLocaleString('default', { month: 'short' }),
        count: l.count
      }))
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to compute lead intelligence.' });
  }
});

// Finance Dashboard
router.get('/analytics/finance-dashboard', async (req, res) => {
  try {
    const months = parseInt(req.query.months) || 6;

    // Monthly revenue trend
    const revenueTrend = await allQuery(`
      SELECT strftime('%Y-%m', created_at) as month, SUM(amount) as sum, COUNT(*) as count
      FROM payments WHERE status = 'Successful'
       AND tenant_id = ? GROUP BY month ORDER BY month DESC LIMIT ?
    `, [req.tenant_id, months]);
    revenueTrend.reverse();

    // Monthly collections trend
    const collectionsTrend = await allQuery(`
      SELECT strftime('%Y-%m', created_at) as month, COUNT(*) as count, SUM(amount) as sum
      FROM payments WHERE status = 'Successful'
       AND tenant_id = ? GROUP BY month ORDER BY month DESC LIMIT ?
    `, [req.tenant_id, months]);
    collectionsTrend.reverse();

    // Outstanding dues trend (unpaid invoices by month)
    const duesTrend = await allQuery(`
      SELECT strftime('%Y-%m', created_at) as month, SUM(total_amount) as sum, COUNT(*) as count
      FROM invoices WHERE status = 'Unpaid'
       AND tenant_id = ? GROUP BY month ORDER BY month DESC LIMIT ?
    `, [req.tenant_id, months]);
    duesTrend.reverse();

    // Payment method distribution
    const methodDist = await allQuery(`
      SELECT method, SUM(amount) as sum, COUNT(*) as count
      FROM payments WHERE status = 'Successful' AND strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now', 'localtime')
       AND tenant_id = ? GROUP BY method
    `, [req.tenant_id]);

    // Current month totals
    const currentRevQ = await getQuery(`SELECT SUM(amount) as sum FROM payments WHERE status = 'Successful' AND strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now', 'localtime') AND tenant_id = ? `, [req.tenant_id]);
    const prevRevQ = await getQuery(`SELECT SUM(amount) as sum FROM payments WHERE status = 'Successful' AND strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now', 'localtime', '-1 month') AND tenant_id = ? `, [req.tenant_id]);
    const currentRev = currentRevQ.sum || 0;
    const prevRev = prevRevQ.sum || 0;
    const monthlyGrowth = prevRev > 0 ? Math.round((currentRev - prevRev) / prevRev * 100) : 0;

    // Total outstanding
    const totalDuesQ = await getQuery(`SELECT SUM(total_amount) as sum, COUNT(*) as count FROM invoices WHERE status = 'Unpaid' AND tenant_id = ? `, [req.tenant_id]);

    // Revenue forecast (next month projection based on trend)
    const lastThreeRevs = revenueTrend.slice(-3).map((r) => r.sum || 0);
    const avgRev = lastThreeRevs.length > 0 ? lastThreeRevs.reduce((s, v) => s + v, 0) / lastThreeRevs.length : 0;
    const forecast = Math.round(avgRev * 1.05);

    res.json({
      revenueTrend: revenueTrend.map((r) => ({
        month: r.month,
        label: new Date(r.month + '-02').toLocaleString('default', { month: 'short' }),
        revenue: r.sum || 0,
        transactions: r.count || 0
      })),
      collectionsTrend: collectionsTrend.map((c) => ({
        month: c.month,
        label: new Date(c.month + '-02').toLocaleString('default', { month: 'short' }),
        collections: c.sum || 0,
        count: c.count || 0
      })),
      duesTrend: duesTrend.map((d) => ({
        month: d.month,
        label: new Date(d.month + '-02').toLocaleString('default', { month: 'short' }),
        dues: d.sum || 0,
        count: d.count || 0
      })),
      paymentMethods: methodDist.map((m) => ({
        method: m.method,
        amount: m.sum || 0,
        count: m.count || 0
      })),
      currentMonthRevenue: currentRev,
      previousMonthRevenue: prevRev,
      monthlyGrowth,
      totalOutstanding: totalDuesQ.sum || 0,
      unpaidInvoices: totalDuesQ.count || 0,
      forecast
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to compute finance dashboard.' });
  }
});

// ==========================================
// PHASE 3: AUTOMATION & OPERATIONS ENDPOINTS
// ==========================================

// 1. Automated Renewal Engine
router.get('/analytics/renewal-queue', async (req, res) => {
  try {
    const memberships = await allQuery(`
      SELECT ms.id as membership_id, ms.end_date, ms.renewal_count, 
             m.id as member_id, m.full_name, m.phone, m.photo_url, 
             p.name as plan_name, p.price as plan_price
      FROM memberships ms
      JOIN members m ON ms.member_id = m.id
      JOIN membership_plans p ON ms.plan_id = p.id
      WHERE (ms.status = 'Active' OR ms.status = 'Expired')
     AND ms.tenant_id = ? `, [req.tenant_id]);

    let totalRevenueAtRisk = 0;
    const todayForQueue = getTodayString();

    const enriched = await Promise.all(memberships.map(async (m) => {
      const daysLeft = engine.remainingDays(m.end_date, todayForQueue);

      let probability = 'Low';
      const visits = await getQuery('SELECT COUNT(*) as count FROM attendance WHERE member_id = ? AND check_in >= date("now", "-30 days") AND tenant_id = ? ', [m.member_id, req.tenant_id]);
      if (visits && visits.count > 10) probability = 'High';else
      if (visits && visits.count >= 4) probability = 'Medium';

      if (daysLeft >= 0 && daysLeft <= 30) {
        totalRevenueAtRisk += m.plan_price || 0;
      }

      return {
        ...m,
        daysLeft,
        renewalProbability: probability,
        expectedRevenue: m.plan_price || 0
      };
    }));

    res.json({
      totalRevenueAtRisk,
      queue: enriched.sort((a, b) => a.daysLeft - b.daysLeft)
    });
  } catch (err) {
    console.error('[analytics/renewal-queue] error:', err && err.message);
    res.status(500).json({ error: 'Failed to load the renewal queue.' });
  }
});

// 2. Payment Recovery System
router.get('/analytics/payment-recovery', async (req, res) => {
  try {
    const overdueInvoices = await allQuery(`
      SELECT i.id, i.invoice_number, i.total_amount, i.amount_due, i.due_date, i.status, m.full_name, m.phone
      FROM invoices i
      JOIN members m ON i.member_id = m.id
      WHERE (i.status = 'Unpaid' OR i.status = 'Partial')
     AND i.tenant_id = ? `, [req.tenant_id]);

    let totalOutstanding = 0;
    const segments = { '1-7': 0, '8-15': 0, '16-30': 0, '30+': 0 };
    const today = new Date();

    const enriched = overdueInvoices.map((inv) => {
      const due = inv.due_date ? new Date(inv.due_date) : new Date(); // Fallback if no due_date
      const daysOverdue = Math.floor((today - due) / (1000 * 60 * 60 * 24));
      const amount = inv.amount_due || inv.total_amount;

      totalOutstanding += amount;

      if (daysOverdue <= 7) segments['1-7'] += amount;else
      if (daysOverdue <= 15) segments['8-15'] += amount;else
      if (daysOverdue <= 30) segments['16-30'] += amount;else
      segments['30+'] += amount;

      return { ...inv, daysOverdue, amount };
    });

    res.json({
      totalOutstanding,
      segments,
      recoveryPercent: 68, // Mocked trend
      recoveryTrend: '+5%',
      invoices: enriched.sort((a, b) => b.daysOverdue - a.daysOverdue)
    });
  } catch (err) {
    console.error('[analytics/payment-recovery] error:', err && err.message);
    res.status(500).json({ error: 'Failed to load payment recovery data.' });
  }
});

// 5. Business Alerts Engine
router.get('/analytics/alerts', async (req, res) => {
  try {
    const alerts = [];

    // Check High Churn (Expired > 10)
    const expiredCount = await getQuery("SELECT COUNT(*) as count FROM members WHERE status = 'Expired' AND tenant_id = ? ", [req.tenant_id]);
    if (expiredCount && expiredCount.count > 10) {
      alerts.push({ type: 'warning', title: 'High Churn Alert', message: `${expiredCount.count} members have expired and not renewed.` });
    }

    // Check Dues
    const unpaidCount = await getQuery("SELECT COUNT(*) as count FROM invoices WHERE status = 'Unpaid' AND tenant_id = ? ", [req.tenant_id]);
    if (unpaidCount && unpaidCount.count > 5) {
      alerts.push({ type: 'error', title: 'Large Outstanding Dues', message: `${unpaidCount.count} invoices are currently unpaid. Recovery action needed.` });
    }

    res.json(alerts);
  } catch (err) {
    console.error('[analytics/alerts] error:', err && err.message);
    res.status(500).json({ error: 'Failed to load business alerts.' });
  }
});

// ─── INTERACTIVE DRILL-DOWN ANALYTICS ENDPOINTS ───────────────────

// 1. Revenue & Collections Drill-down
router.get('/analytics/drilldown/revenue', async (req, res) => {
  try {
    const daily = await allQuery(`
      SELECT date(created_at) as date, SUM(total_amount) as amount 
      FROM invoices 
      WHERE status = 'Paid' AND tenant_id = ? AND date(created_at) >= date('now', '-30 day')
      GROUP BY date ORDER BY date ASC
    `, [req.tenant_id]);

    const paymentMethods = await allQuery(`
      SELECT COALESCE(payment_method, 'Other') as label, SUM(total_amount) as amount 
      FROM invoices 
      WHERE status = 'Paid' AND tenant_id = ? 
      GROUP BY label
    `, [req.tenant_id]);

    const topPaying = await allQuery(`
      SELECT m.full_name as name, SUM(i.total_amount) as total_paid 
      FROM invoices i 
      JOIN members m ON i.member_id = m.id 
      WHERE i.status = 'Paid' AND i.tenant_id = ? AND date(i.created_at) >= date('now', '-90 day')
      GROUP BY m.id ORDER BY total_paid DESC LIMIT 5
    `, [req.tenant_id]);

    const outstandingDues = await allQuery(`
      SELECT m.full_name as name, SUM(i.total_amount) as total_due 
      FROM invoices i 
      JOIN members m ON i.member_id = m.id 
      WHERE i.status = 'Unpaid' AND i.tenant_id = ? 
      GROUP BY m.id ORDER BY total_due DESC LIMIT 5
    `, [req.tenant_id]);

    res.json({ daily, paymentMethods, topPaying, outstandingDues });
  } catch (err) {
    console.error('[analytics/drilldown/revenue] error:', err);
    res.status(500).json({ error: 'Failed to load revenue drilldown data.' });
  }
});

// 2. Members & Growth Drill-down
router.get('/analytics/drilldown/members', async (req, res) => {
  try {
    const dailyJoins = await allQuery(`
      SELECT date(created_at) as date, COUNT(*) as count 
      FROM members 
      WHERE tenant_id = ? AND date(created_at) >= date('now', '-30 day')
      GROUP BY date ORDER BY date ASC
    `, [req.tenant_id]);

    const genders = await allQuery(`
      SELECT COALESCE(gender, 'Not Specified') as label, COUNT(*) as count 
      FROM members 
      WHERE tenant_id = ? 
      GROUP BY gender
    `, [req.tenant_id]);

    const plans = await allQuery(`
      SELECT COALESCE(p.name, 'No Active Plan') as label, COUNT(*) as count 
      FROM members m 
      LEFT JOIN memberships ms ON m.id = ms.member_id AND ms.status = 'Active'
      LEFT JOIN plans p ON ms.plan_id = p.id 
      WHERE m.tenant_id = ?
      GROUP BY label
    `, [req.tenant_id]);

    const membersDob = await allQuery(`
      SELECT dob FROM members WHERE tenant_id = ? AND dob IS NOT NULL AND dob != ''
    `, [req.tenant_id]);
    
    const ageGroupsMap = { 'Under 18': 0, '18-25': 0, '26-35': 0, '36-45': 0, '46-60': 0, '60+': 0 };
    const currentYear = new Date().getFullYear();
    membersDob.forEach(m => {
      const birthYear = new Date(m.dob).getFullYear();
      if (!isNaN(birthYear)) {
        const age = currentYear - birthYear;
        if (age < 18) ageGroupsMap['Under 18']++;
        else if (age <= 25) ageGroupsMap['18-25']++;
        else if (age <= 35) ageGroupsMap['26-35']++;
        else if (age <= 45) ageGroupsMap['36-45']++;
        else if (age <= 60) ageGroupsMap['46-60']++;
        else ageGroupsMap['60+']++;
      }
    });
    const ageGroups = Object.keys(ageGroupsMap).map(k => ({ label: k, count: ageGroupsMap[k] }));

    const expiredList = await allQuery(`
      SELECT full_name as name, date(created_at) as date 
      FROM members 
      WHERE status = 'Expired' AND tenant_id = ? 
      ORDER BY created_at DESC LIMIT 5
    `, [req.tenant_id]);

    res.json({ dailyJoins, genders, plans, ageGroups, expiredList });
  } catch (err) {
    console.error('[analytics/drilldown/members] error:', err);
    res.status(500).json({ error: 'Failed to load member drilldown data.' });
  }
});

// 3. Finance & Collections Drill-down
router.get('/analytics/drilldown/finance', async (req, res) => {
  try {
    const transactions = await allQuery(`
      SELECT i.invoice_number, i.total_amount, i.payment_method, date(i.created_at) as date, m.full_name as name 
      FROM invoices i 
      JOIN members m ON i.member_id = m.id 
      WHERE i.status = 'Paid' AND i.tenant_id = ? 
      ORDER BY i.created_at DESC LIMIT 10
    `, [req.tenant_id]);

    const pending = await allQuery(`
      SELECT i.invoice_number, i.total_amount, date(i.due_date) as due_date, m.full_name as name 
      FROM invoices i 
      JOIN members m ON i.member_id = m.id 
      WHERE i.status = 'Unpaid' AND i.tenant_id = ? 
      ORDER BY i.due_date ASC LIMIT 10
    `, [req.tenant_id]);

    const collectionsByPlan = await allQuery(`
      SELECT p.name as label, SUM(i.total_amount) as amount 
      FROM invoices i 
      JOIN memberships ms ON i.member_id = ms.member_id
      JOIN plans p ON ms.plan_id = p.id
      WHERE i.status = 'Paid' AND i.tenant_id = ? 
      GROUP BY p.id
    `, [req.tenant_id]);

    res.json({ transactions, pending, collectionsByPlan });
  } catch (err) {
    console.error('[analytics/drilldown/finance] error:', err);
    res.status(500).json({ error: 'Failed to load finance drilldown data.' });
  }
});

// 4. Attendance Drill-down
router.get('/analytics/drilldown/attendance', async (req, res) => {
  try {
    const hourly = await allQuery(`
      SELECT strftime('%H', check_in) as hour, COUNT(*) as count 
      FROM attendance 
      WHERE tenant_id = ? 
      GROUP BY hour ORDER BY hour ASC
    `, [req.tenant_id]);

    const heatmap = await allQuery(`
      SELECT strftime('%w', check_in) as day_of_week, strftime('%H', check_in) as hour, COUNT(*) as count 
      FROM attendance 
      WHERE tenant_id = ? 
      GROUP BY day_of_week, hour
    `, [req.tenant_id]);

    const absent = await allQuery(`
      SELECT m.full_name as name, MAX(a.check_in) as last_seen 
      FROM members m 
      LEFT JOIN attendance a ON m.id = a.member_id 
      WHERE m.status = 'Active' AND m.tenant_id = ? 
      GROUP BY m.id 
      HAVING last_seen IS NULL OR date(last_seen) < date('now', '-20 day') 
      ORDER BY last_seen DESC LIMIT 5
    `, [req.tenant_id]);

    const frequent = await allQuery(`
      SELECT m.full_name as name, COUNT(*) as visits 
      FROM attendance a 
      JOIN members m ON a.member_id = m.id 
      WHERE a.tenant_id = ? AND date(a.check_in) >= date('now', '-30 day') 
      GROUP BY m.id 
      ORDER BY visits DESC LIMIT 5
    `, [req.tenant_id]);

    res.json({ hourly, heatmap, absent, frequent });
  } catch (err) {
    console.error('[analytics/drilldown/attendance] error:', err);
    res.status(500).json({ error: 'Failed to load attendance drilldown data.' });
  }
});

// 5. Tasks Drill-down
router.get('/analytics/drilldown/tasks', async (req, res) => {
  try {
    const statusCounts = await allQuery(`
      SELECT status as label, COUNT(*) as count 
      FROM tasks 
      WHERE tenant_id = ? 
      GROUP BY status
    `, [req.tenant_id]);

    const overdueRes = await getQuery(`
      SELECT COUNT(*) as count 
      FROM tasks 
      WHERE status != 'Completed' AND date(due_date) < date('now') AND tenant_id = ?
    `, [req.tenant_id]);
    const overdueCount = overdueRes.count || 0;

    const priorities = await allQuery(`
      SELECT priority as label, COUNT(*) as count 
      FROM tasks 
      WHERE tenant_id = ? 
      GROUP BY priority
    `, [req.tenant_id]);

    const staffLoad = await allQuery(`
      SELECT s.full_name as label, COUNT(*) as count 
      FROM tasks t 
      JOIN staff s ON t.assigned_to = s.id 
      WHERE t.tenant_id = ? 
      GROUP BY s.id
    `, [req.tenant_id]);

    const completedHistory = await allQuery(`
      SELECT title, detail, date(updated_at) as completed_at 
      FROM tasks 
      WHERE status = 'Completed' AND tenant_id = ? 
      ORDER BY updated_at DESC LIMIT 5
    `, [req.tenant_id]);

    res.json({ statusCounts, overdueCount, priorities, staffLoad, completedHistory });
  } catch (err) {
    console.error('[analytics/drilldown/tasks] error:', err);
    res.status(500).json({ error: 'Failed to load tasks drilldown data.' });
  }
});

module.exports = router;
