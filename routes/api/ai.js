const express = require('express');
const router = express.Router();
const { authorize, requireFeature } = require('../../lib/apiUtils');
const { streamAIResponse } = require('../../services/aiInsights');

// POST /api/ai/ask
// Streams back a response using Server-Sent Events (SSE)
router.post('/ask', authorize('reports:read'), async (req, res) => {
  const { message } = req.body;
  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'Message is required.' });
  }

  if (message.length > 2000) {
    return res.status(400).json({ error: 'Message is too long (max 2000 characters).' });
  }

  try {
    await streamAIResponse(req.tenant_id, message, req, res);
  } catch (err) {
    console.error('[AI Router Error]', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to process AI request.' });
    }
  }
});

module.exports = router;
