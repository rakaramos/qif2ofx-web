// QIF to OFX 1.0.2 converter. Pure functions, no DOM access.
// The browser UI (app.js) and the Node tests both import this module.

/**
 * Parse QIF text into a list of raw transaction records.
 * Supports bank and credit card blocks. Skips !Account and other header blocks.
 */
export function parseQif(text) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  const records = [];
  let type = null;
  let current = {};
  let inAccountBlock = false;

  const flush = () => {
    if (!inAccountBlock && (current.date !== undefined || current.amount !== undefined)) {
      records.push(current);
    }
    current = {};
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (line === '') continue;

    if (line.startsWith('!')) {
      const header = line.toLowerCase();
      if (header.startsWith('!type:')) {
        type = line.slice(6).trim();
        inAccountBlock = false;
      } else if (header.startsWith('!account')) {
        inAccountBlock = true;
      } else if (header.startsWith('!option') || header.startsWith('!clear')) {
        // Option lines carry no transaction data.
      }
      continue;
    }

    const code = line[0];
    const value = line.slice(1).trim();

    switch (code) {
      case '^':
        flush();
        if (inAccountBlock) inAccountBlock = false;
        break;
      case 'D': current.date = value; break;
      case 'T':
      case 'U':
        // T and U normally hold the same amount. Keep the first one.
        if (current.amount === undefined) current.amount = value;
        break;
      case 'P': current.payee = value; break;
      case 'M': current.memo = value; break;
      case 'N': current.num = value; break;
      case 'L': current.category = value; break;
      default:
        // Splits (S, E, $), address (A), cleared (C) and others are not used in OFX.
        break;
    }
  }
  flush();

  return { type, records };
}

/**
 * Parse an amount such as "-1,234.56", "1.234,56", "1234,5" or "12.00".
 * Returns a number or NaN.
 */
export function parseAmount(raw) {
  if (raw === undefined || raw === null) return NaN;
  let s = String(raw).trim().replace(/\s/g, '').replace(/[^\d.,+-]/g, '');
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');

  if (lastComma !== -1 && lastDot !== -1) {
    // The separator that comes last is the decimal separator.
    if (lastComma > lastDot) {
      s = s.replace(/\./g, '').replace(',', '.');
    } else {
      s = s.replace(/,/g, '');
    }
  } else if (lastComma !== -1) {
    const decimals = s.length - lastComma - 1;
    const commaCount = (s.match(/,/g) || []).length;
    // One comma followed by 1 or 2 digits is a decimal comma. Otherwise it groups thousands.
    s = commaCount === 1 && decimals <= 2 ? s.replace(',', '.') : s.replace(/,/g, '');
  }
  return Number(s);
}

/** Split a QIF date into three numeric parts. Handles "/", "-", ".", and the "'" year marker. */
function dateParts(raw) {
  const cleaned = String(raw).trim().replace(/'\s*/g, '/').replace(/\s+/g, '');
  const parts = cleaned.split(/[\/\-.]/).filter(Boolean);
  if (parts.length !== 3 || parts.some((p) => !/^\d+$/.test(p))) return null;
  return parts.map(Number).concat([parts[0].length]);
}

/**
 * Work out the date order from all dates in the file.
 * Returns "ymd", "dmy" or "mdy". Defaults to "dmy" when every date is ambiguous.
 */
export function detectDateFormat(rawDates) {
  let dayFirst = false;
  let monthFirst = false;
  for (const raw of rawDates) {
    const p = dateParts(raw);
    if (!p) continue;
    if (p[3] === 4) return 'ymd';
    if (p[0] > 12) dayFirst = true;
    if (p[1] > 12) monthFirst = true;
  }
  if (monthFirst && !dayFirst) return 'mdy';
  return 'dmy';
}

/** Convert a raw QIF date to "YYYYMMDD" with the given order. Returns null when invalid. */
export function parseDate(raw, format) {
  const p = dateParts(raw);
  if (!p) return null;
  let y, m, d;
  if (format === 'ymd' || p[3] === 4) [y, m, d] = p;
  else if (format === 'mdy') [m, d, y] = p;
  else [d, m, y] = p;

  if (y < 100) y += y < 70 ? 2000 : 1900;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const check = new Date(Date.UTC(y, m - 1, d));
  if (check.getUTCMonth() !== m - 1) return null;
  return `${y}${String(m).padStart(2, '0')}${String(d).padStart(2, '0')}`;
}

/** Deterministic 53-bit string hash (cyrb53), returned as hex. */
function hash(str) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}

/**
 * Turn raw QIF records into normalized transactions.
 * Each transaction gets a stable FITID from date, amount, payee and memo.
 * Identical transactions on the same day get a counter, so they stay separate.
 */
export function normalizeTransactions(records, dateFormat = 'auto') {
  const format = dateFormat === 'auto'
    ? detectDateFormat(records.map((r) => r.date).filter(Boolean))
    : dateFormat;

  const seen = new Map();
  const transactions = [];
  const errors = [];

  records.forEach((r, index) => {
    const date = parseDate(r.date, format);
    const amount = parseAmount(r.amount);
    if (!date || Number.isNaN(amount)) {
      errors.push({ index, record: r, reason: !date ? `bad date "${r.date}"` : `bad amount "${r.amount}"` });
      return;
    }
    const payee = r.payee || '';
    const memo = r.memo || '';
    const key = `${date}|${amount.toFixed(2)}|${payee}|${memo}`;
    const count = seen.get(key) || 0;
    seen.set(key, count + 1);
    transactions.push({
      fitid: hash(count === 0 ? key : `${key}|${count}`),
      date,
      amount,
      payee,
      memo,
      num: r.num || '',
      category: r.category || '',
    });
  });

  return { transactions, errors, dateFormat: format };
}

function escapeSgml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatAmount(n) {
  return (Math.round(n * 100) / 100).toFixed(2);
}

function nowStamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;
}

/**
 * Build an OFX 1.0.2 (SGML) statement.
 * options: currency, accountId, bankId, acctType (CHECKING | SAVINGS | CREDITCARD), balance, now
 */
export function buildOfx(transactions, options = {}) {
  const currency = (options.currency || 'EUR').toUpperCase();
  const acctType = (options.acctType || 'CHECKING').toUpperCase();
  const accountId = options.accountId || `WISE-${currency}`;
  const bankId = options.bankId || 'WISE';
  const isCard = acctType === 'CREDITCARD';
  const now = nowStamp(options.now);

  const sorted = [...transactions].sort((a, b) => a.date.localeCompare(b.date));
  const dtStart = sorted.length ? sorted[0].date : now.slice(0, 8);
  const dtEnd = sorted.length ? sorted[sorted.length - 1].date : now.slice(0, 8);
  const sum = sorted.reduce((acc, t) => acc + t.amount, 0);
  const balance = options.balance !== undefined && options.balance !== '' && !Number.isNaN(Number(options.balance))
    ? Number(options.balance)
    : sum;

  const trnLines = sorted.map((t) => {
    const lines = [
      '<STMTTRN>',
      `<TRNTYPE>${t.amount < 0 ? 'DEBIT' : 'CREDIT'}`,
      `<DTPOSTED>${t.date}`,
      `<TRNAMT>${formatAmount(t.amount)}`,
      `<FITID>${t.fitid}`,
    ];
    if (/^\d+$/.test(t.num)) lines.push(`<CHECKNUM>${t.num}`);
    const name = t.payee || t.memo || 'Transaction';
    lines.push(`<NAME>${escapeSgml(name.slice(0, 32))}`);
    if (t.memo) lines.push(`<MEMO>${escapeSgml(t.memo.slice(0, 255))}`);
    lines.push('</STMTTRN>');
    return lines.join('\n');
  });

  const acctFrom = isCard
    ? `<CCACCTFROM>\n<ACCTID>${escapeSgml(accountId)}\n</CCACCTFROM>`
    : `<BANKACCTFROM>\n<BANKID>${escapeSgml(bankId)}\n<ACCTID>${escapeSgml(accountId)}\n<ACCTTYPE>${acctType}\n</BANKACCTFROM>`;

  const stmtBody = [
    `<CURDEF>${currency}`,
    acctFrom,
    '<BANKTRANLIST>',
    `<DTSTART>${dtStart}`,
    `<DTEND>${dtEnd}`,
    ...trnLines,
    '</BANKTRANLIST>',
    '<LEDGERBAL>',
    `<BALAMT>${formatAmount(balance)}`,
    `<DTASOF>${dtEnd}`,
    '</LEDGERBAL>',
  ].join('\n');

  const msgSet = isCard
    ? `<CREDITCARDMSGSRSV1>\n<CCSTMTTRNRS>\n<TRNUID>1\n<STATUS>\n<CODE>0\n<SEVERITY>INFO\n</STATUS>\n<CCSTMTRS>\n${stmtBody}\n</CCSTMTRS>\n</CCSTMTTRNRS>\n</CREDITCARDMSGSRSV1>`
    : `<BANKMSGSRSV1>\n<STMTTRNRS>\n<TRNUID>1\n<STATUS>\n<CODE>0\n<SEVERITY>INFO\n</STATUS>\n<STMTRS>\n${stmtBody}\n</STMTRS>\n</STMTTRNRS>\n</BANKMSGSRSV1>`;

  const header = [
    'OFXHEADER:100',
    'DATA:OFXSGML',
    'VERSION:102',
    'SECURITY:NONE',
    'ENCODING:UTF-8',
    'CHARSET:NONE',
    'COMPRESSION:NONE',
    'OLDFILEUID:NONE',
    'NEWFILEUID:NONE',
    '',
  ].join('\r\n');

  const body = [
    '<OFX>',
    '<SIGNONMSGSRSV1>',
    '<SONRS>',
    '<STATUS>',
    '<CODE>0',
    '<SEVERITY>INFO',
    '</STATUS>',
    `<DTSERVER>${now}`,
    '<LANGUAGE>ENG',
    '</SONRS>',
    '</SIGNONMSGSRSV1>',
    msgSet,
    '</OFX>',
    '',
  ].join('\n');

  return `${header}\r\n${body.replace(/\r?\n/g, '\r\n')}`;
}

/** One-call conversion: QIF text in, OFX text plus details out. */
export function convertQifToOfx(qifText, options = {}) {
  const { type, records } = parseQif(qifText);
  const { transactions, errors, dateFormat } = normalizeTransactions(records, options.dateFormat || 'auto');
  let acctType = options.acctType;
  if (!acctType) acctType = type && /ccard/i.test(type) ? 'CREDITCARD' : 'CHECKING';
  const ofx = buildOfx(transactions, { ...options, acctType });
  return { ofx, transactions, errors, dateFormat, qifType: type, acctType };
}
