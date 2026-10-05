const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../server/app');

test('MyXpend API keeps each user private and derives balances from transactions', async (t) => {
  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'myxpend-test-'));
  const { server } = createApp({ dbPath: path.join(tempDirectory, 'test.db') });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tempDirectory, { recursive: true, force: true });
  });

  async function request(pathname, { cookie = '', method = 'GET', body } = {}) {
    const response = await fetch(`${baseUrl}${pathname}`, {
      method,
      headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    const contentType = response.headers.get('content-type') || '';
    const payload = contentType.includes('application/json') ? await response.json() : await response.text();
    return { response, payload, cookie: response.headers.get('set-cookie')?.split(';')[0] || cookie };
  }

  const aliceRegistration = await request('/api/auth/register', {
    method: 'POST', body: { name: 'Alice Example', email: 'alice@example.com', password: 'StrongPass1' }
  });
  assert.equal(aliceRegistration.response.status, 201);
  const aliceCookie = aliceRegistration.cookie;

  const accountsResponse = await request('/api/accounts', { cookie: aliceCookie });
  assert.deepEqual(accountsResponse.payload.accounts.map((account) => account.name), ['Bank', 'Cash']);
  const bank = accountsResponse.payload.accounts[0];

  const income = await request('/api/transactions', {
    cookie: aliceCookie, method: 'POST', body: {
      kind: 'income', amount: 1000, accountId: bank.id, description: 'Opening deposit',
      category: 'Salary', transactionDate: '2026-09-01', notes: 'Test income',
      targetAccountId: accountsResponse.payload.accounts[1].id
    }
  });
  assert.equal(income.response.status, 201);

  const expense = await request('/api/transactions', {
    cookie: aliceCookie, method: 'POST', body: {
      kind: 'expense', amount: 250, accountId: bank.id, description: 'Groceries',
      category: 'Food & Dining', transactionDate: '2026-09-02', notes: ''
    }
  });
  assert.equal(expense.response.status, 201);

  const dashboard = await request('/api/dashboard', { cookie: aliceCookie });
  assert.equal(dashboard.payload.summary.total_balance_cents, 75000);
  assert.equal(dashboard.payload.summary.all_time_expense_cents, 25000);

  const cash = accountsResponse.payload.accounts[1];
  const transfer = await request('/api/transactions', {
    cookie: aliceCookie, method: 'POST', body: {
      kind: 'transfer', amount: 200, accountId: bank.id, targetAccountId: cash.id,
      description: 'Move to cash', category: 'Other', transactionDate: '2026-09-02', notes: ''
    }
  });
  assert.equal(transfer.response.status, 201);
  const afterTransfer = await request('/api/dashboard', { cookie: aliceCookie });
  assert.equal(afterTransfer.payload.summary.total_balance_cents, 75000);
  assert.equal(afterTransfer.payload.accounts.find((account) => account.name === 'Bank').balance_cents, 55000);
  assert.equal(afterTransfer.payload.accounts.find((account) => account.name === 'Cash').balance_cents, 20000);

  const overspend = await request('/api/transactions', {
    cookie: aliceCookie, method: 'POST', body: {
      kind: 'expense', amount: 751, accountId: bank.id, description: 'Too expensive',
      category: 'Other', transactionDate: '2026-09-03', notes: ''
    }
  });
  assert.equal(overspend.response.status, 422);
  assert.match(overspend.payload.fields.amount, /enough balance/i);

  const bobRegistration = await request('/api/auth/register', {
    method: 'POST', body: { name: 'Bob Example', email: 'bob@example.com', password: 'StrongPass2' }
  });
  const bobCookie = bobRegistration.cookie;
  const bobTransactions = await request('/api/transactions', { cookie: bobCookie });
  assert.deepEqual(bobTransactions.payload.transactions, []);

  const crossUserDelete = await request(`/api/transactions/${expense.payload.transaction.id}`, {
    cookie: bobCookie, method: 'DELETE'
  });
  assert.equal(crossUserDelete.response.status, 404);

  const aliceTransactions = await request('/api/transactions', { cookie: aliceCookie });
  assert.equal(aliceTransactions.payload.transactions.length, 3);
});

test('invalid registrations are rejected without creating an account', async (t) => {
  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'myxpend-validation-'));
  const { server } = createApp({ dbPath: path.join(tempDirectory, 'test.db') });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tempDirectory, { recursive: true, force: true });
  });
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'A', email: 'wrong', password: 'short' })
  });
  const body = await response.json();
  assert.equal(response.status, 422);
  assert.deepEqual(Object.keys(body.fields).sort(), ['email', 'name', 'password']);
});

test('expense history preserves all months, handles calendar boundaries, and stays private beyond 500 entries', async (t) => {
  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'myxpend-history-'));
  const dbPath = path.join(tempDirectory, 'history.db');
  let app;
  let baseUrl;
  async function start() {
    app = createApp({ dbPath });
    await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${app.server.address().port}`;
  }
  await start();
  t.after(async () => {
    if (app.server.listening) await new Promise((resolve) => app.server.close(resolve));
    fs.rmSync(tempDirectory, { recursive: true, force: true });
  });
  async function request(pathname, { cookie = '', method = 'GET', body } = {}) {
    const response = await fetch(`${baseUrl}${pathname}`, {
      method, headers: { Cookie: cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    const payload = response.headers.get('content-type').includes('application/json') ? await response.json() : await response.text();
    return { response, payload, cookie: response.headers.get('set-cookie')?.split(';')[0] || cookie };
  }
  const alice = await request('/api/auth/register', {
    method: 'POST', body: { name: 'History Alice', email: 'history-alice@example.com', password: 'StrongPass1' }
  });
  const userId = alice.payload.user.id;
  const accounts = app.db.listAccounts(userId);
  const add = (date, amountCents, category = 'Food & Dining', kind = 'expense') => app.db.createTransaction(userId, {
    accountId: accounts[0].id, targetAccountId: kind === 'transfer' ? accounts[1].id : null,
    kind, amountCents, description: `Entry ${date}`, category, transactionDate: date
  });
  add('2024-02-01', 12550, 'Travel');
  add('2024-02-29', 5025, 'Travel');
  add('2025-02-01', 1000);
  for (let index = 0; index < 501; index++) add('2025-12-01', 100);
  add('2025-12-31', 20025, 'Transport');
  add('2026-01-01', 30000, 'Shopping');
  const last = add('2026-01-15', 40000, 'Shopping');
  add('2026-01-01', 100000000, 'Salary', 'income');
  add('2026-01-01', 100000, 'Other', 'transfer');

  const historyPath = '/api/history?asOf=2026-01-15&month=2025-12';
  const history = await request(historyPath, { cookie: alice.cookie });
  assert.equal(history.response.status, 200);
  assert.equal(history.payload.months.length, 12);
  assert.equal(history.payload.months[0].month, '2025-02');
  assert.equal(history.payload.months.at(-1).month, '2026-01');
  assert.equal(history.payload.months.find((month) => month.month === '2025-03').amount_cents, 0);
  assert.equal(history.payload.months.find((month) => month.month === '2025-12').expense_count, 502);
  assert.equal(history.payload.recent.amount_cents, 141125);
  assert.equal(history.payload.selected_month.days.length, 31);
  assert.equal(history.payload.selected_month.days[0].amount_cents, 50100);
  assert.equal(history.payload.selected_month.days[1].amount_cents, 0);
  assert.equal(history.payload.selected_month.days.at(-1).amount_cents, 20025);
  assert.equal(history.payload.selected_month.amount_cents, 70125);
  assert.equal(history.payload.selected_month.by_category[0].category, 'Food & Dining');
  assert.equal(history.payload.overall.amount_cents, 158700);
  assert.equal(history.payload.overall.expense_count, 507);
  assert.equal(history.payload.overall.months[0].month, '2024-02');
  assert.equal(history.payload.overall.months[1].month, '2024-03');
  assert.equal(history.payload.overall.months[1].amount_cents, 0);
  assert.equal(history.payload.overall.months.at(-1).cumulative_cents, 158700);
  assert.equal(history.payload.overall.by_category.reduce((sum, row) => sum + row.amount_cents, 0), 158700);

  const leap = await request('/api/history?asOf=2026-01-15&month=2024-02', { cookie: alice.cookie });
  assert.equal(leap.payload.selected_month.days.length, 29);
  assert.equal(leap.payload.selected_month.days.at(-1).date, '2024-02-29');
  assert.equal(leap.payload.selected_month.days.at(-1).amount_cents, 5025);
  const emptyMonth = await request('/api/history?asOf=2026-01-15&month=2025-02', { cookie: alice.cookie });
  assert.equal(emptyMonth.payload.selected_month.days.length, 28);

  const dashboard = await request('/api/dashboard', { cookie: alice.cookie });
  assert.equal(dashboard.payload.summary.all_time_expense_cents, 158700);
  const exported = await request('/api/export.csv', { cookie: alice.cookie });
  assert.equal(exported.payload.split('\n').length, 510);
  assert.match(exported.payload, /2024-02-29/);

  // Closing and reopening the actual database must retain older months and sessions.
  await new Promise((resolve) => app.server.close(resolve));
  await start();
  const reopened = await request(historyPath, { cookie: alice.cookie });
  assert.deepEqual(reopened.payload, history.payload);

  const bob = await request('/api/auth/register', {
    method: 'POST', body: { name: 'History Bob', email: 'history-bob@example.com', password: 'StrongPass2' }
  });
  const bobHistory = await request(historyPath, { cookie: bob.cookie });
  assert.equal(bobHistory.payload.overall.amount_cents, 0);
  assert.deepEqual(bobHistory.payload.overall.months, []);
  assert.equal(bobHistory.payload.months.length, 12);
  assert.ok(bobHistory.payload.months.every((month) => month.amount_cents === 0));
  assert.ok(bobHistory.payload.selected_month.days.every((day) => day.amount_cents === 0));
  assert.deepEqual(bobHistory.payload.selected_month.by_category, []);
  assert.equal((await request(historyPath)).response.status, 401);
  for (const query of ['month=2026-13', 'month=2026-1', 'month=wrong', 'asOf=2026-02-30', 'asOf=wrong']) {
    assert.equal((await request(`/api/history?${query}`, { cookie: alice.cookie })).response.status, 422);
  }
  const deleted = await request(`/api/transactions/${last.id}`, { cookie: alice.cookie, method: 'DELETE' });
  assert.equal(deleted.response.status, 200);
  const afterDelete = await request(historyPath, { cookie: alice.cookie });
  assert.equal(afterDelete.payload.overall.amount_cents, 118700);
  assert.equal(afterDelete.payload.months.at(-1).amount_cents, 30000);
});
