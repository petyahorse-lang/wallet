/* Кошелёк BYN — помощник.
   Вкладка чата: вопросы по своим деньгам, советы и запись операций голосом
   обычной фразой. Отдельный файл, чтобы index.html не рос: расчёты остаются
   в engine.js, интерфейс и синхронизация в index.html, здесь только чат.

   Ключ модели сюда не попадает и попасть не может. Приложение обращается к
   своей Edge Function ai в Supabase, она проверяет вход и уже сама ходит в
   модель со своим секретом. Без входа в аккаунт помощник не работает,
   и это правильно: платит за обращения владелец проекта.

   Снимок финансов считается здесь же, через FIN, теми же функциями, что
   рисуют экраны. Второй реализации правил нет нигде, поэтому помощник видит
   ровно те цифры, которые человек видит на вкладках, включая операции,
   которые ещё не уехали в базу. */
(function (root) {
  "use strict";

  var FN = "ai";                       // имя Edge Function в Supabase
  var LS_CHAT = "wallet.byn.chat";
  var KEEP_LOG = 60;                   // реплик на экране и в памяти устройства
  var KEEP_MSGS = 20;                  // сколько уходит в модель
  var RECENT = 40;                     // операций в снимке
  var TOOL_ROUNDS = 3;                 // предохранитель от зацикливания инструментов

  var chat = { log: [], msgs: [], busy: false, err: "" };
  var loaded = false;

  /* ---------- память устройства ----------
     Переписка не синхронизируется между телефоном и компьютером и в базу не
     уходит: это заметки на полях, а не данные кошелька. Пропадёт, и ничего
     не потеряется. */
  function loadChat() {
    if (loaded) return;
    loaded = true;
    try {
      var raw = localStorage.getItem(LS_CHAT);
      if (!raw) return;
      var d = JSON.parse(raw);
      if (d && Array.isArray(d.log) && Array.isArray(d.msgs)) {
        chat.log = d.log; chat.msgs = trimMsgs(d.msgs);
      }
    } catch (e) {}
  }
  function saveChat() {
    try {
      localStorage.setItem(LS_CHAT, JSON.stringify({
        log: chat.log.slice(-KEEP_LOG), msgs: trimMsgs(chat.msgs)
      }));
    } catch (e) {}
  }
  /* Обрезка переписки по правилу протокола: ответ инструмента обязан идти
     сразу за вызовом инструмента. Режем не по счётчику, а до ближайшей
     обычной реплики человека, иначе модель получит оборванную пару и
     откажется отвечать. */
  function trimMsgs(msgs) {
    var out = (msgs || []).slice(-KEEP_MSGS);
    while (out.length && !(out[0].role === "user" && typeof out[0].content === "string")) out.shift();
    return out;
  }

  /* ---------- снимок финансов ---------- */
  function r2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
  function dayStart(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); }
  function catName(id, income) {
    var list = income ? state.config.incomeCats : state.config.categories;
    var c = list.filter(function (x) { return x.id === id; })[0];
    return c ? c.name : (id || "");
  }
  function statBlock(all, from) {
    var s = FIN.periodStats(all, from, state.config);
    var by = Object.keys(s.byCat).map(function (id) {
      return { category: id === "__debt" ? "возврат долгов" : catName(id, false), amount: s.byCat[id] };
    }).sort(function (a, b) { return b.amount - a.amount; });
    return { income: s.income, expense: s.expense, diff: s.diff, operations: s.count, by_category: by };
  }

  function snapshot() {
    var cfg = state.config, all = ops(), good = validOps(), now = new Date();
    var monthFrom = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    var weekFrom = dayStart(new Date(now.getTime() - ((now.getDay() + 6) % 7) * 864e5));

    var months = {};
    good.forEach(function (o) {
      var k = monthKey(o.ts), a = Math.abs(Number(o.amount) || 0);
      if (!months[k]) months[k] = { month: k, income: 0, expense: 0 };
      if (o.type === "income") months[k].income = r2(months[k].income + a);
      else if (o.type === "expense" || o.type === "repay") months[k].expense = r2(months[k].expense + a);
    });

    return {
      today: now.toISOString().slice(0, 10),
      weekday: now.toLocaleDateString("ru-RU", { weekday: "long" }),
      currency: CUR,
      total_balance: FIN.totalBalance(cfg, all),
      accounts: cfg.accounts.map(function (a) {
        return { id: a.id, name: a.name, balance: FIN.accountBalance(cfg, all, a.id) };
      }),
      expense_categories: cfg.categories.map(function (c) { return { id: c.id, name: c.name }; }),
      income_categories: cfg.incomeCats.map(function (c) { return { id: c.id, name: c.name }; }),
      people: cfg.people.slice(),
      /* Две стороны долга держатся раздельно: i_owe это сколько должен
         человек я, owed_to_me сколько должны мне. Складывать их нельзя. */
      total_debt: FIN.totalDebt(cfg, all),
      total_owed_to_me: FIN.totalClaims(cfg, all),
      i_owe: FIN.debtBreakdown(cfg, all)
        .filter(function (d) { return d.amount !== 0; })
        .map(function (d) { return { person: d.person, amount: d.amount }; }),
      owed_to_me: FIN.claimBreakdown(cfg, all)
        .filter(function (d) { return d.amount !== 0; })
        .map(function (d) { return { person: d.person, amount: d.amount }; }),
      limits: cfg.categories.filter(function (c) { return Number(cfg.limits[c.id]) > 0; })
        .map(function (c) {
          return {
            category_id: c.id, name: c.name, limit: Number(cfg.limits[c.id]),
            spent_this_month: FIN.spentInCategory(all, c.id, monthFrom, cfg)
          };
        }),
      stats: {
        today: statBlock(all, dayStart(now)),
        this_week: statBlock(all, weekFrom),
        this_month: statBlock(all, monthFrom)
      },
      months: Object.keys(months).sort().slice(-12).map(function (k) { return months[k]; }),
      recent_operations: good.slice(0, RECENT).map(function (o) {
        var d = new Date(o.ts);
        return {
          date: d.toISOString().slice(0, 10),
          time: String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0"),
          type: o.type,
          amount: Math.abs(Number(o.amount) || 0),
          account: FIN.nameOfAccount(state.config, o.account) || undefined,
          to_account: o.toAccount ? FIN.nameOfAccount(state.config, o.toAccount) : undefined,
          category: o.category ? catName(o.category, o.type === "income") : undefined,
          person: o.person || undefined,
          note: o.note || undefined
        };
      }),
      total_operations: good.length
    };
  }

  /* ---------- инструмент: запись операции ----------
     Модель ничего не пишет в базу сама. Она предлагает операцию, а проверяет
     и записывает её тот же код, что и форма на экране: FIN.validateOp и
     addOp. Поэтому через помощника нельзя создать запись, которую нельзя
     создать руками, и правила остаются в одном месте. */
  function findId(list, v) {
    if (v == null || v === "") return "";
    var s = String(v).trim().toLowerCase();
    var byId = list.filter(function (x) { return String(x.id).toLowerCase() === s; })[0];
    if (byId) return byId.id;
    var byName = list.filter(function (x) { return String(x.name).toLowerCase() === s; })[0];
    return byName ? byName.id : "";
  }
  function tsOf(v) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v == null ? "" : v).trim());
    if (m) {
      var n = new Date();
      var d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), n.getHours(), n.getMinutes());
      if (isFinite(d.getTime())) return d.toISOString();
    }
    return new Date().toISOString();
  }
  function matchPerson(v) {
    var s = String(v == null ? "" : v).trim();
    if (!s) return "";
    var hit = state.config.people.filter(function (p) { return p.toLowerCase() === s.toLowerCase(); })[0];
    return hit || s;
  }

  function addOperation(inp) {
    var cfg = state.config;
    var type = String(inp.type || "").trim();
    if (FIN.TYPES.indexOf(type) < 0) return { out: { ok: false, error: "неизвестный тип операции" } };

    var amt = parseAmt(String(inp.amount == null ? "" : inp.amount));
    if (!isFinite(amt)) return { out: { ok: false, error: "сумма должна быть положительным числом, не меньше 0,01 и не точнее копейки" } };

    var cand = {
      id: uid(),
      ts: tsOf(inp.date),
      type: type,
      amount: amt,
      account: findId(cfg.accounts, inp.account),
      toAccount: findId(cfg.accounts, inp.to_account),
      category: findId(type === "income" ? cfg.incomeCats : cfg.categories, inp.category),
      person: matchPerson(inp.person),
      note: String(inp.note == null ? "" : inp.note).trim().slice(0, 120)
    };
    /* Категория обязательна только для дохода и расхода: у перевода и долга
       её нет вовсе, у погашения она служебная. Если модель категорию не
       назвала, подставляем первую, но только когда выбор очевиден. */
    if ((type === "income" || type === "expense") && !cand.category) {
      var list = type === "income" ? cfg.incomeCats : cfg.categories;
      if (list.length === 1) cand.category = list[0].id;
      else return { out: { ok: false, error: "не указана категория, спроси у человека какую взять" } };
    }
    if (type === "repay") cand.category = "debt";
    /* Счёт нужен всем типам, кроме ничего не значащих исключений: у перевода
       он же счёт списания, у всех четырёх долговых операций это счёт, куда
       деньги пришли или откуда ушли. */
    if (!cand.account) {
      if (cfg.accounts.length === 1) cand.account = cfg.accounts[0].id;
      else return { out: { ok: false, error: "не указан счёт, спроси у человека с какого счёта" } };
    }

    var v = FIN.validateOp(cand, cfg, ops());
    if (!v.ok) return { out: { ok: false, error: v.error } };

    addOp(cand);
    var m = opMeta(cand);
    return {
      note: "Записано: " + m.title + " · " + m.amt + " " + CUR,
      out: { ok: true, saved: true, id: cand.id, type: type, amount: amt, date: cand.ts.slice(0, 10) }
    };
  }

  function runTool(name, input) {
    if (name === "add_operation") return addOperation(input || {});
    return { out: { ok: false, error: "инструмент " + name + " не поддерживается" } };
  }

  /* ---------- обращение к функции ---------- */
  async function callFn() {
    var client = (typeof SUPA !== "undefined" && SUPA) ? SUPA : await supaClient();
    if (!client) throw new Error("нет связи с базой");
    var r = await client.functions.invoke(FN, {
      body: { messages: trimMsgs(chat.msgs), wallet: snapshot() }
    });
    if (r.error) throw new Error(await errorText(r.error));
    if (r.data && r.data.error) throw new Error(String(r.data.error));
    if (!r.data || !Array.isArray(r.data.content)) throw new Error("пустой ответ помощника");
    return r.data;
  }
  /* У ошибки функции текст лежит в теле ответа, а не в message: без этого
     на экране было бы бесполезное Edge Function returned a non-2xx status. */
  async function errorText(err) {
    var ctx = err && err.context;
    try {
      if (ctx && (typeof ctx.json === "function" || typeof ctx.clone === "function")) {
        /* Тело ответа читается один раз, поэтому если копия доступна, берём
           её. Полагаться на наличие обоих методов нельзя: форма объекта
           ошибки менялась от версии к версии библиотеки. */
        var src = typeof ctx.clone === "function" ? ctx.clone() : ctx;
        var body = await src.json();
        if (body && body.error) return String(body.error);
      }
    } catch (e) {}
    if (ctx && ctx.status === 404) return "функция ai ещё не развёрнута в Supabase";
    return (err && err.message) ? err.message : "помощник не ответил";
  }

  async function turn() {
    for (var round = 0; round < TOOL_ROUNDS; round++) {
      var data = await callFn();
      var blocks = data.content || [];

      var text = blocks.filter(function (b) { return b.type === "text"; })
        .map(function (b) { return b.text; }).join("\n").trim();
      if (text) chat.log.push({ who: "ai", text: text });
      chat.msgs.push({ role: "assistant", content: blocks });

      var calls = blocks.filter(function (b) { return b.type === "tool_use"; });
      if (!calls.length) return;

      var results = calls.map(function (c) {
        var res = runTool(c.name, c.input);
        if (res.note) chat.log.push({ who: "sys", text: res.note });
        return {
          type: "tool_result",
          tool_use_id: c.id,
          content: JSON.stringify(res.out),
          is_error: !res.out.ok
        };
      });
      chat.msgs.push({ role: "user", content: results });
      saveChat(); paintLog();
    }
    chat.log.push({ who: "sys", text: "Помощник слишком долго возился с записью, остановил." });
  }

  async function send(text) {
    text = String(text == null ? "" : text).trim();
    if (!text || chat.busy) return;
    if (text.length > 2000) text = text.slice(0, 2000);

    chat.log.push({ who: "me", text: text });
    chat.msgs.push({ role: "user", content: text });
    chat.busy = true; chat.err = "";
    saveChat(); paintLog();

    try {
      await turn();
    } catch (e) {
      /* Незавершённая пара вызов и ответ сломает следующий запрос, поэтому
         откатываем переписку до последней целой реплики человека. */
      while (chat.msgs.length && chat.msgs[chat.msgs.length - 1].role === "assistant") chat.msgs.pop();
      chat.log.push({ who: "sys", text: "Не получилось: " + (e && e.message ? e.message : "неизвестная ошибка") });
    }
    chat.busy = false;
    saveChat(); paintLog();
  }

  /* ---------- экран ---------- */
  var ASKS = [
    "Сколько я потратил в этом месяце",
    "На что уходит больше всего денег",
    "Запиши 12,50 на еду с карты",
    "Кто мне должен и сколько"
  ];

  function bubbles() {
    if (!chat.log.length) {
      return '<div class="chatHello">' +
        '<div class="chatHi">Спроси про свои деньги</div>' +
        '<div class="hint">Помощник видит счета, долги, лимиты и свежие операции. Может и записать трату: просто скажи словами, сколько и на что.</div>' +
        '<div class="chips" style="margin-top:12px">' +
        ASKS.map(function (a) { return '<button class="chip" data-ask="' + esc(a) + '">' + esc(a) + '</button>'; }).join("") +
        '</div></div>';
    }
    var h = chat.log.slice(-KEEP_LOG).map(function (m) {
      var cls = m.who === "me" ? "me" : (m.who === "sys" ? "sys" : "ai");
      return '<div class="msg ' + cls + '">' + esc(m.text) + '</div>';
    }).join("");
    if (chat.busy) h += '<div class="msg ai typing"><i></i><i></i><i></i></div>';
    return h;
  }

  function paintLog() {
    var log = document.getElementById("chatLog");
    if (!log) return;
    log.innerHTML = bubbles();
    var btn = document.getElementById("chatSend");
    if (btn) btn.disabled = chat.busy;
    var box = document.querySelector("main");
    if (box) box.scrollTop = box.scrollHeight;
  }

  function renderChat() {
    loadChat();
    /* Перерисовка приходит из синхронизации раз в пятнадцать секунд. Если
       собирать экран заново, у человека пропадёт набранный текст и слетит
       курсор, поэтому пересобираем только ленту. */
    if (document.getElementById("chatBox")) { paintLog(); return; }

    if (!supaConfigured()) {
      view.innerHTML = '<div class="card empty"><b>Помощник недоступен</b>' +
        'Приложение работает без базы, только на этом устройстве. Помощник обращается к своей функции в Supabase, для этого нужны ключи в config.js.</div>';
      return;
    }
    if (typeof SUPA_USER === "undefined" || !SUPA_USER) {
      view.innerHTML = '<div class="card" style="padding:16px">' +
        '<div style="font-family:var(--f-display); font-weight:700; font-size:17px">Нужен вход</div>' +
        '<div class="hint" style="margin:6px 0 12px">Помощник работает от твоего аккаунта: так он видит именно твои деньги, и никто чужой не тратит обращения к модели.</div>' +
        '<button class="btn" data-act="signIn">Войти</button></div>';
      return;
    }

    view.innerHTML =
      '<div class="chatBox" id="chatBox"><div class="chatLog" id="chatLog"></div></div>' +
      '<div class="chatBar">' +
        '<textarea class="chatIn" id="chatIn" rows="1" enterkeyhint="send" ' +
        'placeholder="Спроси или продиктуй операцию"></textarea>' +
        '<button class="chatSend" id="chatSend" aria-label="Отправить">↑</button>' +
      '</div>' +
      '<div class="chatFoot"><button class="linkBtn" id="chatClear">Очистить переписку</button>' +
      '<span class="hint">Переписка лежит только на этом устройстве</span></div>';

    paintLog();
    wire();
  }

  function wire() {
    var inp = document.getElementById("chatIn");
    var btn = document.getElementById("chatSend");
    var box = document.getElementById("chatBox");

    function grow() {
      inp.style.height = "auto";
      inp.style.height = Math.min(inp.scrollHeight, 120) + "px";
    }
    function go() {
      var t = inp.value;
      inp.value = ""; grow();
      send(t);
    }
    inp.addEventListener("input", grow);
    inp.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); go(); }
    });
    btn.addEventListener("click", go);

    box.addEventListener("click", function (e) {
      var a = e.target.closest("[data-ask]");
      if (a) send(a.dataset.ask);
    });
    document.getElementById("chatClear").addEventListener("click", function () {
      chat.log = []; chat.msgs = []; saveChat(); paintLog();
      toast("Переписка очищена");
    });
  }

  root.renderChat = renderChat;
  root.walletSnapshot = snapshot;      // пригодится, если захочешь посмотреть, что видит помощник
})(typeof window !== "undefined" ? window : globalThis);
