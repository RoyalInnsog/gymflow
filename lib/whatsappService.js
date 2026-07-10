/**
 * WhatsApp Service Provider Abstraction
 * Handles communication with Meta's WhatsApp Cloud API.
 * Enforces real network requests and strips "fake success" capabilities.
 */

/**
 * Validates and normalizes phone numbers to E.164 format.
 * Returns null if invalid.
 */
function validateAndNormalizePhone(phone) {
  if (!phone) return null;
  // Remove all non-numeric characters
  let numeric = phone.replace(/\D/g, '');
  
  if (numeric.length < 10) return null;
  
  // Assume Indian number if exactly 10 digits
  if (numeric.length === 10) {
    numeric = '91' + numeric;
  }
  
  // Cloud API requires phone number without '+' sign
  return numeric;
}

/**
 * Sends a message via Meta WhatsApp Cloud API.
 * Returns { success: boolean, messageId: string, error: string }
 */
async function sendMessage(toPhone, messageText) {
  const phoneId = process.env.WHATSAPP_PHONE_ID;
  const apiToken = process.env.WHATSAPP_API_TOKEN;

  if (!phoneId || !apiToken) {
    console.error("WhatsApp Provider Error: Missing WHATSAPP_PHONE_ID or WHATSAPP_API_TOKEN credentials.");
    return { 
      success: false, 
      error: 'WhatsApp provider credentials not configured.' 
    };
  }

  const normalizedPhone = validateAndNormalizePhone(toPhone);
  if (!normalizedPhone) {
    return {
      success: false,
      error: 'Invalid phone number format.'
    };
  }

  const url = `https://graph.facebook.com/v17.0/${phoneId}/messages`;
  const payload = {
    messaging_product: "whatsapp",
    to: normalizedPhone,
    type: "text",
    text: { body: messageText }
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json();

    if (response.ok && data.messages && data.messages.length > 0) {
      return {
        success: true,
        messageId: data.messages[0].id
      };
    } else {
      console.error("WhatsApp Provider API Error:", data.error || data);
      return {
        success: false,
        error: data.error?.message || 'Provider rejected the request.'
      };
    }
  } catch (error) {
    console.error("WhatsApp Provider Network Error:", error);
    return {
      success: false,
      error: 'Network failure communicating with WhatsApp provider.'
    };
  }
}

module.exports = {
  validateAndNormalizePhone,
  sendMessage
};
