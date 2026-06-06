import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import "../calculations.js";

const C = globalThis.LendpileCalculations;

function approx(actual, expected, tolerance = 0.01) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `expected ${actual} to be within ${tolerance} of ${expected}`);
}

function loadCampbellLoan() {
  return JSON.parse(fs.readFileSync("test/fixtures/legacy-example-loan.json", "utf8"))[0];
}

function localIso(date) {
  const d = new Date(date);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function snapshot(timeline, todayStr) {
  const today = new Date(`${todayStr}T00:00:00`);
  const historical = timeline.filter(row => row.date < today);
  const forecast = timeline.filter(row => row.date >= today);
  return {
    lastHistorical: historical.at(-1) || null,
    firstForecast: forecast[0] || null,
    forecast,
    totalInterest: timeline.reduce((sum, row) => sum + row.interest, 0),
    totalPayments: timeline.reduce((sum, row) => sum + row.payment, 0),
    lastRow: timeline.at(-1) || null
  };
}

function assertDefaultTimelineBalances(timeline) {
  for (const [index, row] of timeline.entries()) {
    const unpaidInterest = Math.max(0, row.interest - row.payment);
    approx(row.endingDebt, row.startingDebt - row.amortization + unpaidInterest, 0.000001);
    assert.ok(row.interest >= -0.000001, `row ${index} has negative interest`);
    assert.ok(row.payment >= -0.000001, `row ${index} has negative payment`);
    assert.ok(row.amortization >= -0.000001, `row ${index} has negative amortization`);
    assert.ok(row.endingDebt >= -0.000001, `row ${index} has negative ending debt`);
    if (row.payment >= row.interest) {
      approx(row.amortization, Math.min(row.payment - row.interest, row.startingDebt), 0.000001);
    } else {
      approx(row.amortization, 0, 0.000001);
    }
  }
}

function assertAdvancedTimelineBalances(timeline) {
  for (const [index, row] of timeline.entries()) {
    const loanChange = (row.changes || [])
      .filter(change => change.type === "loan")
      .reduce((sum, change) => sum + change.value, 0);
    const interestPaid = Math.max(0, row.payment - row.amortization);
    const unpaidInterest = Math.max(0, row.interest - interestPaid);
    approx(row.endingDebt, row.startingDebt + loanChange - row.amortization + unpaidInterest, 0.000001);
    assert.ok(row.interest >= -0.000001, `row ${index} has negative interest`);
    assert.ok(row.payment >= -0.000001, `row ${index} has negative payment`);
    assert.ok(row.amortization >= -0.000001, `row ${index} has negative amortization`);
    assert.ok(row.endingDebt >= -0.000001, `row ${index} has negative ending debt`);
  }
}

function makeRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function randomLoan(seed) {
  const rand = makeRandom(seed);
  const startMonth = Math.floor(rand() * 12);
  const startDay = 1 + Math.floor(rand() * 26);
  const startDate = `2026-${String(startMonth + 1).padStart(2, "0")}-${String(startDay).padStart(2, "0")}`;
  const initialAmount = 10000 + Math.floor(rand() * 500000);
  const interestRate = Math.round(rand() * 900) / 100;
  const loanChanges = [];
  const interestChanges = [{ date: startDate, rate: interestRate }];
  const payments = [];

  for (let i = 0; i < 3; i++) {
    if (rand() < 0.7) {
      const month = startMonth + 1 + Math.floor(rand() * 18);
      const date = new Date(2026, month, 1 + Math.floor(rand() * 26));
      loanChanges.push({ date: localIso(date), amount: Math.round((rand() - 0.25) * 50000) });
    }
    if (rand() < 0.7) {
      const month = startMonth + 1 + Math.floor(rand() * 18);
      const date = new Date(2026, month, 1 + Math.floor(rand() * 26));
      interestChanges.push({ date: localIso(date), rate: Math.round(rand() * 900) / 100 });
    }
  }

  const scheduledAmount = 500 + Math.floor(rand() * 6000);
  payments.push({
    type: "scheduled",
    amount: scheduledAmount,
    startDate,
    frequency: String(1 + Math.floor(rand() * 3)),
    frequencyUnit: rand() < 0.25 ? "week" : "month",
    dayOfMonth: String(startDay)
  });
  if (rand() < 0.5) {
    const date = new Date(2026, startMonth + 4 + Math.floor(rand() * 12), 1 + Math.floor(rand() * 26));
    payments.push({ type: "one-time", amount: 1000 + Math.floor(rand() * 25000), startDate: localIso(date) });
  }

  return { startDate, initialAmount, interestRate, interestChanges, loanChanges, payments, currency: "SEK" };
}

test("default Lendpile calculator preserves trusted legacy 30/360 example numbers", () => {
  const timeline = C.buildTimeline(loadCampbellLoan());
  const jan2026 = snapshot(timeline, "2026-01-31");

  assertDefaultTimelineBalances(timeline);
  approx(jan2026.lastHistorical.endingDebt, 137517.0816378194);
  assert.equal(Math.round(jan2026.lastHistorical.endingDebt), 137517);
  assert.equal(jan2026.forecast.length, 185);
  assert.equal(Math.round(jan2026.totalInterest), 36917);
  assert.equal(localIso(jan2026.lastRow.paymentDate), "2041-06-27");
});

test("advanced comparator intentionally exposes bank-like/date-aware differences", () => {
  const loan = loadCampbellLoan();
  const legacyTimeline = C.buildTimeline(loan);
  const advancedTimeline = C.buildTimelineAdvanced(loan);
  const legacy = snapshot(legacyTimeline, "2026-01-31");
  const advanced = snapshot(advancedTimeline, "2026-01-31");

  assertDefaultTimelineBalances(legacyTimeline);
  assertAdvancedTimelineBalances(advancedTimeline);
  assert.equal(Math.round(legacy.lastHistorical.endingDebt), 137517);
  assert.notEqual(Math.round(advanced.lastHistorical.endingDebt), 137517);
  assert.equal(legacy.forecast.length, advanced.forecast.length);
  assert.notEqual(Math.round(legacy.totalInterest), Math.round(advanced.totalInterest));
});

test("day-count convention selects the intended calculator", () => {
  const loan = {
    startDate: "2026-01-15",
    initialAmount: 100000,
    interestRate: 6,
    payments: [{ type: "one-time", amount: 1000, startDate: "2026-01-20" }]
  };

  const thirty360 = C.buildTimeline({ ...loan, dayCountConvention: "thirty360" })[0];
  const actual365 = C.buildTimeline({ ...loan, dayCountConvention: "actual365" })[0];
  const actual360 = C.buildTimeline({ ...loan, dayCountConvention: "actual360" })[0];
  const advanced365 = C.buildTimelineAdvanced(loan)[0];
  const advanced360 = C.buildTimelineAdvanced(loan, { denominator: 360 })[0];

  approx(actual365.interest, advanced365.interest);
  approx(actual360.interest, advanced360.interest);
  assert.ok(actual360.interest > actual365.interest);
  assert.ok(thirty360.interest > 0);
  assert.notEqual(Math.round(thirty360.interest), Math.round(actual365.interest));
});

test("advanced comparator handles mid-month start, same-month rate change, and arbitrary payment date", () => {
  const timeline = C.buildTimelineAdvanced({
    startDate: "2026-01-15",
    initialAmount: 100000,
    interestRate: 3,
    interestChanges: [{ date: "2026-01-25", rate: 6 }],
    payments: [{ type: "one-time", amount: 1000, startDate: "2026-01-20" }]
  });

  const jan = timeline[0];
  assert.equal(localIso(jan.date), "2026-01-01");
  assert.equal(localIso(jan.paymentDate), "2026-01-20");
  assert.equal(jan.changes[0].type, "interest");
  assert.equal(localIso(jan.changes[0].date), "2026-01-25");
  approx(jan.interest, 195.76);
  approx(jan.endingDebt, 99195.76);
});

test("default and advanced calculators both count weekly and daily recurrences", () => {
  const weeklyLoan = {
    startDate: "2026-01-01",
    initialAmount: 1000,
    interestRate: 0,
    payments: [{ type: "scheduled", amount: 10, startDate: "2026-01-01", endDate: "2026-01-31", frequency: 1, frequencyUnit: "week" }]
  };
  assert.equal(C.buildTimeline(weeklyLoan)[0].payment, 50);
  assert.equal(C.buildTimelineAdvanced(weeklyLoan)[0].payment, 50);

  const dailyPayment = { type: "scheduled", amount: 2, startDate: "2026-01-01", endDate: "2026-01-05", frequency: 1, frequencyUnit: "day" };
  assert.deepEqual(C.getPaymentDates(dailyPayment).map(localIso), ["2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04", "2026-01-05"]);
  assert.equal(C.buildTimeline({ ...weeklyLoan, payments: [dailyPayment] })[0].payment, 10);
  assert.equal(C.buildTimelineAdvanced({ ...weeklyLoan, payments: [dailyPayment] })[0].payment, 10);
});

test("default target payoff returns an amount that actually clears by target month", () => {
  const loan = {
    startDate: "2026-01-15",
    initialAmount: 12000,
    interestRate: 5,
    payments: []
  };
  const required = C.calculatePaymentForTargetDate(loan, "2027-01-15");
  const timeline = C.buildTimeline({
    ...loan,
    payments: [{ type: "scheduled", amount: required, startDate: loan.startDate, endDate: "2027-01-15", frequency: 1, frequencyUnit: "month", dayOfMonth: "15" }]
  });

  assert.ok(required > 0);
  assert.ok(timeline.at(-1).endingDebt <= 0.01);
  assert.ok(timeline.at(-1).date <= new Date(2027, 0, 15));
});

test("chart data mirrors whichever timeline is supplied", () => {
  const timeline = C.buildTimeline(loadCampbellLoan());
  const chart = C.buildChartData(timeline, localIso);

  assert.equal(chart.labels[0], localIso(timeline[0].paymentDate));
  assert.equal(chart.debt[0], timeline[0].endingDebt);
  approx(chart.interest[10], timeline.slice(0, 11).reduce((sum, row) => sum + row.interest, 0));
  approx(chart.amort[10], timeline.slice(0, 11).reduce((sum, row) => sum + row.amortization, 0));
});

test("generated loan timelines obey balance invariants", () => {
  for (let seed = 1; seed <= 100; seed++) {
    const loan = randomLoan(seed);
    assertDefaultTimelineBalances(C.buildTimeline(loan));
    assertAdvancedTimelineBalances(C.buildTimelineAdvanced(loan));
  }
});
