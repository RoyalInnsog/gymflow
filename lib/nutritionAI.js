/*
 * [DIET] Photo → nutrition estimate via the Gemini API (Google AI Studio key).
 * Server-side only: the key lives in GEMINI_API_KEY and never reaches a client;
 * members call POST /api/v1/member/nutrition/analyze which proxies through here.
 * Default model is flash-lite — the cheapest vision call available (and the most
 * generous free tier), which is exactly what a per-meal scan should burn.
 */

// flash-lite is Google's cheapest vision tier; the -latest alias tracks the
// current one so we never hit a "deprecated for new users" wall (2.5-flash-lite
// already returns 404 for new keys). Pin a specific version via GEMINI_MODEL.
const MODEL = process.env.GEMINI_MODEL || 'gemini-flash-lite-latest';

const PROMPT =
  'You are a nutritionist analyzing a single food photo. Identify each distinct ' +
  'food or drink item and estimate the nutrition of the VISIBLE portion. Indian ' +
  'meals (roti, dal, sabzi, paneer, rice, idli, dosa, etc.) are common — recognize ' +
  'them accurately. Respond ONLY with JSON matching exactly: ' +
  '{"is_food": boolean, "items": [{"name": string, "portion": string, ' +
  '"calories": integer, "protein_g": number, "carbs_g": number, "fat_g": number}], ' +
  '"confidence": "high"|"medium"|"low", "note": string} ' +
  'If the image contains no food, set is_food to false with an empty items array. ' +
  'Keep "note" under 120 characters (a useful tip or caveat about the estimate).';

function clamp(v, max) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(n, max);
}

// base64 (no data: prefix) + mime → normalized estimate. Throws Error with
// `.status` set for clean HTTP mapping in the route.
async function analyzeFoodImage(base64, mimeType) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    const e = new Error('AI food scan is not configured on this server.');
    e.status = 503; throw e;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000);
  let resp;
  try {
    resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        contents: [{ parts: [{ inline_data: { mime_type: mimeType, data: base64 } }, { text: PROMPT }] }],
        generationConfig: { temperature: 0.2, response_mime_type: 'application/json' }
      }),
      signal: controller.signal
    });
  } catch (err) {
    const e = new Error(err && err.name === 'AbortError'
      ? 'The AI took too long — try again.'
      : 'Could not reach the AI service.');
    e.status = 502; throw e;
  } finally {
    clearTimeout(timer);
  }

  if (resp.status === 429) {
    const e = new Error('AI scanner is busy right now — try again in a minute.');
    e.status = 429; throw e;
  }
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    console.error(`Gemini ${MODEL} error ${resp.status}:`, body.slice(0, 500));
    const e = new Error('The AI could not analyze this photo.');
    e.status = 502; throw e;
  }

  const data = await resp.json();
  const text = (((data.candidates || [])[0] || {}).content || {}).parts
    ? data.candidates[0].content.parts.map(p => p.text || '').join('')
    : '';
  let parsed;
  try {
    // response_mime_type asks for raw JSON, but strip code fences defensively.
    parsed = JSON.parse(text.replace(/^```(json)?|```$/g, '').trim());
  } catch (err) {
    console.error('Gemini unparseable response:', text.slice(0, 300));
    const e = new Error('The AI returned an unreadable answer — try another photo.');
    e.status = 502; throw e;
  }

  const items = (Array.isArray(parsed.items) ? parsed.items : []).slice(0, 12).map(i => ({
    name: String((i && i.name) || 'Food item').slice(0, 120),
    portion: String((i && i.portion) || '').slice(0, 80),
    calories: Math.round(clamp(i && i.calories, 3000)),
    protein_g: Math.round(clamp(i && i.protein_g, 300) * 10) / 10,
    carbs_g: Math.round(clamp(i && i.carbs_g, 500) * 10) / 10,
    fat_g: Math.round(clamp(i && i.fat_g, 300) * 10) / 10
  }));
  const total = items.reduce((t, i) => ({
    calories: t.calories + i.calories,
    protein_g: Math.round((t.protein_g + i.protein_g) * 10) / 10,
    carbs_g: Math.round((t.carbs_g + i.carbs_g) * 10) / 10,
    fat_g: Math.round((t.fat_g + i.fat_g) * 10) / 10
  }), { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 });

  return {
    is_food: parsed.is_food !== false && items.length > 0,
    items,
    total,
    confidence: ['high', 'medium', 'low'].includes(parsed.confidence) ? parsed.confidence : 'low',
    note: String(parsed.note || '').slice(0, 200)
  };
}

module.exports = { analyzeFoodImage };
