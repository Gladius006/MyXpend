function createHistoryView({ api, money, dateText, escapeHtml, localDate }) {
  const element = (id) => document.getElementById(id);
  let data = null;
  let selectedMonth = '';
  let mode = 'monthly';
  let style = 'bar';
  let requestId = 0;
  const monthText = (month, short = false) => new Intl.DateTimeFormat('en-IN', { month: short ? 'short' : 'long', year: 'numeric' }).format(new Date(`${month}-01T00:00:00`));
  const entryText = (count) => `${count} expense${count === 1 ? '' : 's'}`;
  const best = (rows) => rows.reduce((top, row) => row.amount_cents > (top?.amount_cents || 0) ? row : top, null);

  async function load(scrollToMonth = false) {
    const id = ++requestId;
    selectedMonth ||= localDate().slice(0, 7);
    element('history-view').setAttribute('aria-busy', 'true');
    element('history-feedback').textContent = 'Loading your expense history…';
    element('history-feedback').classList.remove('error');
    element('history-retry').classList.add('hidden');
    element('history-content').classList.add('hidden');
    try {
      const result = await api(`/api/history?${new URLSearchParams({ asOf: localDate(), month: selectedMonth })}`);
      if (id !== requestId) return;
      data = result;
      element('history-feedback').textContent = '';
      render();
      if (scrollToMonth === true) focusMonth();
    } catch (error) {
      if (id !== requestId) return;
      element('history-feedback').textContent = error.message || 'Could not load expense history.';
      element('history-feedback').classList.add('error');
      element('history-retry').classList.remove('hidden');
    } finally {
      if (id === requestId) element('history-view').setAttribute('aria-busy', 'false');
    }
  }

  function selectMonth(month) {
    selectedMonth = month;
    mode = 'daily';
    syncControls();
    if (data?.selected_month.month === month) { render(); focusMonth(); }
    else load(true);
  }

  function focusMonth() {
    element('history-mode').closest('.history-controls').scrollIntoView({ behavior: 'smooth', block: 'start' });
    element('history-chart-title').setAttribute('tabindex', '-1');
    element('history-chart-title').focus({ preventScroll: true });
  }

  function syncControls() {
    element('history-mode').value = mode;
    element('history-chart-style').value = style;
    element('history-month').value = selectedMonth;
    element('history-month-field').classList.toggle('hidden', mode !== 'daily');
  }

  function render() {
    if (!data) return;
    syncControls();
    element('history-content').classList.remove('hidden');
    let rows, summaries, insights, title, caption, categories = [], total = 0;
    let amountLabel = 'Expenses';
    if (mode === 'monthly') {
      rows = data.months.map((row) => ({ ...row, label: monthText(row.month, true), shortLabel: monthText(row.month, true), value: row.amount_cents }));
      total = Number(data.recent.amount_cents);
      const peak = best(rows);
      summaries = [['Total · last 12 months', money(total)], ['Average per month', money(Math.round(total / 12))], ['Highest month', peak ? monthText(peak.month, true) : 'No expenses'], ['Recorded expenses', String(data.recent.expense_count)]];
      title = 'Expenses by month';
      caption = `${monthText(rows[0].month)} – ${monthText(rows.at(-1).month)} · Includes the current month. Select a month below or a point on the chart for daily details.`;
      insights = peak ? [`${monthText(peak.month)} had the most spending: ${money(peak.amount_cents)}.`, `${data.months.filter((row) => row.expense_count > 0).length} of these 12 months have recorded expenses.`] : ['Your history will appear here as you record expenses.'];
    } else if (mode === 'daily') {
      const month = data.selected_month;
      rows = month.days.map((row) => ({ ...row, label: dateText(row.date), shortLabel: String(Number(row.date.slice(-2))), value: row.amount_cents }));
      total = Number(month.amount_cents);
      categories = month.by_category;
      const peak = best(rows);
      summaries = [['Month total', money(total)], ['Average per calendar day', money(Math.round(total / rows.length))], ['Highest spending day', peak ? dateText(peak.date) : 'No expenses'], ['Recorded expenses', String(month.expense_count)]];
      title = `Daily expenses · ${monthText(month.month)}`;
      caption = 'Each day shows the total expenses recorded on that date. Days without expenses are zero; income and transfers are excluded.';
      insights = peak ? [`${dateText(peak.date)} had the most spending: ${money(peak.amount_cents)}.`, `Expenses were recorded on ${rows.filter((row) => row.expense_count > 0).length} of ${rows.length} calendar days.`] : [`No expenses have been recorded for ${monthText(month.month)}.`];
    } else {
      const overall = data.overall;
      rows = overall.months.map((row) => ({ ...row, label: monthText(row.month, true), shortLabel: monthText(row.month, true), value: row.cumulative_cents }));
      total = Number(overall.amount_cents);
      categories = overall.by_category;
      const peak = best(overall.months);
      summaries = [['All-time expenses', money(total)], ['Average per recorded expense', money(overall.expense_count ? Math.round(total / overall.expense_count) : 0)], ['Highest month', peak ? monthText(peak.month, true) : 'No expenses'], ['Recorded expenses', String(overall.expense_count)]];
      title = 'Total expenses over time';
      amountLabel = 'Cumulative expenses';
      caption = overall.first_date ? `${dateText(overall.first_date)} – ${dateText(overall.last_date)} · Each point includes all spending through that month, including history older than 12 months.` : 'All your saved expenses will appear here, including history older than 12 months.';
      insights = peak ? [`Your largest month was ${monthText(peak.month)}: ${money(peak.amount_cents)}.`, `${entryText(overall.expense_count)} recorded across ${overall.months.filter((row) => row.expense_count > 0).length} months with spending.`] : ['Add your first expense to start your spending history.'];
    }
    if (categories[0] && total) insights.push(`${categories[0].category} accounts for ${Math.round(Number(categories[0].amount_cents) / total * 100)}% of this view’s spending (${money(categories[0].amount_cents)}).`);
    if (mode === 'monthly' || mode === 'daily') {
      const current = mode === 'daily' ? data.selected_month : data.months.at(-1);
      const index = data.months.findIndex((row) => row.month === current.month);
      const previous = data.months[index - 1];
      if (previous?.amount_cents && current.amount_cents) {
        const change = Math.round((current.amount_cents - previous.amount_cents) / previous.amount_cents * 100);
        insights.push(`${monthText(current.month)} is ${Math.abs(change)}% ${change >= 0 ? 'higher' : 'lower'} than ${monthText(previous.month)}${current.month === data.as_of.slice(0, 7) ? '; the current month is still in progress' : ''}.`);
      }
    }
    element('history-summary').innerHTML = summaries.map(([label, value]) => `<article class="summary-card"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></article>`).join('');
    element('history-chart-eyebrow').textContent = mode === 'daily' ? 'DAILY BREAKDOWN' : mode === 'overall' ? 'LIFETIME SPENDING' : 'MONTHLY COMPARISON';
    element('history-chart-title').textContent = title;
    element('history-chart-caption').textContent = caption;
    element('history-chart').innerHTML = expenseChart(rows, { style, title, amountLabel, clickable: mode !== 'daily' });
    element('history-period-label').textContent = mode === 'daily' ? 'Day' : 'Month';
    element('history-amount-label').textContent = amountLabel;
    element('history-chart-data').innerHTML = rows.map((row) => `<tr><th scope="row">${escapeHtml(row.label)}</th><td>${money(row.value)}</td><td>${row.expense_count}</td></tr>`).join('') || '<tr><td colspan="3">No recorded expenses yet.</td></tr>';
    element('history-insights').innerHTML = insights.map((text) => `<li>${escapeHtml(text)}</li>`).join('');
    element('history-category-panel').classList.toggle('hidden', mode === 'monthly');
    element('history-categories').innerHTML = categories.length ? categories.map((row) => {
      const share = Number(row.amount_cents) / total * 100;
      return `<div class="history-category"><div><span>${escapeHtml(row.category)}</span><strong>${money(row.amount_cents)}</strong></div><progress max="100" value="${share}" aria-label="${escapeHtml(row.category)}: ${Math.round(share)}% of expenses"></progress><span class="muted small-text">${Math.round(share)}% · ${entryText(row.expense_count)}</span></div>`;
    }).join('') : '<p class="muted small-text">No expenses in this period.</p>';
    const maximum = Math.max(1, ...data.months.map((row) => row.amount_cents));
    element('history-months').innerHTML = [...data.months].reverse().map((row) => `<button class="history-month-card ${mode === 'daily' && row.month === selectedMonth ? 'selected' : ''}" type="button" data-history-month="${row.month}" aria-label="View daily expenses for ${monthText(row.month)}: ${money(row.amount_cents)}" aria-pressed="${mode === 'daily' && row.month === selectedMonth}"><span>${monthText(row.month, true)}</span><strong>${money(row.amount_cents)}</strong><progress max="${maximum}" value="${row.amount_cents}" aria-hidden="true"></progress><span class="muted small-text">${entryText(row.expense_count)}</span></button>`).join('');
  }

  function expenseChart(rows, { style, title, amountLabel, clickable }) {
    if (!rows.length || !rows.some((row) => row.value > 0)) return '<div class="chart-empty"><span aria-hidden="true">↗</span><p>No expenses recorded in this period.</p><p class="muted small-text">Your chart will appear when expenses are added.</p></div>';
    const width = 900, height = 300;
    const left = 90, right = 25, top = 20, bottom = 55;
    const plotWidth = width - left - right, plotHeight = height - top - bottom;
    const maximum = Math.max(...rows.map((row) => row.value));
    const power = 10 ** Math.floor(Math.log10(maximum));
    const scale = Math.ceil(maximum / power) * power;
    const step = plotWidth / rows.length;
    const y = (value) => top + plotHeight * (1 - value / scale);
    const compactMoney = (value) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', notation: 'compact', maximumFractionDigits: 1 }).format(value / 100);
    const grid = Array.from({ length: 5 }, (_, index) => {
      const value = scale * index / 4;
      return `<g><line class="chart-gridline" x1="${left}" y1="${y(value)}" x2="${width - right}" y2="${y(value)}"/><text class="chart-axis" x="${left - 12}" y="${y(value) + 4}" text-anchor="end">${compactMoney(value)}</text></g>`;
    }).join('');
    const labelEvery = rows.length > 12 && mode !== 'daily' ? Math.ceil(rows.length / 8) : 1;
    const points = rows.map((row, index) => {
      const x = left + (index + .5) * step;
      const label = `${row.label}: ${money(row.value)} ${amountLabel.toLowerCase()}`;
      const shape = style === 'bar'
        ? `<rect class="chart-bar" x="${x - step * .31}" y="${y(row.value)}" width="${step * .62}" height="${plotHeight * row.value / scale}" rx="${Math.min(5, step * .15)}"/>`
        : `<circle class="chart-point" cx="${x}" cy="${y(row.value)}" r="${rows.length > 36 ? 3 : 4}"/>`;
      const mark = clickable ? `<a href="#history" data-history-month="${row.month}" aria-label="${escapeHtml(label)}. Open daily details." tabindex="0"><title>${escapeHtml(label)}</title><rect class="chart-hit-area" x="${left + index * step}" y="${top}" width="${step}" height="${plotHeight}"/>${shape}</a>` : `<g><title>${escapeHtml(label)}</title>${shape}</g>`;
      const showLabel = index === rows.length - 1 || (index % labelEvery === 0 && (index === 0 || rows.length - 1 - index >= labelEvery));
      return `${mark}${showLabel ? `<text class="chart-axis chart-x-label" x="${x}" y="${height - bottom + 27}" text-anchor="middle">${escapeHtml(row.shortLabel)}</text>` : ''}`;
    }).join('');
    const line = style === 'line' ? `<polyline class="chart-line" points="${rows.map((row, index) => `${left + (index + .5) * step},${y(row.value)}`).join(' ')}"/>` : '';
    return `<div class="chart-scroll"><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(title)}. ${escapeHtml(amountLabel)} in rupees. Exact values are available in View chart data."><title>${escapeHtml(title)}</title>${grid}${line}${points}<text class="chart-axis" x="${left + plotWidth / 2}" y="${height - 5}" text-anchor="middle">${mode === 'daily' ? 'Day of month' : 'Month'}</text></svg></div>`;
  }

  element('history-mode').addEventListener('change', (event) => { mode = event.target.value; syncControls(); render(); });
  element('history-chart-style').addEventListener('change', (event) => { style = event.target.value; render(); });
  element('history-month').addEventListener('change', (event) => {
    if (event.target.value && event.target.checkValidity()) selectMonth(event.target.value);
  });
  element('history-content').addEventListener('click', (event) => {
    const target = event.target.closest('[data-history-month]');
    if (target) { event.preventDefault(); selectMonth(target.dataset.historyMonth); }
  });
  element('history-content').addEventListener('keydown', (event) => {
    const target = event.target.closest('a[data-history-month]');
    if (target && (event.key === ' ' || event.key === 'Enter')) { event.preventDefault(); selectMonth(target.dataset.historyMonth); }
  });
  element('history-retry').addEventListener('click', load);

  return {
    show() { if (!data || data.as_of !== localDate()) load(); else render(); },
    refresh: load,
    get hasLoaded() { return Boolean(data); },
    reset() {
      ++requestId;
      data = null; selectedMonth = ''; mode = 'monthly'; style = 'bar';
      element('history-content').classList.add('hidden');
      element('history-feedback').textContent = '';
      element('history-retry').classList.add('hidden');
      element('history-view').setAttribute('aria-busy', 'false');
      syncControls();
    }
  };
}
