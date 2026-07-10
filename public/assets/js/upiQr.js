/* =====================================================================
 * Gym Flow — Shared UPI QR utility  (window.GymUPIQR)
 * ---------------------------------------------------------------------
 * Extracted from the member-creation / payment-center flows into one
 * reusable block so any surface (Collect Payment drawer, renew, add member)
 * renders an identical UPI QR. Uses the QRious lib when present, with a
 * remote-renderer fallback. The gym's member-collection UPI comes from
 * Settings (/settings/public) — never the platform SaaS UPI.
 * ===================================================================== */
window.GymUPIQR = (function () {
  'use strict';

  function buildUpiString(o) {
    o = o || {};
    var parts = [
      'pa=' + encodeURIComponent(o.upiId || ''),
      'pn=' + encodeURIComponent(o.upiName || 'GymFlow'),
      'cu=INR'
    ];
    if (o.amount != null && !isNaN(Number(o.amount))) parts.push('am=' + encodeURIComponent(Number(o.amount)));
    if (o.note) parts.push('tn=' + encodeURIComponent(o.note));
    return 'upi://pay?' + parts.join('&');
  }

  function dataUrl(o) {
    o = o || {};
    var value = buildUpiString(o);
    if (typeof QRious !== 'undefined') {
      try {
        return new QRious({ value: value, size: o.size || 220, level: 'M', background: '#ffffff', foreground: '#000000' }).toDataURL();
      } catch (e) { /* fall through to remote */ }
    }
    // Fallback renderer (requires connectivity) so a missing QRious lib still
    // yields a scannable code rather than a blank box.
    return 'https://api.qrserver.com/v1/create-qr-code/?size=' + (o.size || 220) + 'x' + (o.size || 220) + '&data=' + encodeURIComponent(value);
  }

  function render(imgEl, o) {
    if (!imgEl) return '';
    var url = dataUrl(o);
    imgEl.src = url;
    return url;
  }

  // The gym's own member-collection UPI (Settings → UPI), distinct from the
  // platform's SaaS-billing UPI.
  function fetchGymUpi() {
    if (!window.api || !window.api.fetch) return Promise.resolve(null);
    return window.api.fetch('/settings/public')
      .then(function (r) { return r.json(); })
      .then(function (s) {
        return {
          upiId: (s && s.upi_id) || '',
          upiName: (s && s.upi_name) || (window.APP_CONFIG && window.APP_CONFIG.brand && window.APP_CONFIG.brand.name) || 'GymFlow'
        };
      })
      .catch(function () { return null; });
  }

  return { buildUpiString: buildUpiString, dataUrl: dataUrl, render: render, fetchGymUpi: fetchGymUpi };
})();
