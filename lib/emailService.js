const { runQuery } = require('../database');

/**
 * Email Service Provider Abstraction
 * Handles communication with an Email Provider (e.g. Resend)
 * Eliminates fake success by requiring an actual HTTP API response.
 */

async function sendEmail({ to, subject, html, tenantId }) {
  const apiKey = process.env.EMAIL_API_KEY;
  const fromEmail = process.env.EMAIL_FROM || 'onboarding@resend.dev'; // Resend's default test sender

  if (!apiKey) {
    console.error("Email Provider Error: Missing EMAIL_API_KEY credentials.");
    // Log failure to email_logs
    const logId = 'el_' + Date.now() + Math.floor(Math.random() * 1000);
    await runQuery(`
      INSERT INTO email_logs (id, tenant_id, recipient, subject, provider, status)
      VALUES (?, ?, ?, ?, 'Resend', 'Failed')
    `, [logId, tenantId || null, to, subject]);

    return { 
      success: false, 
      error: 'Email provider credentials not configured.' 
    };
  }

  // Insert Pending state
  const logId = 'el_' + Date.now() + Math.floor(Math.random() * 1000);
  await runQuery(`
    INSERT INTO email_logs (id, tenant_id, recipient, subject, provider, status)
    VALUES (?, ?, ?, ?, 'Resend', 'Pending')
  `, [logId, tenantId || null, to, subject]);

  const url = 'https://api.resend.com/emails';
  const payload = {
    from: fromEmail,
    to: [to],
    subject: subject,
    html: html
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json();

    if (response.ok && data.id) {
      await runQuery(`UPDATE email_logs SET status = 'Delivered', provider_message_id = ? WHERE id = ?`, [data.id, logId]);
      return {
        success: true,
        messageId: data.id
      };
    } else {
      console.error("Email Provider API Error:", data.error || data);
      await runQuery(`UPDATE email_logs SET status = 'Failed' WHERE id = ?`, [logId]);
      return {
        success: false,
        error: data.message || data.error?.message || 'Provider rejected the request.'
      };
    }
  } catch (error) {
    console.error("Email Provider Network Error:", error);
    await runQuery(`UPDATE email_logs SET status = 'Failed' WHERE id = ?`, [logId]);
    return {
      success: false,
      error: 'Network failure communicating with email provider.'
    };
  }
}

// [H3] Build links from a configured public base URL, not a hard-coded
// http://localhost — verification/reset links sent to real users must point at
// the deployed host. Falls back to localhost:<port> only for local dev.
function baseUrl(port) {
  return (process.env.APP_BASE_URL || `http://localhost:${port}`).replace(/\/+$/, '');
}

async function sendVerificationEmail(to, token, tenantId, port) {
  const link = `${baseUrl(port)}/verify-email?token=${token}`;
  const html = `
    <h2>Verify Your Account</h2>
    <p>Please click the link below to verify your email address:</p>
    <a href="${link}">Verify Email</a>
  `;
  return sendEmail({ to, subject: 'Verify Account', html, tenantId });
}

async function sendPasswordReset(to, token, tenantId, port) {
  const link = `${baseUrl(port)}/reset-password?token=${token}`;
  const html = `
    <h2>Reset Your Password</h2>
    <p>Please click the link below to reset your password. This link expires in 1 hour.</p>
    <a href="${link}">Reset Password</a>
  `;
  return sendEmail({ to, subject: 'Reset Password', html, tenantId });
}

// [IDENTITY] Confirmation link sent to the NEW address in the change-email flow.
async function sendEmailChangeVerification(to, token, tenantId, port) {
  const link = `${baseUrl(port)}/verify-email?token=${token}&type=change`;
  const html = `
    <h2>Confirm Your New Email</h2>
    <p>Click the link below to confirm this as the new sign-in email for your GYM Flow account. This link expires in 24 hours.</p>
    <a href="${link}">Confirm Email Change</a>
    <p>If you did not request this change, you can ignore this email.</p>
  `;
  return sendEmail({ to, subject: 'Confirm your new email', html, tenantId });
}

// [IDENTITY] Generic security notification (new device, password changed,
// provider linked/unlinked, …). Best-effort — callers must not await-fail on it.
async function sendSecurityAlert(to, subject, lines, tenantId) {
  const html = `
    <h2>${subject}</h2>
    ${(lines || []).map(l => `<p>${l}</p>`).join('\n    ')}
    <p>If this was you, no action is needed. If it wasn't, change your password and review your active sessions under Settings → Security.</p>
  `;
  return sendEmail({ to, subject, html, tenantId });
}

module.exports = {
  sendEmail,
  sendVerificationEmail,
  sendPasswordReset,
  sendEmailChangeVerification,
  sendSecurityAlert
};
