(function(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.LendpileCalculations = api;
})(typeof globalThis !== "undefined" ? globalThis : window, function() {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const MAX_MONTHS = 600;
  const DAY_COUNT_CONVENTIONS = {
    ACTUAL_365: "actual365",
    ACTUAL_360: "actual360",
    THIRTY_360: "thirty360"
  };

  function parseDate(value, endOfDay = false) {
    if (!value) return null;
    if (value instanceof Date) {
      const d = new Date(value);
      d.setHours(endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0, endOfDay ? 999 : 0);
      return d;
    }
    const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    const d = match
      ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
      : new Date(value);
    if (Number.isNaN(d.getTime())) return null;
    d.setHours(endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0, endOfDay ? 999 : 0);
    return d;
  }

  function monthStart(date) {
    return new Date(date.getFullYear(), date.getMonth(), 1);
  }

  function nextMonthStart(date) {
    return new Date(date.getFullYear(), date.getMonth() + 1, 1);
  }

  function sameMonth(a, b) {
    return a && b && a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();
  }

  function daysBetween(start, end) {
    return Math.max(0, Math.round((end.getTime() - start.getTime()) / DAY_MS));
  }

  function days360US(start, end) {
    let startDay = start.getDate();
    let endDay = end.getDate();
    const startIsLastFebruaryDay = start.getMonth() === 1 && startDay === new Date(start.getFullYear(), 2, 0).getDate();
    const endIsLastFebruaryDay = end.getMonth() === 1 && endDay === new Date(end.getFullYear(), 2, 0).getDate();
    if (startDay === 31 || startIsLastFebruaryDay) startDay = 30;
    if ((endDay === 31 && startDay === 30) || (endIsLastFebruaryDay && startIsLastFebruaryDay)) endDay = 30;
    return Math.max(0, (end.getFullYear() - start.getFullYear()) * 360
      + (end.getMonth() - start.getMonth()) * 30 + endDay - startDay);
  }

  function numeric(value, fallback = 0) {
    const n = typeof value === "number" ? value : parseFloat(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function normalizeDayCountConvention(value, fallback = DAY_COUNT_CONVENTIONS.THIRTY_360) {
    if (value === DAY_COUNT_CONVENTIONS.ACTUAL_365 || value === "actual/365") return DAY_COUNT_CONVENTIONS.ACTUAL_365;
    if (value === DAY_COUNT_CONVENTIONS.ACTUAL_360 || value === "actual/360") return DAY_COUNT_CONVENTIONS.ACTUAL_360;
    if (value === DAY_COUNT_CONVENTIONS.THIRTY_360 || value === "30/360") return DAY_COUNT_CONVENTIONS.THIRTY_360;
    return fallback;
  }

  function getLoanDayCountConvention(loan) {
    return normalizeDayCountConvention(loan && loan.dayCountConvention);
  }

  function getLastWeekdayOfMonth(year, month) {
    const last = new Date(year, month + 1, 0);
    const dow = last.getDay();
    if (dow === 0) last.setDate(last.getDate() - 2);
    else if (dow === 6) last.setDate(last.getDate() - 1);
    last.setHours(0, 0, 0, 0);
    return last.getTime();
  }

  function getPaymentDates(payment) {
    const dates = [];
    const unit = payment.frequencyUnit || "month";
    const freq = Math.max(1, parseInt(payment.frequency || "1", 10) || 1);
    const start = parseDate(payment.startDate);
    if (!start) return dates;
    const endDate = parseDate(payment.endDate, true);

    if (payment.type === "one-time") return [start.getTime()];

    if (unit === "day") {
      for (let i = 0; i < MAX_MONTHS * 31; i += freq) {
        const d = new Date(start);
        d.setDate(start.getDate() + i);
        if (endDate && d > endDate) break;
        dates.push(d.getTime());
      }
      return dates;
    }

    if (unit === "week") {
      for (let i = 0; i < MAX_MONTHS * 7; i += freq * 7) {
        const d = new Date(start);
        d.setDate(start.getDate() + i);
        if (endDate && d > endDate) break;
        dates.push(d.getTime());
      }
      return dates;
    }

    if (payment.lastWeekdayOfMonth) {
      let y = start.getFullYear();
      let m = start.getMonth();
      for (let i = 0; i < MAX_MONTHS; i += freq) {
        const t = getLastWeekdayOfMonth(y, m + i);
        if (t >= start.getTime()) {
          if (endDate && t > endDate.getTime()) break;
          dates.push(t);
        }
      }
      return dates;
    }

    const dayOfMonth = Math.max(1, parseInt(payment.dayOfMonth || start.getDate(), 10) || start.getDate());
    for (let i = 0; i < MAX_MONTHS; i += freq) {
      const d = new Date(start.getFullYear(), start.getMonth() + i, 1);
      const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
      d.setDate(Math.min(dayOfMonth, lastDay));
      d.setHours(0, 0, 0, 0);
      if (d >= start) {
        if (endDate && d > endDate) break;
        dates.push(d.getTime());
      }
    }
    return dates;
  }

  function paymentLabel(payment, translate) {
    const t = translate || ((key) => key);
    if (payment.type === "one-time") return t("oneTimeAmortization");
    const unit = payment.frequencyUnit || "month";
    const freq = Math.max(1, parseInt(payment.frequency || "1", 10) || 1);
    if (unit === "day") return freq === 1 ? t("dailyPayment") : t("everyDaysPayment").replace("{freq}", freq);
    if (unit === "week") return freq === 1 ? t("weeklyPayment") : t("everyWeeksPayment").replace("{freq}", freq);
    if (freq === 1) return t("monthlyPayment");
    if (freq === 2) return t("biMonthlyPayment");
    if (freq === 3) return t("triMonthlyPayment");
    return t("everyMonthsPayment").replace("{freq}", freq);
  }

  function getMonthlyPaymentBreakdownAdvanced(loan, d, options = {}) {
    const currentMonth = monthStart(d);
    const monthEndExclusive = nextMonthStart(currentMonth);
    const breakdown = {};
    const payments = (loan.payments || []).slice().sort((a, b) => {
      if (a.type !== b.type) return a.type === "one-time" ? -1 : 1;
      return numeric(parseDate(a.startDate)?.getTime()) - numeric(parseDate(b.startDate)?.getTime());
    });

    for (const payment of payments) {
      const dates = getPaymentDates(payment).filter(t => t >= currentMonth.getTime() && t < monthEndExclusive.getTime());
      if (!dates.length) continue;
      const key = paymentLabel(payment, options.translate);
      breakdown[key] = (breakdown[key] || 0) + numeric(payment.amount) * dates.length;
    }
    return { total: Object.values(breakdown).reduce((sum, v) => sum + v, 0), breakdown };
  }

  function initialRateAtStart(loan, start) {
    let rate = numeric(loan.interestRate);
    const changes = (loan.interestChanges || []).slice().sort((a, b) => parseDate(a.date) - parseDate(b.date));
    for (const change of changes) {
      const d = parseDate(change.date);
      if (!d || d > start) break;
      rate = Math.max(0, numeric(change.rate));
    }
    return rate;
  }

  function buildTimelineAdvancedLegacy(loan, options = {}) {
    const loanStart = parseDate(loan && loan.startDate);
    if (!loanStart) return [];
    const timeline = [];
    let currentDebt = numeric(loan.initialAmount);
    let currentRate = initialRateAtStart(loan, loanStart);
    let currentMonth = monthStart(loanStart);
    const denominator = options.denominator === 360 ? 360 : 365;

    for (let monthsCount = 0; monthsCount < MAX_MONTHS && currentDebt > 0.000001; monthsCount++) {
      const periodStart = currentMonth < loanStart ? new Date(loanStart) : new Date(currentMonth);
      const periodEnd = nextMonthStart(currentMonth);
      const changesThisMonth = [];
      const breakdown = {};
      let interest = 0;
      let payment = 0;
      let principalPaid = 0;
      let accruedInterest = 0;
      let cursor = new Date(periodStart);

      const events = [];
      for (const change of (loan.interestChanges || [])) {
        const date = parseDate(change.date);
        if (date && date >= periodStart && date < periodEnd) {
          events.push({
            type: "interest",
            date,
            value: Math.max(0, numeric(change.rate)),
            title: String(change.title || ""),
            note: String(change.note || "")
          });
        }
      }
      for (const change of (loan.loanChanges || [])) {
        const date = parseDate(change.date);
        if (date && date >= periodStart && date < periodEnd) {
          events.push({
            type: "loan",
            date,
            value: numeric(change.amount),
            title: String(change.title || ""),
            note: String(change.note || "")
          });
        }
      }
      for (const p of (loan.payments || [])) {
        for (const t of getPaymentDates(p)) {
          const date = new Date(t);
          if (date >= periodStart && date < periodEnd) {
            events.push({ type: "payment", date, payment: p, value: numeric(p.amount) });
          }
        }
      }

      events.sort((a, b) => {
        const diff = a.date - b.date;
        if (diff !== 0) return diff;
        const order = { interest: 0, loan: 1, payment: 2 };
        return order[a.type] - order[b.type];
      });

      const applyInterestTo = (date) => {
        const days = daysBetween(cursor, date);
        if (days > 0 && currentDebt > 0) {
          const segmentInterest = currentDebt * (currentRate / 100) * (days / denominator);
          interest += segmentInterest;
          accruedInterest += segmentInterest;
        }
        cursor = new Date(date);
      };

      for (const event of events) {
        applyInterestTo(event.date);
        if (event.type === "interest") {
          if (event.value !== currentRate) changesThisMonth.push({
            type: "interest",
            value: event.value,
            date: new Date(event.date),
            title: event.title,
            note: event.note
          });
          currentRate = event.value;
        } else if (event.type === "loan") {
          const appliedValue = event.value < -currentDebt ? -currentDebt : event.value;
          currentDebt = Math.max(0, currentDebt + event.value);
          changesThisMonth.push({
            type: "loan",
            value: appliedValue,
            enteredValue: event.value,
            date: new Date(event.date),
            title: event.title,
            note: event.note
          });
        } else if (event.type === "payment") {
          const amount = Math.max(0, event.value);
          const interestCovered = Math.min(amount, accruedInterest);
          const principalAvailable = amount - interestCovered;
          const principal = Math.max(0, Math.min(principalAvailable, currentDebt));
          accruedInterest -= interestCovered;
          currentDebt -= principal;
          payment += amount;
          principalPaid += principal;
          const key = paymentLabel(event.payment, options.translate);
          breakdown[key] = (breakdown[key] || 0) + amount;
        }
      }

      applyInterestTo(periodEnd);
      const startingDebt = timeline.length
        ? timeline[timeline.length - 1].endingDebt
        : numeric(loan.initialAmount);
      const plannedPayment = payment;
      const unpaidInterest = Math.max(0, accruedInterest);
      currentDebt = Math.max(0, currentDebt + unpaidInterest);

      let isOverpayment = false;
      let actualNeeded = 0;
      if (currentDebt <= 0.000001 && plannedPayment > principalPaid + interest) {
        isOverpayment = true;
        actualNeeded = principalPaid + interest;
      }

      const paymentDates = events.filter(e => e.type === "payment").map(e => e.date.getTime());
      const paymentDate = paymentDates.length ? new Date(Math.min(...paymentDates)) : new Date(periodStart);
      timeline.push({
        date: new Date(currentMonth),
        paymentDate,
        startingDebt,
        interestRate: currentRate,
        changes: changesThisMonth,
        interest,
        payment: isOverpayment && actualNeeded ? actualNeeded : plannedPayment,
        paymentBreakdown: breakdown,
        amortization: principalPaid,
        endingDebt: currentDebt,
        isOverpayment,
        actualNeeded
      });
      currentMonth = nextMonthStart(currentMonth);
    }
    return timeline;
  }

  function calculatePaymentForTargetDateAdvanced(loan, targetDateStr, options = {}) {
    const start = parseDate(loan && loan.startDate);
    const target = parseDate(targetDateStr);
    if (!start || !target || target <= start) return null;
    const dayOfMonth = String(start.getDate());
    let low = 0;
    let high = numeric(loan.initialAmount) * 2 + 500000;
    const tol = 1;
    for (let iter = 0; iter < 60; iter++) {
      const p = (low + high) / 2;
      const loanCopy = {
        ...loan,
        payments: [{ type: "scheduled", amount: p, startDate: loan.startDate, endDate: targetDateStr, frequency: 1, frequencyUnit: "month", dayOfMonth }]
      };
      const timeline = buildTimelineAdvancedLegacy(loanCopy, options);
      if (!timeline.length) {
        low = p;
        continue;
      }
      const last = timeline[timeline.length - 1];
      if (last.endingDebt > 0.01 || last.date > monthStart(target)) low = p;
      else high = p;
      if (high - low < tol) break;
    }
    return Math.ceil(high * 100) / 100;
  }

  function getMonthlyPaymentBreakdownThirty360(loan, d, options = {}) {
    const breakdown = {};
    const currentDate = new Date(d.getFullYear(), d.getMonth(), 1);
    const nextMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0);
    const payments = (loan.payments || []).slice().sort((a, b) => {
      if (a.type !== b.type) return a.type === "one-time" ? -1 : 1;
      return parseDate(a.startDate) - parseDate(b.startDate);
    });

    for (const p of payments) {
      const ps = parseDate(p.startDate);
      if (!ps) continue;
      if (p.type === "one-time") {
        if (sameMonth(ps, d)) {
          const key = paymentLabel(p, options.translate);
          breakdown[key] = (breakdown[key] || 0) + numeric(p.amount);
        }
        continue;
      }

      if (ps > nextMonth) continue;
      const pe = parseDate(p.endDate);
      if (pe && currentDate > pe) continue;

      const unit = p.frequencyUnit || "month";
      const freq = Math.max(1, parseInt(p.frequency || "1", 10) || 1);
      if (unit === "week" || unit === "day") {
        const monthStartMs = currentDate.getTime();
        const monthEndMs = nextMonth.getTime() + DAY_MS - 1;
        const count = getPaymentDates(p).filter(t => t >= monthStartMs && t <= monthEndMs).length;
        if (count > 0) {
          const key = paymentLabel(p, options.translate);
          breakdown[key] = (breakdown[key] || 0) + numeric(p.amount) * count;
        }
        continue;
      }

      const monthsDiff = (d.getFullYear() - ps.getFullYear()) * 12 + (d.getMonth() - ps.getMonth());
      if (monthsDiff >= 0 && monthsDiff % freq === 0) {
        const key = paymentLabel(p, options.translate);
        breakdown[key] = (breakdown[key] || 0) + numeric(p.amount);
      }
    }

    return { total: Object.values(breakdown).reduce((sum, v) => sum + v, 0), breakdown };
  }

  function buildTimelineLegacy(loan, options = {}) {
    const convention = normalizeDayCountConvention(options.dayCountConvention || loan?.dayCountConvention);
    if (convention === DAY_COUNT_CONVENTIONS.ACTUAL_365) {
      return buildTimelineAdvancedLegacy(loan, { ...options, denominator: 365 });
    }
    if (convention === DAY_COUNT_CONVENTIONS.ACTUAL_360) {
      return buildTimelineAdvancedLegacy(loan, { ...options, denominator: 360 });
    }
    if (!loan || !loan.startDate) return [];
    const timeline = [];
    const start = parseDate(loan.startDate);
    if (!start) return [];
    const startMonth = monthStart(start);
    const interestChanges = (loan.interestChanges || []).slice().sort((a, b) => parseDate(a.date) - parseDate(b.date));
    const loanChanges = (loan.loanChanges || []).slice().sort((a, b) => parseDate(a.date) - parseDate(b.date));
    let icIndex = 0;
    let lcIndex = 0;
    let currentDebt = numeric(loan.initialAmount);
    let currentRate = numeric(loan.interestRate);

    while (icIndex < interestChanges.length) {
      const icDate = parseDate(interestChanges[icIndex].date);
      if (!icDate || monthStart(icDate) >= startMonth) break;
      currentRate = Math.max(0, numeric(interestChanges[icIndex].rate));
      icIndex++;
    }

    let currentDate = new Date(start);
    let monthsCount = 0;
    let pendingInterestChange = null;
    while (monthsCount < MAX_MONTHS && currentDebt > 0) {
      const changesThisMonth = [];
      if (pendingInterestChange !== null) {
        const pending = pendingInterestChange;
        const prevRate = currentRate;
        currentRate = pending.value;
        pendingInterestChange = null;
        if (prevRate !== currentRate) changesThisMonth.push({
          type: "interest",
          value: currentRate,
          date: pending.date,
          title: pending.title,
          note: pending.note
        });
      }

      if (icIndex < interestChanges.length) {
        const icDate = parseDate(interestChanges[icIndex].date);
        if (sameMonth(icDate, currentDate)) {
          const newRate = Math.max(0, numeric(interestChanges[icIndex].rate));
          if (newRate === currentRate) currentRate = newRate;
          else pendingInterestChange = {
            value: newRate,
            date: icDate,
            title: String(interestChanges[icIndex].title || ""),
            note: String(interestChanges[icIndex].note || "")
          };
          icIndex++;
        }
      }

      while (lcIndex < loanChanges.length) {
        const lcDate = parseDate(loanChanges[lcIndex].date);
        if (lcDate && (lcDate.getFullYear() < currentDate.getFullYear() ||
            (lcDate.getFullYear() === currentDate.getFullYear() && lcDate.getMonth() <= currentDate.getMonth()))) {
          const amount = numeric(loanChanges[lcIndex].amount);
          const appliedValue = amount < -currentDebt ? -currentDebt : amount;
          currentDebt = Math.max(0, currentDebt + amount);
          changesThisMonth.push({
            type: "loan",
            value: appliedValue,
            enteredValue: amount,
            date: lcDate,
            title: String(loanChanges[lcIndex].title || ""),
            note: String(loanChanges[lcIndex].note || "")
          });
          lcIndex++;
        } else {
          break;
        }
      }

      const startingDebt = currentDebt;
      const interest = startingDebt * (currentRate / 100 / 12);
      const paymentInfo = getMonthlyPaymentBreakdownThirty360(loan, currentDate, options);
      const payment = paymentInfo.total;
      const principalPaid = Math.max(0, Math.min(payment - interest, currentDebt));
      const unpaidInterest = Math.max(0, interest - payment);
      currentDebt = Math.max(0, currentDebt - principalPaid + unpaidInterest);

      if (currentDebt === 0 && payment > (startingDebt + interest)) {
        paymentInfo.isOverpayment = true;
        paymentInfo.actualNeeded = startingDebt + interest;
        paymentInfo.plannedPayment = payment;
      }

      let paymentDate = new Date(currentDate);
      const activePayment = (loan.payments || []).find(p => {
        const pStart = parseDate(p.startDate);
        const pEnd = parseDate(p.endDate);
        return pStart && pStart <= currentDate && (!pEnd || pEnd >= currentDate);
      });
      if (activePayment) {
        const y = currentDate.getFullYear();
        const m = currentDate.getMonth();
        if (activePayment.frequencyUnit === "week" || activePayment.frequencyUnit === "day") {
          const monthStartDate = new Date(y, m, 1);
          const monthEndDate = new Date(y, m + 1, 0);
          const allInMonth = getPaymentDates(activePayment)
            .filter(t => {
              const date = new Date(t);
              return date >= monthStartDate && date <= monthEndDate;
            });
          paymentDate = allInMonth.length ? new Date(allInMonth[0]) : new Date(y, m, 1);
        } else if (activePayment.lastWeekdayOfMonth) {
          paymentDate = new Date(getLastWeekdayOfMonth(y, m));
        } else {
          paymentDate = new Date(y, m, 1);
          const paymentDay = parseInt(activePayment.dayOfMonth, 10) || parseDate(activePayment.startDate).getDate();
          const lastDayOfMonth = new Date(y, m + 1, 0).getDate();
          paymentDate.setDate(Math.min(paymentDay, lastDayOfMonth));
        }
      }

      const displayPayment = (paymentInfo.isOverpayment && paymentInfo.actualNeeded != null)
        ? paymentInfo.actualNeeded
        : payment;
      timeline.push({
        date: new Date(currentDate),
        paymentDate,
        startingDebt,
        interestRate: currentRate,
        changes: changesThisMonth,
        interest,
        payment: displayPayment,
        paymentBreakdown: paymentInfo.breakdown,
        amortization: principalPaid,
        endingDebt: currentDebt,
        isOverpayment: paymentInfo.isOverpayment || false,
        actualNeeded: paymentInfo.actualNeeded || 0
      });
      currentDate.setMonth(currentDate.getMonth() + 1);
      monthsCount++;
    }
    return timeline;
  }

  // Version 2 is the sole saved facility shape. This normalizer is deliberately
  // one-way: legacy fields are read only at import/load time and never emitted.
  function isoDate(value) { const d = parseDate(value); return d ? `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}` : ""; }
  function normalizeLoan(input) {
    const loan = input || {};
    if (Array.isArray(loan.loanParts)) {
      const { initialAmount, interestRate, startDate, loanChanges, interestChanges, ...canonical } = loan;
      return { ...canonical, schemaVersion: 2, loanParts: loan.loanParts.map((part, i) => ({
        ...part,
        id: part.id || `part-${i + 1}`, originalPrincipal: Math.max(0, numeric(part.originalPrincipal ?? part.amount)),
        startDate: isoDate(part.startDate), interestRate: Math.max(0, numeric(part.interestRate)),
        compoundInterest: Boolean(part.compoundInterest),
        interestChanges: normalizeInterestChanges(part.interestChanges, part.startDate)
      })), principalAdjustments: Array.isArray(loan.principalAdjustments) ? loan.principalAdjustments : [] };
    }
    const start = isoDate(loan.startDate);
    const baseChanges = (loan.interestChanges || []).slice().sort((a,b) => parseDate(a.date) - parseDate(b.date));
    const rateAt = date => { let rate = numeric(loan.interestRate); for (const c of baseChanges) if (parseDate(c.date) <= parseDate(date)) rate = numeric(c.rate); return Math.max(0, rate); };
    const parts = [{ id: "part-1", originalPrincipal: Math.max(0, numeric(loan.initialAmount)), startDate: start, interestRate: rateAt(start), compoundInterest: Boolean(loan.compoundInterest), interestChanges: baseChanges }];
    const adjustments = [];
    (loan.loanChanges || []).forEach((change, i) => {
      const amount = numeric(change.amount), date = isoDate(change.date);
      const { amount: _legacyAmount, date: _legacyDate, ...auditFields } = change;
      if (amount > 0) parts.push({
        ...auditFields,
        id: change.id || `part-drawdown-${i + 1}`,
        originalPrincipal: amount,
        startDate: date,
        interestRate: rateAt(date),
        compoundInterest: Boolean(loan.compoundInterest),
        interestChanges: baseChanges.filter(c => parseDate(c.date) >= parseDate(date))
      });
      else adjustments.push({
        ...auditFields,
        id: change.id || `adjustment-${i + 1}`,
        date,
        amount,
        allocationPolicy: "proRata"
      });
    });
    const { initialAmount, interestRate, startDate, loanChanges, interestChanges, ...rest } = loan;
    return { ...rest, schemaVersion: 2, loanParts: parts, principalAdjustments: adjustments };
  }

  function buildCanonicalLoan(existing, draft) {
    const base = normalizeLoan(existing || {});
    const {
      initialAmount, interestRate, startDate, loanChanges, interestChanges,
      ...canonicalDraft
    } = draft || {};
    const parts = Array.isArray(canonicalDraft.loanParts)
      ? canonicalDraft.loanParts
      : base.loanParts;
    const adjustments = Array.isArray(canonicalDraft.principalAdjustments)
      ? canonicalDraft.principalAdjustments
      : base.principalAdjustments;
    return normalizeLoan({
      ...base,
      ...canonicalDraft,
      schemaVersion: 2,
      loanParts: parts,
      principalAdjustments: adjustments,
      payments: canonicalDraft.payments ?? base.payments ?? []
    });
  }

  function facilityEditorModel(input) {
    const canonical = normalizeLoan(input || {});
    const [primary = {}, ...additionalParts] = canonical.loanParts || [];
    return {
      ...canonical,
      startDate: primary.startDate || "",
      initialAmount: numeric(primary.originalPrincipal),
      interestRate: numeric(primary.interestRate),
      compoundInterest: Boolean(primary.compoundInterest),
      interestChanges: Array.isArray(primary.interestChanges) ? primary.interestChanges.map(change => ({ ...change })) : [],
      loanChanges: [
        ...additionalParts.map(part => ({ ...part, facilityKind: "part", date: part.startDate, amount: numeric(part.originalPrincipal) })),
        ...(canonical.principalAdjustments || []).map(adjustment => ({ ...adjustment, facilityKind: "adjustment" }))
      ]
    };
  }

  function buildCanonicalLoanFromEditor(existing, editor) {
    const base = normalizeLoan(existing || {});
    const draft = editor || {};
    const primaryBase = (base.loanParts && base.loanParts[0]) || {};
    const primary = {
      ...primaryBase,
      id: primaryBase.id || "part-1",
      originalPrincipal: Math.max(0, numeric(draft.initialAmount)),
      startDate: isoDate(draft.startDate),
      interestRate: Math.max(0, numeric(draft.interestRate)),
      compoundInterest: Boolean(draft.compoundInterest ?? primaryBase.compoundInterest),
      interestChanges: Array.isArray(draft.interestChanges) ? draft.interestChanges.map(change => ({ ...change })) : []
    };
    const parts = [primary];
    const adjustments = [];
    for (const change of (draft.loanChanges || [])) {
      const amount = numeric(change.amount);
      const date = isoDate(change.date);
      const facilityKind = change.facilityKind || (change.kind === "part" || change.kind === "adjustment" ? change.kind : "");
      if (facilityKind === "part" || amount > 0) {
        const { facilityKind: _facilityKind, amount: _amount, date: _date, allocationPolicy, ...partFields } = change;
        const inheritedChange = (primary.interestChanges || [])
          .filter(item => parseDate(item.date) <= parseDate(date))
          .sort((a, b) => parseDate(b.date) - parseDate(a.date))[0];
        const inheritedRate = inheritedChange ? numeric(inheritedChange.rate) : numeric(primary.interestRate);
        parts.push({
          ...partFields,
          id: change.id || `part-${parts.length + 1}`,
          originalPrincipal: Math.max(0, amount),
          startDate: date,
          interestRate: Number.isFinite(Number(change.interestRate)) ? Math.max(0, numeric(change.interestRate)) : inheritedRate,
          compoundInterest: Boolean(change.compoundInterest ?? primary.compoundInterest),
          interestChanges: Array.isArray(change.interestChanges)
            ? change.interestChanges.map(item => ({ ...item }))
            : (primary.interestChanges || []).filter(item => parseDate(item.date) >= parseDate(date)).map(item => ({ ...item }))
        });
      } else if (facilityKind === "adjustment" || amount < 0) {
        const { facilityKind: _facilityKind, ...adjustment } = change;
        adjustments.push({ ...adjustment, id: change.id || `adjustment-${adjustments.length + 1}`, date, amount, allocationPolicy: change.allocationPolicy || "proRata" });
      }
    }
    return buildCanonicalLoan(base, { ...draft, loanParts: parts, principalAdjustments: adjustments });
  }

  function cloneData(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }

  function normalizeInterestChanges(changes, startDate) {
    const start = parseDate(startDate);
    return (Array.isArray(changes) ? changes : []).map(change => {
      const date = isoDate(change?.date);
      const rate = Number(change?.rate);
      if (!date || !Number.isFinite(rate) || rate < 0 || (start && parseDate(date) < start)) {
        throw new Error("Every rate change needs a valid date on or after the part start date and a non-negative rate.");
      }
      const normalized = { ...cloneData(change), date, rate };
      if (!String(normalized.title || "").trim()) delete normalized.title;
      else normalized.title = String(normalized.title).trim();
      if (!String(normalized.note || "").trim()) delete normalized.note;
      else normalized.note = String(normalized.note).trim();
      return normalized;
    }).sort((a, b) => parseDate(a.date) - parseDate(b.date));
  }

  function updateLoanPart(input, partId, patch = {}) {
    const loan = normalizeLoan(input || {});
    const index = loan.loanParts.findIndex(part => String(part.id) === String(partId));
    if (index < 0) throw new Error("Loan part not found.");
    const current = loan.loanParts[index];
    if ((current.refinancedBy || []).length) {
      throw new Error("A refinanced loan part cannot be edited because its recorded payoff and successor principal must remain consistent.");
    }
    const originalPrincipal = patch.originalPrincipal === undefined
      ? current.originalPrincipal : Number(patch.originalPrincipal);
    const startDate = patch.startDate === undefined ? current.startDate : isoDate(patch.startDate);
    const interestRate = patch.interestRate === undefined ? current.interestRate : Number(patch.interestRate);
    if (!Number.isFinite(originalPrincipal) || originalPrincipal <= 0) throw new Error("Original principal must be greater than zero.");
    if (!startDate) throw new Error("Choose a valid part start date.");
    if (!Number.isFinite(interestRate) || interestRate < 0) throw new Error("Interest rate must be zero or greater.");
    const next = {
      ...current,
      ...cloneData(patch),
      id: current.id,
      originalPrincipal,
      startDate,
      interestRate,
      compoundInterest: patch.compoundInterest === undefined ? Boolean(current.compoundInterest) : Boolean(patch.compoundInterest),
      interestChanges: normalizeInterestChanges(patch.interestChanges === undefined ? current.interestChanges : patch.interestChanges, startDate)
    };
    const title = String(next.title || "").trim();
    if (title) next.title = title;
    else delete next.title;
    const note = String(next.note || "").trim();
    if (note) next.note = note;
    else delete next.note;
    delete next.sourceLoanNote;
    const parts = loan.loanParts.map((part, partIndex) => partIndex === index ? next : cloneData(part));
    return normalizeLoan({ ...loan, loanParts: parts });
  }

  function analyzeLoanCombination(inputs) {
    const sourceLoans = Array.isArray(inputs) ? inputs.filter(Boolean) : [];
    const loans = sourceLoans.map(normalizeLoan);
    const errors = [];
    const currencies = new Set(loans.map(loan => loan.currency || "SEK"));
    const loanTypes = new Set(loans.map(loan => loan.loanType || "borrow"));
    const conventions = new Set(loans.map(loan => normalizeDayCountConvention(loan.dayCountConvention)));
    if (loans.length < 2) errors.push("Select at least two loans to combine.");
    if (currencies.size > 1) errors.push("Loans must use the same currency.");
    if (loanTypes.size > 1) errors.push("Loans must all be borrowing or all be lending.");
    if (conventions.size > 1) errors.push("Loans must use the same interest calculation method.");
    if (sourceLoans.some(loan => loan.shared || loan.isShared || loan._shared)) errors.push("Shared loans cannot be combined yet.");
    if (loans.some(loan => loan.closedDate || loan.refinanceClosedDate)) errors.push("Closed or refinanced loans cannot be combined yet.");
    if (loans.some(loan => loan.facilityKind === "combined")) errors.push("A combined facility cannot be combined again. Separate it first.");
    return {
      errors,
      warnings: [
        "The selected loans will appear as one overview and forecast instead of separate cards.",
        "Every loan part keeps its original rate, start date, changes, and calculation history; rates are never averaged for accounting.",
        "Existing payment schedules and principal adjustments stay attached to their original loan parts.",
        "You can separate the facility later; current part details and part-targeted history are preserved."
      ],
      sourceCount: loans.length,
      partCount: loans.reduce((sum, loan) => sum + (loan.loanParts || []).length, 0),
      originalPrincipal: loans.reduce((sum, loan) => sum + (loan.loanParts || []).reduce((partSum, part) => partSum + numeric(part.originalPrincipal), 0), 0),
      paymentPlanCount: loans.reduce((sum, loan) => sum + (loan.payments || []).length, 0),
      currency: loans[0]?.currency || "SEK",
      loanType: loans[0]?.loanType || "borrow",
      dayCountConvention: loans[0]?.dayCountConvention || "actual365"
    };
  }

  function combineLoans(inputs, options = {}) {
    const sourceLoans = (Array.isArray(inputs) ? inputs : []).map(normalizeLoan);
    const analysis = analyzeLoanCombination(sourceLoans);
    if (analysis.errors.length) throw new Error(analysis.errors.join(" "));
    const name = String(options.name || "").trim();
    if (!name) throw new Error("Choose a title for the combined loan.");
    const first = sourceLoans[0];
    const {
      id: _sourceId, name: _sourceName, notes: _sourceNotes, loanParts: _sourceParts,
      principalAdjustments: _sourceAdjustments, payments: _sourcePayments,
      combination: _sourceCombination, facilityKind: _sourceFacilityKind,
      ...sharedFields
    } = first;
    const parts = [];
    const adjustments = [];
    const payments = [];
    const sourceLoanIds = [];
    sourceLoans.forEach((loan, loanIndex) => {
      const sourceKey = String(loan.id ?? `source-${loanIndex + 1}`);
      sourceLoanIds.push(loan.id ?? sourceKey);
      const partIds = (loan.loanParts || []).map((part, partIndex) => {
        const sourcePartId = String(part.id ?? `part-${partIndex + 1}`);
        const id = `${sourceKey}:${sourcePartId}`;
        const combinedPart = { ...cloneData(part), id, sourceLoanId: loan.id ?? sourceKey, sourceLoanName: loan.name || `Loan ${loanIndex + 1}`, sourcePartId };
        if (!String(combinedPart.note || "").trim() && String(loan.notes || "").trim()) combinedPart.note = String(loan.notes).trim();
        delete combinedPart.sourceLoanNote;
        parts.push(combinedPart);
        return id;
      });
      const originalToCombinedPartIds = new Map((loan.loanParts || []).map((part, partIndex) => [
        String(part.id ?? `part-${partIndex + 1}`), partIds[partIndex]
      ]));
      const mappedTargets = targetPartIds => {
        if (!Array.isArray(targetPartIds) || !targetPartIds.length) return [...partIds];
        const mapped = targetPartIds.map(id => originalToCombinedPartIds.get(String(id))).filter(Boolean);
        return mapped.length ? mapped : [...partIds];
      };
      (loan.principalAdjustments || []).forEach((adjustment, adjustmentIndex) => adjustments.push({
        ...cloneData(adjustment),
        id: `${sourceKey}:${adjustment.id ?? `adjustment-${adjustmentIndex + 1}`}`,
        sourceLoanId: loan.id ?? sourceKey,
        targetPartIds: mappedTargets(adjustment.targetPartIds),
        allocationPolicy: adjustment.allocationPolicy || "proRata"
      }));
      (loan.payments || []).forEach((payment, paymentIndex) => payments.push({
        ...cloneData(payment),
        id: `${sourceKey}:${payment.id ?? `payment-${paymentIndex + 1}`}`,
        sourceLoanId: loan.id ?? sourceKey,
        targetPartIds: mappedTargets(payment.targetPartIds),
        allocationPolicy: payment.allocationPolicy || "proRata"
      }));
    });
    const notes = String(options.notes || "").trim();
    return normalizeLoan({
      ...sharedFields,
      id: options.id || `combined-${Date.now()}`,
      name,
      notes,
      facilityKind: "combined",
      schemaVersion: 2,
      currency: analysis.currency,
      loanType: analysis.loanType,
      dayCountConvention: analysis.dayCountConvention,
      loanParts: parts,
      principalAdjustments: adjustments,
      payments,
      combination: {
        version: 1,
        combinedAt: options.combinedAt || new Date().toISOString(),
        sourceLoanIds,
        sources: cloneData(sourceLoans)
      }
    });
  }

  function uncombineLoan(input) {
    const combined = normalizeLoan(input || {});
    combined.payments = (combined.payments || []).map((payment, index) => ({ ...payment, id: payment.id || `combined-payment-${index + 1}` }));
    combined.principalAdjustments = (combined.principalAdjustments || []).map((adjustment, index) => ({ ...adjustment, id: adjustment.id || `combined-adjustment-${index + 1}` }));
    const sources = combined.combination?.sources;
    if (!Array.isArray(sources) || sources.length < 2) throw new Error("This facility does not contain restorable source loans.");
    const sourceKeys = sources.map((source, index) => String(source.id ?? `source-${index + 1}`));
    const partSource = new Map(combined.loanParts.map(part => [String(part.id), String(part.sourceLoanId)]));
    const restored = sources.map((source, sourceIndex) => {
      const sourceKey = sourceKeys[sourceIndex];
      const currentParts = combined.loanParts.filter(part => String(part.sourceLoanId) === sourceKey).map(part => {
        const clean = cloneData(part);
        clean.id = clean.sourcePartId || clean.id;
        delete clean.sourceLoanId;
        delete clean.sourceLoanName;
        delete clean.sourcePartId;
        delete clean.sourceLoanNote;
        return clean;
      });
      const base = normalizeLoan(source);
      const currentName = currentParts.length === 1 ? String(currentParts[0].title || base.name || "").trim() : String(base.name || "");
      const currentNote = currentParts.length === 1 ? String(currentParts[0].note || "") : String(base.notes || "");
      const notes = currentNote || Object.prototype.hasOwnProperty.call(base, "notes") ? { notes: currentNote } : {};
      return normalizeLoan({ ...base, name: currentName, ...notes, loanParts: currentParts, payments: [], principalAdjustments: [] });
    });
    const sourceIndexByKey = new Map(sourceKeys.map((key, index) => [key, index]));
    const localTargets = (targetPartIds, sourceKey) => (targetPartIds || [])
      .filter(id => partSource.get(String(id)) === sourceKey)
      .map(id => combined.loanParts.find(part => String(part.id) === String(id))?.sourcePartId || id);
    const singleSourceFor = targetPartIds => {
      if (!Array.isArray(targetPartIds) || !targetPartIds.length) return null;
      const keys = new Set(targetPartIds.map(id => partSource.get(String(id))).filter(Boolean));
      return keys.size === 1 ? [...keys][0] : null;
    };
    const materializedPaymentIds = new Set();
    for (const payment of combined.payments || []) {
      const sourceKey = singleSourceFor(payment.targetPartIds);
      if (sourceKey && sourceIndexByKey.has(sourceKey)) {
        const clean = cloneData(payment);
        clean.id = String(clean.id || "payment").replace(`${sourceKey}:`, "");
        clean.targetPartIds = localTargets(payment.targetPartIds, sourceKey);
        delete clean.sourceLoanId;
        restored[sourceIndexByKey.get(sourceKey)].payments.push(clean);
      } else materializedPaymentIds.add(String(payment.id));
    }
    const materializedAdjustmentIds = new Set();
    for (const adjustment of combined.principalAdjustments || []) {
      const sourceKey = singleSourceFor(adjustment.targetPartIds);
      if (sourceKey && sourceIndexByKey.has(sourceKey)) {
        const clean = cloneData(adjustment);
        clean.id = String(clean.id || "adjustment").replace(`${sourceKey}:`, "");
        clean.targetPartIds = localTargets(adjustment.targetPartIds, sourceKey);
        delete clean.sourceLoanId;
        restored[sourceIndexByKey.get(sourceKey)].principalAdjustments.push(clean);
      } else materializedAdjustmentIds.add(String(adjustment.id));
    }
    if (materializedPaymentIds.size || materializedAdjustmentIds.size) {
      for (const row of buildCanonicalTimeline(combined)) {
        for (const allocation of row.paymentAllocations || []) {
          if (!materializedPaymentIds.has(String(allocation.paymentId))) continue;
          for (const partAllocation of allocation.parts || []) {
            const sourceKey = partSource.get(String(partAllocation.partId));
            const sourceIndex = sourceIndexByKey.get(sourceKey);
            const amount = numeric(partAllocation.interest) + numeric(partAllocation.principal);
            if (sourceIndex == null || amount <= 0) continue;
            restored[sourceIndex].payments.push({
              id: `${allocation.paymentId}:${isoDate(allocation.date)}:${sourceKey}`,
              type: "one-time", amount, startDate: isoDate(allocation.date),
              targetPartIds: localTargets([partAllocation.partId], sourceKey), allocationPolicy: "proRata",
              materializedFromPaymentId: allocation.paymentId
            });
          }
        }
        for (const change of row.changes || []) {
          if (change.type !== "principalAdjustment" || !materializedAdjustmentIds.has(String(change.adjustmentId))) continue;
          for (const partAllocation of change.allocations || []) {
            const sourceKey = partSource.get(String(partAllocation.partId));
            const sourceIndex = sourceIndexByKey.get(sourceKey);
            if (sourceIndex == null || numeric(partAllocation.principal) <= 0) continue;
            restored[sourceIndex].principalAdjustments.push({
              id: `${change.adjustmentId}:${isoDate(change.date)}:${sourceKey}`,
              date: isoDate(change.date), amount: -numeric(partAllocation.principal),
              targetPartIds: localTargets([partAllocation.partId], sourceKey), allocationPolicy: "proRata",
              materializedFromAdjustmentId: change.adjustmentId
            });
          }
        }
      }
    }
    return restored.map(normalizeLoan);
  }

  function isCanonicalLoan(loan) { return Array.isArray(loan && loan.loanParts); }
  function canonicalStart(loan) { return loan.loanParts.map(p => parseDate(p.startDate)).filter(Boolean).sort((a,b)=>a-b)[0] || null; }
  function partRate(part, date) { let rate = numeric(part.interestRate); for (const c of (part.interestChanges || []).slice().sort((a,b)=>parseDate(a.date)-parseDate(b.date))) if (parseDate(c.date) <= date) rate = Math.max(0, numeric(c.rate)); return rate; }
  function eligibleStates(states, targetPartIds) {
    if (!Array.isArray(targetPartIds) || !targetPartIds.length) return states;
    const targetIds = new Set(targetPartIds.map(String));
    return states.filter(state => targetIds.has(String(state.part.id)));
  }
  function allocateProRata(states, amount, targetPartIds) {
    const eligible = eligibleStates(states, targetPartIds).filter(s => s.balance > .000001), total = eligible.reduce((n,s)=>n+s.balance,0);
    let remaining = Math.min(Math.max(0, amount), total);
    return eligible.map((s, i) => { const value = i === eligible.length - 1 ? remaining : Math.min(s.balance, amount * s.balance / total); remaining -= value; s.balance -= value; return { partId: s.part.id, interest: 0, principal: value }; });
  }
  function allocateAccruedInterest(states, amount, targetPartIds) {
    const eligible = eligibleStates(states, targetPartIds).filter(s => s.accrued > .000001), total = eligible.reduce((sum, state) => sum + state.accrued, 0);
    let remaining = Math.min(Math.max(0, amount), total);
    return eligible.map((state, index) => {
      const value = index === eligible.length - 1 ? remaining : Math.min(state.accrued, amount * state.accrued / total);
      remaining -= value;
      state.accrued -= value;
      return { partId: state.part.id, interest: value, principal: 0 };
    });
  }
  function mergePartAllocations(interestParts, principalParts) {
    const merged = new Map();
    for (const part of [...interestParts, ...principalParts]) {
      const allocation = merged.get(part.partId) || { partId: part.partId, interest: 0, principal: 0 };
      allocation.interest += part.interest || 0;
      allocation.principal += part.principal || 0;
      merged.set(part.partId, allocation);
    }
    return [...merged.values()];
  }
  function buildCanonicalTimeline(loan, options = {}) {
    const start = canonicalStart(loan); if (!start) return [];
    const selectedConvention = options.dayCountConvention || loan.dayCountConvention;
    const convention = normalizeDayCountConvention(selectedConvention);
    const thirty360 = selectedConvention === "thirty360" || selectedConvention === "30/360" || convention === DAY_COUNT_CONVENTIONS.THIRTY_360;
    const denominator = convention === DAY_COUNT_CONVENTIONS.ACTUAL_360 ? 360 : (thirty360 ? 360 : 365);
    const close = parseDate(loan.refinanceClosedDate || loan.closedDate);
    const states = loan.loanParts.map(part => ({ part, balance: 0, active: false, accrued: 0, monthInterest: 0 }));
    const timeline = []; let month = monthStart(start);
    for (let n=0; n < MAX_MONTHS; n++) {
      const end = nextMonthStart(month); if (close && month >= close) break;
      const periodEnd = close && close < end ? close : end, events=[];
      states.forEach(s => { const d=parseDate(s.part.startDate); if (d && d >= month && d < periodEnd) events.push({type:"draw",date:d,state:s}); (s.part.interestChanges||[]).forEach(c=>{const d=parseDate(c.date);if(d&&d>=month&&d<periodEnd) events.push({type:"rate",date:d}); }); });
      (loan.principalAdjustments||[]).forEach(a=>{const d=parseDate(a.date);if(d&&d>=month&&d<periodEnd) events.push({type:"adjustment",date:d,value:numeric(a.amount),source:a});});
      (loan.payments||[]).forEach(payment=>getPaymentDates(payment).forEach(t=>{const d=new Date(t);if(d>=month&&d<periodEnd) events.push({type:"payment",date:d,value:Math.max(0,numeric(payment.amount)),payment});}));
      events.sort((a,b)=>a.date-b.date || ({draw:0,rate:1,adjustment:2,payment:3}[a.type]-({draw:0,rate:1,adjustment:2,payment:3}[b.type])));
      let cursor = new Date(month < start ? start : month), interest=0, payment=0, amortization=0, allocations=[], changes=[];
      states.forEach(s => { s.monthInterest = 0; });
      const accrue = date => { const days = thirty360 ? days360US(cursor, date) : daysBetween(cursor,date);
        if(days) states.forEach(s=>{ if(s.active && s.balance>0) { const value=s.balance*(partRate(s.part,cursor)/100)*days/denominator; s.accrued+=value; s.monthInterest+=value; interest+=value; }}); cursor=new Date(date); };
      for (const e of events) { accrue(e.date); if(e.type === "draw") { e.state.active=true; e.state.balance=e.state.part.originalPrincipal; changes.push({type:"loanPart",partId:e.state.part.id,value:e.state.balance,date:new Date(e.date)}); }
        else if(e.type === "adjustment") { const applied=allocateProRata(states, -e.value, e.source.targetPartIds); amortization += applied.reduce((x,a)=>x+a.principal,0); changes.push({type:"principalAdjustment",adjustmentId:e.source.id || null,value:e.value,date:new Date(e.date),allocations:applied}); }
        else if(e.type === "payment") { const interestParts=allocateAccruedInterest(states,e.value,e.payment.targetPartIds); const interestPaid=interestParts.reduce((sum,part)=>sum+part.interest,0); const principalParts=allocateProRata(states,e.value-interestPaid,e.payment.targetPartIds); const principal=principalParts.reduce((sum,part)=>sum+part.principal,0); const actual=interestPaid+principal; amortization+=principal; payment+=actual; allocations.push({paymentId:e.payment.id || null,date:new Date(e.date), policy:e.payment.allocationPolicy || "proRata", amount:actual, plannedAmount:e.value, targetPartIds:e.payment.targetPartIds || null, parts:mergePartAllocations(interestParts,principalParts)}); }
      }
      accrue(periodEnd);
      // Non-compounding interest remains a separate liability. Only parts that
      // explicitly compound capitalize their accrued interest at a period end.
      states.forEach(s => {
        if (s.part.compoundInterest && s.accrued) {
          s.balance += s.accrued;
          s.accrued = 0;
        }
      });
      const endingDebt=states.reduce((x,s)=>x+s.balance+s.accrued,0); const startingDebt=timeline.length ? timeline.at(-1).endingDebt : 0;
      if (states.some(s=>s.active) || events.length) timeline.push({date:new Date(month),paymentDate:allocations[0]?.date || new Date(month),startingDebt,interestRate: endingDebt ? states.reduce((x,s)=>x+s.balance*partRate(s.part,periodEnd),0)/endingDebt : 0,changes,interest,payment,amortization,endingDebt,paymentAllocations:allocations,partBalances:states.filter(s=>s.active).map(s=>({partId:s.part.id,originalPrincipal:s.part.originalPrincipal,startDate:s.part.startDate,interestRate:partRate(s.part,periodEnd),balance:s.balance,accruedInterest:s.accrued,interest:s.monthInterest}))});
      if (close && periodEnd >= close) break; if (endingDebt <= .000001 && states.every(s=>s.active || parseDate(s.part.startDate)<end)) break; month=nextMonthStart(month);
    } return timeline;
  }
  function buildTimelineAdvanced(loan, options = {}) { return isCanonicalLoan(loan) ? buildCanonicalTimeline(loan, options) : buildTimelineAdvancedLegacy(loan, options); }
  function buildTimeline(loan, options = {}) { return isCanonicalLoan(loan) ? buildCanonicalTimeline(loan, options) : buildTimelineLegacy(loan, options); }

  function debtAtEffectiveDate(input, effectiveDate, targetPartIds) {
    const loan = normalizeLoan(input || {});
    const date = isoDate(effectiveDate);
    if (!date) throw new Error("Choose a valid effective date.");
    const selectedIds = Array.isArray(targetPartIds) && targetPartIds.length
      ? [...new Set(targetPartIds.map(String))]
      : loan.loanParts.map(part => String(part.id));
    const knownIds = new Set(loan.loanParts.map(part => String(part.id)));
    if (!selectedIds.length || selectedIds.some(id => !knownIds.has(id))) throw new Error("A selected loan part could not be found.");
    const latestStart = selectedIds.reduce((latest, id) => {
      const start = parseDate(loan.loanParts.find(part => String(part.id) === id).startDate);
      return !latest || start > latest ? start : latest;
    }, null);
    if (!latestStart || parseDate(date) < latestStart) throw new Error("The effective date cannot be before a selected loan part starts.");
    const probeId = `__debt-probe__:${date}:${selectedIds.join(",")}`;
    const probe = {
      id: probeId, type: "one-time", amount: Number.MAX_SAFE_INTEGER,
      startDate: date, targetPartIds: selectedIds, allocationPolicy: "proRata"
    };
    const timeline = buildCanonicalTimeline({ ...loan, payments: [...(loan.payments || []), probe] });
    const allocation = timeline.flatMap(row => row.paymentAllocations || []).find(item => item.paymentId === probeId);
    const parts = selectedIds.map(partId => {
      const item = allocation?.parts?.find(part => String(part.partId) === partId);
      const principal = numeric(item?.principal);
      const interest = numeric(item?.interest);
      return { partId, principal, interest, total: principal + interest };
    });
    return { date, total: parts.reduce((sum, part) => sum + part.total, 0), parts };
  }

  function createRefinancing(inputs, selections, terms = {}) {
    const loans = (Array.isArray(inputs) ? inputs : []).map(normalizeLoan);
    const effectiveDate = isoDate(terms.effectiveDate);
    const name = String(terms.name || "").trim();
    const successorId = String(terms.id || "").trim();
    const transactionId = String(terms.transactionId || "").trim();
    const interestRate = Number(terms.interestRate);
    if (!effectiveDate) throw new Error("Choose a valid effective date.");
    if (!name) throw new Error("Choose a title for the refinanced loan.");
    if (!successorId || loans.some(loan => String(loan.id) === successorId)) throw new Error("The successor loan needs a unique stable ID.");
    if (!transactionId) throw new Error("The refinancing needs a stable transaction ID.");
    if (!Number.isFinite(interestRate) || interestRate < 0) throw new Error("Interest rate must be zero or greater.");
    if (!Array.isArray(selections) || !selections.length) throw new Error("Select at least one loan or loan part to refinance.");
    const byId = new Map(loans.map((loan, index) => [String(loan.id), { loan, index }]));
    const normalizedSelections = [];
    const seenParts = new Set();
    for (const selection of selections) {
      const entry = byId.get(String(selection?.loanId));
      if (!entry) throw new Error("A selected source loan could not be found.");
      const allPartIds = entry.loan.loanParts.map(part => String(part.id));
      const partIds = Array.isArray(selection.partIds) && selection.partIds.length
        ? [...new Set(selection.partIds.map(String))] : allPartIds;
      if (partIds.some(id => !allPartIds.includes(id))) throw new Error("A selected loan part could not be found.");
      for (const partId of partIds) {
        const selectionKey = `${entry.loan.id}:${partId}`;
        if (seenParts.has(selectionKey)) throw new Error("The same obligation cannot be selected twice.");
        seenParts.add(selectionKey);
        const part = entry.loan.loanParts.find(item => String(item.id) === partId);
        if ((part.refinancedBy || []).length) throw new Error("A selected loan part is already refinanced.");
      }
      normalizedSelections.push({ ...entry, partIds });
    }
    const currencies = new Set(normalizedSelections.map(item => item.loan.currency || "SEK"));
    const directions = new Set(normalizedSelections.map(item => item.loan.loanType || "borrow"));
    if (currencies.size !== 1) throw new Error("Selected obligations must use the same currency.");
    if (directions.size !== 1) throw new Error("Selected obligations must all be borrowing or all be lending.");
    const payoffRecords = normalizedSelections.map(item => {
      const debt = debtAtEffectiveDate(item.loan, effectiveDate, item.partIds);
      if (!(debt.total > 0.000001)) throw new Error("Every selected obligation must have positive debt on the effective date.");
      return { loanId: item.loan.id, loanName: item.loan.name || "", partIds: item.partIds, amount: debt.total, parts: debt.parts };
    });
    const total = payoffRecords.reduce((sum, record) => sum + record.amount, 0);
    const traceBase = { transactionId, successorLoanId: successorId, effectiveDate };
    const updated = loans.map(cloneData);
    normalizedSelections.forEach((selection, selectionIndex) => {
      const record = payoffRecords[selectionIndex];
      const source = updated[selection.index];
      const payoffId = `${transactionId}:payoff:${source.id}`;
      source.payments = [...(source.payments || []), {
        id: payoffId, type: "one-time", amount: record.amount, startDate: effectiveDate,
        targetPartIds: [...selection.partIds], allocationPolicy: "proRata",
        title: "Refinancing payoff", refinancing: { ...traceBase, amount: record.amount }
      }];
      source.refinancingOut = [...(source.refinancingOut || []), { ...traceBase, amount: record.amount, partIds: [...selection.partIds], payoffPaymentId: payoffId }];
      source.loanParts = source.loanParts.map(part => selection.partIds.includes(String(part.id))
        ? { ...part, refinancedBy: [...(part.refinancedBy || []), { ...traceBase, amount: record.parts.find(item => item.partId === String(part.id))?.total || 0 }] }
        : part);
    });
    const currency = [...currencies][0];
    const loanType = [...directions][0];
    const successor = normalizeLoan({
      id: successorId, name, notes: String(terms.notes || "").trim(), currency, loanType,
      dayCountConvention: terms.dayCountConvention || normalizedSelections[0].loan.dayCountConvention,
      facilityKind: "refinanced", schemaVersion: 2,
      loanParts: [{ id: `${successorId}:part-1`, originalPrincipal: total, startDate: effectiveDate, interestRate, compoundInterest: Boolean(terms.compoundInterest), interestChanges: [] }],
      principalAdjustments: [], payments: [],
      refinancing: {
        version: 1, transactionId, effectiveDate,
        sources: payoffRecords.map(record => ({ loanId: record.loanId, loanName: record.loanName, partIds: [...record.partIds], amount: record.amount }))
      }
    });
    updated.push(successor);
    return { loans: updated, successor, payoffRecords, total };
  }

  function calculatePaymentForTargetDate(loan, targetDateStr, options = {}) {
    if (isCanonicalLoan(loan)) {
      const start = canonicalStart(loan), target = parseDate(targetDateStr);
      if (!start || !target || target <= start) return null;
      const principal = loan.loanParts.reduce((sum, part) => sum + numeric(part.originalPrincipal), 0);
      let low = 0, high = principal * 2 + 500000;
      for (let iteration = 0; iteration < 60; iteration++) {
        const amount = (low + high) / 2;
        const timeline = buildCanonicalTimeline({ ...loan, payments: [{ type: "scheduled", amount, startDate: isoDate(start), endDate: targetDateStr, frequency: 1, frequencyUnit: "month", dayOfMonth: String(start.getDate()), allocationPolicy: "proRata" }] }, options);
        const last = timeline.at(-1);
        if (!last || last.endingDebt > .01 || last.date > monthStart(target)) low = amount; else high = amount;
        if (high - low < 1) break;
      }
      return Math.ceil(high * 100) / 100;
    }
    const convention = normalizeDayCountConvention(options.dayCountConvention || loan?.dayCountConvention);
    if (convention === DAY_COUNT_CONVENTIONS.ACTUAL_365) {
      return calculatePaymentForTargetDateAdvanced(loan, targetDateStr, { ...options, denominator: 365 });
    }
    if (convention === DAY_COUNT_CONVENTIONS.ACTUAL_360) {
      return calculatePaymentForTargetDateAdvanced(loan, targetDateStr, { ...options, denominator: 360 });
    }
    const start = parseDate(loan && loan.startDate);
    const target = parseDate(targetDateStr);
    if (!start || !target) return null;
    const targetMonth = monthStart(target);
    const startMonth = monthStart(start);
    if (targetMonth <= startMonth) return null;
    const dayOfMonth = String(start.getDate());
    let low = 0;
    let high = numeric(loan.initialAmount) * 2 + 500000;
    const tol = 1;
    for (let iter = 0; iter < 60; iter++) {
      const p = (low + high) / 2;
      const loanCopy = {
        ...loan,
        payments: [{ type: "scheduled", amount: p, startDate: loan.startDate, endDate: targetDateStr, frequency: 1, frequencyUnit: "month", dayOfMonth }]
      };
      const timeline = buildTimeline(loanCopy, options);
      if (!timeline.length) {
        low = p;
        continue;
      }
      const last = timeline[timeline.length - 1];
      const lastMonth = monthStart(last.date);
      if (last.endingDebt > 0.01 || lastMonth > targetMonth) low = p;
      else high = p;
      if (high - low < tol) break;
    }
    return Math.ceil(high * 100) / 100;
  }

  function getMonthlyPaymentBreakdown(loan, d, options = {}) {
    const convention = normalizeDayCountConvention(options.dayCountConvention || loan?.dayCountConvention);
    if (convention === DAY_COUNT_CONVENTIONS.ACTUAL_365 || convention === DAY_COUNT_CONVENTIONS.ACTUAL_360) {
      return getMonthlyPaymentBreakdownAdvanced(loan, d, options);
    }
    return getMonthlyPaymentBreakdownThirty360(loan, d, options);
  }

  function buildChartData(timeline, formatLabel) {
    let totalInterest = 0;
    let totalAmort = 0;
    return timeline.reduce((acc, row) => {
      acc.labels.push(formatLabel ? formatLabel(row.paymentDate) : row.paymentDate.toISOString().slice(0, 10));
      acc.debt.push(row.endingDebt);
      totalInterest += row.interest;
      totalAmort += row.amortization;
      acc.interest.push(totalInterest);
      acc.amort.push(totalAmort);
      return acc;
    }, { labels: [], debt: [], interest: [], amort: [] });
  }

  return {
    DAY_MS,
    DAY_COUNT_CONVENTIONS,
    MAX_MONTHS,
    buildTimeline,
    buildTimelineAdvanced,
    buildCanonicalTimeline,
    normalizeLoan,
    buildCanonicalLoan,
    facilityEditorModel,
    buildCanonicalLoanFromEditor,
    analyzeLoanCombination,
    combineLoans,
    uncombineLoan,
    updateLoanPart,
    debtAtEffectiveDate,
    createRefinancing,
    calculatePaymentForTargetDate,
    calculatePaymentForTargetDateAdvanced,
    getLastWeekdayOfMonth,
    getMonthlyPaymentBreakdown,
    getMonthlyPaymentBreakdownAdvanced,
    getMonthlyPaymentBreakdownThirty360,
    getPaymentDates,
    getLoanDayCountConvention,
    normalizeDayCountConvention,
    buildChartData,
    parseDate
  };
});
