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
