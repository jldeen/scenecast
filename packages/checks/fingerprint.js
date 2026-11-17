// DOM fingerprint of the replica's apps: each frame's markup, field values and scroll offsets, hashed.
// One function expression, evaluated in the replica page (tests/check.mjs, tests/record.mjs).
async () => {
  const parts = [];
  const walk = (d, tag) => {
    parts.push(tag, d.documentElement.outerHTML);
    for (const el of d.querySelectorAll('*')) { if (el.scrollTop || el.scrollLeft) parts.push('s', el.scrollTop, el.scrollLeft); if ('value' in el && el.value) parts.push('v', el.value); }
    d.querySelectorAll('iframe').forEach((f, i) => { try { if (f.contentDocument) walk(f.contentDocument, tag + '/' + i); } catch (e) {} });
  };
  document.querySelectorAll('#stage > iframe').forEach(f => walk(f.contentDocument, f.dataset.app + (f.classList.contains('on') ? '*' : '')));
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(parts.join('\u0000')));
  return [...new Uint8Array(buf)].slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join('');
}
