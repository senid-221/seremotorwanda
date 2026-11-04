/* SERE Moto — Rwanda's five administrative levels as cascading dropdowns.
   Intara → Akarere → Umurenge → Akagari → Umudugudu, each one loaded from GET /api/locations only when
   the level above it has been chosen, so a phone never downloads 14,837 villages to pick a sector.
   Vanilla ES5, no dependencies. The level names come from the server (/api/locations/levels), so the
   Kinyarwanda and English halves of "Umurenge / Sector" are written down once, in src/locations.js.
   Used by public/index.html, public/rider.html and public/admin.html. */
(function () {
  'use strict';

  var I18N = {
    rw: {
      'dv.all': 'Zose',
      'dv.any': 'Nta n\'imwe',
      'dv.loading': 'Biracyategereza…',
      'dv.pickParent': 'Banza uhitemo {parent}',
      'dv.empty': 'Nta ho hagaragara hano',
      'dv.failed': 'Ntibashije kubona aho u Rwanda ruri',
      'dv.missing': 'Nta turere rubatswe kuri uyu mudasobwa'
    },
    en: {
      'dv.all': 'All',
      'dv.any': 'None',
      'dv.loading': 'Loading…',
      'dv.pickParent': 'Choose {parent} first',
      'dv.empty': 'Nothing to list here',
      'dv.failed': 'Could not load the Rwandan divisions',
      'dv.missing': 'No divisions are loaded on this server'
    }
  };

  var ORDER = ['province', 'district', 'sector', 'cell', 'village'];
  var FALLBACK = {
    province: { rw: 'Intara', en: 'Province' },
    district: { rw: 'Akarere', en: 'District' },
    sector: { rw: 'Umurenge', en: 'Sector' },
    cell: { rw: 'Akagari', en: 'Cell' },
    village: { rw: 'Umudugudu', en: 'Village' }
  };

  var stored = '';
  try { stored = localStorage.getItem('sere_lang') || ''; } catch (e) { /* private mode */ }
  var lang = stored === 'en' || document.documentElement.getAttribute('lang') === 'en' ? 'en' : 'rw';
  var names = null;
  var mounted = [];
  var uid = 0;

  var t = function (key, vars) {
    var text = (I18N[lang] && I18N[lang][key]) || (I18N.en[key]) || key;
    for (var name in vars) if (Object.prototype.hasOwnProperty.call(vars, name)) {
      text = text.replace('{' + name + '}', vars[name]);
    }
    return text;
  };

  var reason = function (error) {
    return error && error.code === 'divisions_unavailable' ? t('dv.missing') : t('dv.failed');
  };

  /* The host page owns the language switch. The shared pages tell us through SERE.onLang; index.html
     has its own toggle and calls SERE_DIVISIONS.setLang when it changes the rest of the copy. */
  var onPageLang = function (handler) {
    if (!window.SERE || typeof window.SERE.onLang !== 'function') return false;
    window.SERE.onLang(function () { handler(window.SERE.getLang()); });
    return true;
  };

  var LEVEL_STYLE = ''
    + '.dv-grid{display:grid;gap:8px;grid-template-columns:repeat(auto-fit,minmax(140px,1fr))}'
    + '.dv-f{display:flex;flex-direction:column;gap:4px;min-width:0}'
    + '.dv-f>label{font-size:11px;font-weight:700;letter-spacing:.3px;text-transform:uppercase;color:var(--ink-soft,#475569)}'
    + '.dv-f>select{width:100%;min-width:0;font-size:16px;padding:9px 10px;border:1px solid var(--line,#cbd5e1);'
    + 'border-radius:var(--r-s,11px);background:var(--card,#fff);color:var(--ink,#171717)}'
    + '.dv-f>select:disabled{opacity:.55}'
    + '.dv-note{font-size:12px;color:var(--ink-soft,#475569);margin:6px 0 0}';

  var ensureStyle = function () {
    if (document.getElementById('sere-division-style')) return;
    var style = document.createElement('style');
    style.id = 'sere-division-style';
    style.textContent = LEVEL_STYLE;
    document.head.appendChild(style);
  };

  var getJson = function (path) {
    return fetch(path, { headers: { Accept: 'application/json' } }).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (body) {
        if (!response.ok) {
          var error = new Error((body && body.message) || 'HTTP ' + response.status);
          error.code = body && body.error;
          throw error;
        }
        return body;
      });
    });
  };

  var levelName = function (key) {
    if (names && names[key]) return names[key][lang] || names[key].en || key;
    return (FALLBACK[key] && FALLBACK[key][lang]) || key;
  };

  /* One request for the whole country's five level names, shared by every mounted cascade. */
  var levelsRequest = null;
  var loadLevels = function (api) {
    if (names) return Promise.resolve(names);
    if (!levelsRequest) {
      levelsRequest = api('/api/locations/levels').then(function (body) {
        var found = {};
        for (var i = 0; i < body.levels.length; i += 1) {
          var level = body.levels[i];
          found[level.key] = { rw: level.rw, en: level.en };
        }
        names = found;
        levelsRequest = null;
        return found;
      }).catch(function () {
        levelsRequest = null;
        names = FALLBACK;
        return FALLBACK;
      });
    }
    return levelsRequest;
  };

  var option = function (value, text, selected) {
    var node = document.createElement('option');
    node.value = value;
    node.textContent = text;
    if (selected) node.selected = true;
    return node;
  };

  function Cascade(host, settings) {
    this.host = host;
    this.depth = Math.max(1, Math.min(ORDER.length, settings.depth || ORDER.length));
    this.api = settings.api || getJson;
    this.onChange = settings.onChange || null;
    this.anyLabel = settings.anyLabel !== false;
    this.id = 'dv' + (uid += 1);
    this.picked = [];
    this.items = [];
    this.selects = [];
    this.labels = [];
    this.busy = Promise.resolve();
    this.build();
  }

  Cascade.prototype.build = function () {
    ensureStyle();
    var self = this;
    this.host.innerHTML = '';
    var grid = document.createElement('div');
    grid.className = 'dv-grid';
    grid.setAttribute('data-testid', 'division-cascade');
    this.note = document.createElement('p');
    this.note.className = 'dv-note';
    this.note.hidden = true;
    for (var level = 0; level < this.depth; level += 1) {
      this.picked.push('');
      this.items.push([]);
      var field = document.createElement('div');
      field.className = 'dv-f';
      var label = document.createElement('label');
      label.htmlFor = this.id + '-' + level;
      var select = document.createElement('select');
      select.id = this.id + '-' + level;
      this.wire(select, level);
      field.appendChild(label);
      field.appendChild(select);
      grid.appendChild(field);
      this.selects.push(select);
      this.labels.push(label);
    }
    this.host.appendChild(grid);
    this.host.appendChild(this.note);
    /* A language switch mid-form must not drop what the user already chose. */
    if (!Cascade.watched) {
      Cascade.watched = true;
      onPageLang(function (next) { setLang(next); });
    }
    this.reload();
  };

  Cascade.prototype.wire = function (select, level) {
    var self = this;
    select.addEventListener('change', function () { self.choose(level, select.value); });
  };

  Cascade.prototype.message = function (text) {
    this.note.textContent = text || '';
    this.note.hidden = !text;
  };

  Cascade.prototype.reload = function () {
    var self = this;
    this.busy = this.busy.then(function () {
      return loadLevels(self.api).then(function () {
        self.paintLabels();
        return self.hydrateFrom(0);
      });
    }).catch(function (error) {
      self.message(reason(error));
    });
  };

  Cascade.prototype.paintLabels = function () {
    for (var level = 0; level < this.depth; level += 1) {
      var name = levelName(ORDER[level]);
      this.labels[level].textContent = name;
      this.selects[level].setAttribute('aria-label', name);
    }
  };

  /* The options for one level: everything under whatever was picked above it. */
  Cascade.prototype.hydrate = function (level) {
    var self = this;
    var select = this.selects[level];
    if (level > 0 && !this.picked[level - 1]) {
      select.innerHTML = '';
      select.appendChild(option('', t('dv.pickParent', { parent: levelName(ORDER[level - 1]) }), true));
      select.disabled = true;
      this.items[level] = [];
      return Promise.resolve();
    }
    var path = level === 0
      ? '/api/locations?level=' + ORDER[level] + '&lang=' + lang
      : '/api/locations?parent=' + encodeURIComponent(this.picked[level - 1]) + '&lang=' + lang;
    select.disabled = true;
    select.innerHTML = '';
    select.appendChild(option('', t('dv.loading'), true));
    return this.api(path).then(function (body) {
      var rows = body.items || [];
      self.items[level] = rows;
      select.innerHTML = '';
      var first = rows.length || level > 0 ? t(self.anyLabel ? 'dv.all' : 'dv.any') : t('dv.empty');
      select.appendChild(option('', first, true));
      for (var i = 0; i < rows.length; i += 1) {
        select.appendChild(option(rows[i].code, rows[i].name, rows[i].code === self.picked[level]));
      }
      select.disabled = rows.length === 0;
      if (!rows.length) self.picked[level] = '';
      else select.value = self.picked[level] || '';
    }).catch(function (error) {
      select.innerHTML = '';
      select.appendChild(option('', t('dv.failed'), true));
      select.disabled = true;
      self.items[level] = [];
      self.message(reason(error));
    });
  };

  /* Levels after an empty one are meaningless, so only the ones with a parent are fetched. */
  Cascade.prototype.hydrateFrom = function (level) {
    var self = this;
    var walk = Promise.resolve();
    for (var next = level; next < this.depth; next += 1) {
      walk = walk.then(function (index) {
        return function () { return self.hydrate(index); };
      }(next));
    }
    return walk;
  };

  Cascade.prototype.choose = function (level, code) {
    this.picked[level] = code || '';
    for (var deeper = level + 1; deeper < this.depth; deeper += 1) this.picked[deeper] = '';
    var self = this;
    this.busy = this.busy.then(function () {
      return self.hydrateFrom(level + 1);
    }).then(function () { self.notify(); });
  };

  Cascade.prototype.notify = function () {
    if (this.onChange) this.onChange(this.value());
  };

  /* The deepest division the user actually picked, or null when nothing below "All" was chosen. */
  Cascade.prototype.value = function () {
    var code = '';
    var level = -1;
    for (var i = 0; i < this.depth; i += 1) {
      if (this.picked[i]) { code = this.picked[i]; level = i; }
    }
    if (!code) return null;
    var rows = this.items[level] || [];
    var row = null;
    for (var r = 0; r < rows.length; r += 1) if (rows[r].code === code) row = rows[r];
    return {
      code: code,
      level: level + 1,
      levelKey: ORDER[level],
      name: row ? row.name : code,
      label: row && row.label ? row.label : (row ? row.name : code)
    };
  };

  Cascade.prototype.codes = function () {
    return this.picked.slice(0);
  };

  /* Put the cascade back to a known division — used when a saved profile is loaded. */
  Cascade.prototype.set = function (code) {
    var self = this;
    if (!code) {
      this.picked = [];
      for (var clear = 0; clear < this.depth; clear += 1) this.picked.push('');
      this.reload();
      return this.busy;
    }
    this.busy = this.busy.then(function () {
      return self.api('/api/locations/chain?code=' + encodeURIComponent(code) + '&lang=' + lang);
    }).then(function (body) {
      for (var step = 0; step < self.depth; step += 1) self.picked[step] = '';
      for (var i = 0; i < body.chain.length && i < self.depth; i += 1) self.picked[i] = body.chain[i].code;
      return self.hydrateFrom(0);
    }).then(function () { self.notify(); }).catch(function (error) { self.message(reason(error)); });
    return this.busy;
  };

  Cascade.prototype.repaint = function () {
    this.reload();
  };

  var setLang = function (next) {
    lang = next === 'en' ? 'en' : 'rw';
    /* A dashboard repaints its panel, so old hosts are long gone from the document. Dropping the
       controllers that came with them keeps a language switch from re-fetching detached dropdowns. */
    mounted = mounted.filter(function (controller) {
      return document.body.contains(controller.host);
    });
    for (var i = 0; i < mounted.length; i += 1) mounted[i].repaint();
  };

  window.SERE_DIVISIONS = {
    levels: ORDER,
    /* mount(host, { depth, api, onChange, anyLabel }) → the cascade controller */
    mount: function (host, options) {
      if (!host) return null;
      for (var i = mounted.length - 1; i >= 0; i -= 1) {
        if (mounted[i].host === host || !document.body.contains(mounted[i].host)) mounted.splice(i, 1);
      }
      var controller = new Cascade(host, options || {});
      mounted.push(controller);
      return controller;
    },
    /* "Around Kacyiru, Gasabo" for a GPS fix, in one call. */
    point: function (lat, lng, requestApi) {
      return (requestApi || getJson)('/api/locations/point?lat=' + lat + '&lng=' + lng + '&lang=' + lang);
    },
    /* One level's rows, asked the way a cascade asks them: all provinces, or everything under a parent. */
    list: function (parentCode, levelKey, requestApi) {
      var path = parentCode
        ? '/api/locations?parent=' + encodeURIComponent(parentCode) + '&lang=' + lang
        : '/api/locations?level=' + encodeURIComponent(levelKey) + '&lang=' + lang;
      return (requestApi || getJson)(path).then(function (body) { return body.items || []; });
    },
    /* One box over all five levels: type "Biryogo", get "Biryogo, Gashora, Bugesera, Intara y'Iburasirazuba". */
    suggest: function (needle, requestApi, limit) {
      var path = '/api/locations/search?q=' + encodeURIComponent(needle) + '&lang=' + lang
        + '&limit=' + (limit || 8);
      return (requestApi || getJson)(path);
    },
    t: t,
    setLang: setLang,
    getLang: function () { return lang; },
    levelName: levelName
  };
}());
