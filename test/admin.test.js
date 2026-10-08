const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../server/app');
const { MyXpendDatabase } = require('../server/database');

test('admin access is restricted and exposes complete financial records without credentials', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'myxpend-admin-'));
  const dbPath = path.join(directory, 'test.db');
  const fixture = new MyXpendDatabase(dbPath);
  const salt = 'admin-test-salt';
  const password = 'OwnerPassword7';
  const passwordHash = `${salt}:${crypto.scryptSync(password, salt, 64).toString('hex')}`;
  const owner = fixture.createUser({ name: 'Site Owner', email: 'owner@example.com', passwordHash });
  const customer = fixture.createUser({ name: '<img src=x onerror=alert(1)>', email: 'customer@example.com', passwordHash });
  const other = fixture.createUser({ name: 'Other User', email: 'other@example.com', passwordHash });
  for (let i = 0; i < 26; i++) fixture.createUser({ name: `Empty User ${i}`, email: `empty${i}@example.com`, passwordHash });
  const [bank, cash] = fixture.listAccounts(customer.id);
  fixture.createTransaction(customer.id, { kind: 'income', amountCents: 100000, accountId: bank.id, description: 'Deposit', category: 'Salary', transactionDate: '2026-01-01' });
  for (let i = 0; i < 507; i++) fixture.createTransaction(customer.id, { kind: 'expense', amountCents: 100, accountId: bank.id, description: `Expense ${i}`, category: 'Other', transactionDate: '2026-02-01', notes: 'Private customer note' });
  fixture.createTransaction(customer.id, { kind: 'transfer', amountCents: 1000, accountId: bank.id, targetAccountId: cash.id, description: 'Cash transfer', category: 'Other', transactionDate: '2026-02-02' });
  fixture.setBudget(customer.id, 200000);
  fixture.createTransaction(other.id, { kind: 'income', amountCents: 500, accountId: fixture.listAccounts(other.id)[0].id, description: 'Other private record', category: 'Salary', transactionDate: '2026-01-01' });
  fixture.close();
  const { server, db } = createApp({ dbPath, adminEmail: ' OWNER@EXAMPLE.COM ' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); fs.rmSync(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(route, { cookie = '', method = 'GET', body } = {}) {
    const response = await fetch(`${base}${route}`, { method, headers: { Cookie: cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { response, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] || cookie };
  }
  const login = await request('/api/auth/login', { method: 'POST', body: { email: owner.email, password } });
  assert.equal(login.data.user.is_admin, true);
  const ownerCookie = login.cookie;
  const ordinary = await request('/api/auth/login', { method: 'POST', body: { email: customer.email, password } });
  assert.equal(ordinary.data.user.is_admin, false);
  const routes = ['/api/admin/overview', '/api/admin/users', `/api/admin/users/${customer.id}`, `/api/admin/users/${customer.id}/transactions`, `/api/admin/users/${customer.id}/history`, `/api/admin/users/${customer.id}/export`];
  for (const route of routes) {
    assert.equal((await request(route)).response.status, 401);
    assert.equal((await request(route, { cookie: ordinary.cookie })).response.status, 403);
  }
  const escalated = await request('/api/auth/register', { method: 'POST', body: { name: 'Attempted Admin', email: 'attempt@example.com', password: 'AttemptPassword7', is_admin: true, role: 'admin', adminEmail: 'attempt@example.com' } });
  assert.equal(escalated.data.user.is_admin, false);
  assert.equal((await request('/api/admin/users', { cookie: escalated.cookie })).response.status, 403);
  const overview = await request('/api/admin/overview', { cookie: ownerCookie });
  assert.deepEqual(overview.data.summary, { user_count: 30, transaction_count: 510, expense_cents: 50700, income_cents: 100500 });
  const page1 = await request('/api/admin/users', { cookie: ownerCookie });
  const page2 = await request('/api/admin/users?offset=25', { cookie: ownerCookie });
  assert.equal(page1.data.total, 30); assert.equal(page1.data.users.length, 25); assert.equal(page2.data.users.length, 5);
  assert.equal(new Set([...page1.data.users, ...page2.data.users].map((user) => user.id)).size, 30);
  const search = await request('/api/admin/users?search=customer%40example.com', { cookie: ownerCookie });
  assert.equal(search.data.total, 1); assert.equal(search.data.users[0].transaction_count, 509);
  assert.equal(search.data.users[0].expense_cents, 50700);
  const profile = await request(`/api/admin/users/${customer.id}`, { cookie: ownerCookie });
  assert.equal(profile.data.user.name, customer.name);
  assert.equal(profile.data.summary.total_balance_cents, 49300);
  assert.equal(profile.data.accounts.find((row) => row.type === 'cash').balance_cents, 1000);
  assert.equal(profile.data.budget.monthly_limit_cents, 200000);
  const ledger1 = await request(`/api/admin/users/${customer.id}/transactions?limit=100`, { cookie: ownerCookie });
  const ledgerLast = await request(`/api/admin/users/${customer.id}/transactions?limit=100&offset=500`, { cookie: ownerCookie });
  assert.equal(ledger1.data.total, 509); assert.equal(ledgerLast.data.transactions.length, 9);
  assert.ok(ledgerLast.data.transactions.some((row) => row.kind === 'income'));
  assert.ok(ledger1.data.transactions.some((row) => row.target_account_name === 'Cash'));
  assert.ok(ledger1.data.transactions.every((row) => row.user_id === customer.id));
  const filtered = await request(`/api/admin/users/${customer.id}/transactions?kind=income&search=Deposit`, { cookie: ownerCookie });
  assert.equal(filtered.data.total, 1); assert.equal(filtered.data.transactions[0].description, 'Deposit');
  const history = await request(`/api/admin/users/${customer.id}/history?asOf=2026-03-01&month=2026-02`, { cookie: ownerCookie });
  assert.equal(history.data.overall.amount_cents, 50700); assert.equal(history.data.selected_month.days.length, 28);
  const exported = await request(`/api/admin/users/${customer.id}/export`, { cookie: ownerCookie });
  assert.equal(exported.data.transactions.length, 509);
  assert.match(exported.response.headers.get('content-disposition'), /myxpend-user-2.json/);
  for (const result of [login, ordinary, overview, page1, page2, search, profile, ledger1, ledgerLast, filtered, history, exported]) {
    assert.doesNotMatch(JSON.stringify(result.data), /password|token_hash|OwnerPassword7|admin-test-salt/);
    assert.match(result.response.headers.get('cache-control'), /no-store/);
  }
  assert.equal((await request('/api/admin/users/999999', { cookie: ownerCookie })).response.status, 404);
  assert.equal((await request('/api/admin/users?limit=101', { cookie: ownerCookie })).response.status, 422);
  assert.equal((await request('/api/admin/users?offset=-1', { cookie: ownerCookie })).response.status, 422);
  assert.equal((await request(`/api/admin/users/${customer.id}/history?month=2026-99`, { cookie: ownerCookie })).response.status, 422);
  assert.equal((await request(`/api/admin/users/${customer.id}`, { cookie: ownerCookie, method: 'DELETE' })).response.status, 405);
  assert.ok(db.db.prepare('SELECT * FROM admin_audit_events').all().every((row) => row.admin_user_id === owner.id && row.target_user_id === customer.id));
  assert.equal(db.db.prepare("SELECT COUNT(*) AS count FROM admin_audit_events WHERE action = 'export'").get().count, 1);
  const ownLedger = await request('/api/transactions', { cookie: ordinary.cookie });
  assert.ok(ownLedger.data.transactions.every((row) => row.user_id === customer.id));
  await request('/api/auth/logout', { cookie: ownerCookie, method: 'POST' });
  assert.equal((await request('/api/admin/users', { cookie: ownerCookie })).response.status, 401);
});

test('admin defaults to disabled and cannot be claimed through a future registration', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'myxpend-admin-disabled-'));
  const dbPath = path.join(directory, 'test.db');
  assert.throws(() => createApp({ dbPath, adminEmail: 'missing@example.com' }), /existing MyXpend account/);
  const { server } = createApp({ dbPath, adminEmail: '' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); fs.rmSync(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const registered = await fetch(`${base}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Missing Admin', email: 'missing@example.com', password: 'StrongPassword7' }) });
  const cookie = registered.headers.get('set-cookie').split(';')[0];
  assert.equal((await registered.json()).user.is_admin, false);
  assert.equal((await fetch(`${base}/api/admin/users`, { headers: { Cookie: cookie } })).status, 403);
});
