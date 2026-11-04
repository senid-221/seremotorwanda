/* SERE Moto — passenger dashboard. Drives /api/passenger/auth/verify, /api/passenger/me,
   /api/passenger/trips*, /api/passenger/places* and /api/requests/:id/payments.
   Sign-in is the phone number alone: the server asks the numbering plan whether it exists. */
(function () {
  'use strict';

  var S = window.SERE;
  var t = S.t;
  var esc = S.esc;
  var api = S.api;
  var q = S.q;
  var qa = S.qa;
  var text = S.text;
  var errText = S.errText;
  var ecOf = S.ecOf;

  var POLL_MS = 30000;
  var TAB_KEY = 'sere_pax_tab';
  var SCOPE_KEY = 'sere_pax_scope';
  var SCOPES = [['active', 'ps.scopeActive'], ['history', 'ps.scopeHistory'], ['all', 'ps.scopeAll']];
  var PROVIDERS = [['mtn_momo', 'ps.payMomo'], ['paystack', 'ps.payCard']];
  var TABS = ['trips', 'places', 'profile'];
  var OFF = ['paystack_not_configured', 'momo_not_configured', 'provider_not_configured'];
  var EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

  var els = {};
  var st = {
    view: '', kind: '', gate: '',
    me: null, stats: null, trips: [], places: [],
    tab: 'trips', scope: 'active',
    openPay: '', provider: 'mtn_momo', openRate: '', stars: 0, confirmPlace: '',
    busy: {},
    phone: '', submitting: false
  };
  var timers = { poll: null, hide: null };

  /* ================================================================== views */

  function showView(which) {
    st.view = which;
    S.visible(els.signIn, which === 'sign');
    S.visible(els.gate, which === 'gate');
    S.visible(els.area, which === 'dash');
    S.visible(els.btnRefresh, which === 'dash');
    S.visible(els.btnLogout, which === 'dash');
  }

  /* A driver token on this page: send the person to the driver dashboard. */
  function showRiderGate() {
    st.gate = 'rider';
    showView('gate');
    els.gateIcon.innerHTML = S.icons.moto;
    text(els.gateTitle, t('ab.rider'));
    text(els.gateBody, t('ps.notPax'));
    text(els.gateCta, t('ab.rider'));
    els.gateCta.className = 'btn btn-p';
    els.gateCta.onclick = function () { location.href = '/rider'; };
  }

  function showSignIn() {
    st.kind = '';
    st.gate = '';
    showView('sign');
    paintSignIn();
  }

  function signOut() {
    S.clearToken();
    stopPoll();
    st.kind = '';
    st.me = null;
    st.stats = null;
    st.trips = [];
    st.places = [];
    st.openPay = '';
    st.openRate = '';
    st.stars = 0;
    st.confirmPlace = '';
    st.busy = {};
    els.panel.innerHTML = '';
    S.hideBanner(els.board);
    S.hideBanner(els.err);
    showSignIn();
  }

  /* =============================================================== sign-in */

  function paintSignIn() {
    text(els.namesHint, t('ps.nameHint'));
  }

  /* The number is the whole credential: one POST, and the numbering plan either knows it or not. */
  function enter() {
    if (st.submitting) { return; }
    var raw = String(els.phone.value || '');
    if (!S.isPhone(raw)) {
      S.fieldError(els.phoneField, t('su.errPhone'));
      S.banner(els.sendMsg, 'err', ecOf('invalid_phone'));
      els.phone.focus();
      return;
    }
    var phone = S.normalizePhone(raw);
    var names = S.cleanNames(els.names.value);
    if (names && !S.isNames(names)) {
      S.fieldError(els.namesField, t('su.errNames'));
      els.names.focus();
      return;
    }
    S.fieldError(els.phoneField, '');
    S.fieldError(els.namesField, '');
    S.hideBanner(els.sendMsg);
    var body = { phone: phone };
    if (names) { body.name = names; }
    st.submitting = true;
    S.loading(els.btnSend, true);
    api('/api/passenger/auth/verify', { body: body }).then(function (data) {
      st.submitting = false;
      S.loading(els.btnSend, false);
      st.phone = phone;
      S.setToken(data.token);
      st.kind = 'passenger';
      st.me = data.passenger || null;
      showView('dash');
      say('ok', t('ps.hello', { name: nameOf(st.me) }));
      refresh(false);
    }, function (err) {
      st.submitting = false;
      S.loading(els.btnSend, false);
      if (err.code === 'invalid_phone' || err.code === 'phone_invalid') { S.fieldError(els.phoneField, errText(err)); }
      S.banner(els.sendMsg, 'err', errText(err));
    });
  }

  /* ================================================================ session */

  function nameOf(me) {
    if (!me) { return '—'; }
    return me.name || me.phone || '—';
  }

  function loadMe() {
    return api('/api/passenger/me', { useToken: true }).then(function (data) {
      st.me = (data && data.passenger) || st.me;
      st.places = (st.me && st.me.places) || [];
      st.stats = (data && data.stats) || st.stats;
      return true;
    });
  }

  function loadTrips() {
    return api('/api/passenger/trips?scope=' + st.scope + '&limit=60', { useToken: true })
      .then(function (data) { st.trips = (data && data.trips) || []; });
  }

  function loadSession() {
    if (!S.getToken()) {
      showSignIn();
      return Promise.resolve(false);
    }
    /* /api/auth/me is driver-only: asking it here would throw a passenger's token away. */
    return api('/api/auth/session').then(function (data) {
      var kind = (data && data.kind) || '';
      if (kind === 'passenger') {
        st.kind = 'passenger';
        st.gate = '';
        showView('dash');
        refresh(false);
        return true;
      }
      if (kind === 'driver') { showRiderGate(); return false; }
      /* the browser holds a token the server does not recognise: drop it and start clean */
      S.clearToken();
      showSignIn();
      return false;
    }, function (err) {
      if (err.status === 401) { S.clearToken(); }
      showSignIn();
      return false;
    });
  }

  /* ============================================================== painting */

  function paintHello() {
    var active = (st.stats && st.stats.active) || 0;
    els.helloBox.className = 'state' + (active ? ' on' : '');
    text(els.helloTxt, t('ps.hello', { name: nameOf(st.me) }));
    text(els.helloPhone, (st.me && st.me.phone) || '—');
    text(els.footHello, t('ps.hello', { name: nameOf(st.me) }));
  }

  function statTile(value, labelKey, cls) {
    return '<div class="stat ' + (cls || '') + '"><b>' + esc(value) + '</b><i>' + esc(t(labelKey)) + '</i></div>';
  }

  function paintStats() {
    var s = st.stats || {};
    els.stats.innerHTML = statTile(S.num(s.total || 0), 'ps.tripsCount')
      + statTile(S.num(s.active || 0), 'ps.activeCount', s.active ? 'hot' : '')
      + statTile(S.rwf(s.spentRwf || 0), 'ps.spent', 'pos')
      + statTile(S.num(s.ratingsGiven || 0), 'ps.ratingsGiven');
  }

  function paintTabs() {
    var tabs = qa('#tabs button');
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].setAttribute('aria-selected', String(tabs[i].getAttribute('data-tab') === st.tab));
    }
    text(els.cntTrips, st.trips.length ? String(st.trips.length) : '');
    text(els.cntPlaces, st.places.length ? String(st.places.length) : '');
  }

  function paintPanel() {
    if (st.tab === 'trips') { els.panel.innerHTML = tripsHtml(); return; }
    if (st.tab === 'places') { els.panel.innerHTML = placesHtml(); wirePlaces(); return; }
    els.panel.innerHTML = profileHtml();
    wireProfile();
  }

  function paint() {
    paintHello();
    paintStats();
    paintTabs();
    paintPanel();
  }

  function skHtml(n) {
    var html = '';
    for (var i = 0; i < n; i++) {
      html += '<div class="sk"><span class="l a"></span><span class="l b"></span><span class="l c"></span></div>';
    }
    return html;
  }

  function skeleton() {
    if (st.tab !== 'trips') {
      els.panel.innerHTML = skHtml(2);
      return;
    }
    els.panel.innerHTML = '<section class="sect"><div class="sect-hd"><h2>' + esc(t('ps.tabTrips'))
      + '</h2></div><div class="chips">' + scopeLabel() + '</div>' + skHtml(2) + '</section>';
  }

  /* ================================================================= trips */

  function pair(label, value) {
    return '<div><dt>' + esc(label) + '</dt><dd>' + esc(value) + '</dd></div>';
  }

  function scopeLabel() {
    var html = '';
    for (var i = 0; i < SCOPES.length; i++) {
      html += '<button type="button" class="chip" data-act="scope" data-id="' + SCOPES[i][0] + '"'
        + ' aria-pressed="' + (st.scope === SCOPES[i][0] ? 'true' : 'false') + '">'
        + esc(t(SCOPES[i][1])) + '</button>';
    }
    return html;
  }

  function actButton(act, key, cls, id, busyPrefix) {
    var busy = !!st.busy[(busyPrefix || 'a') + id];
    return '<button type="button" class="btn ' + cls + ' btn-s' + (busy ? ' loading' : '') + '"'
      + ' data-act="' + act + '" data-id="' + esc(id) + '"' + (busy ? ' disabled' : '') + '>'
      + esc(t(key)) + '</button>';
  }

  function actsFor(r) {
    var out = '';
    if (r.cancellable) { out += actButton('cancel', 'ps.cancelTrip', 'btn-no', r.id); }
    if (r.payable) {
      out += st.openPay === r.id ? '' : actButton('pay-open', 'ps.pay', 'btn-p', r.id);
    }
    if (r.rateable) {
      out += st.openRate === r.id ? '' : actButton('rate-open', 'ps.rate', 'btn-ok', r.id);
    }
    if (r.payment && r.payment.checkoutUrl && r.payment.status === 'pending') {
      out += '<a class="btn btn-quiet btn-s" href="' + esc(r.payment.checkoutUrl) + '"'
        + ' target="_blank" rel="noopener">' + esc(t('ps.payOpen')) + '</a>';
    }
    return out;
  }

  function riderCard(r) {
    if (!r.rider) { return ''; }
    var veh = S.VEHICLE[r.rider.vehicleType] || S.VEHICLE.moto;
    var html = '<div class="ctl"><span class="grow">'
      + esc(t('tp.rider')) + ': <b>' + esc(r.rider.name || '—') + '</b> · '
      + esc(r.rider.plate || '—') + ' · ' + esc(S.getLang() === 'rw' ? veh.rw : veh.en)
      + (r.rider.zone ? ' · ' + esc(r.rider.zone) : '') + '</span>'
      + S.stars(r.rider.rating || 0)
      + (r.rider.phone ? '<a class="btn btn-ghost btn-s" href="' + esc(S.telHref(r.rider.phone)) + '">'
        + esc(t('c.call')) + '</a>' : '')
      + '</div>';
    return html;
  }

  function payForm(r) {
    var html = '<div class="ctl"><span class="grow"><b>' + esc(t('ps.pay')) + '</b> · '
      + esc(S.rwf(r.fareRwf)) + '</span>'
      + '<div class="chips">';
    for (var i = 0; i < PROVIDERS.length; i++) {
      html += '<button type="button" class="chip" data-act="provider" data-id="' + PROVIDERS[i][0] + '"'
        + ' aria-pressed="' + (st.provider === PROVIDERS[i][0] ? 'true' : 'false') + '">'
        + esc(t(PROVIDERS[i][1])) + '</button>';
    }
    html += '</div></div>';
    html += '<div class="field">' + (st.provider === 'mtn_momo'
      ? '<label for="payPhone">' + esc(t('ad.kPhone')) + '</label>'
        + '<input type="tel" id="payPhone" inputmode="tel" maxlength="14" value="'
        + esc((st.me && st.me.phone) || '') + '">'
      : '<label for="payEmail">' + esc(t('ps.payEmail')) + '</label>'
        + '<input type="email" id="payEmail" maxlength="120" value="' + esc((st.me && st.me.email) || '') + '">')
      + '<p class="err" hidden aria-live="polite"></p></div>';
    html += '<p class="actions"><button type="button" class="btn btn-p btn-s" data-act="pay-go" data-id="'
      + esc(r.id) + '">' + esc(t('ps.pay')) + ' ' + esc(S.rwf(r.fareRwf)) + '</button>'
      + '<button type="button" class="btn btn-quiet btn-s" data-act="pay-close">' + esc(t('ad.cancel')) + '</button></p>';
    return html;
  }

  function rateForm(r) {
    var html = '<div class="field"><span class="lbl">' + esc(t('ps.rateTitle')) + '</span>'
      + '<div class="picker" role="group" aria-label="' + esc(t('ps.ratePick')) + '">';
    for (var i = 1; i <= 5; i++) {
      html += '<button type="button" data-act="star" data-id="' + i + '"'
        + ' aria-pressed="' + (st.stars === i ? 'true' : 'false') + '" aria-label="'
        + esc(t('ps.ratePick')) + ' ' + i + '">&#9733;</button>';
    }
    html += '</div><p class="hint">' + esc(t('ps.ratePick')) + '</p>'
      + '<label class="lbl" for="rateComment">' + esc(t('ps.rateComment')) + '</label>'
      + '<textarea id="rateComment" maxlength="300" rows="2"></textarea>'
      + '<p class="err" hidden aria-live="polite"></p></div>';
    html += '<p class="actions"><button type="button" class="btn btn-ok btn-s" data-act="rate-go" data-id="'
      + esc(r.id) + '">' + esc(t('ps.rateSend')) + '</button>'
      + '<button type="button" class="btn btn-quiet btn-s" data-act="rate-close">' + esc(t('ad.cancel')) + '</button></p>';
    return html;
  }

  function tripRow(r) {
    var html = '<article class="row">';
    html += '<span class="av" aria-hidden="true">'
      + S.initials((r.rider && r.rider.name) || r.destination || 'S') + '</span>';
    html += '<div class="who"><b>' + esc(t('ps.receipt', { id: r.id })) + '</b>';
    html += ' <em>' + esc(t(S.KIND_LABEL[r.kind] || 'tp.kind')) + '</em>';
    html += '<div class="route"><span>' + esc(t('tp.origin')) + ': ' + esc(r.origin) + '</span>'
      + '<i aria-hidden="true">&rarr;</i><span>' + esc(t('tp.dest')) + ': ' + esc(r.destination) + '</span></div>';
    html += '<div class="pairs">'
      + pair(t('tp.distance'), S.km(r.distanceKm))
      + pair(t('tp.fare'), S.rwf(r.fareRwf))
      + pair(t('c.seats'), S.num(r.passengers))
      + (r.scheduledAt ? pair(t('tp.scheduled'), S.stamp(r.scheduledAt)) : '')
      + pair(t('tp.created'), S.stamp(r.createdAt))
      + (r.payment ? pair(t('ps.ref'), r.payment.reference || '—') : '')
      + '</div>';
    if (r.note) { html += '<p class="subtle">' + esc(t('tp.note')) + ': ' + esc(r.note) + '</p>'; }
    html += riderCard(r);
    if (r.rating) {
      html += '<p class="subtle">' + S.stars(r.rating.stars) + ' '
        + esc(t('ps.rated', { n: r.rating.stars })) + '</p>';
      if (r.rating.comment) { html += '<p class="subtle">' + esc(r.rating.comment) + '</p>'; }
    }
    if (st.openPay === r.id) { html += payForm(r); }
    if (st.openRate === r.id) { html += rateForm(r); }
    html += '<div class="acts">' + actsFor(r) + '</div>';
    html += '</div>';
    html += '<div class="tail">' + S.badge(r.status)
      + S.payBadge(r.payment ? r.payment.status : null)
      + '<span class="money">' + esc(S.rwf(r.fareRwf)) + '</span></div>';
    return html + '</article>';
  }

  function tripsHtml() {
    var html = '<section class="sect"><div class="sect-hd"><h2>' + esc(t('ps.tabTrips')) + '</h2>'
      + '<span class="grow"></span><span class="stamp">' + esc(t('tp.status')) + '</span></div>'
      + '<div class="chips">' + scopeLabel() + '</div>';
    if (!st.trips.length) {
      html += '<p class="subtle">' + esc(t('ps.noTrips')) + '</p>';
    } else {
      html += '<div class="rows" style="margin-top:10px">';
      for (var i = 0; i < st.trips.length; i++) { html += tripRow(st.trips[i]); }
      html += '</div>';
    }
    return html + '</section>';
  }

  /* =============================================================== places */

  function placeRow(p) {
    var html = '<article class="row">';
    html += '<span class="av" aria-hidden="true">' + S.initials(p.label) + '</span>';
    html += '<div class="who"><b>' + esc(p.label) + '</b>';
    html += '<p class="subtle">' + esc(t('ps.placeAddr')) + ': ' + esc(p.address) + '</p>';
    if (st.confirmPlace === p.id) {
      html += '<p class="msg msg-wait">' + S.icons.wait + '<span>'
        + esc(t('ps.placeConfirm', { label: p.label })) + '</span></p>';
      html += '<div class="acts"><button type="button" class="btn btn-no btn-s" data-act="del-go" data-id="'
        + esc(p.id) + '">' + esc(t('ps.confirm')) + '</button>'
        + '<button type="button" class="btn btn-quiet btn-s" data-act="del-close">'
        + esc(t('ad.cancel')) + '</button></div>';
    } else {
      html += '<div class="acts">'
        + '<a class="btn btn-p btn-s" href="/?view=find" title="' + esc(p.address) + '">'
        + esc(t('ps.placeBook')) + '</a>'
        + '<button type="button" class="btn btn-quiet btn-s" data-act="del-open" data-id="'
        + esc(p.id) + '">' + esc(t('ps.placeDel')) + '</button></div>';
    }
    html += '</div>';
    return html + '</article>';
  }

  function placesHtml() {
    var html = '<section class="sect"><div class="sect-hd"><h2>' + esc(t('ps.tabPlaces')) + '</h2></div>';
    html += '<form id="plForm" autocomplete="off" novalidate>';
    html += '<div class="grid2">';
    html += '<div class="field"><label for="plLabel">' + esc(t('ps.placeLabel')) + '</label>'
      + '<input type="text" id="plLabel" maxlength="40"'
      + ' required><p class="err" hidden aria-live="polite"></p></div>';
    html += '<div class="field"><label for="plAddr">' + esc(t('ps.placeAddr')) + '</label>'
      + '<input type="text" id="plAddr" maxlength="120"'
      + ' required><p class="err" hidden aria-live="polite"></p></div>';
    html += '</div>';
    html += '<p class="actions"><button class="btn btn-p" type="submit" id="plAdd">'
      + esc(t('ps.placeAdd')) + '</button></p>';
    html += '</form>';
    if (!st.places.length) {
      html += '<p class="subtle">' + esc(t('ps.placeNone')) + '</p>';
    } else {
      html += '<div class="rows">';
      for (var i = 0; i < st.places.length; i++) { html += placeRow(st.places[i]); }
      html += '</div>';
    }
    return html + '</section>';
  }

  function wirePlaces() {
    var form = q('#plForm', els.panel);
    if (!form) { return; }
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      addPlace(form);
    });
  }

  function addPlace(form) {
    var label = q('#plLabel', form);
    var addr = q('#plAddr', form);
    var l = label.value.replace(/^ +| +$/g, '');
    var a = addr.value.replace(/^ +| +$/g, '');
    S.fieldError(label.parentNode, l ? '' : ecOf('invalid_label'));
    S.fieldError(addr.parentNode, a ? '' : ecOf('invalid_address'));
    if (!l || !a) { return; }
    S.loading(q('#plAdd', form), true);
    api('/api/passenger/places', { body: { label: l.slice(0, 40), address: a.slice(0, 120) }, useToken: true })
      .then(function () {
        say('ok', t('c.saved'));
        refresh(true);
      }, function (err) {
        S.loading(q('#plAdd', form), false);
        if (err.status === 401) { signOut(); return; }
        if (err.code === 'place_exists' || err.code === 'invalid_label') {
          S.fieldError(label.parentNode, errText(err));
        } else if (err.code === 'invalid_address') {
          S.fieldError(addr.parentNode, errText(err));
        } else {
          say('err', errText(err));
        }
      });
  }

  function dropPlace(id, button) {
    S.loading(button, true);
    api('/api/passenger/places/' + encodeURIComponent(id), { method: 'DELETE', useToken: true })
      .then(function () {
        st.confirmPlace = '';
        say('info', t('ps.placeGone'));
        refresh(true);
      }, function (err) {
        st.confirmPlace = '';
        if (err.status === 401) { signOut(); return; }
        say('err', errText(err));
        refresh(true);
      });
  }

  /* =============================================================== profile */

  function field(labelKey, inner, hint) {
    return '<div class="field"><label>' + esc(labelKey) + '</label>' + inner
      + (hint ? '<p class="hint">' + esc(hint) + '</p>' : '') + '<p class="err" hidden aria-live="polite"></p></div>';
  }

  function profileHtml() {
    var me = st.me || {};
    var html = '<section class="sect"><div class="sect-hd"><h2>' + esc(t('ps.tabProfile')) + '</h2></div>';
    html += '<form id="pfForm" autocomplete="on" novalidate>';
    html += '<div class="grid2">';
    html += field(t('ps.name'), '<input type="text" id="pfName" name="name" maxlength="80" value="'
      + esc(me.name || '') + '">');
    html += field(t('ps.email'), '<input type="email" id="pfEmail" name="email" maxlength="120" value="'
      + esc(me.email || '') + '">');
    html += '</div>';
    html += field(t('ad.kPhone'), '<input type="tel" id="pfPhone" maxlength="14" value="'
      + esc(me.phone || '') + '" disabled>', t('ps.verifiedShort'));
    html += '<div class="pairs">'
      + pair(t('ps.createdOn'), S.stamp(me.createdAt || ''))
      + pair(t('ad.paxLast'), S.stamp(me.lastLoginAt || ''))
      + '</div>';
    html += '<p class="actions"><button class="btn btn-p" type="submit" id="pfSave">'
      + esc(t('c.save')) + '</button>'
      + '<button class="btn btn-no" type="button" id="pfOut">' + esc(t('ad.logout')) + '</button>'
      + '<span class="subtle" id="pfMsg"></span></p>';
    return html + '</form></section>';
  }

  function wireProfile() {
    var form = q('#pfForm', els.panel);
    if (!form) { return; }
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      saveProfile(form);
    });
    q('#pfOut', form).addEventListener('click', signOut);
  }

  function saveProfile(form) {
    var nameEl = q('#pfName', form);
    var mailEl = q('#pfEmail', form);
    var names = S.cleanNames(nameEl.value);
    var mail = mailEl.value.replace(/^ +| +$/g, '');
    var body = {};
    if (names && !S.isNames(names)) {
      S.fieldError(nameEl.parentNode, t('su.errNames'));
    } else {
      S.fieldError(nameEl.parentNode, '');
      if (names && names !== (st.me && st.me.name)) { body.name = names; }
    }
    if (mail && !EMAIL.test(mail)) {
      S.fieldError(mailEl.parentNode, ecOf('invalid_email'));
    } else if (mail.length > 120) {
      S.fieldError(mailEl.parentNode, ecOf('invalid_email'));
    } else {
      S.fieldError(mailEl.parentNode, '');
      if (mail !== ((st.me && st.me.email) || '')) { body.email = mail; }
    }
    if (qa('.field.bad', form).length) { return; }
    if (!body.name && !body.email) {
      text(q('#pfMsg', form), ecOf('empty_update'));
      return;
    }
    S.loading(q('#pfSave', form), true);
    api('/api/passenger/me', { method: 'PATCH', body: body, useToken: true }).then(function (data) {
      st.me = (data && data.passenger) || st.me;
      S.loading(q('#pfSave', form), false);
      text(q('#pfMsg', form), t('c.saved'));
      say('ok', t('c.saved'));
      refresh(true);
    }, function (err) {
      S.loading(q('#pfSave', form), false);
      text(q('#pfMsg', form), '');
      if (err.status === 401) { signOut(); return; }
      if (err.code === 'invalid_email') { S.fieldError(mailEl.parentNode, errText(err)); }
      if (err.code === 'invalid_name') { S.fieldError(nameEl.parentNode, errText(err)); }
      say('err', errText(err));
    });
  }

  /* =============================================================== banners */

  function say(kind, message) {
    var node = kind === 'err' ? els.err : els.board;
    S.banner(node, kind, message, kind === 'err' ? 'warn' : kind === 'ok' ? 'ok' : 'info');
    if (kind === 'err') { return; }
    if (timers.hide) { clearTimeout(timers.hide); }
    timers.hide = setTimeout(function () { S.hideBanner(els.board); }, 7000);
  }

  /* ================================================================ refresh */

  function refresh(quiet) {
    if (st.kind !== 'passenger') { return; }
    if (!quiet) {
      skeleton();
      S.hideBanner(els.err);
      text(els.helloTxt, t('c.loading'));
    }
    Promise.all([loadMe(), loadTrips()]).then(function () {
      paint();
      startPoll();
    }, function (err) {
      if (err.status === 401) { signOut(); return; }
      say('err', errText(err));
      paint();
      startPoll();
    });
  }

  function editing() {
    if (st.openPay || st.openRate || st.confirmPlace) { return true; }
    var now = document.activeElement;
    return !!(now && els.panel && els.panel.contains(now));
  }

  function poll() {
    if (document.hidden || st.kind !== 'passenger' || !S.getToken() || editing()) { return; }
    loadMe().then(loadTrips).then(function () {
      paint();
    }, function (err) {
      if (err.status === 401) { signOut(); }
    });
  }

  function startPoll() {
    if (!timers.poll) { timers.poll = setInterval(poll, POLL_MS); }
  }

  function stopPoll() {
    if (timers.poll) { clearInterval(timers.poll); timers.poll = null; }
  }

  /* ================================================================ actions */

  function cancelTrip(id, button) {
    st.busy['a' + id] = true;
    S.loading(button, true);
    api('/api/passenger/trips/' + encodeURIComponent(id) + '/cancel', { method: 'POST', body: {}, useToken: true })
      .then(function () {
        delete st.busy['a' + id];
        say('info', t('ps.cancelled'));
        refresh(true);
      }, function (err) {
        delete st.busy['a' + id];
        if (err.status === 401) { signOut(); return; }
        say('err', errText(err));
        refresh(true);
      });
  }

  function submitPay(id, button) {
    var body = { provider: st.provider };
    if (st.provider === 'mtn_momo') {
      var phoneEl = q('#payPhone', els.panel);
      if (!phoneEl) { return; }
      var phone = S.normalizePhone(phoneEl.value);
      if (!S.isPhone(phone)) {
        S.fieldError(phoneEl.parentNode, t('su.errPhone'));
        return;
      }
      S.fieldError(phoneEl.parentNode, '');
      body.phone = phone;
    } else {
      var mailEl = q('#payEmail', els.panel);
      if (!mailEl) { return; }
      var mail = mailEl.value.replace(/^ +| +$/g, '');
      if (!EMAIL.test(mail)) {
        S.fieldError(mailEl.parentNode, ecOf('invalid_email'));
        return;
      }
      S.fieldError(mailEl.parentNode, '');
      body.email = mail;
    }
    st.busy['p' + id] = true;
    S.loading(button, true);
    /* the payments route is open on purpose: no useToken, so a 401 never drops the session */
    api('/api/requests/' + encodeURIComponent(id) + '/payments', { body: body })
      .then(function (data) {
        delete st.busy['p' + id];
        st.openPay = '';
        var pay = (data && data.payment) || null;
        if (pay && pay.status === 'paid') { say('ok', t('ps.payDone')); }
        else { say('wait', t('ps.payWait')); }
        refresh(true);
      }, function (err) {
        delete st.busy['p' + id];
        S.loading(button, false);
        if (err.status === 503 || OFF.indexOf(err.code) >= 0) {
          st.openPay = '';
          say('info', t('ps.payOff'));
          refresh(true);
          return;
        }
        if (err.code === 'not_payable') {
          st.openPay = '';
          say('err', errText(err));
          refresh(true);
          return;
        }
        say('err', errText(err));
      });
  }

  function submitRate(id, button) {
    if (!st.stars) {
      say('err', ecOf('invalid_stars'));
      return;
    }
    var body = { stars: st.stars };
    var box = q('#rateComment', els.panel);
    if (box) {
      var comment = box.value.replace(/^ +| +$/g, '').slice(0, 300);
      if (comment) { body.comment = comment; }
    }
    st.busy['r' + id] = true;
    S.loading(button, true);
    api('/api/passenger/trips/' + encodeURIComponent(id) + '/rating', { method: 'POST', body: body, useToken: true })
      .then(function () {
        delete st.busy['r' + id];
        st.openRate = '';
        st.stars = 0;
        say('ok', t('ps.rateDone'));
        refresh(true);
      }, function (err) {
        delete st.busy['r' + id];
        if (err.status === 401) { signOut(); return; }
        if (err.code === 'already_rated' || err.code === 'not_completed') {
          st.openRate = '';
          st.stars = 0;
          say('err', errText(err));
          refresh(true);
          return;
        }
        if (err.code === 'invalid_comment') {
          S.loading(button, false);
          S.fieldError(box ? box.parentNode : null, errText(err));
          return;
        }
        S.loading(button, false);
        say('err', errText(err));
      });
  }

  function paintStars() {
    qa('button[data-act="star"]', els.panel).forEach(function (b) {
      b.setAttribute('aria-pressed', String(Number(b.getAttribute('data-id')) === st.stars));
    });
  }

  function setScope(next) {
    st.scope = next;
    st.openPay = '';
    st.openRate = '';
    try { localStorage.setItem(SCOPE_KEY, next); } catch (e) { /* private mode keeps defaults */ }
    st.trips = [];
    skeleton();
    loadTrips().then(function () {
      paintTabs();
      paintPanel();
    }, function (err) {
      if (err.status === 401) { signOut(); return; }
      say('err', errText(err));
      paintPanel();
    });
  }

  function showTab(name) {
    st.tab = name;
    st.confirmPlace = '';
    try { localStorage.setItem(TAB_KEY, name); } catch (e) { /* private mode keeps defaults */ }
    paintTabs();
    paintPanel();
  }

  /* ============================================================= delegation */

  function actionNode(ev) {
    var node = ev.target;
    while (node && node !== els.panel && !(node.getAttribute && node.getAttribute('data-act'))) {
      node = node.parentNode;
    }
    if (!node || node === els.panel) { return null; }
    return node;
  }

  function onPanelClick(ev) {
    var node = actionNode(ev);
    if (!node) { return; }
    var act = node.getAttribute('data-act');
    var id = node.getAttribute('data-id');

    if (act === 'scope') {
      if (st.scope !== id) { setScope(id); }
      return;
    }
    if (act === 'provider') {
      st.provider = id;
      paintPanel();
      return;
    }
    if (act === 'pay-open') {
      st.openPay = id;
      st.openRate = '';
      st.provider = 'mtn_momo';
      paintPanel();
      return;
    }
    if (act === 'pay-close') {
      st.openPay = '';
      paintPanel();
      return;
    }
    if (act === 'pay-go') {
      submitPay(id, node);
      return;
    }
    if (act === 'rate-open') {
      st.openRate = id;
      st.openPay = '';
      st.stars = 0;
      paintPanel();
      return;
    }
    if (act === 'rate-close') {
      st.openRate = '';
      st.stars = 0;
      paintPanel();
      return;
    }
    if (act === 'star') {
      st.stars = Number(id);
      paintStars();
      return;
    }
    if (act === 'rate-go') {
      submitRate(id, node);
      return;
    }
    if (act === 'cancel') {
      cancelTrip(id, node);
      return;
    }
    if (act === 'del-open') {
      st.confirmPlace = id;
      paintPanel();
      return;
    }
    if (act === 'del-close') {
      st.confirmPlace = '';
      paintPanel();
      return;
    }
    if (act === 'del-go') {
      dropPlace(id, node);
    }
  }

  /* =================================================================== wire */

  function wire() {
    els.btnRefresh.addEventListener('click', function () {
      refresh(false);
    });
    els.btnLogout.addEventListener('click', signOut);
    qa('#tabs button').forEach(function (tab) {
      tab.addEventListener('click', function () { showTab(tab.getAttribute('data-tab')); });
    });
    els.panel.addEventListener('click', onPanelClick);

    els.frmPhone.addEventListener('submit', function (ev) {
      ev.preventDefault();
      enter();
    });
    els.phone.addEventListener('input', function () {
      S.fieldError(els.phoneField, '');
      S.hideBanner(els.sendMsg);
    });
    els.names.addEventListener('input', function () {
      S.fieldError(els.namesField, '');
    });
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) { poll(); }
    });
    S.onLang(function () {
      if (st.kind === 'passenger' && st.view === 'dash') { paint(); }
      else if (st.view === 'gate') { showRiderGate(); }
      else { paintSignIn(); }
    });
  }

  /* =================================================================== boot */

  function init() {
    els = {
      signIn: q('#signIn'),
      stPhone: q('#stPhone'),
      frmPhone: q('#frmPhone'),
      phone: q('#inPhone'),
      phoneField: q('#fldPhone'),
      names: q('#inNames'),
      namesField: q('#fldNames'),
      namesHint: q('#namesHint'),
      btnSend: q('#btnSend'),
      sendMsg: q('#sendMsg'),
      gate: q('#gate'), gateIcon: q('#gateIcon'), gateTitle: q('#gateTitle'),
      gateBody: q('#gateBody'), gateCta: q('#gateCta'),
      area: q('#area'),
      helloBox: q('#helloBox'), helloTxt: q('#helloTxt'), helloPhone: q('#helloPhone'),
      stats: q('#stats'),
      board: q('#boardMsg'), err: q('#errMsg'),
      cntTrips: q('#cntTrips'), cntPlaces: q('#cntPlaces'),
      panel: q('#panel'),
      footHello: q('#footHello'),
      btnRefresh: q('#btnRefresh'), btnLogout: q('#btnLogout')
    };
    try {
      var tab = localStorage.getItem(TAB_KEY);
      if (tab && TABS.indexOf(tab) >= 0 && q('#tabs button[data-tab="' + tab + '"]')) { st.tab = tab; }
      var scope = localStorage.getItem(SCOPE_KEY);
      for (var i = 0; i < SCOPES.length; i++) { if (SCOPES[i][0] === scope) { st.scope = scope; } }
    } catch (e) { /* private mode keeps defaults */ }
    wire();
    showSignIn();
    loadSession();
  }

  S.onPage('passenger', init);
}());
