import { convertQifToOfx } from './qif2ofx.js';

const $ = (id) => document.getElementById(id);
const fileInput = $('file');
const drop = $('drop');
const optionIds = ['currency', 'acctType', 'dateFormat', 'accountId', 'balance'];

let current = null; // { name, text }
let lastOfx = '';

function readOptions() {
  const balanceRaw = $('balance').value.trim().replace(',', '.');
  return {
    currency: $('currency').value.trim() || 'EUR',
    acctType: $('acctType').value || undefined,
    dateFormat: $('dateFormat').value,
    accountId: $('accountId').value.trim() || undefined,
    balance: balanceRaw === '' ? undefined : balanceRaw,
  };
}

function formatDate(yyyymmdd) {
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}

function render() {
  $('error').hidden = true;
  if (!current) return;

  let result;
  try {
    result = convertQifToOfx(current.text, readOptions());
  } catch (err) {
    $('result').hidden = true;
    $('error').textContent = `Conversion failed: ${err.message}`;
    $('error').hidden = false;
    return;
  }

  if (result.transactions.length === 0) {
    $('result').hidden = true;
    $('error').textContent = 'No transactions found. Check that the file is a QIF statement.';
    $('error').hidden = false;
    return;
  }

  lastOfx = result.ofx;
  const opts = readOptions();
  const currency = opts.currency.toUpperCase();
  $('accountId').placeholder = `WISE-${currency}`;
  const fmt = new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const sum = result.transactions.reduce((a, t) => a + t.amount, 0);
  const dateLabel = { dmy: 'day/month/year', mdy: 'month/day/year', ymd: 'year-month-day' }[result.dateFormat];

  $('summary').textContent =
    `${current.name}: ${result.transactions.length} transactions, total ${fmt.format(sum)} ${currency}. ` +
    `Dates read as ${dateLabel}. Account type ${result.acctType.toLowerCase()}.`;

  if (result.errors.length) {
    $('warnings').textContent = `Skipped ${result.errors.length} record(s): ` +
      result.errors.slice(0, 3).map((e) => e.reason).join('; ') + (result.errors.length > 3 ? '…' : '');
    $('warnings').hidden = false;
  } else {
    $('warnings').hidden = true;
  }

  const rows = $('rows');
  rows.replaceChildren(...result.transactions.map((t) => {
    const tr = document.createElement('tr');
    const cells = [formatDate(t.date), t.payee, t.memo, fmt.format(t.amount)];
    cells.forEach((value, i) => {
      const td = document.createElement('td');
      td.textContent = value;
      if (i === 3) td.className = t.amount < 0 ? 'num neg' : 'num';
      tr.append(td);
    });
    return tr;
  }));

  $('result').hidden = false;
}

async function loadFile(file) {
  if (!file) return;
  current = { name: file.name, text: await file.text() };
  $('drop-text').innerHTML = '';
  const strong = document.createElement('strong');
  strong.textContent = file.name;
  $('drop-text').append(strong, ' — choose another file or drop it here');

  // Guess the currency from the file name, for example "statement_EUR_2026-01.qif".
  const match = file.name.match(/(?:^|[^A-Z])([A-Z]{3})(?:[^A-Z]|$)/);
  if (match && match[1] !== 'QIF' && match[1] !== 'OFX') $('currency').value = match[1];

  render();
}

fileInput.addEventListener('change', () => loadFile(fileInput.files[0]));

['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => {
  e.preventDefault();
  drop.classList.add('over');
}));
['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => {
  e.preventDefault();
  drop.classList.remove('over');
}));
drop.addEventListener('drop', (e) => loadFile(e.dataTransfer.files[0]));

optionIds.forEach((id) => $(id).addEventListener('input', render));

$('download').addEventListener('click', () => {
  if (!lastOfx || !current) return;
  const blob = new Blob([lastOfx], { type: 'application/x-ofx' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = current.name.replace(/\.qif$/i, '') + '.ofx';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
