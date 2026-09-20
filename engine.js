/* Кошелёк BYN — расчётное ядро.
   Чистые функции без DOM: балансы, долги, статистика, экспорт, валидация.

   Два уровня защиты:
   1. validateOp не даёт создать некорректную операцию и объясняет причину.
   2. effects и debtEffect считают некорректную запись инертной: если она
      всё же попала в базу (старая копия, чужая правка файла), она не двигает
      ни балансы, ни долги, вместо того чтобы тихо их искажать. */
(function (root) {
  "use strict";

  var TYPES = ["income", "expense", "transfer", "debt", "repay"];
  var EPS = 0.005;
  var MIN = 0.01;                                  // копейка, минимальная сумма операции

  function r2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
  /* Сумма операции. Ничего не чинит и не округляет: либо сумма корректна и
     возвращается как есть, либо операция инертна и возвращается 0.
     Корректная — это конечное число не меньше копейки и ровно с двумя
     знаками после запятой. Округлять 0.014 до 0.01 нельзя: из битой записи
     получилась бы сумма, которой никто не вводил. Знак задаёт тип операции,
     а не сумма, поэтому модуль тоже не берём. */
  function amountOf(op) {
    var a = Number(op && op.amount);
    if (!isFinite(a) || a < MIN) return 0;
    return r2(a) === a ? a : 0;
  }

  /* Момент операции в миллисекундах или NaN, если ts отсутствует или битый. */
  function tsMs(op) {
    if (!op) return NaN;
    var t = op.ts;
    if (typeof t === "number") return isFinite(t) ? t : NaN;
    if (typeof t !== "string" || !t) return NaN;
    var v = Date.parse(t);
    return isFinite(v) ? v : NaN;
  }

  function accountIds(config) {
    var set = Object.create(null);
    ((config && config.accounts) || []).forEach(function (a) { set[a.id] = true; });
    return set;
  }
  function known(ids, id) { return !ids || (!!id && ids[id] === true); }

  /* Денежные эффекты операции: [{account, delta}].
     ids — набор существующих счетов; без него проверка счетов не делается.
     Долг (debt) денег не трогает. Погашение (repay) списывает один раз. */
  function effects(op, ids) {
    if (!op) return [];
    var a = amountOf(op);
    if (!(a > 0)) return [];                       // ноль и отрицательное инертны
    switch (op.type) {
      case "income":
        return known(ids, op.account) ? [{ account: op.account, delta: a }] : [];
      case "expense":
      case "repay":
        return known(ids, op.account) ? [{ account: op.account, delta: -a }] : [];
      case "transfer":
        if (op.account === op.toAccount) return [];
        if (!known(ids, op.account) || !known(ids, op.toAccount)) return [];
        return [{ account: op.account, delta: -a }, { account: op.toAccount, delta: a }];
      default:
        return [];
    }
  }

  /* Эффект операции на долг перед человеком: + взял в долг, − отдал. */
  function debtEffect(op) {
    if (!op || !op.person) return 0;
    var a = amountOf(op);
    if (!(a > 0)) return 0;
    if (op.type === "debt") return a;
    if (op.type === "repay") return -a;
    return 0;
  }

  function dedupe(items) {
    var seen = Object.create(null), out = [];
    (items || []).forEach(function (o) {
      if (!o || !o.id || seen[o.id]) return;
      seen[o.id] = 1; out.push(o);
    });
    return out;
  }

  function flatten(months) {
    var out = [];
    Object.keys(months || {}).forEach(function (k) {
      (months[k] || []).forEach(function (o) { out.push(o); });
    });
    return dedupe(out).sort(function (a, b) {
      return a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : (a.id < b.id ? 1 : -1);
    });
  }

  /* ЕДИНЫЙ фильтр нерабочих операций: попали в базу мимо validateOp
     (ручная правка JSON, повреждённая копия) и применить их нельзя.
     Один список на все производные: баланс, долги, статистика, экспорт.
     Разных правил между ними быть не должно, иначе цифры разойдутся.

     Погашения разбираются одним проходом по времени, поэтому важен
     порядок: долг сначала, погашения потом. Погашение сверх накопленного
     долга отбрасывается целиком, а не зачитывается частично — иначе из
     повреждённой записи получилась бы операция, которой не делали.

     Без config проверка существования счетов не выполняется: вызывающий
     сам решает, есть ли у него справочник счетов. */
  function rejectedIds(ops, config) {
    var ids = config ? accountIds(config) : null;
    var owed = Object.create(null), bad = Object.create(null);
    (ops || []).slice().sort(function (a, b) {
      var x = tsMs(a), y = tsMs(b);                // битые даты уходят в конец
      if (!isFinite(x)) x = Infinity;
      if (!isFinite(y)) y = Infinity;
      return x !== y ? x - y : (a.id < b.id ? -1 : 1);
    }).forEach(function (op) {
      if (!op || !op.id) return;
      if (TYPES.indexOf(op.type) < 0) { bad[op.id] = true; return; }
      if (!isFinite(tsMs(op))) { bad[op.id] = true; return; }  // нет даты или она битая
      var a = amountOf(op);
      if (!(a > 0)) { bad[op.id] = true; return; }          // ноль, минус, мусор, лишние знаки

      if (op.type === "income" || op.type === "expense") {
        if (!known(ids, op.account)) bad[op.id] = true;
        return;
      }
      if (op.type === "transfer") {
        if (op.account === op.toAccount) { bad[op.id] = true; return; }
        if (!known(ids, op.account) || !known(ids, op.toAccount)) bad[op.id] = true;
        return;
      }
      if (op.type === "debt") {
        if (!op.person) { bad[op.id] = true; return; }
        owed[op.person] = r2((owed[op.person] || 0) + a);
        return;
      }
      /* repay */
      if (!op.person || !known(ids, op.account)) { bad[op.id] = true; return; }
      var left = r2(owed[op.person] || 0);
      if (left <= EPS || a > left + EPS) { bad[op.id] = true; return; }
      owed[op.person] = r2(left - a);
    });
    return bad;
  }

  function accountBalance(config, ops, accId) {
    var ids = accountIds(config);
    var bad = rejectedIds(ops, config);
    var acc = ((config && config.accounts) || []).filter(function (a) { return a.id === accId; })[0];
    var v = acc ? Number(acc.start) || 0 : 0;
    (ops || []).forEach(function (op) {
      if (bad[op.id]) return;
      effects(op, ids).forEach(function (e) { if (e.account === accId) v += e.delta; });
    });
    return r2(v);
  }

  function totalBalance(config, ops) {
    return r2(((config && config.accounts) || []).reduce(function (s, a) {
      return s + accountBalance(config, ops, a.id);
    }, 0));
  }

  /* Долг перед человеком. exceptId исключает одну операцию — нужно при
     правке, чтобы операция не проверялась сама против себя. */
  function debtFor(ops, person, exceptId, config) {
    var bad = rejectedIds(ops, config);
    var v = 0;
    (ops || []).forEach(function (op) {
      if (op.person !== person) return;
      if (exceptId && op.id === exceptId) return;
      if (bad[op.id]) return;
      v += debtEffect(op);
    });
    return r2(v);
  }

  function totalDebt(config, ops) {
    return r2(((config && config.people) || []).reduce(function (s, p) {
      return s + Math.max(0, debtFor(ops, p, null, config));
    }, 0));
  }

  /* Незакрытые долги по всем людям, включая тех, кого убрали из списка. */
  function debtBreakdown(config, ops) {
    var names = {};
    (((config && config.people) || [])).forEach(function (p) { names[p] = true; });
    (ops || []).forEach(function (o) { if (o.person) names[o.person] = true; });
    return Object.keys(names).map(function (p) {
      return { person: p, amount: debtFor(ops, p, null, config), listed: ((config && config.people) || []).indexOf(p) >= 0 };
    }).sort(function (a, b) { return b.amount - a.amount; });
  }

  /* ---------- валидация ---------- */
  function plain(n) {
    var s = r2(n).toFixed(2).replace(".", ",");
    return s.replace(/,00$/, "");
  }
  function bad(msg) { return { ok: false, error: msg }; }

  /* op — кандидат на запись (с id, если это правка существующей).
     ops — текущий список операций. Возвращает {ok:true} или {ok:false,error}. */
  function validateOp(op, config, ops) {
    if (!op || TYPES.indexOf(op.type) < 0) return bad("Неизвестный тип операции");
    var a = Number(op.amount);
    if (!isFinite(a)) return bad("Сумма не похожа на число");
    if (a <= 0) return bad("Сумма должна быть больше нуля");
    if (a < MIN) return bad("Минимальная сумма операции: 0,01 BYN");
    /* Сумма должна записаться ровно такой, какой её проверили: если
       округление до копейки её меняет, операция не проходит. */
    if (r2(a) !== a) return bad("Сумма указывается с точностью до копейки");
    var ids = accountIds(config);

    if (op.type === "income" || op.type === "expense" || op.type === "repay") {
      if (!known(ids, op.account)) return bad("Выбери существующий счёт");
    }
    if (op.type === "transfer") {
      if (!known(ids, op.account)) return bad("Счёт списания не существует");
      if (!known(ids, op.toAccount)) return bad("Счёт зачисления не существует");
      if (op.account === op.toAccount) return bad("Счета перевода должны быть разными");
    }
    if (op.type === "debt" || op.type === "repay") {
      if (!op.person) return bad("Выбери человека");
    }
    if (op.type === "repay") {
      var owed = debtFor(ops, op.person, op.id, config);
      if (owed <= EPS) return bad("Этому человеку ты ничего не должен");
      if (r2(a) > r2(owed) + EPS) return bad("Нельзя погасить больше, чем текущий долг: " + plain(owed) + " BYN");
    }
    return { ok: true };
  }

  function periodStats(ops, fromTs, config) {
    var bad = rejectedIds(ops, config);
    var inc = 0, exp = 0, count = 0, byCat = {};
    (ops || []).forEach(function (op) {
      if (bad[op.id]) return;
      if (new Date(op.ts).getTime() < fromTs) return;
      var a = amountOf(op);
      if (!(a > 0)) return;
      count++;
      if (op.type === "income") inc += a;
      else if (op.type === "expense") { exp += a; byCat[op.category || "other"] = r2((byCat[op.category || "other"] || 0) + a); }
      else if (op.type === "repay") { exp += a; byCat.__debt = r2((byCat.__debt || 0) + a); }
    });
    return { income: r2(inc), expense: r2(exp), diff: r2(inc - exp), count: count, byCat: byCat };
  }

  /* Только обычные расходы: погашения долгов в лимиты категорий не входят. */
  function spentInCategory(ops, catId, fromTs, config) {
    var bad = rejectedIds(ops, config);
    var v = 0;
    (ops || []).forEach(function (op) {
      if (bad[op.id]) return;
      if (op.type !== "expense" || op.category !== catId) return;
      if (new Date(op.ts).getTime() < fromTs) return;
      v += amountOf(op);
    });
    return r2(v);
  }

  /* ---------- экспорт ---------- */
  function pad(n) { return String(n).padStart(2, "0"); }
  function dateOf(ts) { var d = new Date(ts); return pad(d.getDate()) + "." + pad(d.getMonth() + 1) + "." + d.getFullYear(); }
  function timeOf(ts) { var d = new Date(ts); return pad(d.getHours()) + ":" + pad(d.getMinutes()); }
  function safe(s) { return String(s == null ? "" : s).replace(/[;\r\n]/g, " ").trim(); }

  function nameOfAccount(config, id) {
    var a = ((config && config.accounts) || []).filter(function (x) { return x.id === id; })[0];
    return a ? a.name : (id || "");
  }
  function nameOfCategory(config, id, isIncome) {
    var list = isIncome ? ((config && config.incomeCats) || []) : ((config && config.categories) || []);
    var c = list.filter(function (x) { return x.id === id; })[0];
    return c ? c.name : (id || "");
  }

  var FIN_HEAD = "id;дата;время;тип;категория;человек;комментарий;счёт;сумма";
  function csvFinance(config, ops) {
    var bad = rejectedIds(ops, config);
    var rows = [FIN_HEAD];
    (ops || []).slice().reverse().forEach(function (o) {
      if (bad[o.id]) return;                       // нерабочая запись не выгружается
      var a = amountOf(o), d = dateOf(o.ts), t = timeOf(o.ts), n = safe(o.note);
      if (!(a > 0)) return;
      if (o.type === "transfer") {
        rows.push([o.id, d, t, "Перевод", "Перевод", "", n, nameOfAccount(config, o.account), (-a).toFixed(2)].join(";"));
        rows.push([o.id, d, t, "Перевод", "Перевод", "", n, nameOfAccount(config, o.toAccount), a.toFixed(2)].join(";"));
      } else if (o.type === "income") {
        rows.push([o.id, d, t, "Доход", nameOfCategory(config, o.category, true), "", n, nameOfAccount(config, o.account), a.toFixed(2)].join(";"));
      } else if (o.type === "expense") {
        rows.push([o.id, d, t, "Расход", nameOfCategory(config, o.category, false), "", n, nameOfAccount(config, o.account), (-a).toFixed(2)].join(";"));
      } else if (o.type === "repay") {
        rows.push([o.id, d, t, "Погашение", "Долги", safe(o.person), n, nameOfAccount(config, o.account), (-a).toFixed(2)].join(";"));
      } else if (o.type === "debt") {
        rows.push([o.id, d, t, "Долг", "", safe(o.person), n, "", a.toFixed(2)].join(";"));
      }
    });
    return rows.join("\n");
  }

  function csvDebts(ops, config) {
    var bad = rejectedIds(ops, config);
    var rows = ["id;дата;время;тип;комментарий;человек;сумма"];
    (ops || []).slice().reverse().forEach(function (o) {
      if (bad[o.id]) return;
      if (o.type !== "debt" && o.type !== "repay") return;
      var a = amountOf(o);
      if (!(a > 0)) return;
      rows.push([o.id, dateOf(o.ts), timeOf(o.ts), o.type === "debt" ? "Долг" : "Погашение",
        safe(o.note), safe(o.person), (o.type === "debt" ? a : -a).toFixed(2)].join(";"));
    });
    return rows.join("\n");
  }

  /* Полная резервная копия: восстанавливает систему целиком. */
  function backup(config, months) {
    return JSON.stringify({
      app: "wallet-byn", version: 1, exportedAt: new Date().toISOString(),
      currency: "BYN", config: config, months: months
    }, null, 1);
  }

  function restore(text) {
    var d = JSON.parse(text);
    if (!d || d.app !== "wallet-byn" || !d.config || !d.months) throw new Error("Не похоже на копию Кошелька");
    var months = {};
    Object.keys(d.months).forEach(function (k) {
      months[k] = dedupe(d.months[k]).filter(function (o) { return o && o.id && o.ts && TYPES.indexOf(o.type) >= 0; });
    });
    return { config: d.config, months: months };
  }

  var FIN = {
    TYPES: TYPES, EPS: EPS, MIN: MIN, r2: r2, amountOf: amountOf, tsMs: tsMs, accountIds: accountIds,
    effects: effects, debtEffect: debtEffect, rejectedIds: rejectedIds, dedupe: dedupe, flatten: flatten,
    accountBalance: accountBalance, totalBalance: totalBalance,
    debtFor: debtFor, totalDebt: totalDebt, debtBreakdown: debtBreakdown,
    validateOp: validateOp, periodStats: periodStats, spentInCategory: spentInCategory,
    nameOfAccount: nameOfAccount, nameOfCategory: nameOfCategory,
    csvFinance: csvFinance, csvDebts: csvDebts, backup: backup, restore: restore
  };

  if (typeof module !== "undefined" && module.exports) module.exports = FIN;
  root.FIN = FIN;
})(typeof window !== "undefined" ? window : globalThis);
