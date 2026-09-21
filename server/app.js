const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { MyXpendDatabase } = require('./database');

const scrypt = promisify(crypto.scrypt);
const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const VOLUME_PATH = process.env.RAILWAY_VOLUME_MOUNT_PATH;
const DEFAULT_DB = process.env.MYXPEND_DB || (VOLUME_PATH ? path.join(VOLUME_PATH, 'myxpend.db') : path.join(ROOT, 'data', 'myxpend.db'));
const PORT = Number(process.env.PORT || 3000);
const CATEGORIES = [
  'Food & Dining', 'Transport', 'Shopping', 'Entertainment',
  'Bills & Utilities', 'Health', 'Education', 'Travel', 'Salary', 'Other'
];

function json(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers
  });
  res.end(JSON.stringify(body));
}

function errorResponse(res, status, message, fields) {
  json(res, status, { error: message, ...(fields ? { fields } : {}) });
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw Object.assign(new Error('Request is too large'), { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('Request body must be valid JSON'), { status: 400 });
  }
}

function parseCookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').filter(Boolean).map((part) => {
    const index = part.indexOf('=');
    return [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1))];
  }));
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = await scrypt(password, salt, 64);
  return `${salt}:${derived.toString('hex')}`;
}

async function verifyPassword(password, stored) {
  const [salt, expectedHex] = stored.split(':');
  if (!salt || !expectedHex) return false;
  const actual = await scrypt(password, salt, 64);
  const expected = Buffer.from(expectedHex, 'hex');
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function sessionCookie(token, maxAge = 60 * 60 * 24 * 14) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `myxpend_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

function currentUser(req, db) {
  const token = parseCookies(req).myxpend_session;
  return token ? db.getSession(tokenHash(token)) : null;
}

function requireUser(req, res, db) {
  const user = currentUser(req, db);
  if (!user) errorResponse(res, 401, 'Please sign in to continue');
  return user;
}

function toCents(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || number > 100_000_000) return null;
  return Math.round(number * 100);
}

function isDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value || '') && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

function localDateString(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function dashboard(db, userId) {
  const accounts = db.listAccounts(userId).map((row) => ({ ...row, balance_cents: Number(row.balance_cents) }));
  const all = db.listTransactions(userId);
  const today = localDateString();
  const now = new Date();
  const month = today.slice(0, 7);
  const previous = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const previousMonth = `${previous.getFullYear()}-${String(previous.getMonth() + 1).padStart(2, '0')}`;
  const expenses = all.filter((item) => item.kind === 'expense');
  const currentMonth = expenses.filter((item) => item.transaction_date.startsWith(month));
  const previousMonthItems = expenses.filter((item) => item.transaction_date.startsWith(previousMonth));
  const sum = (rows) => rows.reduce((total, row) => total + Number(row.amount_cents), 0);
  const currentMonthCents = sum(currentMonth);
  const previousMonthCents = sum(previousMonthItems);
  const byCategory = Object.entries(currentMonth.reduce((result, item) => {
    result[item.category] = (result[item.category] || 0) + Number(item.amount_cents);
    return result;
  }, {})).map(([category, amount_cents]) => ({ category, amount_cents }))
    .sort((a, b) => b.amount_cents - a.amount_cents);
  const budget = db.getBudget(userId)?.monthly_limit_cents || 0;
  const insights = [];
  if (previousMonthCents && currentMonthCents > previousMonthCents) {
    const increase = Math.round(((currentMonthCents - previousMonthCents) / previousMonthCents) * 100);
    insights.push(`Spending is ${increase}% above last month. Review your largest category before your next purchase.`);
  }
  if (budget && currentMonthCents > budget) {
    insights.push(`You have exceeded your monthly budget by ₹${((currentMonthCents - budget) / 100).toFixed(2)}.`);
  } else if (budget) {
    insights.push(`₹${((budget - currentMonthCents) / 100).toFixed(2)} remains in this month's budget.`);
  }
  if (byCategory[0] && currentMonthCents) {
    const share = Math.round((byCategory[0].amount_cents / currentMonthCents) * 100);
    insights.push(`${byCategory[0].category} is your largest category at ${share}% of this month's spending.`);
  }
  if (!insights.length) insights.push('Add a monthly budget to receive useful spending insights.');
  return {
    accounts,
    summary: {
      total_balance_cents: accounts.reduce((total, account) => total + account.balance_cents, 0),
      this_month_cents: currentMonthCents,
      today_cents: sum(expenses.filter((item) => item.transaction_date === today)),
      all_time_expense_cents: sum(expenses),
      daily_average_cents: Math.round(currentMonthCents / Math.max(now.getDate(), 1)),
      previous_month_cents: previousMonthCents,
      monthly_budget_cents: Number(budget)
    },
    by_category: byCategory,
    insights,
    recent_transactions: all.slice(0, 8)
  };
}

function validateTransaction(db, userId, body) {
  const fields = {};
  const kind = String(body.kind || 'expense');
  const amountCents = toCents(body.amount);
  const accountId = Number(body.accountId);
  const targetAccountId = kind === 'transfer' && body.targetAccountId ? Number(body.targetAccountId) : null;
  const description = String(body.description || '').trim();
  const category = String(body.category || '').trim();
  const transactionDate = String(body.transactionDate || '');
  const notes = String(body.notes || '').trim();
  if (!['income', 'expense', 'transfer'].includes(kind)) fields.kind = 'Choose a valid transaction type';
  if (!amountCents) fields.amount = 'Enter an amount greater than zero';
  if (!db.accountBelongsTo(userId, accountId)) fields.accountId = 'Choose one of your accounts';
  if (kind === 'transfer' && !db.accountBelongsTo(userId, targetAccountId)) fields.targetAccountId = 'Choose a destination account';
  if (kind === 'transfer' && accountId === targetAccountId) fields.targetAccountId = 'Choose a different destination account';
  if (description.length < 2 || description.length > 80) fields.description = 'Use 2 to 80 characters';
  if (!category || category.length > 40) fields.category = 'Choose a category';
  if (!isDate(transactionDate)) fields.transactionDate = 'Choose a valid date';
  if (notes.length > 300) fields.notes = 'Keep notes under 300 characters';
  if (!Object.keys(fields).length && ['expense', 'transfer'].includes(kind)) {
    const balance = db.getAccountBalance(userId, accountId);
    if (amountCents > balance) fields.amount = 'This account does not have enough balance';
  }
  return { fields, value: { kind, amountCents, accountId, targetAccountId, description, category, transactionDate, notes } };
}

function csvEscape(value) {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function serveStatic(req, res, pathname) {
  const requested = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.resolve(PUBLIC, requested);
  if (!file.startsWith(`${PUBLIC}${path.sep}`) && file !== path.join(PUBLIC, 'index.html')) return false;
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  const type = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' }[path.extname(file)] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
  return true;
}

function createApp({ dbPath = DEFAULT_DB } = {}) {
  const db = new MyXpendDatabase(dbPath);
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'");
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;
    try {
      if (req.method === 'GET' && pathname === '/api/health') {
        return json(res, 200, { status: 'ok' });
      }
      if (req.method === 'POST' && pathname === '/api/auth/register') {
        const body = await readJson(req);
        const name = String(body.name || '').trim();
        const email = String(body.email || '').trim().toLowerCase();
        const password = String(body.password || '');
        const fields = {};
        if (name.length < 2 || name.length > 60) fields.name = 'Use 2 to 60 characters';
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fields.email = 'Enter a valid email address';
        if (password.length < 8 || !/[a-zA-Z]/.test(password) || !/\d/.test(password)) fields.password = 'Use at least 8 characters with a letter and a number';
        if (Object.keys(fields).length) return errorResponse(res, 422, 'Please correct the highlighted fields', fields);
        if (db.getUserByEmail(email)) return errorResponse(res, 409, 'An account with this email already exists');
        const user = db.createUser({ name, email, passwordHash: await hashPassword(password) });
        const token = crypto.randomBytes(32).toString('base64url');
        const expires = new Date(Date.now() + 14 * 86400_000).toISOString();
        db.createSession(tokenHash(token), user.id, expires);
        return json(res, 201, { user }, { 'Set-Cookie': sessionCookie(token) });
      }
      if (req.method === 'POST' && pathname === '/api/auth/login') {
        const body = await readJson(req);
        const user = db.getUserByEmail(String(body.email || '').trim().toLowerCase());
        if (!user || !(await verifyPassword(String(body.password || ''), user.password_hash))) {
          return errorResponse(res, 401, 'Email or password is incorrect');
        }
        const token = crypto.randomBytes(32).toString('base64url');
        db.createSession(tokenHash(token), user.id, new Date(Date.now() + 14 * 86400_000).toISOString());
        return json(res, 200, { user: db.getUserById(user.id) }, { 'Set-Cookie': sessionCookie(token) });
      }
      if (req.method === 'POST' && pathname === '/api/auth/logout') {
        const token = parseCookies(req).myxpend_session;
        if (token) db.deleteSession(tokenHash(token));
        return json(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0) });
      }
      if (req.method === 'GET' && pathname === '/api/me') {
        const user = requireUser(req, res, db); if (!user) return;
        return json(res, 200, { user: { id: user.user_id, name: user.name, email: user.email } });
      }
      if (req.method === 'GET' && pathname === '/api/dashboard') {
        const user = requireUser(req, res, db); if (!user) return;
        return json(res, 200, dashboard(db, user.user_id));
      }
      if (req.method === 'GET' && pathname === '/api/accounts') {
        const user = requireUser(req, res, db); if (!user) return;
        return json(res, 200, { accounts: db.listAccounts(user.user_id) });
      }
      if (req.method === 'GET' && pathname === '/api/transactions') {
        const user = requireUser(req, res, db); if (!user) return;
        const filters = Object.fromEntries(['kind', 'category', 'search', 'from', 'to'].map((key) => [key, url.searchParams.get(key) || '']));
        return json(res, 200, { transactions: db.listTransactions(user.user_id, filters) });
      }
      if (req.method === 'POST' && pathname === '/api/transactions') {
        const user = requireUser(req, res, db); if (!user) return;
        const checked = validateTransaction(db, user.user_id, await readJson(req));
        if (Object.keys(checked.fields).length) return errorResponse(res, 422, 'Please correct the highlighted fields', checked.fields);
        return json(res, 201, { transaction: db.createTransaction(user.user_id, checked.value) });
      }
      const deleteMatch = pathname.match(/^\/api\/transactions\/(\d+)$/);
      if (req.method === 'DELETE' && deleteMatch) {
        const user = requireUser(req, res, db); if (!user) return;
        const changed = db.deleteTransaction(user.user_id, Number(deleteMatch[1]));
        return changed ? json(res, 200, { ok: true }) : errorResponse(res, 404, 'Transaction not found');
      }
      if (req.method === 'POST' && pathname === '/api/budget') {
        const user = requireUser(req, res, db); if (!user) return;
        const body = await readJson(req);
        const cents = body.amount === 0 || body.amount === '0' ? 0 : toCents(body.amount);
        if (cents === null) return errorResponse(res, 422, 'Budget must be zero or a positive amount');
        db.setBudget(user.user_id, cents);
        return json(res, 200, { monthly_budget_cents: cents });
      }
      if (req.method === 'GET' && pathname === '/api/export.csv') {
        const user = requireUser(req, res, db); if (!user) return;
        const rows = db.listTransactions(user.user_id);
        const header = ['Date', 'Type', 'Description', 'Category', 'Account', 'Destination', 'Amount', 'Notes'];
        const lines = [header, ...rows.map((item) => [
          item.transaction_date, item.kind, item.description, item.category,
          item.account_name, item.target_account_name || '', (Number(item.amount_cents) / 100).toFixed(2), item.notes
        ])].map((row) => row.map(csvEscape).join(','));
        res.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="myxpend-transactions.csv"',
          'Cache-Control': 'no-store'
        });
        return res.end(`\uFEFF${lines.join('\n')}`);
      }
      if (pathname.startsWith('/api/')) return errorResponse(res, 404, 'API route not found');
      if (serveStatic(req, res, pathname)) return;
      serveStatic(req, res, '/');
    } catch (error) {
      console.error(error);
      errorResponse(res, error.status || 500, error.status ? error.message : 'Something went wrong');
    }
  });
  server.on('close', () => db.close());
  return { server, db };
}

if (require.main === module) {
  const { server } = createApp();
  server.listen(PORT, () => console.log(`MyXpend is running at http://localhost:${PORT}`));
}

module.exports = { createApp };
