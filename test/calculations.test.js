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

test("timeline change markers preserve the entered amount and loan-change context", () => {
  const change = { date: "2025-01-01", amount: 240000, title: "Car purchase", note: "Family car" };
  for (const dayCountConvention of ["actual365", "thirty360"]) {
    const timeline = C.buildTimeline({
      startDate: "2024-10-01",
      initialAmount: 450000.1,
      interestRate: 2,
      dayCountConvention,
      interestChanges: [],
      loanChanges: [change],
      payments: [{ type: "scheduled", amount: 4000, startDate: "2024-10-27", frequency: 1, frequencyUnit: "month", dayOfMonth: 27 }]
    });
    const marker = timeline.flatMap(row => row.changes).find(item => item.type === "loan");
    assert.deepEqual(
      { value: marker.value, title: marker.title, note: marker.note },
      { value: 240000, title: "Car purchase", note: "Family car" }
    );
  }
});

test("timeline interest markers preserve title and note", () => {
  const timeline = C.buildTimeline({
    startDate: "2025-01-01",
    initialAmount: 100000,
    interestRate: 2,
    dayCountConvention: "actual365",
    interestChanges: [{ date: "2025-02-10", rate: 3.5, title: "Rate review", note: "Annual adjustment" }],
    loanChanges: [],
    payments: [{ type: "scheduled", amount: 1000, startDate: "2025-01-27", frequency: 1, frequencyUnit: "month", dayOfMonth: 27 }]
  });
  const marker = timeline.flatMap(row => row.changes).find(item => item.type === "interest");
  assert.deepEqual(
    { value: marker.value, title: marker.title, note: marker.note },
    { value: 3.5, title: "Rate review", note: "Annual adjustment" }
  );
});

test("normalizes legacy drawdowns into canonical loan parts and preserves non-positive changes as adjustments", () => {
  const normalized = C.normalizeLoan({
    id: "legacy", startDate: "2025-01-01", initialAmount: 1000, interestRate: 4,
    interestChanges: [{ date: "2025-03-01", rate: 5 }],
    loanChanges: [
      { id: "drawdown-source-id", date: "2025-02-01", amount: 500, title: "Drawdown ref", note: "Audit note", kind: "contract-drawdown", approvedBy: "auditor", audit: { externalRef: "DRAW-7" } },
      { id: "adjustment-source-id", date: "2025-04-01", amount: -100, title: "Correction", note: "Principal only", kind: "principal-correction", createdAt: "2025-04-02T00:00:00Z", reasonCode: "MANUAL" },
      { id: "zero-audit-id", date: "2025-05-01", amount: 0, title: "No-op audit", note: "Retained for history", kind: "audit-marker", approvedBy: "reviewer" },
    ]
  });
  assert.equal(normalized.schemaVersion, 2);
  assert.deepEqual(normalized.loanParts.map(p => [p.originalPrincipal, p.startDate, p.interestRate]), [[1000, "2025-01-01", 4], [500, "2025-02-01", 4]]);
  assert.deepEqual(
    { title: normalized.loanParts[1].title, note: normalized.loanParts[1].note, kind: normalized.loanParts[1].kind },
    { title: "Drawdown ref", note: "Audit note", kind: "contract-drawdown" }
  );
  assert.deepEqual(
    { id: normalized.loanParts[1].id, approvedBy: normalized.loanParts[1].approvedBy, audit: normalized.loanParts[1].audit },
    { id: "drawdown-source-id", approvedBy: "auditor", audit: { externalRef: "DRAW-7" } }
  );
  assert.deepEqual(normalized.principalAdjustments.map(a => [a.amount, a.date]), [[-100, "2025-04-01"], [0, "2025-05-01"]]);
  assert.deepEqual(
    { title: normalized.principalAdjustments[0].title, note: normalized.principalAdjustments[0].note, kind: normalized.principalAdjustments[0].kind },
    { title: "Correction", note: "Principal only", kind: "principal-correction" }
  );
  assert.deepEqual(
    { id: normalized.principalAdjustments[0].id, createdAt: normalized.principalAdjustments[0].createdAt, reasonCode: normalized.principalAdjustments[0].reasonCode },
    { id: "adjustment-source-id", createdAt: "2025-04-02T00:00:00Z", reasonCode: "MANUAL" }
  );
  assert.deepEqual(
    normalized.principalAdjustments[1],
    { id: "zero-audit-id", date: "2025-05-01", amount: 0, title: "No-op audit", note: "Retained for history", kind: "audit-marker", approvedBy: "reviewer", allocationPolicy: "proRata" }
  );
  assert.ok(!("initialAmount" in normalized));
  assert.ok(!("loanChanges" in normalized));
});

test("buildCanonicalLoan preserves facility lifecycle while replacing explicitly edited parts", () => {
  const existing = C.normalizeLoan({
    id: "facility", name: "Before", currency: "SEK", dayCountConvention: "actual365",
    startDate: "2025-01-01", initialAmount: 1000, interestRate: 4,
    loanChanges: [{ date: "2025-03-01", amount: 500 }],
    payments: [{ type: "oneTime", date: "2025-04-01", amount: 100 }],
    predecessorLoanIds: ["old"], refinanceDate: "2025-01-01"
  });
  const edited = C.buildCanonicalLoan(existing, {
    name: "After", currency: "EUR", dayCountConvention: "thirty360", loanType: "borrow",
    loanParts: existing.loanParts.map(part => ({ ...part })),
    principalAdjustments: existing.principalAdjustments
  });
  assert.equal(edited.schemaVersion, 2);
  assert.equal(edited.name, "After");
  assert.equal(edited.currency, "EUR");
  assert.deepEqual(edited.loanParts, existing.loanParts);
  assert.deepEqual(edited.payments, existing.payments);
  assert.deepEqual(edited.predecessorLoanIds, ["old"]);
  assert.equal(edited.refinanceDate, "2025-01-01");
  assert.ok(!("initialAmount" in edited));
  assert.ok(!("loanChanges" in edited));
});

test("facility editor projection round-trips independent part rates and audit metadata", () => {
  const existing = C.normalizeLoan({
    id: "facility", name: "Before", currency: "SEK", dayCountConvention: "actual365",
    startDate: "2025-01-01", initialAmount: 1000, interestRate: 4,
    loanChanges: [{ date: "2025-03-01", amount: 500, title: "Second draw", note: "Contract B", kind: "contract-drawdown" }],
    payments: [{ type: "oneTime", date: "2025-04-01", amount: 100 }]
  });
  existing.loanParts[1].interestRate = 7;
  const editor = C.facilityEditorModel(existing);
  assert.equal(editor.initialAmount, 1000);
  assert.deepEqual(editor.loanChanges.map(change => [change.facilityKind, change.kind, change.amount, change.interestRate]), [["part", "contract-drawdown", 500, 7]]);
  const rebuilt = C.buildCanonicalLoanFromEditor(existing, { ...editor, name: "After" });
  assert.equal(rebuilt.name, "After");
  assert.deepEqual(rebuilt.loanParts, existing.loanParts);
  assert.deepEqual(rebuilt.payments, existing.payments);
  assert.ok(!("initialAmount" in rebuilt));
  assert.ok(!("loanChanges" in rebuilt));
});

test("canonical facilities accrue independently and amortize eligible parts pro-rata with auditable allocations", () => {
  const loan = {
    schemaVersion: 2, loanParts: [
      { id: "a", originalPrincipal: 1000, startDate: "2025-01-01", interestRate: 12 },
      { id: "b", originalPrincipal: 3000, startDate: "2025-01-01", interestRate: 0 }
    ],
    payments: [{ type: "one-time", amount: 1000, startDate: "2025-01-15", allocationPolicy: "proRata" }],
    dayCountConvention: "actual365"
  };
  const row = C.buildTimeline(loan)[0];
  approx(row.interest, 8.800951773315818, .001);
  assert.deepEqual(row.paymentAllocations[0].parts.map(p => [p.partId, Math.round(p.principal)]), [["a", 249], ["b", 747]]);
  approx(row.paymentAllocations[0].parts.reduce((sum, part) => sum + part.interest + part.principal, 0), 1000);
  assert.equal(row.partBalances.length, 2);
});

test("refinance closes predecessor facilities from its date and starts successor parts", () => {
  const predecessor = { id: "old", schemaVersion: 2, loanParts: [{ id: "old-1", originalPrincipal: 1000, startDate: "2025-01-01", interestRate: 0 }], refinanceClosedDate: "2025-02-01" };
  const successor = { id: "new", schemaVersion: 2, predecessorLoanIds: ["old"], refinanceDate: "2025-02-01", loanParts: [{ id: "new-1", originalPrincipal: 1000, startDate: "2025-02-01", interestRate: 0 }] };
  assert.equal(C.buildTimeline(predecessor).length, 1);
  assert.equal(C.buildTimeline(successor)[0].endingDebt, 1000);
});

test("canonical target payoff and 30/360 retain all unpaid interest in the debt", () => {
  const base = { schemaVersion: 2, dayCountConvention: "thirty360", loanParts: [{ id: "p", originalPrincipal: 1200, startDate: "2025-01-01", interestRate: 12, compoundInterest: false }], payments: [] };
  const jan = C.buildTimeline(base)[0];
  approx(jan.interest, 12);
  approx(jan.partBalances[0].interest, 12);
  approx(jan.endingDebt, 1212, .001);
  approx(C.buildTimeline(base)[1].interest, 12, .001);
  const required = C.calculatePaymentForTargetDate(base, "2026-01-01");
  assert.ok(required > 0);
  assert.ok(C.buildTimeline({ ...base, payments: [{ type: "scheduled", amount: required, startDate: "2025-01-01", endDate: "2026-01-01", frequency: 1, frequencyUnit: "month" }] }).at(-1).endingDebt <= .01);
});

test("canonical 30/360 uses contractual day counts for mid-month drawdowns", () => {
  const loan = {
    schemaVersion: 2,
    dayCountConvention: "thirty360",
    loanParts: [{ id: "late", originalPrincipal: 1000, startDate: "2025-07-27", interestRate: 36 }],
    payments: []
  };
  approx(C.buildTimeline(loan)[0].interest, 4, .001);
});


test("non-compounding canonical interest remains a separate liability", () => {
  const loan = { schemaVersion: 2, dayCountConvention: "thirty360", loanParts: [{ id: "p", originalPrincipal: 1200, startDate: "2025-01-01", interestRate: 12, compoundInterest: false }], payments: [] };
  const rows = C.buildTimeline(loan);
  approx(rows[0].partBalances[0].balance, 1200);
  approx(rows[0].partBalances[0].accruedInterest, 12);
  approx(rows[0].endingDebt, 1212);
  approx(rows[1].interest, 12);
});

test("combining existing loans preserves their independently calculated history and schedules", () => {
  const sources = [
    {
      id: "mortgage-a", name: "Mortgage A", loanType: "borrow", currency: "SEK", dayCountConvention: "actual365",
      schemaVersion: 2,
      loanParts: [{ id: "part-1", originalPrincipal: 100000, startDate: "2024-01-01", interestRate: 3, interestChanges: [] }],
      principalAdjustments: [{ id: "extra-a", date: "2024-06-15", amount: -1000, allocationPolicy: "proRata" }],
      payments: [{ id: "pay-a", type: "scheduled", amount: 1200, startDate: "2024-02-01", endDate: "2025-12-01", frequency: 1, frequencyUnit: "month", dayOfMonth: "1" }]
    },
    {
      id: "mortgage-b", name: "Mortgage B", loanType: "borrow", currency: "SEK", dayCountConvention: "actual365",
      schemaVersion: 2,
      loanParts: [{ id: "part-1", originalPrincipal: 50000, startDate: "2024-03-01", interestRate: 5, interestChanges: [] }],
      principalAdjustments: [],
      payments: [{ id: "pay-b", type: "scheduled", amount: 800, startDate: "2024-04-01", endDate: "2025-12-01", frequency: 1, frequencyUnit: "month", dayOfMonth: "1" }]
    }
  ];

  const combined = C.combineLoans(sources, { id: "facility-1", name: "My mortgage", combinedAt: "2026-08-30T12:00:00.000Z" });
  assert.equal(combined.facilityKind, "combined");
  assert.equal(combined.loanParts.length, 2);
  assert.equal(new Set(combined.loanParts.map(part => part.id)).size, 2);
  assert.deepEqual(combined.payments.map(payment => payment.targetPartIds), [
    ["mortgage-a:part-1"],
    ["mortgage-b:part-1"]
  ]);
  assert.deepEqual(combined.principalAdjustments[0].targetPartIds, ["mortgage-a:part-1"]);
  assert.deepEqual(combined.combination.sourceLoanIds, ["mortgage-a", "mortgage-b"]);

  const combinedByMonth = new Map(C.buildTimeline(combined).map(row => [row.date.toISOString().slice(0, 7), row.endingDebt]));
  const sourceRows = sources.map(source => new Map(C.buildTimeline(source).map(row => [row.date.toISOString().slice(0, 7), row.endingDebt])));
  for (const month of ["2024-03", "2024-06", "2025-01"]) {
    const expected = sourceRows.reduce((sum, rows) => sum + (rows.get(month) || 0), 0);
    assert.ok(Math.abs(combinedByMonth.get(month) - expected) < 0.01, `${month} changed by ${combinedByMonth.get(month) - expected}`);
  }
});

test("combination eligibility blocks accounting mismatches and reports the user-facing consequences", () => {
  const base = { loanType: "borrow", currency: "SEK", dayCountConvention: "actual365", loanParts: [{ originalPrincipal: 10, startDate: "2024-01-01", interestRate: 1 }] };
  assert.match(C.analyzeLoanCombination([base]).errors.join(" "), /at least two/i);
  assert.match(C.analyzeLoanCombination([base, { ...base, currency: "EUR" }]).errors.join(" "), /currency/i);
  assert.match(C.analyzeLoanCombination([base, { ...base, loanType: "lend" }]).errors.join(" "), /borrowing.*lending/i);
  assert.match(C.analyzeLoanCombination([base, { ...base, dayCountConvention: "thirty360" }]).errors.join(" "), /interest calculation/i);
  for (const marker of ["shared", "isShared", "_shared"]) {
    assert.match(C.analyzeLoanCombination([base, { ...base, [marker]: true }]).errors.join(" "), /shared/i);
  }
  for (const closeField of ["closedDate", "refinanceClosedDate"]) {
    const closed = { ...base, [closeField]: "2025-01-01" };
    assert.match(C.analyzeLoanCombination([closed, base]).errors.join(" "), /closed.*cannot be combined/i);
    assert.match(C.analyzeLoanCombination([base, closed]).errors.join(" "), /closed.*cannot be combined/i);
  }

  const analysis = C.analyzeLoanCombination([base, base]);
  assert.equal(analysis.errors.length, 0);
  assert.equal(analysis.sourceCount, 2);
  assert.equal(analysis.partCount, 2);
  assert.ok(analysis.warnings.some(message => /one overview/i.test(message)));
  assert.ok(analysis.warnings.some(message => /original rate/i.test(message)));
  assert.ok(analysis.warnings.some(message => /payment schedules/i.test(message)));
});

test("a combined facility can restore exact canonical source records", () => {
  const sources = [
    { id: "a", name: "A", loanType: "borrow", currency: "SEK", dayCountConvention: "actual365", initialAmount: 100, startDate: "2024-01-01", interestRate: 1, payments: [] },
    { id: "b", name: "B", loanType: "borrow", currency: "SEK", dayCountConvention: "actual365", initialAmount: 200, startDate: "2024-02-01", interestRate: 2, payments: [] }
  ];
  const combined = C.combineLoans(sources, { id: "combined", name: "A + B", combinedAt: "2026-08-30T12:00:00.000Z" });
  const restored = C.uncombineLoan(combined);
  assert.deepEqual(restored, sources.map(C.normalizeLoan));
  restored[0].name = "changed";
  assert.equal(combined.combination.sources[0].name, "A");
});

test("loan notes remain separate from the title through canonical editor saves", () => {
  const saved = C.buildCanonicalLoanFromEditor(null, {
    id: "with-notes",
    name: "Kitchen renovation",
    notes: "Receipts are in the blue folder.",
    loanType: "borrow",
    currency: "SEK",
    startDate: "2026-01-01",
    initialAmount: 25000,
    interestRate: 2,
    dayCountConvention: "actual365",
    interestChanges: [],
    loanChanges: []
  });

  assert.equal(saved.name, "Kitchen renovation");
  assert.equal(saved.notes, "Receipts are in the blue folder.");
  assert.equal(C.facilityEditorModel(saved).notes, "Receipts are in the blue folder.");
});

test("combining loans keeps facility notes separate and restores exact source titles and notes", () => {
  const sources = [
    { id: "a", name: "Kitchen", notes: "Invoice 17 remains unpaid.", loanType: "borrow", currency: "SEK", dayCountConvention: "actual365", initialAmount: 100, startDate: "2024-01-01", interestRate: 1, payments: [] },
    { id: "b", name: "Roof", notes: "", loanType: "borrow", currency: "SEK", dayCountConvention: "actual365", initialAmount: 200, startDate: "2024-02-01", interestRate: 2, payments: [] },
    { id: "c", name: "Windows", notes: "Warranty expires in 2031.", loanType: "borrow", currency: "SEK", dayCountConvention: "actual365", initialAmount: 300, startDate: "2024-03-01", interestRate: 3, payments: [] }
  ];

  assert.throws(() => C.combineLoans(sources, { name: "   " }), /title/i);
  const combined = C.combineLoans(sources, {
    id: "home",
    name: "Home improvements",
    notes: "One place for the renovation financing."
  });
  assert.equal(combined.name, "Home improvements");
  assert.equal(combined.notes, "One place for the renovation financing.");
  assert.deepEqual(
    C.uncombineLoan(combined).map(loan => ({ name: loan.name, notes: loan.notes })),
    sources.map(loan => ({ name: loan.name, notes: loan.notes }))
  );
});
