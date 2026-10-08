# MyXpend

**Live app:** [myxpend-production.up.railway.app](https://myxpend-production.up.railway.app/)

MyXpend is a personal finance tracker built around an auditable transaction ledger. Bank and cash balances are calculated from income, expenses, and transfers instead of being stored as unrelated numbers.

This repository is an independent rebuild of the original Base44 prototype. It is designed to be understandable in a technical interview: the application uses a small REST API, a relational schema, server-side validation, password hashing, session cookies, user-scoped queries, automated tests, and a responsive frontend.

## What it does

- Creates separate Bank and Cash accounts for every user.
- Records income, expenses, and transfers in one ledger.
- Calculates account balances from transaction history.
- Rejects expenses and transfers that exceed the selected account's balance.
- Shows monthly, daily, all-time, and per-category spending.
- Supports monthly budgets and transparent rule-based insights.
- Filters and searches transaction history.
- Exports the signed-in user's data to CSV.
- Stores passwords using `scrypt` with a unique salt.
- Uses random, hashed server-side sessions in `HttpOnly`, `SameSite=Lax` cookies.
- Keeps every account and transaction query scoped to the authenticated user.
- Supports light and dark themes and responsive layouts.
- Adds a History tab with the current month and previous 11 months, including months with zero expenses.
- Opens any selected month as a daily bar chart or line graph, with totals, category breakdowns, and spending insights.
- Shows all-time cumulative spending and categories, including records older than 12 months.
- Keeps older expenses in the ledger across month changes; reports and CSV exports read the complete history.

## Run locally

MyXpend has no third-party runtime dependencies. It requires Node.js 22.5 or newer because it uses the built-in SQLite module.

```powershell
cd MyXpend
npm start
```

Open `http://localhost:3000`, create an account, add money, and then record an expense.

The database is created at `data/myxpend.db`. Set `MYXPEND_DB` to use a different path and `PORT` to use another port.

The terminal running `npm start` must remain open. If it closes, `http://localhost:3000` stops responding.

## Deploy

The repository includes a production `Dockerfile`, a public health endpoint, and automatic detection of a Railway volume mount. Follow [DEPLOYMENT.md](DEPLOYMENT.md) to deploy it with persistent SQLite storage.

## Run the tests

```powershell
npm test
```

The integration tests start the real HTTP server against temporary SQLite databases. They verify derived balances, insufficient-balance validation, registration validation, and isolation between two different users.
History tests also cover more than 500 transactions, year boundaries, leap years, empty months, all-time totals, and persistence after reopening the database.

## Expense history

Sign in and select **History**. The default monthly analysis compares the current calendar month with the previous 11 months. Select a month card or chart point for its daily breakdown, or choose **Daily** and use the month picker to inspect an older month. Both monthly and daily charts can be displayed as bars or a line graph. **Overall** displays cumulative spending across every recorded month and an all-time category breakdown. Expand **View chart data** for exact values.

History counts only expenses, so income and account transfers do not inflate spending totals. Zero-spending days and months are included. The daily average uses all calendar days in the selected month. The 12-month window is a display choice, not a retention limit: no automatic monthly deletion is performed. The local database and Railway's persistent database remain separate.

## Admin dashboard

Configure `MYXPEND_ADMIN_EMAIL` on the server to identify an **existing** owner account, then restart or redeploy. Sign in with that account and select **Admin**. The email is resolved to a user ID at startup; registration and client-supplied fields cannot grant admin access. If the configured account does not exist, startup fails rather than reserving admin rights for a later registration. Without this environment variable, admin access is disabled for everyone.

The dashboard provides a searchable, paginated user directory, site totals, profile and registration details, Bank/Cash balances, monthly budgets, every transaction and note through pagination, monthly/daily/overall graphs, and a complete per-user JSON export. It is read-only. Passwords, password hashes, and session tokens are never returned. Detailed record access and exports are logged in `admin_audit_events` with the administrator, target user, action, and timestamp. Only the server operator can change the configured administrator; there is no browser-accessible promotion endpoint.

Admin API routes are `GET /api/admin/overview`, `/api/admin/users`, `/api/admin/users/:id`, and `/api/admin/users/:id/{transactions,history,export}`. Listing endpoints support `limit` (1–100), `offset`, and `search`; transaction listing also supports `kind`. History accepts the same date parameters as personal history. Every admin request requires an active authenticated admin session.

## Architecture

```text
Browser (HTML/CSS/JS)
        |
        | JSON / secure session cookie
        v
Node.js HTTP API
        |
        | parameterized SQL + mandatory user_id filters
        v
SQLite
  users ──< accounts
    |          |
    ├──< sessions
    ├──1 budget
    └──< transactions >── accounts
```

The central design decision is to treat balances as calculated values. An income adds to an account, an expense subtracts from it, and a transfer subtracts from one account while adding to another. Deleting a transaction therefore recalculates the correct balance automatically.

## API outline

| Method | Route | Purpose |
| --- | --- | --- |
| `POST` | `/api/auth/register` | Create a user and default accounts |
| `POST` | `/api/auth/login` | Start a secure session |
| `POST` | `/api/auth/logout` | End the current session |
| `GET` | `/api/dashboard` | Return balances, summaries, categories, and insights |
| `GET` | `/api/history` | Complete expense analysis; optional `asOf=YYYY-MM-DD` anchors the 12-month window and `month=YYYY-MM` selects daily details |
| `GET/POST` | `/api/transactions` | List or create transactions |
| `DELETE` | `/api/transactions/:id` | Delete one owned transaction |
| `POST` | `/api/budget` | Set or remove a monthly budget |
| `GET` | `/api/export.csv` | Export the signed-in user's ledger |

## Next engineering milestones

1. Add transaction editing with an audit history rather than overwriting records silently.
2. Add recurring transaction templates and due-date reminders.
3. Add pagination and database-level aggregate queries for large ledgers.
4. Deploy behind HTTPS and add rate limiting, email verification, password reset, and session management.
5. Add PostgreSQL support and a migration tool before multi-instance deployment.

## Honest scope

The insights are deterministic rules based on spending totals, budget usage, and category share. The UI does not label these rules as artificial intelligence. Production authentication would additionally require HTTPS, rate limiting, verified email ownership, password recovery, and operational monitoring.
