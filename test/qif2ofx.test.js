import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parseQif, parseAmount, parseDate, detectDateFormat, normalizeTransactions, convertQifToOfx,
} from '../site/qif2ofx.js';

const fixture = readFileSync(new URL('./fixture-wise.qif', import.meta.url), 'utf8');

test('parseAmount handles common formats', () => {
  assert.equal(parseAmount('-12.50'), -12.5);
  assert.equal(parseAmount('1,250.00'), 1250);
  assert.equal(parseAmount('1.250,00'), 1250);
  assert.equal(parseAmount('-12,5'), -12.5);
  assert.equal(parseAmount('1,250'), 1250);
  assert.ok(Number.isNaN(parseAmount(undefined)));
});

test('date detection and parsing', () => {
  assert.equal(detectDateFormat(['25/11/2026', '03/11/2026']), 'dmy');
  assert.equal(detectDateFormat(['11/25/2026', '11/03/2026']), 'mdy');
  assert.equal(detectDateFormat(['03/04/2026']), 'dmy');
  assert.equal(detectDateFormat(['2026-11-25']), 'ymd');
  assert.equal(parseDate('25/11/2026', 'dmy'), '20261125');
  assert.equal(parseDate("11/25'26", 'mdy'), '20261125');
  assert.equal(parseDate('2026-11-25', 'dmy'), '20261125');
  assert.equal(parseDate('31/02/2026', 'dmy'), null);
});

test('parseQif reads bank records and skips account blocks', () => {
  const { type, records } = parseQif(fixture);
  assert.equal(type, 'Bank');
  assert.equal(records.length, 4);

  const withAccount = '!Account\nNWise EUR\nTBank\n^\n!Type:Bank\nD01/12/2026\nT5.00\nPX\n^\n';
  assert.equal(parseQif(withAccount).records.length, 1);
});

test('FITIDs are stable and identical same-day transactions stay separate', () => {
  const a = normalizeTransactions(parseQif(fixture).records);
  const b = normalizeTransactions(parseQif(fixture).records);
  assert.deepEqual(a.transactions.map((t) => t.fitid), b.transactions.map((t) => t.fitid));
  const ids = new Set(a.transactions.map((t) => t.fitid));
  assert.equal(ids.size, 4);
});

test('convertQifToOfx builds a valid-looking OFX 1.0.2 bank statement', () => {
  const now = new Date(Date.UTC(2026, 10, 27, 10, 0, 0));
  const { ofx, transactions, errors } = convertQifToOfx(fixture, { currency: 'eur', now });
  assert.equal(errors.length, 0);
  assert.equal(transactions.length, 4);
  assert.match(ofx, /^OFXHEADER:100\r\nDATA:OFXSGML\r\nVERSION:102/);
  assert.match(ofx, /<CURDEF>EUR/);
  assert.match(ofx, /<ACCTID>WISE-EUR/);
  assert.match(ofx, /<ACCTTYPE>CHECKING/);
  assert.match(ofx, /<DTSTART>20261103/);
  assert.match(ofx, /<DTEND>20261125/);
  assert.match(ofx, /<NAME>Acme &amp; Sons &lt;Payroll&gt;/);
  assert.match(ofx, /<TRNTYPE>CREDIT\r\n<DTPOSTED>20261103\r\n<TRNAMT>1250.00/);
  assert.match(ofx, /<BALAMT>1221.80/);
  assert.equal((ofx.match(/<STMTTRN>/g) || []).length, 4);
  assert.match(ofx, /<NAME>Café Lisboa/);
});

test('balance override and credit card output', () => {
  const { ofx } = convertQifToOfx(fixture, { currency: 'EUR', acctType: 'CREDITCARD', balance: '-99.9' });
  assert.match(ofx, /<CREDITCARDMSGSRSV1>/);
  assert.match(ofx, /<CCACCTFROM>\r\n<ACCTID>WISE-EUR/);
  assert.match(ofx, /<BALAMT>-99.90/);
});

test('!Type:CCard switches to credit card automatically', () => {
  const { acctType } = convertQifToOfx('!Type:CCard\nD01/12/2026\nT-5.00\nPShop\n^\n');
  assert.equal(acctType, 'CREDITCARD');
});
