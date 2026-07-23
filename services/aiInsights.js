const { getQuery, allQuery } = require('../database');
const http = require('http');

/**
 * Gathers relevant business context for the AI from the database.
 */
async function gatherGymContext(tenantId) {
  // Get active members count
  const activeMembers = await getQuery(
    "SELECT COUNT(*) as count FROM members WHERE tenant_id = ? AND status = 'Active'",
    [tenantId]
  );

  // Get total revenue this month
  const revenueThisMonth = await getQuery(
    "SELECT SUM(amount_due) as total FROM invoices WHERE tenant_id = ? AND status = 'Paid' AND strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now')",
    [tenantId]
  );

  // Get members expiring in the next 7 days (anonymized)
  const expiries = await allQuery(
    "SELECT m.id, ms.end_date FROM memberships ms JOIN members m ON ms.member_id = m.id WHERE ms.tenant_id = ? AND ms.status = 'Active' AND ms.end_date >= date('now') AND ms.end_date <= date('now', '+7 days')",
    [tenantId]
  );

  return `
GYM BUSINESS CONTEXT:
- Total Active Members: ${activeMembers.count || 0}
- Revenue This Month: ${revenueThisMonth.total || 0}
- Upcoming Expiries (Next 7 days): ${expiries.length} members
  ${expiries.map(e => `* Member ID: ${e.id} (Exp: ${e.end_date})`).join('\n  ')}
  `;
}

/**
 * Connects to local Ollama instance and streams the response via SSE.
 */
async function streamAIResponse(tenantId, userMessage, req, res) {
  const context = await gatherGymContext(tenantId);
  
  const systemPrompt = `You are a highly intelligent AI assistant embedded in 'Gym Flow', a SaaS platform for Gym Owners. 
Your primary job is to provide business insights, answer questions, and analyze data provided to you. 
Keep your answers concise, professional, and directly address the gym owner. 
Do not hallucinate data. If you don't know something, say so.

${context}`;

  const requestBody = JSON.stringify({
    model: "llama3.2", // Default lightweight model
    prompt: userMessage,
    system: systemPrompt,
    stream: true
  });

  const ollamaUrl = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
  const urlObj = new URL(ollamaUrl);

  const options = {
    hostname: urlObj.hostname,
    port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
    path: '/api/generate',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(requestBody)
    }
  };

  const ollamaReq = http.request(options, (ollamaRes) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    if (ollamaRes.statusCode !== 200) {
      res.write(`data: ${JSON.stringify({ error: 'Ollama returned ' + ollamaRes.statusCode })}\n\n`);
      res.end();
      return;
    }

    ollamaRes.on('data', (chunk) => {
      // Chunk might contain multiple JSON lines
      const lines = chunk.toString('utf8').split('\n').filter(l => l.trim() !== '');
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          if (parsed.response) {
            res.write(`data: ${JSON.stringify({ text: parsed.response })}\n\n`);
          }
        } catch (e) {
          // parse error on fragment, ignore
        }
      }
    });

    ollamaRes.on('end', () => {
      res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
      res.end();
    });
  });

  ollamaReq.on('error', (e) => {
    console.error('[AI] Ollama connection error:', e.message);
    if (!res.headersSent) res.setHeader('Content-Type', 'text/event-stream');
    res.write(`data: ${JSON.stringify({ error: 'Could not reach AI service.' })}\n\n`);
    res.end();
  });

  ollamaReq.setTimeout(30000, () => {
    ollamaReq.destroy(new Error('Timeout'));
  });

  req.on('close', () => {
    ollamaReq.destroy();
  });

  ollamaReq.write(requestBody);
  ollamaReq.end();
}

module.exports = {
  gatherGymContext,
  streamAIResponse
};
