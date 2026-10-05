// Reports query the complete expense ledger, independently of the transaction list.
function shiftMonth(month, offset) {
  const date = new Date(`${month}-01T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + offset);
  return date.toISOString().slice(0, 7);
}

function monthRange(month) {
  const last = new Date(`${month}-01T00:00:00Z`);
  last.setUTCMonth(last.getUTCMonth() + 1);
  last.setUTCDate(0);
  return { from: `${month}-01`, to: last.toISOString().slice(0, 10), days: last.getUTCDate() };
}

function expenseHistory(db, userId, { asOf, month = asOf.slice(0, 7) }) {
  const endMonth = asOf.slice(0, 7);
  const startMonth = shiftMonth(endMonth, -11);
  const recentRange = { from: `${startMonth}-01`, to: monthRange(endMonth).to };
  const groupedMonths = new Map(db.expenseSeries(userId, 'month', recentRange).map((row) => [row.period, row]));
  const months = Array.from({ length: 12 }, (_, index) => {
    const key = shiftMonth(startMonth, index);
    const row = groupedMonths.get(key);
    return { month: key, amount_cents: Number(row?.amount_cents || 0), expense_count: Number(row?.expense_count || 0) };
  });
  const range = monthRange(month);
  const groupedDays = new Map(db.expenseSeries(userId, 'day', range).map((row) => [row.period, row]));
  const days = Array.from({ length: range.days }, (_, index) => {
    const date = `${month}-${String(index + 1).padStart(2, '0')}`;
    const row = groupedDays.get(date);
    return { date, amount_cents: Number(row?.amount_cents || 0), expense_count: Number(row?.expense_count || 0) };
  });
  const overall = db.expenseSummary(userId);
  const recordedMonths = db.expenseSeries(userId, 'month');
  const allMonths = [];
  if (recordedMonths.length) {
    const totals = new Map(recordedMonths.map((row) => [row.period, row]));
    const lastMonth = recordedMonths.at(-1).period;
    let cumulative = 0;
    const firstMonth = recordedMonths[0].period;
    const span = (Number(lastMonth.slice(0, 4)) - Number(firstMonth.slice(0, 4))) * 12
      + Number(lastMonth.slice(5)) - Number(firstMonth.slice(5));
    for (let index = 0; index <= span; index++) {
      const key = shiftMonth(firstMonth, index);
      const row = totals.get(key);
      const amount = Number(row?.amount_cents || 0);
      cumulative += amount;
      allMonths.push({ month: key, amount_cents: amount, cumulative_cents: cumulative, expense_count: Number(row?.expense_count || 0) });
    }
  }
  return {
    as_of: asOf,
    months,
    recent: db.expenseSummary(userId, recentRange),
    selected_month: {
      month, ...db.expenseSummary(userId, range), days,
      by_category: db.expenseCategories(userId, range)
    },
    overall: { ...overall, months: allMonths, by_category: db.expenseCategories(userId) }
  };
}

module.exports = { expenseHistory, monthRange, shiftMonth };
