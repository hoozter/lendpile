# Lendpile – Calculation reference

How the app’s loan and amortization calculations work, for verification against Excel or a bank statement.

---

## 1. Data model (inputs)

- **Loan**: `startDate`, `initialAmount`, `interestRate` (annual %), `currency`, `interestChanges[]`, `loanChanges[]`, `payments[]`.
- **Interest change**: `date`, `rate` (new annual %).
- **Loan change**: `date`, `amount` (positive = debt increases, negative = debt decreases).
- **Payment** (amortization): `type` ("scheduled" | "one-time"), `amount`, `startDate`, `endDate` (optional), `frequency` (for scheduled: 1 = every month, 2 = every 2 months, …), `dayOfMonth` (day of month for payment).

---

## 2. Timeline (month-by-month)

The app builds a **timeline**: one row per calendar month from the loan start until debt reaches zero or 600 months.

For each month the code:

1. **Interest rate**  
   If there was an interest change in the **previous** month, the **new** rate is applied **this** month. Change dated March → new rate from **April** onward (not March). Convention: “rate change effective from the start of the next period.”

2. **Loan amount changes**  
   All loan changes with `date` in or before the **current** month are applied at the **start** of the current month (before interest and payment). Change dated March 15 → debt adjusted when processing **March**. Multiple changes in the same month are applied in date order.

3. **Interest**  
   `startingDebt` = debt at start of month (after loan changes). `monthRate = annualRate / 100 / 12`. `interest = startingDebt * monthRate`.

4. **Payment**  
   Sum of all amortization payments in this month: **One-time** only in the month of `startDate`. **Scheduled** if `(currentMonth - paymentStartMonth) % frequency === 0` and current month is between start and end (if set).

5. **Amortization and new balance**  
   `principalPaid = max(0, min(payment - interest, currentDebt))`. Unpaid interest when payment < interest: `unpaidInterest = max(0, interest - payment)`; it is **capitalized** (added to balance). `endingDebt = currentDebt - principalPaid + unpaidInterest` (balance can increase when payment < interest).

6. **Overpayment**  
   When debt reaches zero and `payment > startingDebt + interest`, the row is marked as overpayment and the “actual needed” amount is stored for display.

7. **Next month**  
   Advance by one month; loop until debt = 0 or 600 months.

---

## 3. Scheduled payment timing

Payment with `startDate` in month M and `frequency` F is included in months M, M+F, M+2F, … The first scheduled payment is in the **start month** of the payment.

---

## 4. “Current” summary on the loan card

- **Historical:** Last row with `date < today`; its `endingDebt` is “remaining debt.”
- **When there is no historical row:** Remaining debt is `initialAmount + sum of ALL loanChanges[].amount`. All future loan changes are included; intended behaviour may be to restrict to changes with `date <= today` (candidate fix).

---

## 5. Conventions to confirm

- **Interest change timing:** App uses “next month” (change in March → new rate from April). Confirm this matches your use case.
- **Payment < interest:** Unpaid interest is capitalized (balance grows). Some contracts do not capitalize; match as needed.
- **Loan change sign:** `amount > 0` = debt increases (e.g. drawdown), `amount < 0` = debt decreases (e.g. one-off repayment).
