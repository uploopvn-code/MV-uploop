// A small RFC-4180-ish CSV parser: quoted fields, "" escapes, commas and newlines inside quotes,
// CRLF or LF, a leading BOM. Returns an array of row objects keyed by the (trimmed) header row.
export function parseCsv(text) {
  const s = String(text || '').replace(/^﻿/, '');
  const rows = [];
  let row = [],
    field = '',
    inQuotes = false,
    started = false;
  const endField = () => {
    row.push(field);
    field = '';
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
    started = false;
  };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    started = true;
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') endField();
    else if (c === '\n') endRow();
    else if (c === '\r') {
      /* part of CRLF — the \n ends the row */
    } else field += c;
  }
  if (started || field.length || row.length) endRow();
  const clean = rows.filter(r => r.some(c => String(c).trim() !== ''));
  if (!clean.length) return [];
  const headers = clean[0].map(h => String(h).trim());
  return clean.slice(1).map(r => {
    const o = {};
    headers.forEach((h, i) => (o[h] = String(r[i] ?? '').trim()));
    return o;
  });
}
