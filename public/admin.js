function createAdminView({ api, money, dateText, escapeHtml, localDate }) {
  const el = (id) => document.getElementById(`admin-${id}`);
  let userPage = 0, ledgerPage = 0, selectedId = null;
  let usersTotal = 0, ledgerTotal = 0, userRequest = 0, profileRequest = 0, ledgerRequest = 0;
  const pageSize = 25;
  const history = createHistoryView({ api, money, dateText, escapeHtml, localDate, idPrefix: 'admin-', endpoint: () => `/api/admin/users/${selectedId}/history` });
  const summaryCards = (rows) => rows.map(([label, value]) => `<article class="summary-card"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></article>`).join('');

  function failure(error) {
    el('feedback').textContent = error.message || 'Could not load admin data.';
    el('feedback').classList.add('error');
    if ([401, 403].includes(error.status)) reset(false);
  }

  async function loadUsers() {
    const id = ++userRequest;
    el('users').innerHTML = '';
    el('feedback').textContent = 'Loading users…';
    el('feedback').classList.remove('error');
    el('users-prev').disabled = el('users-next').disabled = true;
    try {
      const result = await api(`/api/admin/users?${new URLSearchParams({ search: el('search').value, limit: pageSize, offset: userPage * pageSize })}`);
      if (id !== userRequest) return;
      usersTotal = result.total;
      el('users').innerHTML = result.users.map((user) => `<tr><td><button type="button" class="admin-user-link" data-admin-user="${user.id}" aria-label="View ${escapeHtml(user.name)}">${escapeHtml(user.name)}</button><span class="admin-email">${escapeHtml(user.email)}</span></td><td>${escapeHtml(user.created_at)}</td><td>${user.transaction_count}</td><td>${money(user.expense_cents)}</td></tr>`).join('');
      el('feedback').textContent = result.total ? '' : 'No users match this search.';
      el('users-caption').textContent = result.total ? `${userPage * pageSize + 1}–${userPage * pageSize + result.users.length} of ${result.total} users` : '0 users';
      el('users-prev').disabled = userPage === 0;
      el('users-next').disabled = (userPage + 1) * pageSize >= usersTotal;
      el('users').querySelectorAll('[data-admin-user]').forEach((button) => button.setAttribute('aria-pressed', String(Number(button.dataset.adminUser) === selectedId)));
    } catch (error) { if (id === userRequest) failure(error); }
  }

  async function selectUser(userId) {
    const id = ++profileRequest;
    ++ledgerRequest;
    selectedId = userId;
    ledgerPage = 0;
    history.reset();
    clearProfile();
    el('ledger-search').value = '';
    el('ledger-kind').value = '';
    el('feedback').textContent = 'Loading user details…';
    el('feedback').classList.remove('error');
    el('users').querySelectorAll('[data-admin-user]').forEach((button) => button.setAttribute('aria-pressed', String(Number(button.dataset.adminUser) === selectedId)));
    try {
      const result = await api(`/api/admin/users/${userId}`);
      if (id !== profileRequest) return;
      el('name').textContent = result.user.name;
      el('email').textContent = result.user.email;
      el('joined').textContent = `Joined ${result.user.created_at} · User #${result.user.id}${result.user.is_admin ? ' · Administrator' : ''}`;
      el('summary').innerHTML = summaryCards([
        ['Available balance', money(result.summary.total_balance_cents)], ['All-time expenses', money(result.summary.all_time_expense_cents)],
        ['Monthly budget', result.budget ? money(result.budget.monthly_limit_cents) : 'Not set'], ['Transactions', String(result.transaction_count)]
      ]);
      el('accounts').innerHTML = result.accounts.map((account) => `<article class="account-card"><span class="account-label">${escapeHtml(account.name)} · ${escapeHtml(account.type)}</span><strong class="account-value">${money(account.balance_cents)}</strong></article>`).join('');
      el('export').href = `/api/admin/users/${userId}/export`;
      el('profile').classList.remove('hidden');
      el('feedback').textContent = '';
      await Promise.all([loadLedger(), history.refresh()]);
      if (id === profileRequest) el('name').focus({ preventScroll: true });
    } catch (error) { if (id === profileRequest) failure(error); }
  }

  async function loadLedger() {
    if (!selectedId) return;
    const id = ++ledgerRequest;
    const target = selectedId;
    el('ledger').innerHTML = '';
    el('ledger-caption').textContent = 'Loading transactions…';
    el('ledger-prev').disabled = el('ledger-next').disabled = true;
    try {
      const result = await api(`/api/admin/users/${target}/transactions?${new URLSearchParams({ search: el('ledger-search').value, kind: el('ledger-kind').value, limit: pageSize, offset: ledgerPage * pageSize })}`);
      if (id !== ledgerRequest || target !== selectedId) return;
      ledgerTotal = result.total;
      el('ledger').innerHTML = result.transactions.map((row) => `<tr><td>${dateText(row.transaction_date)}</td><td>${escapeHtml(row.kind)}</td><td><strong>${escapeHtml(row.description)}</strong><span class="admin-notes">${escapeHtml(row.notes)}</span></td><td>${escapeHtml(row.category)}</td><td>${escapeHtml(row.account_name)}${row.target_account_name ? ` → ${escapeHtml(row.target_account_name)}` : ''}</td><td>${money(row.amount_cents)}</td><td>${escapeHtml(row.created_at)}</td></tr>`).join('');
      el('ledger-caption').textContent = result.total ? `${ledgerPage * pageSize + 1}–${ledgerPage * pageSize + result.transactions.length} of ${result.total} transactions` : 'No transactions match these filters.';
      el('ledger-prev').disabled = ledgerPage === 0;
      el('ledger-next').disabled = (ledgerPage + 1) * pageSize >= ledgerTotal;
    } catch (error) { if (id === ledgerRequest) { el('ledger-caption').textContent = error.message; failure(error); } }
  }

  function clearProfile() {
    el('profile').classList.add('hidden');
    ['name', 'email', 'joined', 'summary', 'accounts', 'ledger', 'ledger-caption', 'history-summary', 'history-chart', 'history-chart-data', 'history-categories', 'history-insights', 'history-months'].forEach((id) => { el(id).textContent = ''; });
    el('export').removeAttribute('href');
  }

  function reset(clearFeedback = true) {
    ++userRequest; ++profileRequest; ++ledgerRequest;
    selectedId = null; userPage = 0; ledgerPage = 0; usersTotal = 0; ledgerTotal = 0;
    history.reset(); clearProfile();
    el('users').textContent = ''; el('overview').textContent = ''; el('users-caption').textContent = '';
    el('search').value = '';
    ['users-prev', 'users-next', 'ledger-prev', 'ledger-next'].forEach((id) => { el(id).disabled = true; });
    if (clearFeedback) el('feedback').textContent = '';
  }

  async function show() {
    const id = userRequest;
    try {
      const result = await api('/api/admin/overview');
      if (id !== userRequest) return;
      el('overview').innerHTML = summaryCards([
        ['Registered users', String(result.summary.user_count)], ['Transactions', String(result.summary.transaction_count)],
        ['Total expenses', money(result.summary.expense_cents)], ['Total income', money(result.summary.income_cents)]
      ]);
      await loadUsers();
    } catch (error) { if (id === userRequest) failure(error); }
  }

  el('search-form').addEventListener('submit', (event) => { event.preventDefault(); userPage = 0; loadUsers(); });
  el('refresh').addEventListener('click', () => { userPage = 0; show(); if (selectedId) selectUser(selectedId); });
  el('users-prev').addEventListener('click', () => { if (userPage > 0) { --userPage; loadUsers(); } });
  el('users-next').addEventListener('click', () => { if ((userPage + 1) * pageSize < usersTotal) { ++userPage; loadUsers(); } });
  el('users').addEventListener('click', (event) => { const button = event.target.closest('[data-admin-user]'); if (button) selectUser(Number(button.dataset.adminUser)); });
  el('ledger-form').addEventListener('submit', (event) => { event.preventDefault(); ledgerPage = 0; loadLedger(); });
  el('ledger-kind').addEventListener('change', () => { ledgerPage = 0; loadLedger(); });
  el('ledger-prev').addEventListener('click', () => { if (ledgerPage > 0) { --ledgerPage; loadLedger(); } });
  el('ledger-next').addEventListener('click', () => { if ((ledgerPage + 1) * pageSize < ledgerTotal) { ++ledgerPage; loadLedger(); } });
  return { show, reset };
}
