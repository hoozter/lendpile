# Lendpile - Calculation reference

This document describes the calculation contract covered by `npm test`.

## Interest Calculation Options

Lendpile supports three day-count conventions:

- **Actual/365 - real calendar days.** Interest accrues by actual elapsed days using a 365-day year. This is the default for newly created loans and is a good fit for family/friend loans because every real day counts naturally.
- **30/360 - simple monthly.** Every month counts as 30 days and the year as 360 days. This is simple and predictable. Existing loans that do not yet store a convention keep this legacy Lendpile behavior.
- **Actual/360 - commercial.** Interest accrues by actual elapsed days using a 360-day year. This is common in some commercial/money-market contexts and usually charges slightly more interest than Actual/365.

## What "Correct" Means

The user-entered loan details define the contract: loan amount, interest rates, loan changes, amortization payments, and the selected interest calculation convention. Once those inputs are defined, the calculation is mathematically provable.

The test suite proves the ledger equations:

- Interest is never negative.
- Payments and amortization are never negative.
- Debt never goes below zero.
- Each row's ending debt balances from its starting debt, applied loan changes, amortization, and any capitalized unpaid interest.
- A synthetic exported legacy loan stays locked to the current 30/360-style Lendpile numbers.
- Generated random loans are checked against the balance invariants.

Run:

```sh
npm test
```

## 30/360 Live-Legacy Convention

30/360 preserves the original Lendpile model:

- Interest uses `annualRate / 12` for the month.
- Interest changes are detected in their dated month and applied from the next timeline row.
- Loan amount changes are applied in their dated month before monthly interest is calculated.
- Payments are summed for the month. Monthly schedules use their month cadence; weekly and daily schedules count actual occurrences in the month.
- Payments cover monthly interest first, then reduce principal.
- If payment is smaller than interest, unpaid interest is capitalized into the balance.
- Final overpayments are capped for display to the amount actually needed.

The synthetic export in `test/fixtures/legacy-example-loan.json` locks known legacy behavior:

- Remaining debt as of January 31, 2026: about `137,517 SEK`.
- Remaining forecast months from January 31, 2026: `185`.
- Total interest across the full 30/360-style timeline: about `36,917 SEK`.

## Actual/365 And Actual/360 Date-Event Conventions

Actual/365 and Actual/360 are date-aware:

- The first period starts on the loan start date.
- Interest accrues between dated events.
- Interest changes take effect on their stated date.
- Loan changes take effect on their stated date.
- Payments take effect on their payment date and first cover accrued interest, then principal.
- Unpaid interest is capitalized at month end.

The only difference between Actual/365 and Actual/360 is the denominator:

- Actual/365: `interest = debt * annualRate * actualDays / 365`
- Actual/360: `interest = debt * annualRate * actualDays / 360`

## Comparison Tool

Run this comparison against an export:

```sh
npm run compare:calculations -- test/fixtures/legacy-example-loan.json 2026-01-31
```

The comparison is useful when deciding whether a legacy loan should stay on 30/360 or be switched to Actual/365/Actual/360.

## Payment Scheduling

- One-time payments occur only on `startDate`.
- Monthly scheduled payments occur on `dayOfMonth`, clamped to the last day for shorter months.
- `lastWeekdayOfMonth` schedules the last weekday in each month.
- Weekly payments repeat every `frequency * 7` days from `startDate`.
- Daily payments repeat every `frequency` days from `startDate`.
- Payment breakdowns and chart data count occurrences inside each month.

## Bank-Like Conventions To Keep Reviewing

Conventions that can differ between lenders and should be decided before changing behavior:

- Monthly `annualRate / 12` vs Actual/365 vs Actual/360.
- Whether interest changes apply the same day, the next month, or from the next payment/statement period.
- Whether payments are applied before interest, after interest, or prorated by payment date.
- Whether interest is rounded monthly, daily, or only at statement/payment time.
- Whether unpaid interest is capitalized immediately, monthly, separately tracked, or not allowed.
- Whether lenders apply payments at beginning of day, end of day, or with settlement delays.
