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

  function buildTimelineAdvanced(loan, options = {}) {
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
          events.push({ type: "interest", date, value: Math.max(0, numeric(change.rate)) });
        }
      }
      for (const change of (loan.loanChanges || [])) {
        const date = parseDate(change.date);
        if (date && date >= periodStart && date < periodEnd) {
          events.push({ type: "loan", date, value: numeric(change.amount) });
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
          if (event.value !== currentRate) changesThisMonth.push({ type: "interest", value: event.value, date: new Date(event.date) });
          currentRate = event.value;
        } else if (event.type === "loan") {
          const previousDebt = currentDebt;
          currentDebt = Math.max(0, currentDebt + event.value);
          changesThisMonth.push({ type: "loan", value: currentDebt - previousDebt, date: new Date(event.date) });
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
      const timeline = buildTimelineAdvanced(loanCopy, options);
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

  function buildTimeline(loan, options = {}) {
    const convention = normalizeDayCountConvention(options.dayCountConvention || loan?.dayCountConvention);
    if (convention === DAY_COUNT_CONVENTIONS.ACTUAL_365) {
      return buildTimelineAdvanced(loan, { ...options, denominator: 365 });
    }
    if (convention === DAY_COUNT_CONVENTIONS.ACTUAL_360) {
      return buildTimelineAdvanced(loan, { ...options, denominator: 360 });
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
        const prevRate = currentRate;
        currentRate = pendingInterestChange;
        pendingInterestChange = null;
        if (prevRate !== currentRate) changesThisMonth.push({ type: "interest", value: currentRate });
      }

      if (icIndex < interestChanges.length) {
        const icDate = parseDate(interestChanges[icIndex].date);
        if (sameMonth(icDate, currentDate)) {
          const newRate = Math.max(0, numeric(interestChanges[icIndex].rate));
          if (newRate === currentRate) currentRate = newRate;
          else pendingInterestChange = newRate;
          icIndex++;
        }
      }

      while (lcIndex < loanChanges.length) {
        const lcDate = parseDate(loanChanges[lcIndex].date);
        if (lcDate && (lcDate.getFullYear() < currentDate.getFullYear() ||
            (lcDate.getFullYear() === currentDate.getFullYear() && lcDate.getMonth() <= currentDate.getMonth()))) {
          const amount = numeric(loanChanges[lcIndex].amount);
          const previousDebt = currentDebt;
          currentDebt = Math.max(0, currentDebt + amount);
          changesThisMonth.push({ type: "loan", value: currentDebt - previousDebt });
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

  function calculatePaymentForTargetDate(loan, targetDateStr, options = {}) {
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
