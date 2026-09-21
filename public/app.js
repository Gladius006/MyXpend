const CATEGORIES = ['Food & Dining', 'Transport', 'Shopping', 'Entertainment', 'Bills & Utilities', 'Health', 'Education', 'Travel', 'Salary', 'Other'];
const state = { user: null, dashboard: null, transactions: [], filters: { search: '', kind: '', category: '' } };
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const money = (cents, digits = 2) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: digits, maximumFractionDigits: digits }).format((Number(cents) || 0) / 100);
const dateText = (value) => new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(`${value}T00:00:00`));
const localDate = () => {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(body.error || 'Request failed'), { status: response.status, fields: body.fields || {} });
  return body;
}

function toast(message) {
  const element = $('#toast');
  element.textContent = message;
  element.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.remove('show'), 2600);
}

function setFormError(form, error) {
  $('[data-form-error]', form).textContent = error?.fields ? Object.values(error.fields)[0] : (error?.message || '');
}

function showApp(user) {
  state.user = user;
  $('#user-name').textContent = user.name.split(' ')[0];
  $('#auth-view').classList.add('hidden');
  $('#app-view').classList.remove('hidden');
}

function showAuth() {
  state.user = null;
  $('#app-view').classList.add('hidden');
  $('#auth-view').classList.remove('hidden');
}

function accountOptions(selected = '') {
  return (state.dashboard?.accounts || []).map((account) => `<option value="${account.id}" ${String(account.id) === String(selected) ? 'selected' : ''}>${escapeHtml(account.name)} · ${money(account.balance_cents)}</option>`).join('');
}

function escapeHtml(value) {
  const node = document.createElement('span');
  node.textContent = String(value ?? '');
  return node.innerHTML;
}

function renderDashboard() {
  const { accounts, summary, by_category: categories, insights } = state.dashboard;
  $('#account-cards').innerHTML = [
    ...accounts.map((account) => `<article class="account-card"><span class="account-label">${escapeHtml(account.name)} balance</span><strong class="account-value">${money(account.balance_cents)}</strong></article>`),
    `<article class="account-card total"><span class="account-label">Total available</span><strong class="account-value">${money(summary.total_balance_cents)}</strong></article>`
  ].join('');
  const summaries = [
    ['This month', summary.this_month_cents], ['Today', summary.today_cents],
    ['All-time expenses', summary.all_time_expense_cents], ['Daily average this month', summary.daily_average_cents]
  ];
  $('#summary-cards').innerHTML = summaries.map(([label, value]) => `<article class="summary-card"><span>${label}</span><strong>${money(value)}</strong></article>`).join('');
  $('#budget-spent').textContent = money(summary.this_month_cents, 0);
  $('#budget-limit').textContent = summary.monthly_budget_cents ? `of ${money(summary.monthly_budget_cents, 0)}` : 'No limit set';
  const percentage = summary.monthly_budget_cents ? Math.round((summary.this_month_cents / summary.monthly_budget_cents) * 100) : 0;
  $('#budget-progress').style.width = `${Math.min(percentage, 100)}%`;
  $('#budget-progress').style.background = percentage > 100 ? 'var(--danger)' : 'var(--brand)';
  $('#budget-caption').textContent = summary.monthly_budget_cents ? `${percentage}% of the monthly budget used.` : 'Set a limit to track your monthly progress.';
  $('#category-chart').innerHTML = categories.length ? categories.map((item) => {
    const pct = summary.this_month_cents ? Math.round((item.amount_cents / summary.this_month_cents) * 100) : 0;
    return `<div class="category-row"><span>${escapeHtml(item.category)}</span><div class="category-bar"><span style="width:${pct}%"></span></div><strong>${pct}%</strong></div>`;
  }).join('') : '<p class="muted small-text">No expenses recorded this month.</p>';
  $('#insight-list').innerHTML = insights.map((item) => `<li>${escapeHtml(item)}</li>`).join('');
  renderTransactions();
}

function filteredTransactions() {
  return state.transactions.filter((item) => {
    const search = state.filters.search.toLowerCase();
    return (!state.filters.kind || item.kind === state.filters.kind)
      && (!state.filters.category || item.category === state.filters.category)
      && (!search || `${item.description} ${item.notes}`.toLowerCase().includes(search));
  });
}

function renderTransactions() {
  const rows = filteredTransactions();
  $('#empty-transactions').classList.toggle('hidden', rows.length > 0);
  $('#transaction-list').innerHTML = rows.map((item) => {
    const isExpense = item.kind === 'expense';
    const isTransfer = item.kind === 'transfer';
    const sign = isExpense ? '−' : (isTransfer ? '⇄' : '+');
    const account = isTransfer ? `${item.account_name} → ${item.target_account_name}` : item.account_name;
    return `<article class="transaction-item">
      <span class="transaction-icon" aria-hidden="true">${sign}</span>
      <div class="transaction-main"><strong>${escapeHtml(item.description)}</strong><span>${dateText(item.transaction_date)} · ${escapeHtml(item.category)} · ${escapeHtml(account)}</span></div>
      <span class="transaction-amount ${item.kind}">${isExpense ? '−' : (isTransfer ? '' : '+')}${money(item.amount_cents)}</span>
      <button class="delete-button" type="button" data-delete-id="${item.id}" aria-label="Delete ${escapeHtml(item.description)}">×</button>
    </article>`;
  }).join('');
}

async function refresh() {
  const [dashboard, transactions] = await Promise.all([api('/api/dashboard'), api('/api/transactions')]);
  state.dashboard = dashboard;
  state.transactions = transactions.transactions;
  renderDashboard();
}

function openTransaction(kind) {
  const form = $('#transaction-form');
  form.reset();
  form.kind.value = kind;
  form.transactionDate.value = localDate();
  form.category.innerHTML = CATEGORIES.map((category) => `<option value="${category}">${category}</option>`).join('');
  form.accountId.innerHTML = accountOptions();
  form.targetAccountId.innerHTML = accountOptions();
  $('#target-account-field').classList.toggle('hidden', kind !== 'transfer');
  form.targetAccountId.required = kind === 'transfer';
  $('#transaction-eyebrow').textContent = kind === 'transfer' ? 'MOVE MONEY' : 'NEW TRANSACTION';
  $('#transaction-title').textContent = kind === 'expense' ? 'Add expense' : kind === 'income' ? 'Add money' : 'Transfer between accounts';
  form.description.value = kind === 'transfer' ? 'Account transfer' : '';
  form.category.value = kind === 'income' ? 'Salary' : kind === 'transfer' ? 'Other' : 'Food & Dining';
  setFormError(form, null);
  $('#transaction-dialog').showModal();
}

async function saveTransaction() {
  const form = $('#transaction-form');
  if (!form.reportValidity()) return;
  const button = $('#save-transaction');
  setFormError(form, null); button.disabled = true;
  try {
    const values = Object.fromEntries(new FormData(form));
    values.amount = Number(values.amount); values.accountId = Number(values.accountId);
    if (values.kind === 'transfer' && values.targetAccountId) values.targetAccountId = Number(values.targetAccountId);
    else delete values.targetAccountId;
    await api('/api/transactions', { method: 'POST', body: JSON.stringify(values) });
    $('#transaction-dialog').close(); await refresh(); toast('Transaction saved');
  } catch (error) { setFormError(form, error); }
  finally { button.disabled = false; }
}

async function saveBudget() {
  const form = $('#budget-form');
  if (!form.reportValidity()) return;
  try {
    await api('/api/budget', { method: 'POST', body: JSON.stringify({ amount: Number(form.amount.value) }) });
    $('#budget-dialog').close(); await refresh(); toast('Budget updated');
  } catch (error) { setFormError(form, error); }
}

function setupEvents() {
  $$('[data-auth-tab]').forEach((button) => button.addEventListener('click', () => {
    const tab = button.dataset.authTab;
    $$('[data-auth-tab]').forEach((item) => { item.classList.toggle('active', item === button); item.setAttribute('aria-selected', String(item === button)); });
    $('#login-form').classList.toggle('hidden', tab !== 'login');
    $('#register-form').classList.toggle('hidden', tab !== 'register');
  }));

  ['login', 'register'].forEach((type) => $(`#${type}-form`).addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = $('button[type="submit"]', form);
    setFormError(form, null); button.disabled = true;
    try {
      const data = Object.fromEntries(new FormData(form));
      const result = await api(`/api/auth/${type}`, { method: 'POST', body: JSON.stringify(data) });
      showApp(result.user); await refresh();
    } catch (error) { setFormError(form, error); }
    finally { button.disabled = false; }
  }));

  $('#logout-button').addEventListener('click', async () => { await api('/api/auth/logout', { method: 'POST' }); showAuth(); });
  $$('[data-open-transaction]').forEach((button) => button.addEventListener('click', () => openTransaction(button.dataset.openTransaction)));
  $$('[data-close-dialog]').forEach((button) => button.addEventListener('click', () => button.closest('dialog').close()));
  $('#transaction-form').addEventListener('submit', (event) => { event.preventDefault(); saveTransaction(); });
  $('#save-transaction').addEventListener('click', saveTransaction);

  $('#transaction-list').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-delete-id]');
    if (!button || !confirm('Delete this transaction? The account balance will be recalculated.')) return;
    await api(`/api/transactions/${button.dataset.deleteId}`, { method: 'DELETE' });
    await refresh(); toast('Transaction deleted');
  });

  $('#budget-button').addEventListener('click', () => {
    $('#budget-form').amount.value = state.dashboard.summary.monthly_budget_cents / 100 || '';
    setFormError($('#budget-form'), null); $('#budget-dialog').showModal();
  });
  $('#budget-form').addEventListener('submit', (event) => { event.preventDefault(); saveBudget(); });
  $('#save-budget').addEventListener('click', saveBudget);

  $('#search-input').addEventListener('input', (event) => { state.filters.search = event.target.value; renderTransactions(); });
  $('#kind-filter').addEventListener('change', (event) => { state.filters.kind = event.target.value; renderTransactions(); });
  $('#category-filter').addEventListener('change', (event) => { state.filters.category = event.target.value; renderTransactions(); });
  $('#theme-toggle').addEventListener('click', () => {
    const dark = document.documentElement.dataset.theme !== 'dark';
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    localStorage.setItem('myxpend-theme', dark ? 'dark' : 'light');
    $('#theme-toggle').textContent = dark ? '☾' : '☼';
  });
}

async function init() {
  const theme = localStorage.getItem('myxpend-theme') || 'light';
  document.documentElement.dataset.theme = theme;
  $('#theme-toggle').textContent = theme === 'dark' ? '☾' : '☼';
  $('#category-filter').innerHTML += CATEGORIES.map((category) => `<option value="${category}">${category}</option>`).join('');
  setupEvents();
  try { const result = await api('/api/me'); showApp(result.user); await refresh(); }
  catch { showAuth(); }
}

init();
