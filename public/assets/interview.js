/* SERE Moto — the booking interview: the app asks where the passenger is, one question at a time.
   Intara yawe? → Akarere kawe? → Umurenge wawe? → Akagari kawe? → Umudugudu wawe? — every answer opens
   the next question with that one's children, so a phone only ever downloads the list it is looking at.

   A five-level dropdown asks somebody standing on the roadside to understand the Rwandan administrative
   ladder before they can book a ride. A question does not. One decision per screen, a radio row per place
   (the circle shows which answer is picked; the whole row is tappable), a Back link, and "Komeza" on the
   last two levels for the passenger who cannot name their village — the search ranks riders at any level,
   so a sector answer is a complete answer.

   Vanilla ES5, no dependencies. Rows come from SERE_DIVISIONS.list() and the host page pushes its
   language in through setLang, the same way it does for the dropdown library. */
(function () {
  'use strict';

  var I18N = {
    rw: {
      'ask.province': 'Intara yawe?',
      'ask.district': 'Akarere kawe?',
      'ask.sector': 'Umurenge wawe?',
      'ask.cell': 'Akagari kawe?',
      'ask.village': 'Umudugudu wawe?',
      'ask.back': 'Subira inyuma',
      'ask.continue': 'Komeza',
      'ask.change': 'Hindura',
      'ask.loading': 'Turimo…',
      'ask.empty': 'Nta ho hagaragara hano',
      'ask.failed': 'Ntibashije kubona aho u Rwanda ruri',
      'ask.retry': 'Ongera ugerageze'
    },
    en: {
      'ask.province': 'Your province?',
      'ask.district': 'Your district?',
      'ask.sector': 'Your sector?',
      'ask.cell': 'Your cell?',
      'ask.village': 'Your village?',
      'ask.back': 'Back',
      'ask.continue': 'Continue',
      'ask.change': 'Change',
      'ask.loading': 'Loading…',
      'ask.empty': 'Nothing to list here',
      'ask.failed': 'Could not load the Rwandan divisions',
      'ask.retry': 'Try again'
    }
  };

  var ORDER = ['province', 'district', 'sector', 'cell', 'village'];
  var ASK = {
    province: 'ask.province',
    district: 'ask.district',
    sector: 'ask.sector',
    cell: 'ask.cell',
    village: 'ask.village'
  };
  /* Cell and village are the two levels a passenger plausibly cannot name, so those steps offer
     "continue" instead of becoming a dead end on the way to a rider. */
  var SKIPPABLE = { cell: true, village: true };

  var stored = '';
  try { stored = localStorage.getItem('sere_lang') || ''; } catch (e) { /* private mode */ }
  var lang = stored === 'en' || document.documentElement.getAttribute('lang') === 'en' ? 'en' : 'rw';
  var mounted = [];
  var seq = 0;

  var t = function (key) {
    return (I18N[lang] && I18N[lang][key]) || I18N.en[key] || key;
  };

  var esc = function (value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };

  var node = function (tag, className, html) {
    var made = document.createElement(tag);
    if (className) made.className = className;
    if (html != null) made.innerHTML = html;
    return made;
  };

  function Ask(host, settings) {
    this.host = host;
    this.api = (settings && settings.api) || null;
    this.onChange = (settings && settings.onChange) || null;
    /* phrase(stage, pickedCodes) → {ask, note} | null. When the host supplies it, the question the
       passenger reads is worded by the model the server is talking to; the scripted label below it
       stays as the answer when that wording does not arrive. */
    this.phrase = (settings && settings.phrase) || null;
    this.onNote = (settings && settings.onNote) || null;
    this.wording = 0;
    this.answers = [null, null, null, null, null];
    this.stage = 0;
    this.locked = false;
    this.timer = null;
    this.id = 'ask' + (seq += 1);
    this.shell = node('div', 'ask');
    this.shell.setAttribute('data-testid', 'division-interview');
    host.innerHTML = '';
    host.appendChild(this.shell);
    this.render();
  }

  Ask.prototype.levelKey = function () {
    return ORDER[Math.min(this.stage, ORDER.length - 1)];
  };

  Ask.prototype.done = function () {
    return this.stage >= ORDER.length;
  };

  /* The deepest place the passenger actually named — a sector when the cell was skipped. */
  Ask.prototype.value = function () {
    for (var i = this.answers.length - 1; i >= 0; i -= 1) {
      if (this.answers[i]) return this.answers[i];
    }
    return null;
  };

  /* Every place named so far, shallowest first — what the assistant needs to ask about the next one. */
  Ask.prototype.codes = function () {
    var out = [];
    for (var i = 0; i < this.answers.length; i += 1) {
      if (this.answers[i]) out.push(this.answers[i].code);
    }
    return out;
  };

  Ask.prototype.render = function () {
    var self = this;
    var divisions = window.SERE_DIVISIONS;
    this.shell.innerHTML = '';
    if (!divisions) {
      this.shell.appendChild(node('p', 'ask-err', esc(t('ask.failed'))));
      return;
    }
    if (this.done()) {
      var picked = this.value();
      var done = node('div', 'ask-done');
      done.appendChild(node('p', 'ask-path', '<b>' + esc(picked ? (picked.label || picked.name) : '') + '</b>'));
      var edit = node('button', 'ask-edit', esc(t('ask.change')));
      edit.type = 'button';
      edit.onclick = function () { self.go(0); };
      done.appendChild(edit);
      this.shell.appendChild(done);
      return;
    }

    var qid = this.id + '-q';
    var head = node('div', 'ask-head');
    var q = node('p', 'ask-q');
    q.id = qid;
    q.textContent = t(ASK[this.levelKey()]);
    head.appendChild(q);
    head.appendChild(node('span', 'ask-n', (this.stage + 1) + '/' + ORDER.length));
    this.shell.appendChild(head);
    this.word(q);

    var box = node('div', 'ask-opts');
    box.setAttribute('role', 'radiogroup');
    box.setAttribute('aria-labelledby', qid);
    this.shell.appendChild(box);
    this.paint(box, null);

    if (this.stage > 0) {
      var back = node('button', 'ask-back', '‹ ' + esc(t('ask.back')));
      back.type = 'button';
      back.onclick = function () { self.go(self.stage - 1); };
      this.shell.appendChild(back);
    }
    this.load(box);
  };

  /* The scripted label is already on screen, so the model's wording only ever replaces it — a slow,
     failed or unconfigured answer leaves the question the app knows how to ask by itself. */
  Ask.prototype.word = function (q) {
    var self = this;
    if (!this.phrase) return;
    var stage = this.stage;
    var token = (this.wording += 1);
    var picked = [];
    for (var i = 0; i < this.answers.length; i += 1) {
      if (this.answers[i]) picked.push(this.answers[i].code);
    }
    Promise.resolve(this.phrase(this.levelKey(), picked)).then(function (wording) {
      if (token !== self.wording || self.stage !== stage || !wording) return;
      if (wording.ask) q.textContent = wording.ask;
      if (wording.note && self.onNote) self.onNote(wording.note);
    }).catch(function () { /* keep the scripted question */ });
  };

  Ask.prototype.load = function (box) {
    var self = this;
    var stage = this.stage;
    var above = stage > 0 ? this.answers[stage - 1] : null;
    var request = above
      ? window.SERE_DIVISIONS.list(above.code, '', this.api)
      : window.SERE_DIVISIONS.list('', this.levelKey(), this.api);
    Promise.resolve(request).then(function (rows) {
      if (self.stage === stage) self.paint(box, rows || []);
    }).catch(function () {
      if (self.stage !== stage) return;
      self.paint(box, null, true);
    });
  };

  /* rows === null means "not loaded yet"; failed is the third state the passenger has to get out of. */
  Ask.prototype.paint = function (box, rows, failed) {
    var self = this;
    var stage = this.stage;
    box.innerHTML = '';
    if (failed) {
      box.appendChild(node('p', 'ask-err', esc(t('ask.failed'))));
      var again = node('button', 'ask-act', esc(t('ask.retry')));
      again.type = 'button';
      again.onclick = function () { self.load(box); };
      box.appendChild(again);
      return;
    }
    if (rows === null) {
      box.appendChild(node('p', 'ask-load', esc(t('ask.loading'))));
      return;
    }
    if (!rows.length) box.appendChild(node('p', 'ask-err', esc(t('ask.empty'))));
    var chosen = this.answers[stage];
    for (var i = 0; i < rows.length; i += 1) {
      box.appendChild(this.place(rows[i], chosen && chosen.code === rows[i].code));
    }
    if (SKIPPABLE[ORDER[stage]] || !rows.length) {
      var next = node('button', 'ask-act', esc(t('ask.continue')));
      next.type = 'button';
      next.onclick = function () { self.go(ORDER.length); };
      box.appendChild(next);
    }
  };

  /* One row per place: a real radio input inside the label, so tapping anywhere on the row answers it. */
  Ask.prototype.place = function (row, pressed) {
    var self = this;
    var stage = this.stage;
    var label = node('label', 'ask-opt' + (pressed ? ' on' : ''));
    label.setAttribute('data-code', String(row.code));
    var dot = document.createElement('input');
    dot.type = 'radio';
    dot.className = 'ask-dot';
    dot.name = this.id + '-' + stage;
    dot.value = String(row.code);
    dot.checked = !!pressed;
    dot.onchange = function () { self.pick(stage, row); };
    label.appendChild(dot);
    label.appendChild(node('span', 'ask-name', esc(row.name)));
    return label;
  };

  /* Fill the circle the passenger picked and let them see it for a beat before the next question. */
  Ask.prototype.mark = function (code) {
    var rows = this.shell.querySelectorAll('.ask-opt');
    for (var i = 0; i < rows.length; i += 1) {
      var on = rows[i].getAttribute('data-code') === String(code);
      rows[i].className = 'ask-opt' + (on ? ' on' : '');
      var dot = rows[i].querySelector('input');
      if (dot) dot.checked = on;
    }
  };

  Ask.prototype.pick = function (stage, row) {
    var self = this;
    if (this.locked) return;
    this.locked = true;
    this.answers[stage] = {
      code: row.code,
      name: row.name,
      label: row.label || row.name,
      levelKey: ORDER[stage]
    };
    for (var deeper = stage + 1; deeper < ORDER.length; deeper += 1) this.answers[deeper] = null;
    this.mark(row.code);
    this.timer = setTimeout(function () {
      self.timer = null;
      self.go(stage + 1 >= ORDER.length ? ORDER.length : stage + 1);
    }, 220);
  };

  Ask.prototype.go = function (stage) {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.locked = false;
    this.stage = stage;
    this.render();
    if (this.onChange) this.onChange(this.value());
  };

  var setLang = function (next) {
    lang = next === 'en' ? 'en' : 'rw';
    mounted = mounted.filter(function (controller) {
      return document.body.contains(controller.host);
    });
    for (var i = 0; i < mounted.length; i += 1) mounted[i].render();
  };

  window.SERE_INTERVIEW = {
    levels: ORDER,
    /* mount(host, { api, onChange }) → the interview controller; value() is the deepest answer. */
    mount: function (host, options) {
      if (!host) return null;
      for (var i = mounted.length - 1; i >= 0; i -= 1) {
        if (mounted[i].host === host || !document.body.contains(mounted[i].host)) mounted.splice(i, 1);
      }
      var controller = new Ask(host, options || {});
      mounted.push(controller);
      return controller;
    },
    setLang: setLang,
    getLang: function () { return lang; },
    t: t
  };
}());
