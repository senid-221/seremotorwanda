/* SERE Moto — driver dashboard. Drives /api/drivers/me*, /api/drivers/me/requests,
   /api/drivers/me/stats, /api/drivers/me/ratings and /api/requests/:id/status. */
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

  var POLL_MS = 30000;
  var AUTO_LOC_MS = 120000;
  var AUTO_KEY = 'sere_auto_loc';
  var TAB_KEY = 'sere_rider_tab';
  var PERIODS = [['today', 'rd.periodToday'], ['week', 'rd.periodWeek'], ['month', 'rd.periodMonth']];
  var SLOTS = [['morning', 'rd.slotMorning'], ['afternoon', 'rd.slotAfternoon'],
    ['evening', 'rd.slotEvening'], ['weekend', 'rd.slotWeekend']];
  var DOCS = [['national_id', 'rd.docNationalId'], ['driving_licence', 'rd.docLicence'], ['plate', 'rd.docPlate']];
  var DOC_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

  var els = {};
  var st = {
    kind: '', gate: '', me: null, stats: null, active: [], history: [],
    ratings: null, docs: null, div: null, tab: 'live', busy: {}
  };
  var timers = { poll: null, loc: null, hide: null };

  /* ================================================================== gate */

  function showGate(kind) {
    st.gate = kind;
    var me = st.me || {};
    els.gateIcon.innerHTML = S.icons[kind === 'wait' ? 'wait' : kind === 'rejected' ? 'warn'
      : kind === 'pax' ? 'user' : 'out'];
    visibleAll(false);
    if (kind === 'wait') {
      text(els.gateTitle, t('lg.waitTitle'));
      text(els.gateBody, t('lg.waitBody', { name: me.name || '' }));
    } else if (kind === 'rejected') {
      text(els.gateTitle, t('lg.rejTitle'));
      text(els.gateBody, t('lg.rejBody') + ' ' + (me.reason || t('lg.rejHelp')));
    } else if (kind === 'pax') {
      text(els.gateTitle, t('ps.riderArea'));
      text(els.gateBody, t('ps.notPax'));
    } else {
      text(els.gateTitle, t('rd.gateTitle'));
      text(els.gateBody, t('rd.gateBody'));
    }
    var target = kind === 'pax' ? '/passenger' : kind === 'none' ? '/login' : '';
    if (target) {
      text(els.gateCta, t(kind === 'pax' ? 'ab.mine' : 'ad.gate401Cta'));
      els.gateCta.className = 'btn btn-p';
      els.gateCta.onclick = function () { location.href = target; };
      return;
    }
    text(els.gateCta, t('ad.logout'));
    els.gateCta.className = 'btn btn-quiet';
    els.gateCta.onclick = logout;
  }

  function visibleAll(on) {
    S.visible(els.gate, !on);
    S.visible(els.area, on);
    S.visible(els.btnRefresh, on);
    S.visible(els.btnLogout, on || st.gate === 'wait' || st.gate === 'rejected' || st.gate === 'pax');
  }

  function logout() {
    S.clearToken();
    stopTimers();
    st.kind = 'none';
    st.me = null;
    st.stats = null;
    st.ratings = null;
    els.panel.innerHTML = '';
    showGate('none');
  }

  /* A 401/403 from any dashboard call means the account, not the button, changed. */
  function gateOn(err) {
    if (err.status === 401) { st.kind = 'none'; showGate('none'); return true; }
    if (err.status === 403 && err.code === 'account_pending') { showGate('wait'); return true; }
    return false;
  }

  /* ============================================================ trip rows */

  function pair(label, value) {
    return '<div><dt>' + esc(label) + '</dt><dd>' + esc(value) + '</dd></div>';
  }

  function actButton(act, labelKey, cls, id) {
    var busy = !!st.busy[id];
    return '<button type="button" class="btn ' + cls + ' btn-s' + (busy ? ' loading' : '') + '"'
      + ' data-act="' + act + '" data-id="' + id + '"' + (busy ? ' disabled' : '') + '>'
      + esc(t(labelKey)) + '</button>';
  }

  function actsFor(r) {
    var out = '';
    if (r.status === 'new') {
      out += actButton('accepted', 'rd.accept', 'btn-ok', r.id)
        + actButton('declined', 'rd.decline', 'btn-quiet', r.id)
        + actButton('seen', 'rd.markSeen', 'btn-ghost', r.id);
    } else if (r.status === 'seen') {
      out += actButton('accepted', 'rd.accept', 'btn-ok', r.id)
        + actButton('declined', 'rd.decline', 'btn-quiet', r.id);
    } else if (r.status === 'accepted') {
      out += actButton('completed', 'rd.complete', 'btn-p', r.id)
        + actButton('cancelled', 'rd.cancelTrip', 'btn-no', r.id);
    }
    if (r.clientPhone) {
      out += '<a class="btn btn-ghost btn-s" href="' + esc(S.telHref(r.clientPhone)) + '">'
        + esc(t('c.call')) + '</a>';
    }
    return out;
  }

  function tripRow(r, live) {
    var html = '<article class="row">';
    html += '<span class="av" aria-hidden="true">' + S.initials(r.clientName || r.clientPhone) + '</span>';
    html += '<div class="who"><b>' + esc(r.clientName || '—') + '</b>';
    html += live && r.clientPhone ? ' <em>' + esc(r.clientPhone) + '</em>' : '';
    html += '<div class="route">' + esc(r.origin) + ' <i aria-hidden="true">&rarr;</i> ' + esc(r.destination) + '</div>';
    html += '<div class="pairs">'
      + pair(t('tp.kind'), t(S.KIND_LABEL[r.kind] || 'tp.kind'))
      + pair(t('tp.distance'), S.km(r.distanceKm))
      + pair(t('tp.fare'), S.rwf(r.fareRwf))
      + pair(t('c.seats'), S.num(r.passengers))
      + (r.scheduledAt ? pair(t('tp.scheduled'), S.stamp(r.scheduledAt)) : '')
      + '</div>';
    if (r.note) { html += '<p class="subtle">' + esc(t('tp.note')) + ': ' + esc(r.note) + '</p>'; }
    if (live) { html += '<div class="acts">' + actsFor(r) + '</div>'; }
    html += '</div>';
    html += '<div class="tail">' + S.badge(r.status)
      + '<span class="money">' + esc(S.rwf(r.fareRwf)) + '</span>'
      + (live ? '' : S.payBadge(r.paymentStatus))
      + '<em class="subtle">' + esc(S.stamp(r.createdAt)) + '</em></div>';
    return html + '</article>';
  }

  function listHtml(rows, live, emptyKey) {
    if (!rows.length) { return '<p class="subtle">' + esc(t(emptyKey)) + '</p>'; }
    var html = '<div class="rows">';
    for (var i = 0; i < rows.length; i++) { html += tripRow(rows[i], live); }
    return html + '</div>';
  }

  /* ============================================================== painting */

  function paintState() {
    var me = st.me;
    if (!me || !me.state) { return; }
    els.stateBox.className = 'state'
      + (me.state === 'available' ? ' on' : me.state === 'with_passenger' ? ' busy' : '');
    text(els.stateTxt, t(me.state === 'available' ? 'rd.stateAvailable'
      : me.state === 'with_passenger' ? 'rd.stateBusy' : 'rd.stateOffline'));
    var veh = S.VEHICLE[me.vehicleType] || S.VEHICLE.moto;
    text(els.statePlate, (me.plate || '—') + ' · ' + (S.getLang() === 'rw' ? veh.rw : veh.en));
    var news = countNew();
    var can = !st.stats || st.stats.can_go_online;
    text(els.availTxt, can
      ? (news ? t('rd.newOnes', { n: news }) : t('rd.none'))
      : t('rd.needProfile', { list: missingList() }));
    text(els.btnOnline, t(me.online ? 'rd.goOffline' : 'rd.goOnline'));
    els.btnOnline.className = 'btn btn-s ' + (me.online ? 'btn-no' : 'btn-ok');
  }

  function missingList() {
    var me = st.me || {};
    var out = [];
    if (!me.area && !me.zone) { out.push(t('rd.kDiv')); }
    if (!me.services) { out.push(t('ad.kServices')); }
    if (me.vehicleType !== 'moto' && !me.pricePerKm) { out.push(t('ad.kPrice')); }
    return out.length ? out.join(', ') : '—';
  }

  function countNew() {
    var n = 0;
    for (var i = 0; i < st.active.length; i++) { if (st.active[i].status === 'new') { n += 1; } }
    return n;
  }

  function paintLoc() {
    var me = st.me;
    if (!me || me.locAgeSeconds === undefined) { return; }
    if (me.locAgeSeconds === null) { text(els.locTxt, t('rd.locNone')); return; }
    var line = me.live ? t('rd.locLive', { n: me.locAgeSeconds }) : t('rd.locStale');
    /* The fix is matched to the nearest sector centre, so the console says "around", never "in". */
    if (me.around && me.around.name) { line += ' · ' + t('rd.locAround', { where: me.around.name }); }
    text(els.locTxt, line);
  }

  function paintTabs() {
    var tabs = qa('#tabs button');
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].setAttribute('aria-selected', String(tabs[i].getAttribute('data-tab') === st.tab));
    }
    text(els.cntLive, st.active.length ? String(st.active.length) : '');
    text(els.cntHistory, st.history.length ? String(st.history.length) : '');
    text(els.cntStars, st.stats && st.stats.rating && st.stats.rating.count ? String(st.stats.rating.count) : '');
  }

  function paintFoot() {
    var me = st.me;
    if (!me || !me.state) { return; }
    text(els.meName, me.name || '—');
    /* The footer is one short line, so the leaf name shows and the full chain rides along as a tooltip. */
    text(els.meZone, me.area ? me.area.name : (me.zone || '—'));
    els.meZone.title = me.area ? me.area.label : '';
    text(els.meRating, me.rating ? t('rd.starsAvg', { n: me.rating }) : t('rd.starsNone'));
  }

  function paintPanel() {
    if (st.tab === 'live') { els.panel.innerHTML = listHtml(st.active, true, 'rd.none'); return; }
    if (st.tab === 'history') { els.panel.innerHTML = listHtml(st.history, false, 'rd.noHistory'); return; }
    if (st.tab === 'money') { els.panel.innerHTML = moneyHtml(); return; }
    if (st.tab === 'stars') { els.panel.innerHTML = starsHtml(); return; }
    els.panel.innerHTML = profileHtml();
    wireProfile();
  }

  function paint() {
    paintState();
    paintLoc();
    paintTabs();
    paintFoot();
    paintPanel();
  }

  /* ================================================================= money */

  function brow(label, value, max, money, amber) {
    var pct = max > 0 ? Math.round((value / max) * 100) : 0;
    return '<div class="brow' + (amber ? ' amber' : '') + '"><span>' + esc(label) + '</span>'
      + '<span class="track"><span class="fill" style="width:' + (value && pct < 4 ? 4 : pct) + '%"></span></span>'
      + '<b>' + esc(money) + '</b></div>';
  }

  function statTile(value, labelKey, cls) {
    return '<div class="stat ' + (cls || '') + '"><b>' + esc(value) + '</b><i>' + esc(t(labelKey)) + '</i></div>';
  }

  function moneyHtml() {
    var s = st.stats;
    if (!s) { return '<p class="subtle">' + esc(t('ad.statsErr')) + '</p>'; }
    /* Three periods of zero tiles is noise: a rider with no completed trip gets one line instead. */
    if (!((s.totals && s.totals.completed) || 0)) {
      return '<p class="subtle">' + esc(t('rd.moneyEmpty')) + '</p>';
    }
    var payouts = [];
    var html = '';
    for (var i = 0; i < PERIODS.length; i++) {
      var p = (s.periods || {})[PERIODS[i][0]] || {};
      payouts.push(p.payout_rwf || 0);
      html += '<section class="sect"><div class="sect-hd"><h2>' + esc(t(PERIODS[i][1])) + '</h2></div>';
      html += '<div class="stats">'
        + statTile(S.num(p.trips || 0), 'rd.done')
        + statTile(S.rwf(p.gross_rwf || 0), 'c.gross')
        + statTile(S.rwf(p.payout_rwf || 0), 'c.payout', 'pos')
        + statTile(S.rwf(p.collected_rwf || 0), 'c.collected')
        + '</div>';
      html += '<p class="subtle">' + esc(t('tp.distance')) + ': ' + esc(S.km(p.distance_km))
        + ' · ' + esc(t('c.commission')) + ': ' + esc(S.rwf(p.fee_rwf || 0)) + '</p>';
      html += '</section>';
    }
    var max = Math.max.apply(Math, payouts.concat([1]));
    html += '<section class="sect"><div class="sect-hd"><h2>' + esc(t('c.payout')) + '</h2></div><div class="bars">';
    for (var j = 0; j < PERIODS.length; j++) {
      html += brow(t(PERIODS[j][1]), payouts[j], max, S.rwf(payouts[j]), true);
    }
    html += '</div><p class="subtle">' + esc(t('c.commission')) + ': '
      + esc(String(s.commissionPercent)) + '% · ' + esc(t('rd.trips')) + ': '
      + esc(S.num((s.totals && s.totals.completed) || 0)) + '</p></section>';
    if (s.unbilled && s.unbilled.trips) {
      html += '<p class="msg msg-wait">' + S.icons.wait + '<span>'
        + esc(t('rd.unbilledBody', { n: s.unbilled.trips, rwf: S.rwf(s.unbilled.rwf) })) + '</span></p>';
    }
    return html;
  }

  /* ================================================================= stars */

  function starsHtml() {
    var r = (st.stats && st.stats.rating) || null;
    var html = '';
    if (!r || !r.count) {
      html += '<p class="subtle">' + esc(t('rd.starsNone')) + '</p>';
    } else {
      html += '<section class="sect"><div class="sect-hd"><h2>' + esc(t('rd.tabStars')) + '</h2>'
        + '<span class="grow"></span><span class="money">' + esc(t('rd.starsAvg', { n: r.average })) + '</span></div>'
        + S.stars(r.average)
        + ' <span class="subtle">' + esc(S.num(r.count) + ' · ' + t('rd.withComment', { n: r.withComments })) + '</span>';
      var max = 1;
      for (var i = 0; i < r.distribution.length; i++) { max = Math.max(max, r.distribution[i].count); }
      html += '<div class="bars" style="margin-top:12px">';
      for (var j = 0; j < r.distribution.length; j++) {
        var d = r.distribution[j];
        html += brow(d.stars + '★', d.count, max, S.num(d.count), false);
      }
      html += '</div></section>';
    }
    if (!st.ratings) { return html + '<div class="sk"><span class="l a"></span><span class="l b"></span></div>'; }
    if (!st.ratings.length) { return html; }
    html += '<section class="sect"><div class="rows">';
    for (var k = 0; k < st.ratings.length; k++) {
      var g = st.ratings[k];
      html += '<article class="row"><span class="av" aria-hidden="true">' + S.initials(g.passenger_name) + '</span>'
        + '<div class="who"><b>' + esc(g.passenger_name || '—') + '</b>'
        + ' <em>' + esc(t('ps.receipt', { id: g.request_id })) + '</em>'
        + '<div class="route">' + esc(g.origin || '') + ' <i aria-hidden="true">&rarr;</i> ' + esc(g.destination || '') + '</div>'
        + (g.comment ? '<p class="subtle">' + esc(g.comment) + '</p>' : '')
        + (g.fare_rwf ? '<div class="pairs">' + pair(t('tp.fare'), S.rwf(g.fare_rwf)) + '</div>' : '')
        + '</div><div class="tail">' + S.stars(g.stars)
        + '<em class="subtle">' + esc(S.stamp(g.created_at)) + '</em></div></article>';
    }
    return html + '</div></section>';
  }

  /* ================================================================ profile */

  function field(labelKey, inner, hint) {
    return '<div class="field"><label>' + esc(t(labelKey)) + '</label>' + inner
      + (hint ? '<p class="hint">' + esc(hint) + '</p>' : '') + '</div>';
  }

  function opts(values, label, current) {
    var out = '';
    for (var i = 0; i < values.length; i++) {
      out += '<option value="' + esc(values[i]) + '"' + (values[i] === current ? ' selected' : '') + '>'
        + esc(label(values[i])) + '</option>';
    }
    return out;
  }

  function profileHtml() {
    var me = st.me || {};
    var slots = me.availableSlots || [];
    var chips = '<div class="chips">';
    for (var i = 0; i < SLOTS.length; i++) {
      chips += '<button type="button" class="chip" data-slot="' + SLOTS[i][0] + '" aria-pressed="'
        + (slots.indexOf(SLOTS[i][0]) >= 0 ? 'true' : 'false') + '">' + esc(t(SLOTS[i][1])) + '</button>';
    }
    var html = '<form id="pfForm" autocomplete="off">';
    html += field('su.names', '<input type="text" id="pfNames" maxlength="80" value="' + esc(me.name || '') + '">');
    html += field('su.plate', '<input type="text" id="pfPlate" maxlength="12" value="' + esc(me.plate || '') + '">');
    html += field('su.type', '<select id="pfType">' + opts(['moto', 'car'], function (v) {
      return v === 'moto' ? t('su.moto') : t('su.car');
    }, me.vehicleType) + '</select>');
    html += field('rd.kDiv', '<div id="pfDiv"></div>', t('rd.divHint'));
    html += field('ad.kPrice', '<input type="number" id="pfPrice" min="100" max="2000" step="10" value="' + esc(me.pricePerKm || '') + '">', t('rd.priceHint'));
    html += field('ad.kServices', '<select id="pfSvc">' + opts(['ride', 'delivery', 'both'], function (v) {
      return t(S.SERVICES[v]);
    }, me.services) + '</select>');
    html += field('c.seats', '<input type="number" id="pfCap" min="1" max="8" step="1" value="' + esc(me.capacity || 1) + '">');
    html += field('rd.slots', chips + '</div>');
    html += '<p class="actions"><button class="btn btn-p" type="submit" id="pfSave">'
      + esc(t('rd.saveProfile')) + '</button><span class="subtle" id="pfMsg"></span></p>';
    html += '<p class="subtle">' + esc(t('ad.kCreated')) + ': ' + esc(S.stamp(me.createdAt || '')) + '</p>';
    html += '</form>';
    return html + docsHtml();
  }

  /* KYC photos go straight to the bucket: the API signs the PUT, then confirms the object exists. */
  function docsHtml() {
    var docs = st.docs || { configured: false, documents: [], maxBytes: 0 };
    var byKind = {};
    (docs.documents || []).forEach(function (doc) { byKind[doc.kind] = doc; });
    var html = '<section class="docs"><h3>' + esc(t('rd.docs')) + '</h3>'
      + '<p class="hint">' + esc(t('rd.docsHint')) + '</p>';
    if (!docs.configured) {
      return html + '<p class="subtle">' + esc(t('rd.docUnavailable')) + '</p></section>';
    }
    html += '<div class="rows">';
    for (var i = 0; i < DOCS.length; i++) {
      var kind = DOCS[i][0];
      var doc = byKind[kind] || null;
      var done = doc && doc.status === 'uploaded';
      html += '<article class="docrow">'
        + '<div class="grow"><b>' + esc(t(DOCS[i][1])) + '</b>'
        + '<em class="subtle">' + esc(done ? t('rd.docUploaded') : t('rd.docPending'))
        + (done && doc.bytes ? ' · ' + Math.max(1, Math.round(doc.bytes / 1024)) + ' KB' : '') + '</em></div>'
        + (done && doc.url ? '<a class="btn btn-ghost btn-s" href="' + esc(doc.url)
          + '" target="_blank" rel="noopener">' + esc(t('rd.docView')) + '</a>' : '')
        + '<button type="button" class="btn btn-quiet btn-s" data-pick="' + kind + '">'
        + esc(t(done ? 'rd.docReplace' : 'rd.docUpload')) + '</button>'
        + '<input type="file" accept="image/jpeg,image/png,image/webp" data-doc="' + kind + '" hidden>'
        + '</article>';
    }
    return html + '</div><p class="subtle" id="docMsg" role="status" aria-live="polite"></p></section>';
  }

  function uploadDoc(kind, input) {
    var file = input.files && input.files[0];
    input.value = '';
    var msg = q('#docMsg', els.panel);
    if (!file) { return; }
    if (DOC_TYPES.indexOf(file.type) < 0) {
      if (msg) { text(msg, t('rd.docType')); }
      return;
    }
    var max = (st.docs && st.docs.maxBytes) || 8 * 1048576;
    if (file.size > max) {
      if (msg) { text(msg, t('rd.docSize', { n: Math.round(max / 1048576) })); }
      return;
    }
    var btn = q('button[data-pick="' + kind + '"]', els.panel);
    var original = btn ? btn.textContent : '';
    if (btn) { btn.classList.add('loading'); btn.disabled = true; text(btn, t('rd.docUploading')); }
    if (msg) { text(msg, ''); }

    api('/api/drivers/me/documents/' + kind + '/upload-url', {
      method: 'POST', body: { content_type: file.type }, useToken: true
    }).then(function (ticket) {
      return fetch(ticket.uploadUrl, {
        method: 'PUT', headers: { 'Content-Type': file.type }, body: file
      }).then(function (res) {
        if (!res.ok) {
          var failure = new Error('upload');
          failure.code = 'document_not_uploaded';
          throw failure;
        }
        return api('/api/drivers/me/documents/' + kind + '/complete', { method: 'POST', useToken: true });
      });
    }).then(function (data) {
      st.docs = st.docs || { configured: true, documents: [] };
      var kept = (st.docs.documents || []).filter(function (doc) { return doc.kind !== kind; });
      kept.push(data.document);
      st.docs.documents = kept;
      say('ok', t('rd.docDone'));
      paintPanel();
    }, function (err) {
      if (gateOn(err)) { return; }
      if (btn) { btn.classList.remove('loading'); btn.disabled = false; text(btn, original); }
      if (msg) { text(msg, errText(err)); }
      say('err', errText(err));
    });
  }

  function pickedDivision() {
    return st.div ? st.div.value() : null;
  }

  function wireProfile() {
    var form = q('#pfForm', els.panel);
    if (!form) { return; }
    qa('button[data-slot]', form).forEach(function (chip) {
      chip.addEventListener('click', function () {
        chip.setAttribute('aria-pressed', chip.getAttribute('aria-pressed') === 'true' ? 'false' : 'true');
      });
    });
    qa('button[data-pick]', els.panel).forEach(function (btn) {
      btn.addEventListener('click', function () {
        var input = q('input[data-doc="' + btn.getAttribute('data-pick') + '"]', els.panel);
        if (input) { input.click(); }
      });
    });
    qa('input[data-doc]', els.panel).forEach(function (input) {
      input.addEventListener('change', function () {
        uploadDoc(input.getAttribute('data-doc'), input);
      });
    });
    /* The service area is one of Rwanda's own divisions, not a typed word: the code goes to
       PATCH /api/drivers/me and the server stores the label plus the province, district and sector. */
    var host = q('#pfDiv', form);
    st.div = null;
    if (host && window.SERE_DIVISIONS) {
      st.div = SERE_DIVISIONS.mount(host, {
        depth: 4,
        onChange: function () {
          S.fieldError(host.parentNode, pickedDivision() ? '' : t('rd.needDivision'));
        }
      });
      if (st.me && st.me.area) { st.div.set(st.me.area.code); }
    }
    var type = q('#pfType', form);
    var price = q('#pfPrice', form);
    /* The regulator sets motorcycle prices, so a moto rider cannot type a rate. */
    function priceState() {
      price.disabled = type.value === 'moto';
      if (price.disabled) { price.value = ''; }
    }
    type.addEventListener('change', priceState);
    priceState();
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      saveProfile(form);
    });
  }

  function saveProfile(form) {
    var names = q('#pfNames', form);
    var plate = q('#pfPlate', form);
    var type = q('#pfType', form);
    var price = q('#pfPrice', form);
    var cap = Number(q('#pfCap', form).value) || 1;
    cap = Math.min(8, Math.max(1, Math.round(cap)));
    q('#pfCap', form).value = String(cap);
    var slots = [];
    qa('button[data-slot][aria-pressed="true"]', form).forEach(function (chip) {
      slots.push(chip.getAttribute('data-slot'));
    });
    var picked = pickedDivision();
    S.fieldError(names.parentNode, S.isNames(names.value) ? '' : t('su.errNames'));
    S.fieldError(plate.parentNode, S.isPlate(plate.value) ? '' : t('su.errPlate'));
    if (st.div) { S.fieldError(q('#pfDiv', form).parentNode, picked ? '' : t('rd.needDivision')); }
    var body = {
      name: S.cleanNames(names.value),
      plate: S.normalizePlate(plate.value),
      vehicle_type: type.value,
      location_code: picked ? picked.code : '',
      services: q('#pfSvc', form).value,
      capacity: cap,
      available_slots: slots
    };
    if (type.value !== 'moto') {
      var rate = Number(price.value);
      S.fieldError(price.parentNode, rate >= 100 && rate <= 2000 ? '' : t('rd.errPrice'));
      body.price_per_km = Math.round(rate);
    }
    if (qa('.field.bad', form).length) { return; }
    var save = q('#pfSave', form);
    S.loading(save, true);
    api('/api/drivers/me', { method: 'PATCH', body: body, useToken: true }).then(function (data) {
      st.me = data.driver;
      S.loading(save, false);
      text(q('#pfMsg', form), t('c.saved'));
      say('ok', t('rd.profileSaved'));
      refresh(true);
    }, function (err) {
      S.loading(save, false);
      text(q('#pfMsg', form), '');
      if (gateOn(err)) { return; }
      if (err.code === 'plate_taken') { S.fieldError(q('#pfPlate', form).parentNode, errText(err)); }
      say('err', errText(err));
    });
  }

  /* ================================================================ banners */

  function say(kind, message) {
    var node = kind === 'err' ? els.err : els.board;
    S.banner(node, kind, message, kind === 'err' ? 'warn' : kind === 'ok' ? 'ok' : 'info');
    if (kind === 'err') { return; }
    if (timers.hide) { clearTimeout(timers.hide); }
    timers.hide = setTimeout(function () { S.hideBanner(els.board); }, 7000);
  }

  /* ================================================================== load */

  function loadSession() {
    if (!S.getToken()) {
      st.kind = 'none';
      showGate('none');
      return Promise.resolve(false);
    }
    return api('/api/auth/session').then(function (data) {
      var kind = (data && data.kind) || 'none';
      st.kind = kind;
      if (kind === 'passenger') { showGate('pax'); return false; }
      if (kind !== 'driver') { showGate('none'); return false; }
      st.me = data.driver;
      if (st.me.status === 'pending') { showGate('wait'); return false; }
      if (st.me.status === 'rejected') { showGate('rejected'); return false; }
      st.gate = '';
      visibleAll(true);
      return true;
    }, function () {
      st.kind = 'none';
      showGate('none');
      return false;
    });
  }

  function getRequests(scope) {
    return api('/api/drivers/me/requests?scope=' + scope, { useToken: true })
      .then(function (data) { return (data && data.requests) || []; });
  }

  function refresh(quiet) {
    if (st.kind !== 'driver' || st.gate !== '') { return; }
    if (!quiet) {
      skeleton();
      S.hideBanner(els.err);
      text(els.stateTxt, '…');
      text(els.locTxt, '…');
    }
    var docs = api('/api/drivers/me/documents', { useToken: true }).catch(function () {
      return { configured: false, documents: [] };
    });
    Promise.all([
      api('/api/drivers/me/stats', { useToken: true }),
      getRequests('active'),
      getRequests('history'),
      docs
    ]).then(function (res) {
      st.stats = res[0];
      st.me = res[0].driver || st.me;
      st.active = res[1];
      st.history = res[2];
      st.docs = res[3];
      if (st.tab === 'stars') { loadRatings(); }
      paint();
      startTimers();
    }, function (err) {
      if (gateOn(err)) { return; }
      say('err', errText(err));
      paint();
    });
  }

  function refreshActive() {
    if (st.kind !== 'driver' || st.gate !== '' || document.hidden) { return; }
    getRequests('active').then(function (rows) {
      st.active = rows;
      paintTabs();
      if (st.tab === 'live') { paintPanel(); }
      paintState();
    }, function () { /* the next poll retries; a dropped background call is not an error banner */ });
  }

  function loadRatings() {
    api('/api/drivers/me/ratings?limit=30', { useToken: true }).then(function (data) {
      st.ratings = (data && data.ratings) || [];
      if (st.tab === 'stars') { paintPanel(); }
    }, function (err) {
      st.ratings = [];
      if (!gateOn(err)) { say('err', errText(err)); }
      if (st.tab === 'stars') { paintPanel(); }
    });
  }

  function skeleton() {
    var html = '';
    for (var i = 0; i < 2; i++) {
      html += '<div class="sk"><span class="l a"></span><span class="l b"></span><span class="l c"></span></div>';
    }
    els.panel.innerHTML = html;
  }

  /* ================================================================ actions */

  function postStatus(id, status, button) {
    st.busy[id] = true;
    if (button) { S.loading(button, true); }
    api('/api/requests/' + id + '/status', {
      method: 'PATCH', body: { status: status }, useToken: true
    }).then(function (data) {
      var key = status === 'accepted' ? 'rd.accepted' : status === 'declined' ? 'rd.declined'
        : status === 'completed' ? 'rd.completed' : status === 'cancelled' ? 'rd.cancelled' : 'c.saved';
      if (data && data.driver) { st.me = data.driver; }
      say(status === 'cancelled' || status === 'declined' ? 'info' : 'ok', t(key));
      return Promise.all([getRequests('active'), getRequests('history'),
        api('/api/drivers/me/stats', { useToken: true })]);
    }, function (err) {
      delete st.busy[id];
      if (button) { S.loading(button, false); }
      if (gateOn(err)) { return null; }
      say('err', errText(err));
      return null;
    }).then(function (res) {
      if (!res) { return; }
      delete st.busy[id];
      st.active = res[0];
      st.history = res[1];
      st.stats = res[2];
      st.me = res[2].driver || st.me;
      paint();
    });
  }

  function setOnline(next) {
    S.loading(els.btnOnline, true);
    api('/api/drivers/me/online', { method: 'POST', body: { online: next }, useToken: true })
      .then(function (data) {
        st.me = data.driver;
        S.loading(els.btnOnline, false);
        say(next ? 'ok' : 'info', t(next ? 'rd.stateAvailable' : 'rd.stateOffline'));
        if (next) { askLocation(); }
        refresh(true);
      }, function (err) {
        S.loading(els.btnOnline, false);
        if (err.code === 'profile_incomplete') {
          say('err', errText(err));
          showTab('profile');
          return;
        }
        if (!gateOn(err)) { say('err', errText(err)); }
      });
  }

  function ready() {
    S.loading(els.btnReady, true);
    api('/api/drivers/me/ready', { method: 'POST', body: {}, useToken: true }).then(function (data) {
      st.me = data.driver;
      S.loading(els.btnReady, false);
      say('ok', t('rd.stateAvailable'));
      askLocation();
      refresh(true);
    }, function (err) {
      S.loading(els.btnReady, false);
      if (err.code === 'profile_incomplete') {
        say('err', errText(err));
        showTab('profile');
        return;
      }
      if (!gateOn(err)) { say('err', errText(err)); }
    });
  }

  function askLocation() {
    if (!navigator.geolocation) {
      text(els.locTxt, t('rd.locNone'));
      return;
    }
    text(els.locTxt, t('rd.locSending'));
    navigator.geolocation.getCurrentPosition(function (pos) {
      api('/api/drivers/me/location', {
        method: 'POST',
        body: {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: Math.round(pos.coords.accuracy)
        },
        useToken: true
      }).then(function (data) {
        st.me = data.driver;
        paintLoc();
      }, function (err) {
        if (!gateOn(err)) { say('err', errText(err)); }
        paintLoc();
      });
    }, function (pos) {
      text(els.locTxt, pos && pos.code === 1 ? t('rd.locDenied') : t('rd.locNone'));
    }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 });
  }

  function autoLocation() {
    var box = q('#chkAuto');
    if (!box || !box.checked || !st.me || !st.me.online || document.hidden) { return; }
    askLocation();
  }

  /* ================================================================ timers */

  function startTimers() {
    if (!timers.poll) { timers.poll = setInterval(refreshActive, POLL_MS); }
    if (!timers.loc) { timers.loc = setInterval(autoLocation, AUTO_LOC_MS); }
  }

  function stopTimers() {
    if (timers.poll) { clearInterval(timers.poll); timers.poll = null; }
    if (timers.loc) { clearInterval(timers.loc); timers.loc = null; }
  }

  /* ================================================================== wire */

  function showTab(name) {
    st.tab = name;
    try { localStorage.setItem(TAB_KEY, name); } catch (e) { /* private mode keeps defaults */ }
    if (name === 'stars' && !st.ratings) { loadRatings(); }
    paintTabs();
    paintPanel();
  }

  function wire() {
    els.btnRefresh.addEventListener('click', function () {
      if (st.tab === 'stars') { loadRatings(); }
      refresh(false);
    });
    els.btnLogout.addEventListener('click', logout);
    qa('#tabs button').forEach(function (tab) {
      tab.addEventListener('click', function () { showTab(tab.getAttribute('data-tab')); });
    });
    els.btnOnline.addEventListener('click', function () { setOnline(!(st.me && st.me.online)); });
    els.btnReady.addEventListener('click', ready);
    els.btnLoc.addEventListener('click', askLocation);
    q('#chkAuto').addEventListener('change', function (ev) {
      try { localStorage.setItem(AUTO_KEY, ev.target.checked ? '1' : '0'); } catch (e) { /* ignore */ }
      if (ev.target.checked) { autoLocation(); }
    });
    els.panel.addEventListener('click', function (ev) {
      var node = ev.target;
      while (node && node !== els.panel && !(node.getAttribute && node.getAttribute('data-act'))) {
        node = node.parentNode;
      }
      if (!node || node === els.panel) { return; }
      postStatus(node.getAttribute('data-id'), node.getAttribute('data-act'), node);
    });
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) { refreshActive(); }
    });
    S.onLang(function () {
      /* Division names arrive from the server in the language that was asked for, so switching has
         to re-read the rider's own row — repainting the local copy alone would strand the old one. */
      if (st.kind === 'driver' && st.gate === '') { refresh(true); } else { showGate(st.gate || 'none'); }
    });
  }

  /* ================================================================== boot */

  function init() {
    els = {
      gate: q('#gate'), gateIcon: q('#gateIcon'), gateTitle: q('#gateTitle'),
      gateBody: q('#gateBody'), gateCta: q('#gateCta'),
      area: q('#area'), stateBox: q('#stateBox'), stateTxt: q('#stateTxt'), statePlate: q('#statePlate'),
      availTxt: q('#availTxt'), btnOnline: q('#btnOnline'), btnReady: q('#btnReady'),
      locTxt: q('#locTxt'), btnLoc: q('#btnLoc'), board: q('#boardMsg'), err: q('#errMsg'),
      panel: q('#panel'),
      cntLive: q('#cntLive'), cntHistory: q('#cntHistory'), cntStars: q('#cntStars'),
      btnRefresh: q('#btnRefresh'), btnLogout: q('#btnLogout'),
      meName: q('#meName'), meZone: q('#meZone'), meRating: q('#meRating')
    };
    text(els.btnOnline, t('rd.goOnline'));
    text(els.btnReady, t('rd.ready'));
    text(els.btnLoc, t('rd.locSend'));
    try {
      q('#chkAuto').checked = localStorage.getItem(AUTO_KEY) !== '0';
      var saved = localStorage.getItem(TAB_KEY);
      if (saved && q('#tabs button[data-tab="' + saved + '"]')) { st.tab = saved; }
    } catch (e) { /* private mode keeps defaults */ }
    wire();
    loadSession().then(function (go) {
      if (go) { refresh(false); }
    });
  }

  S.onPage('rider', init);
}());
