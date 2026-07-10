/**
 * Dependency-free Invoice PDF generator + signed public link helpers
 * =============================================================================
 * The WhatsApp Cloud API sends a document by fetching an HTTPS `link`. We have no
 * third-party cloud storage in this deployment, so the app itself serves the PDF
 * from a short-lived, HMAC-signed public URL (see the /public invoice route in
 * server.js). That signed URL IS the "media URL" the automation passes to the
 * Cloud API payload.
 *
 * The PDF is built by hand (PDF 1.4, single page, built-in Helvetica) so there is
 * ZERO new dependency. It renders a clean membership invoice with the gym header,
 * member details, line items and totals.
 *
 * Text is restricted to WinAnsi-safe characters (the rupee sign and emoji are
 * transliterated/stripped) so glyphs never render as tofu boxes.
 * =============================================================================
 */

const crypto = require('crypto');

function secret() {
  return process.env.JWT_SECRET || 'gymflow-dev-insecure-secret';
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  str = String(str).replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64').toString('utf8');
}

/**
 * Sign a short-lived token authorizing public access to ONE gym's ONE invoice PDF.
 * @param {{tenant_id:string, invoice_id:string}} payload
 * @param {number} ttlSeconds default 7 days (Cloud API may fetch a little later).
 */
function signInvoiceToken(payload, ttlSeconds = 7 * 24 * 3600) {
  const body = {
    t: payload.tenant_id,
    i: payload.invoice_id,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds
  };
  const data = b64url(JSON.stringify(body));
  const sig = b64url(crypto.createHmac('sha256', secret()).update(data).digest());
  return `${data}.${sig}`;
}

/** Verify a token; returns { tenant_id, invoice_id } or null. */
function verifyInvoiceToken(token) {
  if (!token || typeof token !== 'string' || token.indexOf('.') < 0) return null;
  const [data, sig] = token.split('.');
  if (!data || !sig) return null;
  const expected = b64url(crypto.createHmac('sha256', secret()).update(data).digest());
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let body;
  try { body = JSON.parse(b64urlDecode(data)); } catch (e) { return null; }
  if (!body || !body.exp || body.exp < Math.floor(Date.now() / 1000)) return null;
  return { tenant_id: body.t, invoice_id: body.i };
}

// ── PDF text sanitation ─────────────────────────────────────────────────────
function sanitize(text) {
  return String(text == null ? '' : text)
    .replace(/₹/g, 'Rs.')              // ₹ -> Rs.
    .replace(/[^\x20-\x7E]/g, '')           // drop non-WinAnsi (emoji, etc.)
    .trim();
}
// Escape the special chars inside a PDF literal string.
function pdfEscape(text) {
  return sanitize(text).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

/**
 * Build a content stream from an ordered list of drawing ops.
 * Each op: { x, y, size, text, font: 'F1'|'F2' } (F1 = Helvetica, F2 = Bold)
 */
function buildContentStream(ops) {
  let s = '';
  for (const op of ops) {
    if (op.rect) {
      // Filled rectangle: [x, y, w, h, grayLevel]
      const [x, y, w, h, g] = op.rect;
      s += `${g} ${g} ${g} rg\n${x} ${y} ${w} ${h} re f\n0 0 0 rg\n`;
      continue;
    }
    if (op.line) {
      const [x1, y1, x2, y2] = op.line;
      s += `0.8 0.8 0.8 RG\n${x1} ${y1} m ${x2} ${y2} l S\n0 0 0 RG\n`;
      continue;
    }
    const font = op.font === 'F2' ? 'F2' : 'F1';
    const size = op.size || 11;
    s += `BT /${font} ${size} Tf ${op.x} ${op.y} Td (${pdfEscape(op.text)}) Tj ET\n`;
  }
  return s;
}

/**
 * Generate a membership invoice PDF as a Buffer.
 * @param {Object} d
 *   d.gymName, d.gymAddress, d.gymPhone
 *   d.invoiceNumber, d.dateStr, d.status
 *   d.member: { name, phone, email, id }
 *   d.planName
 *   d.currency (symbol, e.g. '₹')
 *   d.subtotal, d.tax, d.taxPercent, d.total, d.amountDue
 */
function generateInvoicePdf(d = {}) {
  const cur = d.currency || 'Rs.';
  const money = (n) => `${cur}${Number(n || 0).toLocaleString('en-IN')}`;

  // Page geometry (A4 points). Origin is bottom-left in PDF space.
  const PW = 595, PH = 842;
  const left = 56;
  let y = PH - 70;

  const ops = [];
  // Header band
  ops.push({ rect: [0, PH - 120, PW, 120, 0.95] });
  ops.push({ x: left, y: PH - 62, size: 24, font: 'F2', text: d.gymName || 'Gym' });
  ops.push({ x: left, y: PH - 84, size: 10, font: 'F1', text: d.gymAddress || '' });
  ops.push({ x: left, y: PH - 98, size: 10, font: 'F1', text: d.gymPhone ? ('Phone: ' + d.gymPhone) : '' });
  ops.push({ x: PW - 200, y: PH - 62, size: 20, font: 'F2', text: 'INVOICE' });
  ops.push({ x: PW - 200, y: PH - 84, size: 10, font: 'F1', text: 'No: ' + (d.invoiceNumber || '-') });
  ops.push({ x: PW - 200, y: PH - 98, size: 10, font: 'F1', text: 'Date: ' + (d.dateStr || '') });

  y = PH - 160;
  ops.push({ x: left, y, size: 11, font: 'F2', text: 'BILL TO' });
  y -= 18;
  ops.push({ x: left, y, size: 12, font: 'F1', text: (d.member && d.member.name) || '' });
  y -= 15;
  if (d.member && d.member.phone) { ops.push({ x: left, y, size: 10, font: 'F1', text: 'Phone: ' + d.member.phone }); y -= 14; }
  if (d.member && d.member.email) { ops.push({ x: left, y, size: 10, font: 'F1', text: 'Email: ' + d.member.email }); y -= 14; }
  if (d.member && d.member.id) { ops.push({ x: left, y, size: 10, font: 'F1', text: 'Member ID: ' + d.member.id }); y -= 14; }

  // Line-items table header
  y -= 16;
  ops.push({ rect: [left, y - 4, PW - left * 2, 22, 0.90] });
  ops.push({ x: left + 8, y, size: 11, font: 'F2', text: 'DESCRIPTION' });
  ops.push({ x: PW - 160, y, size: 11, font: 'F2', text: 'AMOUNT' });
  y -= 26;

  // Single membership line item.
  ops.push({ x: left + 8, y, size: 11, font: 'F1', text: (d.planName || 'Membership Plan') });
  ops.push({ x: PW - 160, y, size: 11, font: 'F1', text: money(d.subtotal) });
  y -= 8;
  ops.push({ line: [left, y, PW - left, y] });
  y -= 22;

  // Totals
  const totalsX = PW - 240;
  ops.push({ x: totalsX, y, size: 11, font: 'F1', text: 'Subtotal' });
  ops.push({ x: PW - 160, y, size: 11, font: 'F1', text: money(d.subtotal) });
  y -= 18;
  if (Number(d.tax) > 0) {
    ops.push({ x: totalsX, y, size: 11, font: 'F1', text: `Tax${d.taxPercent ? ' (' + d.taxPercent + '%)' : ''}` });
    ops.push({ x: PW - 160, y, size: 11, font: 'F1', text: money(d.tax) });
    y -= 18;
  }
  ops.push({ line: [totalsX, y + 6, PW - left, y + 6] });
  y -= 4;
  ops.push({ x: totalsX, y, size: 13, font: 'F2', text: 'TOTAL' });
  ops.push({ x: PW - 160, y, size: 13, font: 'F2', text: money(d.total) });
  y -= 22;
  ops.push({ x: totalsX, y, size: 11, font: 'F2', text: 'Amount Due' });
  ops.push({ x: PW - 160, y, size: 11, font: 'F2', text: money(d.amountDue != null ? d.amountDue : d.total) });

  // Footer
  ops.push({ x: left, y: 70, size: 10, font: 'F1', text: 'Thank you for choosing ' + sanitize(d.gymName || 'us') + '!' });
  ops.push({ x: left, y: 54, size: 9, font: 'F1', text: 'This is a computer-generated invoice.' });

  const content = buildContentStream(ops);
  return assemblePdf(content, PW, PH);
}

// ── Assemble a valid PDF file from a single content stream ──────────────────
function assemblePdf(content, pageW, pageH) {
  const objects = [];
  // 1: Catalog, 2: Pages, 3: Page, 4: Contents, 5: Helvetica, 6: Helvetica-Bold
  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  objects.push('<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  objects.push(
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW} ${pageH}] ` +
    `/Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>`
  );
  const streamBytes = Buffer.byteLength(content, 'utf8');
  objects.push(`<< /Length ${streamBytes} >>\nstream\n${content}\nendstream`);
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');

  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((obj, idx) => {
    offsets[idx] = Buffer.byteLength(pdf, 'utf8');
    pdf += `${idx + 1} 0 obj\n${obj}\nendobj\n`;
  });

  const xrefPos = Buffer.byteLength(pdf, 'utf8');
  const count = objects.length + 1;
  pdf += `xref\n0 ${count}\n`;
  pdf += '0000000000 65535 f \n';
  offsets.forEach((off) => {
    pdf += String(off).padStart(10, '0') + ' 00000 n \n';
  });
  pdf += `trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`;

  return Buffer.from(pdf, 'utf8');
}

module.exports = {
  signInvoiceToken,
  verifyInvoiceToken,
  generateInvoicePdf
};
