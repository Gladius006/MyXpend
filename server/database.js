const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

class MyXpendDatabase {
  constructor(filename) {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
    this.migrate();
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE COLLATE NOCASE,
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS accounts (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('bank', 'cash')),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, name)
      );
      CREATE TABLE IF NOT EXISTS transactions (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
        target_account_id INTEGER REFERENCES accounts(id) ON DELETE RESTRICT,
        kind TEXT NOT NULL CHECK(kind IN ('income', 'expense', 'transfer')),
        amount_cents INTEGER NOT NULL CHECK(amount_cents > 0),
        description TEXT NOT NULL,
        category TEXT NOT NULL,
        transaction_date TEXT NOT NULL,
        notes TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CHECK(kind != 'transfer' OR target_account_id IS NOT NULL),
        CHECK(kind = 'transfer' OR target_account_id IS NULL),
        CHECK(target_account_id IS NULL OR target_account_id != account_id)
      );
      CREATE INDEX IF NOT EXISTS idx_transactions_user_date
        ON transactions(user_id, transaction_date DESC, id DESC);
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS budgets (
        user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        monthly_limit_cents INTEGER NOT NULL CHECK(monthly_limit_cents >= 0),
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS admin_audit_events (
        id INTEGER PRIMARY KEY,
        admin_user_id INTEGER NOT NULL REFERENCES users(id),
        target_user_id INTEGER REFERENCES users(id),
        action TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
  }

  close() {
    this.db.close();
  }

  createUser({ name, email, passwordHash }) {
    const insertUser = this.db.prepare(
      'INSERT INTO users(name, email, password_hash) VALUES (?, ?, ?)'
    );
    const insertAccount = this.db.prepare(
      'INSERT INTO accounts(user_id, name, type) VALUES (?, ?, ?)'
    );
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = insertUser.run(name, email, passwordHash);
      const userId = Number(result.lastInsertRowid);
      insertAccount.run(userId, 'Bank', 'bank');
      insertAccount.run(userId, 'Cash', 'cash');
      this.db.exec('COMMIT');
      return this.getUserById(userId);
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  getUserByEmail(email) {
    return this.db.prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE').get(email);
  }

  getUserById(id) {
    return this.db.prepare('SELECT id, name, email, created_at FROM users WHERE id = ?').get(id);
  }

  createSession(tokenHash, userId, expiresAt) {
    this.db.prepare('DELETE FROM sessions WHERE expires_at <= CURRENT_TIMESTAMP').run();
    this.db.prepare(
      'INSERT INTO sessions(token_hash, user_id, expires_at) VALUES (?, ?, ?)'
    ).run(tokenHash, userId, expiresAt);
  }

  getSession(tokenHash) {
    return this.db.prepare(`
      SELECT s.user_id, s.expires_at, u.name, u.email
      FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > CURRENT_TIMESTAMP
    `).get(tokenHash);
  }

  deleteSession(tokenHash) {
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
  }

  listAccounts(userId) {
    return this.db.prepare(`
      SELECT a.id, a.name, a.type, a.created_at,
        COALESCE(SUM(CASE
          WHEN t.kind = 'income' AND t.account_id = a.id THEN t.amount_cents
          WHEN t.kind = 'expense' AND t.account_id = a.id THEN -t.amount_cents
          WHEN t.kind = 'transfer' AND t.account_id = a.id THEN -t.amount_cents
          WHEN t.kind = 'transfer' AND t.target_account_id = a.id THEN t.amount_cents
          ELSE 0 END), 0) AS balance_cents
      FROM accounts a
      LEFT JOIN transactions t ON t.user_id = a.user_id
        AND (t.account_id = a.id OR t.target_account_id = a.id)
      WHERE a.user_id = ?
      GROUP BY a.id
      ORDER BY a.type = 'cash', a.id
    `).all(userId);
  }

  accountBelongsTo(userId, accountId) {
    return Boolean(this.db.prepare(
      'SELECT 1 FROM accounts WHERE id = ? AND user_id = ?'
    ).get(accountId, userId));
  }

  getAccountBalance(userId, accountId) {
    const account = this.listAccounts(userId).find((item) => item.id === accountId);
    return account ? Number(account.balance_cents) : null;
  }

  createTransaction(userId, data) {
    const result = this.db.prepare(`
      INSERT INTO transactions(
        user_id, account_id, target_account_id, kind, amount_cents,
        description, category, transaction_date, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      userId,
      data.accountId,
      data.targetAccountId || null,
      data.kind,
      data.amountCents,
      data.description,
      data.category,
      data.transactionDate,
      data.notes || ''
    );
    return this.getTransaction(userId, Number(result.lastInsertRowid));
  }

  getTransaction(userId, id) {
    return this.db.prepare(`
      SELECT t.*, a.name AS account_name, ta.name AS target_account_name
      FROM transactions t
      JOIN accounts a ON a.id = t.account_id
      LEFT JOIN accounts ta ON ta.id = t.target_account_id
      WHERE t.id = ? AND t.user_id = ?
    `).get(id, userId);
  }

  listTransactions(userId, { kind = '', category = '', search = '', from = '', to = '', limit = 500, offset = 0 } = {}) {
    const clauses = ['t.user_id = ?'];
    const params = [userId];
    if (kind) { clauses.push('t.kind = ?'); params.push(kind); }
    if (category) { clauses.push('t.category = ?'); params.push(category); }
    if (search) {
      clauses.push('(t.description LIKE ? OR t.notes LIKE ?)');
      params.push(`%${search}%`, `%${search}%`);
    }
    if (from) { clauses.push('t.transaction_date >= ?'); params.push(from); }
    if (to) { clauses.push('t.transaction_date <= ?'); params.push(to); }
    if (limit !== null) params.push(limit, offset);
    return this.db.prepare(`
      SELECT t.*, a.name AS account_name, ta.name AS target_account_name
      FROM transactions t
      JOIN accounts a ON a.id = t.account_id
      LEFT JOIN accounts ta ON ta.id = t.target_account_id
      WHERE ${clauses.join(' AND ')}
      ORDER BY t.transaction_date DESC, t.id DESC
      ${limit === null ? '' : 'LIMIT ? OFFSET ?'}
    `).all(...params);
  }

  expenseWhere(userId, { from = '', to = '' } = {}) {
    const clauses = ["user_id = ?", "kind = 'expense'"];
    const params = [userId];
    if (from) { clauses.push('transaction_date >= ?'); params.push(from); }
    if (to) { clauses.push('transaction_date <= ?'); params.push(to); }
    return { where: clauses.join(' AND '), params };
  }

  expenseSummary(userId, range = {}) {
    const { where, params } = this.expenseWhere(userId, range);
    return this.db.prepare(`
      SELECT COALESCE(SUM(amount_cents), 0) AS amount_cents, COUNT(*) AS expense_count,
        MIN(transaction_date) AS first_date, MAX(transaction_date) AS last_date
      FROM transactions WHERE ${where}
    `).get(...params);
  }

  expenseSeries(userId, period, range = {}) {
    const { where, params } = this.expenseWhere(userId, range);
    const group = period === 'day' ? 'transaction_date' : 'substr(transaction_date, 1, 7)';
    return this.db.prepare(`
      SELECT ${group} AS period, SUM(amount_cents) AS amount_cents, COUNT(*) AS expense_count
      FROM transactions WHERE ${where}
      GROUP BY ${group} ORDER BY period
    `).all(...params);
  }

  expenseCategories(userId, range = {}) {
    const { where, params } = this.expenseWhere(userId, range);
    return this.db.prepare(`
      SELECT category, SUM(amount_cents) AS amount_cents, COUNT(*) AS expense_count
      FROM transactions WHERE ${where}
      GROUP BY category ORDER BY amount_cents DESC, category
    `).all(...params);
  }

  deleteTransaction(userId, id) {
    return this.db.prepare('DELETE FROM transactions WHERE id = ? AND user_id = ?').run(id, userId).changes;
  }

  setBudget(userId, amountCents) {
    this.db.prepare(`
      INSERT INTO budgets(user_id, monthly_limit_cents, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id) DO UPDATE SET
        monthly_limit_cents = excluded.monthly_limit_cents,
        updated_at = CURRENT_TIMESTAMP
    `).run(userId, amountCents);
  }

  getBudget(userId) {
    return this.db.prepare('SELECT monthly_limit_cents, updated_at FROM budgets WHERE user_id = ?').get(userId);
  }

  adminOverview() {
    return this.db.prepare(`
      SELECT (SELECT COUNT(*) FROM users) AS user_count,
        COUNT(*) AS transaction_count,
        COALESCE(SUM(CASE WHEN kind = 'expense' THEN amount_cents ELSE 0 END), 0) AS expense_cents,
        COALESCE(SUM(CASE WHEN kind = 'income' THEN amount_cents ELSE 0 END), 0) AS income_cents
      FROM transactions
    `).get();
  }

  adminUsers({ search = '', limit = 25, offset = 0 } = {}) {
    const pattern = `%${search}%`;
    const total = this.db.prepare('SELECT COUNT(*) AS total FROM users WHERE name LIKE ? OR email LIKE ?').get(pattern, pattern).total;
    const users = this.db.prepare(`
      SELECT u.id, u.name, u.email, u.created_at,
        COUNT(t.id) AS transaction_count,
        COALESCE(SUM(CASE WHEN t.kind = 'expense' THEN t.amount_cents ELSE 0 END), 0) AS expense_cents,
        MAX(t.created_at) AS last_transaction_at
      FROM users u LEFT JOIN transactions t ON t.user_id = u.id
      WHERE u.name LIKE ? OR u.email LIKE ?
      GROUP BY u.id ORDER BY u.created_at DESC, u.id DESC LIMIT ? OFFSET ?
    `).all(pattern, pattern, limit, offset);
    return { users, total: Number(total), limit, offset };
  }

  adminTransactionCount(userId, { search = '', kind = '' } = {}) {
    return Number(this.db.prepare(`
      SELECT COUNT(*) AS total FROM transactions
      WHERE user_id = ? AND (? = '' OR kind = ?)
        AND (? = '' OR description LIKE ? OR notes LIKE ?)
    `).get(userId, kind, kind, search, `%${search}%`, `%${search}%`).total);
  }

  recordAdminAccess(adminUserId, targetUserId, action) {
    this.db.prepare('INSERT INTO admin_audit_events(admin_user_id, target_user_id, action) VALUES (?, ?, ?)')
      .run(adminUserId, targetUserId, action);
  }
}

module.exports = { MyXpendDatabase };
