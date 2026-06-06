import fs from "node:fs";
import path from "node:path";
import "../calculations.js";

const C = globalThis.LendpileCalculations;
const input = process.argv[2] || "test/fixtures/legacy-example-loan.json";
const todayStr = process.argv[3] || new Date().toISOString().slice(0, 10);
const raw = JSON.parse(fs.readFileSync(input, "utf8"));
const loans = Array.isArray(raw) ? raw : (Array.isArray(raw.loans) ? raw.loans : []);

function money(value, currency = "SEK") {
  return new Intl.NumberFormat("sv-SE", { style: "currency", currency, maximumFractionDigits: 0 }).format(value || 0);
}

function localIso(date) {
  if (!date) return "-";
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function snapshot(timeline, today) {
  const historical = timeline.filter(row => row.date < today);
  const forecast = timeline.filter(row => row.date >= today);
  return {
    current: historical.at(-1) || null,
    next: forecast[0] || null,
    remainingMonths: forecast.length,
    completionDate: forecast.at(-1) ? localIso(forecast.at(-1).paymentDate) : "-",
    totalInterest: timeline.reduce((sum, row) => sum + row.interest, 0),
    totalPayments: timeline.reduce((sum, row) => sum + row.payment, 0)
  };
}

function diff(a, b) {
  return {
    debt: (b.current?.endingDebt || 0) - (a.current?.endingDebt || 0),
    months: b.remainingMonths - a.remainingMonths,
    interest: b.totalInterest - a.totalInterest,
    payments: b.totalPayments - a.totalPayments
  };
}

const today = new Date(`${todayStr}T00:00:00`);
today.setHours(0, 0, 0, 0);

console.log(`Calculation comparison for ${path.basename(input)} as of ${todayStr}`);
console.log("Legacy/default missing convention = 30/360. New loans default to Actual/365.\n");

for (const [index, loan] of loans.entries()) {
  const currency = loan.currency || "SEK";
  const current = snapshot(C.buildTimeline(loan), today);
  const thirty360 = snapshot(C.buildTimeline({ ...loan, dayCountConvention: "thirty360" }), today);
  const actual365 = snapshot(C.buildTimeline({ ...loan, dayCountConvention: "actual365" }), today);
  const actual360 = snapshot(C.buildTimeline({ ...loan, dayCountConvention: "actual360" }), today);
  const delta365 = diff(thirty360, actual365);
  const delta360 = diff(thirty360, actual360);

  console.log(`#${index + 1} ${loan.name || "(unnamed loan)"}`);
  console.log(`  Current:    debt ${money(current.current?.endingDebt, currency)}, months ${current.remainingMonths}, completion ${current.completionDate}, total interest ${money(current.totalInterest, currency)}`);
  console.log(`  30/360:     debt ${money(thirty360.current?.endingDebt, currency)}, months ${thirty360.remainingMonths}, completion ${thirty360.completionDate}, total interest ${money(thirty360.totalInterest, currency)}`);
  console.log(`  Actual/365: debt ${money(actual365.current?.endingDebt, currency)}, months ${actual365.remainingMonths}, completion ${actual365.completionDate}, total interest ${money(actual365.totalInterest, currency)}`);
  console.log(`  Actual/360: debt ${money(actual360.current?.endingDebt, currency)}, months ${actual360.remainingMonths}, completion ${actual360.completionDate}, total interest ${money(actual360.totalInterest, currency)}`);
  console.log(`  Delta Actual/365 vs 30/360: debt ${money(delta365.debt, currency)}, months ${delta365.months}, total interest ${money(delta365.interest, currency)}`);
  console.log(`  Delta Actual/360 vs 30/360: debt ${money(delta360.debt, currency)}, months ${delta360.months}, total interest ${money(delta360.interest, currency)}`);
  console.log("");
}
