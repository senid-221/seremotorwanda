/* SERE Moto — admin console. Drives /api/admin/stats, /api/admin/overview,
   /api/admin/applications(+decision), /api/admin/riders(+action),
   /api/admin/trips(+cancel), /api/admin/payments and /api/admin/passengers.
   Gating uses GET /api/auth/session so a passenger token is never dropped.
   Vanilla ES5 only; all copy lives in the I18N dictionary in auth.js. */
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

  var TAB_KEY = 'sere_admin_tab';
  var APP_STATUSES = ['pending', 'approved', 'rejected', 'all'];
  var APP_TAB_LABEL = { pending: 'ad.tabPending', approved: 'ad.tabApproved', rejected: 'ad.tabRejected', all: 'ad.tabAll' };
  var OPEN_TRIP = { new: 1, seen: 1, accepted: 1 };
  var PROVIDERS = ['mtn_momo', 'paystack'];
  var SCOPES = [['active', 'ps.scopeActive'], ['history', 'ps.scopeHistory'], ['all', 'ps.scopeAll']];
  var HIDE_MS = 7000;

  var els = {};
  var timers = { hide: null };

  var st = {
    kind: '', gate: '', me: null, tab: 'overview', pending: '',
    stats: null, overview: null, zones: [], busy: {}, loaded: {},
    apps: { status: 'pending', rows: null, openRow: '', formRow: '', docsRow: '', docs: null },
    riders: { q: '', status: '', vehicle: '', online: false, rows: null, openSuspend: '',
      division: '', picked: null, cascade: null },
    trips: { scope: 'active', kind: '', q: '', driverId: '', driverName: '', rows: null },
    pay: { status: '', provider: '', q: '', rows: null, totals: null },
    pax: { q: '', rows: null }
  };

  /* ================================================================ helpers */

  function pair(label, value) {
    return '<div><dt>' + esc(label) + '</dt><dd>' + esc(value) + '</dd></div>';
  }

  function statTile(value, labelKey, cls) {
    return '<div class="stat ' + (cls || '') + '"><b>' + esc(value) + '</b><i>' + esc(t(labelKey)) + '</i></div>';
  }

  function brow(label, value, max, money, amber) {
    var pct = max > 0 ? Math.round((value / max) * 100) : 0;
    return '<div class="brow' + (amber ? ' amber' : '') + '"><span>' + esc(label) + '</span>'
      + '<span class="track"><span class="fill" style="width:' + (value && pct < 4 ? 4 : pct) + '%"></span></span>'
      + '<b>' + esc(money) + '</b></div>';
  }

  function sect(titleKey, inner) {
    return '<section class="sect"><div class="sect-hd"><h2>' + esc(t(titleKey)) + '</h2></div>' + inner + '</section>';
  }

  function vehLabel(vt) {
    var v = S.VEHICLE[vt] || S.VEHICLE.moto;
    return S.getLang() === 'rw' ? v.rw : v.en;
  }

  function svcLabel(v) {
    if (!v) { return '—'; }
    return t(S.SERVICES[v] || 'ad.kServices');
  }

  function statusBadge(status) {
    return '<span class="badge b-' + esc(status || '') + '">'
      + esc(t(S.STATUS_LABEL[status] || 'ad.sTotal')) + '</span>';
  }

  function stateBadges(r) {
    var out = r.online
      ? '<span class="badge b-online">' + esc(t('ad.badOnline')) + '</span>'
      : '<span class="badge b-offline">' + esc(t('ad.badOffline')) + '</span>';
    if (r.onTrip) { out += ' <span class="badge b-accepted">' + esc(t('ad.badBusy')) + '</span>'; }
    return out;
  }

  function skHtml(n) {
    var html = '';
    for (var i = 0; i < n; i++) {
      html += '<div class="sk"><span class="l a"></span><span class="l b"></span><span class="l c"></span></div>';
    }
    return html;
  }

  function subtle(textValue) {
    return '<p class="subtle">' + esc(textValue) + '</p>';
  }

  function qs(base, params) {
    var out = base;
    for (var i = 0; i < params.length; i += 2) {
      if (params[i + 1]) { out += (out.indexOf('?') > -1 ? '&' : '?') + params[i] + '=' + encodeURIComponent(params[i + 1]); }
    }
    return out;
  }

  function opt(value, label, current) {
    return '<option value="' + esc(value) + '"' + (value === current ? ' selected' : '') + '>' + esc(label) + '</option>';
  }

  function feeOf(fareRwf) {
    if (fareRwf == null) { return '—'; }
    var pct = st.stats && st.stats.commissionPercent != null ? Number(st.stats.commissionPercent) : 0;
    return S.rwf(Math.round(fareRwf * pct / 100));
  }

  /* ================================================================== gate */

  function showGate(kind) {
    st.gate = kind;
    st.pending = '';
    els.panel.innerHTML = '';
    S.visible(els.gate, true);
    S.visible(els.area, false);
    S.visible(els.btnRefresh, false);
    S.visible(els.btnLogout, kind !== '401');
    var is401 = kind === '401';
    var isPax = kind === 'pax';
    els.gateIcon.innerHTML = S.icons[isPax ? 'user' : is401 ? 'out' : 'lock'];
    text(els.gateTitle, t(is401 ? 'ad.gate401Title' : 'ad.gate403Title'));
    if (is401) {
      S.visible(els.gateBody, false);
    } else {
      S.visible(els.gateBody, true);
      text(els.gateBody, t(isPax ? 'ad.paxGate' : 'ad.gate403Body'));
    }
    if (is401) {
      text(els.gateCta, t('ad.gate401Cta'));
      els.gateCta.className = 'btn btn-p';
      els.gateCta.onclick = function () { location.href = '/login'; };
    } else if (isPax) {
      text(els.gateCta, t('ab.mine'));
      els.gateCta.className = 'btn btn-p';
      els.gateCta.onclick = function () { location.href = '/passenger'; };
    } else {
      text(els.gateCta, t('ad.logout'));
      els.gateCta.className = 'btn btn-quiet';
      els.gateCta.onclick = logout;
    }
  }

  function logout() {
    S.clearToken();
    st.kind = '';
    st.me = null;
    st.stats = null;
    st.overview = null;
    st.loaded = {};
    st.apps.rows = null;
    st.riders.rows = null;
    st.trips.rows = null;
    st.pay.rows = null;
    st.pax.rows = null;
    S.hideBanner(els.board);
    S.hideBanner(els.err);
    showGate('401');
  }

  /* A 401/403 from any console call means the session, not the button, changed. */
  function gateOn(err) {
    if (err.status === 401) { showGate('401'); return true; }
    if (err.status === 403) { showGate('403'); return true; }
    return false;
  }

  /* ============================================================== banners */

  function sayBoard(kind, message) {
    S.banner(els.board, kind, message, kind === 'ok' ? 'ok' : 'info');
    if (timers.hide) { clearTimeout(timers.hide); }
    timers.hide = setTimeout(function () { S.hideBanner(els.board); }, HIDE_MS);
  }

  function sayErr(message) {
    S.banner(els.err, 'err', message, 'warn');
    var again = document.createElement('button');
    again.type = 'button';
    again.className = 'mini';
    again.style.marginLeft = '6px';
    again.textContent = t('c.retry');
    again.addEventListener('click', function () {
      S.hideBanner(els.err);
      loadData(st.tab, false);
    });
    els.err.appendChild(again);
  }

  /* ================================================================ loading */

  /* One loader front door: quiet = keep the current paint until fresh data
     arrives, so the refresh button never flashes skeletons. */
  function loadData(name, quiet) {
    if (st.gate !== '') { return; }
    if (!quiet) {
      st.pending = name;
      if (st.tab === name) { els.panel.innerHTML = skHtml(name === 'overview' ? 3 : 2); }
      S.hideBanner(els.err);
    }
    work(name, quiet).then(function () {
      st.pending = '';
      st.loaded[name] = true;
      if (st.tab === name || name === 'overview') { paint(); } else { paintTabs(); }
    }, function (err) {
      st.pending = '';
      if (gateOn(err)) { return; }
      sayErr(errText(err) + ' ' + t(name === 'overview' ? 'ad.statsErr' : 'ad.listErr'));
      if (st.tab === name) { paintPanel(); }
    });
  }

  function work(name) {
    if (name === 'overview') {
      return Promise.all([
        api('/api/admin/stats', { useToken: true }),
        api('/api/admin/overview', { useToken: true })
      ]).then(function (res) {
        st.stats = res[0];
        st.overview = res[1];
      });
    }
    if (name === 'apps') {
      return appsFetch().then(function (rows) {
        st.apps.rows = rows;
        st.apps.openRow = '';
        st.apps.formRow = '';
        return refreshStats();
      });
    }
    if (name === 'riders') {
      return api(ridersUrl(), { useToken: true }).then(function (data) {
        st.riders.rows = (data && data.riders) || [];
        st.riders.picked = (data && data.division) || null;
      });
    }
    if (name === 'trips') {
      return api(tripsUrl(), { useToken: true }).then(function (data) {
        st.trips.rows = (data && data.trips) || [];
      });
    }
    if (name === 'payments') {
      return api(payUrl(), { useToken: true }).then(function (data) {
        st.pay.rows = (data && data.payments) || [];
        st.pay.totals = (data && data.totals) || null;
      });
    }
    return api(paxUrl(), { useToken: true }).then(function (data) {
      st.pax.rows = (data && data.passengers) || [];
    });
  }

  function refreshStats() {
    return api('/api/admin/stats', { useToken: true }).then(function (data) {
      st.stats = data;
      paintTabs();
      paintFoot();
    }, function () { /* the list is more important than the tiles */ });
  }

  function fetchOneApps(status) {
    return api('/api/admin/applications?status=' + status, { useToken: true })
      .then(function (data) { return (data && data.applications) || []; });
  }

  function appsFetch() {
    if (st.apps.status !== 'all') { return fetchOneApps(st.apps.status); }
    /* the API answers one status per call, so "all" is stitched together */
    return Promise.all([fetchOneApps('pending'), fetchOneApps('approved'), fetchOneApps('rejected')])
      .then(function (parts) { return parts[0].concat(parts[1], parts[2]); });
  }

  function ridersUrl() {
    return qs('/api/admin/riders', [
      'status', st.riders.status,
      'vehicle_type', st.riders.vehicle,
      'online', st.riders.online ? '1' : '',
      'division', st.riders.division,
      'q', st.riders.q
    ]);
  }

  function tripsUrl() {
    return qs('/api/admin/trips', [
      'scope', st.trips.scope,
      'kind', st.trips.kind,
      'driver_id', st.trips.driverId,
      'q', st.trips.q,
      'limit', '80'
    ]);
  }

  function payUrl() {
    return qs('/api/admin/payments', [
      'status', st.pay.status,
      'provider', st.pay.provider,
      'q', st.pay.q,
      'limit', '80'
    ]);
  }

  function paxUrl() {
    return qs('/api/admin/passengers', ['q', st.pax.q, 'limit', '100']);
  }

  /* ============================================================== overview */

  function sparkHtml(series) {
    var max = 1;
    var i;
    for (i = 0; i < series.length; i++) { if (series[i].grossRwf > max) { max = series[i].grossRwf; } }
    var html = '<div class="spark">';
    for (i = 0; i < series.length; i++) {
      var r = series[i];
      var h = Math.max(3, Math.round((r.grossRwf / max) * 64));
      html += '<div title="' + esc(S.rwf(r.grossRwf)) + '"><i style="height:' + h + 'px"></i>'
        + '<em>' + esc(String(r.day).slice(8)) + '</em></div>';
    }
    return html + '</div>';
  }

  function barsHtml(rows, labelOf, valueOf, moneyOf, amber) {
    var max = 1;
    var i;
    for (i = 0; i < rows.length; i++) { if (valueOf(rows[i]) > max) { max = valueOf(rows[i]); } }
    var html = '<div class="bars">';
    for (i = 0; i < rows.length; i++) {
      html += brow(labelOf(rows[i]), valueOf(rows[i]), max, moneyOf(rows[i]), amber);
    }
    return html + '</div>';
  }

  function overviewHtml() {
    if (!st.stats || !st.overview) { return subtle(t('ad.noData')); }
    var s = st.stats;
    var o = st.overview;
    var d = s.drivers || {};
    var p = s.payments || {};
    var px = s.passengers || {};
    var td = s.today || {};
    var html = '<div class="stats">'
      + statTile(S.num(d.pending || 0), 'ad.sPending', 'hot')
      + statTile(S.num(d.online || 0), 'ad.sOnline')
      + statTile(S.num(d.withPassenger || 0), 'ad.sBusy')
      + statTile(S.rwf(td.gross_rwf), 'ad.sGrossToday', 'pos')
      + statTile(S.rwf(p.commissionRwf), 'ad.sCommission')
      + statTile(S.rwf(p.driverPayoutRwf), 'ad.sPayout')
      + statTile(S.num(px.accounts || 0), 'ad.sPax')
      + statTile(String(px.averageStars || 0), 'ad.sStars')
      + '</div>' + S.stars(px.averageStars || 0);

    var sum = 0;
    var i;
    for (i = 0; i < o.series.length; i++) { sum += o.series[i].grossRwf; }
    html += '<section class="sect"><div class="sect-hd"><h2>' + esc(t('ad.sevenDays')) + '</h2>'
      + '<span class="grow"></span><span class="money">' + esc(S.rwf(sum)) + '</span></div>'
      + sparkHtml(o.series) + '</section>';

    if (o.byZone.length) {
      html += sect('ad.zoneSplit', barsHtml(o.byZone,
        function (r) { return r.zone + ' · ' + S.num(r.trips); },
        function (r) { return r.gross_rwf; },
        function (r) { return S.rwf(r.gross_rwf); }, false));
    }
    if (o.byProvider.length) {
      html += sect('ad.payProvider', barsHtml(o.byProvider,
        function (r) { return r.provider + ' · ' + t(S.PAY_STATUS[r.status] || 'tp.payment'); },
        function (r) { return r.rwf; },
        function (r) { return S.num(r.count) + ' · ' + S.rwf(r.rwf); }, false));
    }
    if (o.byKind.length) {
      html += sect('ad.kindSplit', barsHtml(o.byKind,
        function (r) { return t(S.KIND_LABEL[r.kind] || 'tp.kind'); },
        function (r) { return r.gross_rwf; },
        function (r) { return S.num(r.count) + ' · ' + S.rwf(r.gross_rwf); }, false));
    }
    if (o.topRiders.length) {
      var rows = '<div class="rows">';
      for (i = 0; i < o.topRiders.length; i++) {
        var r = o.topRiders[i];
        rows += '<article class="row"><span class="av" aria-hidden="true">' + S.initials(r.name) + '</span>'
          + '<div class="who"><b>' + esc(r.name) + '</b>'
          + '<em><span class="plate">' + esc(r.plate || '—') + '</span> '
          + esc(r.area ? r.area.name : (r.zone || '—')) + '</em></div>'
          + '<div class="tail"><span class="money">' + esc(S.rwf(r.gross_rwf)) + '</span>'
          + '<em class="subtle">' + esc(t('ad.riderTrips', { n: S.num(r.trips), gross: S.rwf(r.gross_rwf) })) + '</em>'
          + '<button type="button" class="mini" data-act="tripsOf" data-id="' + esc(r.id) + '" data-name="' + esc(r.name) + '">'
          + esc(t('ad.tabTrips')) + '</button></div></article>';
      }
      html += sect('ad.topRiders', rows + '</div>');
    }
    var wh = o.webhooks || {};
    html += '<div class="stats" style="margin-top:16px">'
      + statTile(S.num(wh.received || 0), 'ad.webhooksSeen')
      + statTile(S.num(wh.failed || 0), 'ad.webhooksFailed', wh.failed ? 'hot' : '')
      + '</div>';
    return html;
  }

  /* ================================================================= apps */

  function appTabsHtml() {
    var d = (st.stats && st.stats.drivers) || null;
    var counts = d ? { pending: d.pending, approved: d.approved, rejected: d.rejected, all: (d.pending || 0) + (d.approved || 0) + (d.rejected || 0) } : null;
    var html = '<div class="tabs" id="appTabs" role="tablist">';
    for (var i = 0; i < APP_STATUSES.length; i++) {
      var s = APP_STATUSES[i];
      html += '<button type="button" role="tab" data-act="appStatus" data-status="' + s + '"'
        + ' aria-selected="' + (st.apps.status === s ? 'true' : 'false') + '">'
        + '<span>' + esc(t(APP_TAB_LABEL[s])) + '</span>'
        + '<em>' + esc(counts ? String(counts[s] || 0) : '') + '</em></button>';
    }
    return html + '</div>';
  }

  /* The three verdicts RRA, NIDA and the phone check left on this application. Each pill is
     the button that re-runs its own lookup, so an admin can retry a check that was unavailable
     when the rider signed up without leaving the queue. */
  var KYC_PILLS = [['tin', 'ad.kycTin'], ['id', 'ad.kycId'], ['phone', 'ad.kycPhone']];

  function kycPillHtml(id, check, labelKey, verdict, evidence) {
    var cls = verdict === 'pass' ? ' pass' : verdict === 'fail' ? ' fail' : '';
    var word = verdict === 'pass' ? t('ad.kycPass') : verdict === 'fail' ? t('ad.kycFail')
      : verdict === 'unavailable' ? t('ad.kycWait') : t('ad.kycNone');
    var mark = verdict === 'pass' ? S.icons.ok : verdict === 'fail' ? S.icons.warn : '';
    return '<button type="button" class="kv' + cls + '" data-act="kyc" data-check="' + check + '"'
      + ' data-id="' + id + '" title="' + esc(evidence || t('ad.kycAgain')) + '">'
      + mark + '<span>' + esc(t(labelKey)) + ' · ' + esc(word) + '</span></button>';
  }

  function kycRowHtml(a) {
    var k = a.kyc || {};
    var html = '<div class="kycstate">';
    for (var i = 0; i < KYC_PILLS.length; i++) {
      var check = KYC_PILLS[i][0];
      var evidence = check === 'tin' ? k.taxpayer : check === 'id' ? k.idName : k.operator;
      html += kycPillHtml(a.id, check, KYC_PILLS[i][1], k[check] || 'unchecked', evidence);
    }
    return html + '</div>';
  }

  function kycVerify(id, check, button) {
    var key = 'kyc' + id + check;
    if (st.busy[key]) { return; }
    st.busy[key] = true;
    if (button) { button.classList.add('loading'); button.setAttribute('disabled', 'disabled'); }
    api('/api/admin/applications/' + id + '/verify', { body: { check: check }, useToken: true })
      .then(function (data) {
        delete st.busy[key];
        var i = findApp(id);
        if (i > -1 && data && data.application) { st.apps.rows[i] = data.application; }
        paintPanel();
      }, function (err) {
        delete st.busy[key];
        if (button) { button.classList.remove('loading'); button.removeAttribute('disabled'); }
        if (gateOn(err)) { return; }
        sayErr(errText(err));
      });
  }

  function docsBoxHtml() {
    var data = st.apps.docs;
    var html = '<div class="docsbox">';
    if (!data) {
      return html + '<p class="rownote rownote-info">' + esc(t('c.loading')) + '</p></div>';
    }
    if (!data.configured) {
      return html + '<p class="rownote rownote-err">' + esc(t('rd.docUnavailable')) + '</p></div>';
    }
    if (!data.documents.length) {
      return html + '<p class="rownote rownote-info">' + esc(t('ad.docsNone')) + '</p></div>';
    }
    html += '<div class="doclinks">';
    for (var i = 0; i < data.documents.length; i++) {
      var doc = data.documents[i];
      var label = doc.kind === 'national_id' ? t('rd.docNationalId')
        : doc.kind === 'driving_licence' ? t('rd.docLicence') : t('rd.docPlate');
      var ready = doc.status === 'uploaded' && doc.url;
      html += '<a class="btn btn-ghost btn-s" href="' + esc(ready ? doc.url : '#') + '"'
        + (ready ? ' target="_blank" rel="noopener"' : ' aria-disabled="true"')
        + '>' + esc(label) + ' · ' + esc(t(ready ? 'rd.docView' : 'rd.docPending')) + '</a>';
    }
    return html + '</div></div>';
  }

  function loadAppDocs(id) {
    api('/api/admin/riders/' + id + '/documents', { useToken: true }).then(function (data) {
      if (String(st.apps.docsRow) !== String(id)) { return; }
      st.apps.docs = data;
      paintPanel();
    }, function (err) {
      sayErr(errText(err));
    });
  }

  function appRowHtml(a) {
    var id = a.id;
    var pending = a.status === 'pending';
    var openReason = String(st.apps.openRow) === String(id);
    var openForm = String(st.apps.formRow) === String(id);
    var busy = !!st.busy['app' + id];
    var busyAttr = busy ? ' disabled' : '';

    var html = '<article class="app" id="app-' + id + '" data-id="' + id + '">';
    html += '<div class="app-top">'
      + '<span class="av" aria-hidden="true">' + S.initials(a.name) + '</span>'
      + '<div class="who"><b>' + esc(a.name || '') + '</b>'
      + '<em><span class="badge b-' + esc(a.vehicleType) + '">' + esc(vehLabel(a.vehicleType)) + '</span>'
      + '<span class="plate">' + esc(a.plate || '') + '</span>'
      + statusBadge(a.status)
      + '<a href="' + esc(S.telHref(a.phone)) + '">' + esc(a.phone || '') + '</a>'
      + '</em></div></div>';

    html += '<dl class="kyc">';
    html += pair(t('ad.kId'), a.idNumber || '—');
    html += pair(t('ad.kTin'), a.tinNumber || '—');
    html += pair(t('ad.kCreated'), S.stamp(a.createdAt));
    if (a.reviewedAt) { html += pair(t('ad.kReviewed'), S.stamp(a.reviewedAt)); }
    html += pair(t('ad.kPhone'), a.phone || '—');
    if (a.zone || a.area || a.pricePerKm || a.services) {
      html += pair(t('ad.kZone'), a.area ? a.area.label : (a.zone || '—'));
      html += pair(t('ad.kPrice'), a.pricePerKm ? S.rwf(a.pricePerKm) : '—');
      html += pair(t('ad.kServices'), svcLabel(a.services));
    }
    html += pair(t('ad.kGoogle'), a.hasGoogle ? t('ad.yes') : t('ad.no'));
    html += '</dl>';
    html += kycRowHtml(a);

    html += '<div class="decide">'
      + '<button type="button" class="btn btn-quiet btn-s" data-act="docs" data-id="' + id + '">'
      + esc(t('rd.docs')) + '</button></div>';
    if (String(st.apps.docsRow) === String(id)) { html += docsBoxHtml(); }

    if (a.reason) { html += '<p class="app-reason">' + esc(a.reason) + '</p>'; }

    if (pending) {
      html += '<div class="decide">'
        + '<button type="button" class="btn btn-ok btn-s' + (busy ? ' loading' : '') + '" data-act="approve" data-id="' + id + '"' + busyAttr + '>'
        + S.icons.ok + '<span>' + esc(t('ad.approve')) + '</span></button>'
        + '<button type="button" class="btn btn-no btn-s" data-act="reject" data-id="' + id + '">'
        + '<span>' + esc(t('ad.reject')) + '</span></button>'
        + '</div>';
    } else {
      html += '<div class="decide"><p class="rownote rownote-info">' + esc(t('ad.reviewed')) + '</p></div>';
    }

    if (openReason && pending) {
      html += '<div class="reasonbox" id="reason-' + id + '">'
        + '<div><label for="r-' + id + '">' + esc(t('ad.reasonLbl')) + '</label>'
        + '<textarea id="r-' + id + '" maxlength="300" placeholder="' + esc(t('ad.reasonPh')) + '"></textarea></div>'
        + '<div class="lbl">' + esc(t('ad.reasonQuick')) + '</div>'
        + '<div class="chips">'
        + '<button type="button" class="chip" data-fill="' + id + '" data-text="' + esc(t('ad.r1')) + '">' + esc(t('ad.r1')) + '</button>'
        + '<button type="button" class="chip" data-fill="' + id + '" data-text="' + esc(t('ad.r2')) + '">' + esc(t('ad.r2')) + '</button>'
        + '<button type="button" class="chip" data-fill="' + id + '" data-text="' + esc(t('ad.r3')) + '">' + esc(t('ad.r3')) + '</button>'
        + '</div>'
        + '<p class="rownote rownote-err" id="rerr-' + id + '" hidden></p>'
        + '<div class="decide">'
        + '<button type="button" class="btn btn-no btn-s" data-act="reject-send" data-id="' + id + '">' + esc(t('ad.sendReject')) + '</button>'
        + '<button type="button" class="btn btn-quiet btn-s" data-act="cancel" data-id="' + id + '">' + esc(t('ad.cancel')) + '</button>'
        + '</div></div>';
    }

    if (openForm && pending) {
      html += '<div class="reasonbox" id="form-' + id + '">'
        + '<p class="rownote rownote-info">' + esc(t('ad.incompleteBody')) + '</p>'
        + '<div class="grid2">'
        + '<div><label for="z-' + id + '">' + esc(t('ad.kZone')) + '</label>'
        + '<input id="z-' + id + '" list="zoneList" value="' + esc(a.zone || '') + '"></div>'
        + '<div><label for="p-' + id + '">' + esc(t('ad.kPrice')) + ' (RWF)</label>'
        + '<input id="p-' + id + '" class="num" type="number" min="100" max="2000" step="10" value="' + esc(a.pricePerKm || 300) + '"></div>'
        + '</div>'
        + '<div><label for="s-' + id + '">' + esc(t('ad.kServices')) + '</label>'
        + '<select id="s-' + id + '"><option value="ride">' + esc(t('ad.svcRide')) + '</option>'
        + '<option value="delivery">' + esc(t('ad.svcDelivery')) + '</option>'
        + '<option value="both">' + esc(t('ad.svcBoth')) + '</option></select></div>'
        + '<p class="rownote rownote-err" id="ferr-' + id + '" hidden></p>'
        + '<div class="decide">'
        + '<button type="button" class="btn btn-ok btn-s" data-act="approve-send" data-id="' + id + '">' + esc(t('ad.saveApprove')) + '</button>'
        + '<button type="button" class="btn btn-quiet btn-s" data-act="cancel" data-id="' + id + '">' + esc(t('ad.cancel')) + '</button>'
        + '</div></div>';
    }

    return html + '</article>';
  }

  function appsHtml() {
    var html = appTabsHtml();
    if (st.apps.rows === null) { return html + skHtml(2); }
    if (!st.apps.rows.length) {
      return html + '<div class="empty">' + S.icons.inbox + '<span>' + esc(t('ad.empty')) + '</span></div>';
    }
    html += '<div class="apps">';
    for (var i = 0; i < st.apps.rows.length; i++) { html += appRowHtml(st.apps.rows[i]); }
    return html + '</div>';
  }

  function findApp(id) {
    var rows = st.apps.rows || [];
    for (var i = 0; i < rows.length; i++) {
      if (String(rows[i].id) === String(id)) { return i; }
    }
    return -1;
  }

  function rowError(prefix, id, message) {
    var box = q('#rerr-' + id) || q('#ferr-' + id);
    if (box) {
      box.textContent = message;
      S.visible(box, true);
    } else {
      sayErr(message);
    }
  }

  function decision(id, body, button) {
    st.busy['app' + id] = true;
    if (button) { S.loading(button, true); }
    api('/api/admin/applications/' + id + '/decision', { body: body, useToken: true }).then(function (data) {
      delete st.busy['app' + id];
      if (button) { S.loading(button, false); }
      if (data && data.application) {
        var i = findApp(id);
        if (i > -1) { st.apps.rows[i] = data.application; }
      }
      st.apps.openRow = '';
      st.apps.formRow = '';
      refreshStats();
      paintPanel();
    }, function (err) {
      delete st.busy['app' + id];
      if (button) { S.loading(button, false); }
      if (gateOn(err)) { return; }
      if (err.code === 'incomplete_profile') {
        st.apps.formRow = id;
        st.apps.openRow = '';
        paintPanel();
        var prefill = q('#p-' + id);
        if (prefill && !prefill.value) { prefill.value = '300'; }
        if (prefill) { prefill.focus(); }
        return;
      }
      if (err.code === 'already_reviewed') {
        loadData('apps', false);
        return;
      }
      rowError('rerr', id, errText(err));
    });
  }

  function appsClick(act, id, node) {
    var appIndex = findApp(id);
    var app = appIndex > -1 ? st.apps.rows[appIndex] : null;
    if (act === 'appStatus') {
      st.apps.status = node.getAttribute('data-status');
      loadData('apps', false);
      return;
    }
    if (!app) { return; }
    if (act === 'kyc') {
      var check = node.getAttribute('data-check');
      if (check) { kycVerify(id, check, node); }
      return;
    }
    if (act === 'docs' || act === 'docsClose') {
      var open = act === 'docs' && String(st.apps.docsRow) !== String(id);
      st.apps.docsRow = open ? id : '';
      st.apps.docs = null;
      paintPanel();
      if (open) { loadAppDocs(id); }
      return;
    }
    if (act === 'reject') {
      st.apps.openRow = String(st.apps.openRow) === String(id) ? '' : id;
      st.apps.formRow = '';
      paintPanel();
      var area = q('#r-' + id);
      if (area) { area.focus(); }
      return;
    }
    if (act === 'cancel') {
      st.apps.openRow = '';
      st.apps.formRow = '';
      paintPanel();
      return;
    }
    if (act === 'approve') {
      decision(id, { action: 'approve' }, node);
      return;
    }
    if (act === 'reject-send') {
      var area2 = q('#r-' + id);
      var reason = area2 ? S.cleanNames(area2.value) : '';
      if (reason.length < 3) { rowError('rerr', id, S.ecOf('invalid_reason')); return; }
      decision(id, { action: 'reject', reason: reason }, node);
      return;
    }
    if (act === 'approve-send') {
      var zone = S.cleanNames(q('#z-' + id).value);
      var services = q('#s-' + id).value;
      var price = parseInt(q('#p-' + id).value, 10);
      if (zone.length < 2) { rowError('ferr', id, t('ad.kZone') + ' — ' + t('ad.missing')); return; }
      if (!(price >= 100 && price <= 2000)) { rowError('ferr', id, t('ad.kPrice') + ' — ' + t('ad.missing')); return; }
      decision(id, {
        action: 'approve', zone: zone, services: services, price_per_km: price
      }, node);
    }
  }

  /* =============================================================== riders */

  function finderHtml(kind) {
    var ph = esc(t('ad.searchPh'));
    var go = '<button class="btn btn-p btn-s" type="button" data-act="' + kind + 'Go">' + esc(t('c.search')) + '</button>';
    if (kind === 'rider') {
      /* The division filter is the country's own tree — one dropdown per level — and it keeps the
         riders who work there or were last seen there, exactly like the booking page's picker. */
      var count = st.riders.picked
        ? '<p class="subtle">' + esc(t('ad.divCount', {
          where: st.riders.picked.name, n: S.num((st.riders.rows || []).length)
        })) + '</p>'
        : '';
      return '<div class="finder">'
        + '<input type="search" id="riderQ" placeholder="' + ph + '" value="' + esc(st.riders.q) + '" aria-label="' + esc(t('c.search')) + '">'
        + go
        + '<select id="riderStatus" aria-label="' + esc(t('tp.status')) + '">'
        + opt('', t('c.all'), st.riders.status)
        + opt('pending', t('ad.tabPending'), st.riders.status)
        + opt('approved', t('ad.tabApproved'), st.riders.status)
        + opt('rejected', t('ad.tabRejected'), st.riders.status)
        + '</select>'
        + '<select id="riderVehicle" aria-label="' + esc(t('su.type')) + '">'
        + opt('', t('c.all'), st.riders.vehicle)
        + opt('moto', t('su.moto'), st.riders.vehicle)
        + opt('car', t('su.car'), st.riders.vehicle)
        + '</select>'
        + '<label class="switch" for="riderOnline"><input type="checkbox" id="riderOnline"'
        + (st.riders.online ? ' checked' : '') + '><span>' + esc(t('ad.filterOnline')) + '</span></label>'
        + '</div><div id="riderDiv"></div>' + count;
    }
    if (kind === 'trip') {
      var tabs = '<div class="tabs x3" role="tablist">';
      for (var i = 0; i < SCOPES.length; i++) {
        tabs += '<button type="button" role="tab" data-act="tripScope" data-scope="' + SCOPES[i][0] + '"'
          + ' aria-selected="' + (st.trips.scope === SCOPES[i][0] ? 'true' : 'false') + '">'
          + '<span>' + esc(t(SCOPES[i][1])) + '</span><em></em></button>';
      }
      tabs += '</div>';
      if (st.trips.driverId) {
        tabs += '<div class="ctl"><span class="grow">' + esc(t('ad.tripsOf', { name: st.trips.driverName || st.trips.driverId })) + '</span>'
          + '<button class="btn btn-quiet btn-s" type="button" data-act="tripsClearRider">' + esc(t('c.close')) + '</button></div>';
      }
      return tabs + '<div class="finder">'
        + '<input type="search" id="tripQ" placeholder="' + ph + '" value="' + esc(st.trips.q) + '" aria-label="' + esc(t('c.search')) + '">'
        + go
        + '<select id="tripKind" aria-label="' + esc(t('tp.kind')) + '">'
        + opt('', t('c.all'), st.trips.kind)
        + opt('ride', t('tp.ride'), st.trips.kind)
        + opt('delivery', t('tp.delivery'), st.trips.kind)
        + '</select></div>';
    }
    if (kind === 'pay') {
      /* provider names are brand identifiers and stay untranslated */
      var pOpts = opt('', t('c.all'), st.pay.provider);
      for (var p = 0; p < PROVIDERS.length; p++) { pOpts += opt(PROVIDERS[p], PROVIDERS[p], st.pay.provider); }
      return '<div class="finder">'
        + '<input type="search" id="payQ" placeholder="' + ph + '" value="' + esc(st.pay.q) + '" aria-label="' + esc(t('c.search')) + '">'
        + go
        + '<select id="payStatus" aria-label="' + esc(t('tp.status')) + '">'
        + opt('', t('c.all'), st.pay.status)
        + '<option value="pending"' + (st.pay.status === 'pending' ? ' selected' : '') + '>' + esc(t('pay.pending')) + '</option>'
        + '<option value="paid"' + (st.pay.status === 'paid' ? ' selected' : '') + '>' + esc(t('pay.paid')) + '</option>'
        + '<option value="failed"' + (st.pay.status === 'failed' ? ' selected' : '') + '>' + esc(t('pay.failed')) + '</option>'
        + '<option value="refunded"' + (st.pay.status === 'refunded' ? ' selected' : '') + '>' + esc(t('pay.refunded')) + '</option>'
        + '</select>'
        + '<select id="payProvider" aria-label="' + esc(t('ad.payProvider')) + '">' + pOpts + '</select>'
        + '</div>';
    }
    return '<div class="finder">'
      + '<input type="search" id="paxQ" placeholder="' + ph + '" value="' + esc(st.pax.q) + '" aria-label="' + esc(t('c.search')) + '">'
      + go + '</div>';
  }

  /* One line for where a rider is: the division they registered, plus — when the tracker has a fix —
     where they were last seen. A centroid match, so it says "near", never "in". */
  function whereText(r) {
    var bits = [];
    if (r.area && r.area.label) { bits.push(r.area.label); }
    else if (r.zone) { bits.push(r.zone); }
    if (r.around && r.around.name) { bits.push(t('ad.seenNear', { where: r.around.name })); }
    return bits.length ? bits.join(' · ') : '—';
  }

  function riderRowHtml(r) {
    var id = r.id;
    var busy = !!st.busy['r' + id];
    var busyAttr = busy ? ' disabled' : '';
    var loadingCls = busy ? ' loading' : '';
    var html = '<article class="row" id="rider-' + id + '">';
    html += '<span class="av" aria-hidden="true">' + S.initials(r.name) + '</span>';
    html += '<div class="who"><b>' + esc(r.name || '') + '</b>'
      + '<em><span class="plate">' + esc(r.plate || '—') + '</span>'
      + '<span class="badge b-' + esc(r.vehicleType) + '">' + esc(vehLabel(r.vehicleType)) + '</span>'
      + statusBadge(r.status) + stateBadges(r)
      + '</em>'
      + '<p class="subtle">' + esc(whereText(r)) + (r.isAdmin ? ' · ' + t('ab.admin') : '') + '</p>';
    html += '<div class="pairs">'
      + pair(t('rd.done'), S.num(r.tripsCompleted || 0))
      + pair(t('c.gross'), S.rwf(r.grossRwf || 0))
      + pair(t('ad.payoutAll'), S.rwf(r.payoutRwf || 0))
      + pair(t('ad.sStars'), r.rating ? r.rating + ' ★' : '—')
      + '</div>';
    html += '<div class="acts">';
    if (r.phone) {
      html += '<a class="btn btn-ghost btn-s" href="' + esc(S.telHref(r.phone)) + '">' + esc(t('c.call')) + '</a>';
    }
    html += '<button type="button" class="btn btn-ghost btn-s" data-act="tripsOf" data-id="' + esc(id) + '" data-name="' + esc(r.name) + '">'
      + esc(t('ad.tabTrips')) + '</button>';
    if (!r.isAdmin) {
      if (r.status !== 'rejected') {
        html += '<button type="button" class="btn btn-no btn-s" data-act="suspendOpen" data-id="' + id + '">' + esc(t('ad.suspend')) + '</button>';
      } else {
        html += '<button type="button" class="btn btn-ok btn-s' + loadingCls + '" data-act="reinstate" data-id="' + id + '"' + busyAttr + '>' + esc(t('ad.reinstate')) + '</button>';
      }
    }
    if (r.online || r.onTrip) {
      html += '<button type="button" class="btn btn-quiet btn-s' + loadingCls + '" data-act="offline" data-id="' + id + '"' + busyAttr + '>' + esc(t('ad.forceOffline')) + '</button>';
    }
    html += '</div>';
    if (String(st.riders.openSuspend) === String(id) && r.status !== 'rejected') {
      html += '<div class="reasonbox" id="susp-' + id + '">'
        + '<div><label for="sus-' + id + '">' + esc(t('ad.suspendWhy')) + '</label>'
        + '<textarea id="sus-' + id + '" maxlength="300" placeholder="' + esc(t('ad.reasonPh')) + '"></textarea></div>'
        + '<p class="rownote rownote-err" id="serr-' + id + '" hidden></p>'
        + '<div class="decide">'
        + '<button type="button" class="btn btn-no btn-s" data-act="suspendSend" data-id="' + id + '">' + esc(t('ad.suspend')) + '</button>'
        + '<button type="button" class="btn btn-quiet btn-s" data-act="suspendCancel" data-id="' + id + '">' + esc(t('ad.cancel')) + '</button>'
        + '</div></div>';
    }
    html += '</div>';
    html += '<div class="tail"><span class="subtle">' + esc(t('ad.riderOpen', { n: S.num(r.tripsOpen || 0) })) + '</span>'
      + '<em class="subtle">' + esc(S.stamp(r.createdAt)) + '</em></div>';
    return html + '</article>';
  }

  function ridersHtml() {
    var html = finderHtml('rider');
    if (st.riders.rows === null) { return html + skHtml(2); }
    if (!st.riders.rows.length) { return html + subtle(t('ad.noRiders')); }
    html += '<div class="rows">';
    for (var i = 0; i < st.riders.rows.length; i++) { html += riderRowHtml(st.riders.rows[i]); }
    return html + '</div>';
  }

  function riderAction(action, id, reason, button) {
    st.busy['r' + id] = true;
    if (button) { S.loading(button, true); }
    var body = { action: action };
    if (reason) { body.reason = reason; }
    api('/api/admin/riders/' + id + '/action', { body: body, useToken: true }).then(function (data) {
      delete st.busy['r' + id];
      var rows = st.riders.rows || [];
      for (var i = 0; i < rows.length; i++) {
        if (String(rows[i].id) === String(id)) { rows[i] = data.rider; }
      }
      st.riders.openSuspend = '';
      if (data.cancelledTrips > 0) {
        sayBoard('wait', t('ad.cancelledTrips', { n: S.num(data.cancelledTrips) }));
      }
      paintPanel();
      paintTabs();
    }, function (err) {
      delete st.busy['r' + id];
      if (button) { S.loading(button, false); }
      if (gateOn(err)) { return; }
      var box = q('#serr-' + id);
      if (box) {
        box.textContent = errText(err);
        S.visible(box, true);
      } else {
        sayErr(errText(err));
      }
    });
  }

  /* ================================================================ trips */

  function tripRowHtml(tr) {
    var busy = !!st.busy['t' + tr.id];
    var busyAttr = busy ? ' disabled' : '';
    var html = '<article class="row">';
    html += '<span class="av" aria-hidden="true">' + S.initials(tr.clientName || tr.clientPhone) + '</span>';
    html += '<div class="who"><b>' + esc(tr.clientName || '—') + '</b>'
      + '<em>' + (tr.clientPhone ? '<a href="' + esc(S.telHref(tr.clientPhone)) + '">' + esc(tr.clientPhone) + '</a>' : esc(t('tp.client'))) + '</em>'
      + '<div class="route">' + esc(tr.origin || '—') + ' <i aria-hidden="true">&rarr;</i> ' + esc(tr.destination || '—') + '</div>';
    html += '<div class="pairs">'
      + pair(t('tp.kind'), t(S.KIND_LABEL[tr.kind] || 'tp.kind'))
      + pair(t('tp.distance'), S.km(tr.distanceKm))
      + pair(t('tp.fare'), S.rwf(tr.fareRwf))
      + pair(t('ad.fee'), feeOf(tr.fareRwf))
      + '</div>';
    if (tr.scheduledAt) { html += subtle(t('tp.scheduled') + ': ' + S.stamp(tr.scheduledAt)); }
    html += '<div class="acts">'
      + '<button type="button" class="btn btn-ghost btn-s" data-act="tripsOf" data-id="' + esc(tr.driver.id) + '" data-name="' + esc(tr.driver.name) + '">'
      + esc(tr.driver.plate || t('tp.rider')) + '</button>';
    if (OPEN_TRIP[tr.status]) {
      html += '<button type="button" class="btn btn-no btn-s' + (busy ? ' loading' : '') + '" data-act="tripCancel" data-id="' + tr.id + '"' + busyAttr + '>'
        + esc(t('ad.cancelTrip')) + '</button>';
    }
    html += '</div></div>';
    html += '<div class="tail">' + S.badge(tr.status)
      + '<span class="money">' + esc(S.rwf(tr.fareRwf)) + '</span>'
      + S.payBadge(tr.paymentStatus)
      + (tr.collectedRwf ? '<em class="subtle">' + esc(t('c.collected')) + ': ' + esc(S.rwf(tr.collectedRwf)) + '</em>' : '')
      + '<em class="subtle">' + esc(S.stamp(tr.createdAt)) + '</em></div>';
    return html + '</article>';
  }

  function tripsHtml() {
    var html = finderHtml('trip');
    if (st.trips.rows === null) { return html + skHtml(2); }
    if (!st.trips.rows.length) { return html + subtle(t('ad.noTrips')); }
    html += '<div class="rows">';
    for (var i = 0; i < st.trips.rows.length; i++) { html += tripRowHtml(st.trips.rows[i]); }
    return html + '</div>';
  }

  function cancelTrip(id, button) {
    st.busy['t' + id] = true;
    if (button) { S.loading(button, true); }
    api('/api/admin/trips/' + id + '/cancel', { method: 'POST', body: {}, useToken: true }).then(function (data) {
      delete st.busy['t' + id];
      var rows = st.trips.rows || [];
      for (var i = 0; i < rows.length; i++) {
        if (String(rows[i].id) === String(id)) { rows[i] = data.trip; }
      }
      sayBoard('info', t('rd.cancelled'));
      paintPanel();
    }, function (err) {
      delete st.busy['t' + id];
      if (button) { S.loading(button, false); }
      if (gateOn(err)) { return; }
      sayErr(errText(err));
      if (err.code === 'not_cancellable') { loadData('trips', true); }
    });
  }

  function filterTripsByDriver(id, name) {
    st.trips.driverId = String(id);
    st.trips.driverName = name || '';
    st.trips.rows = null;
    st.loaded.trips = false;
    showTab('trips');
  }

  /* ============================================================= payments */

  function payRowHtml(p) {
    var html = '<article class="row">';
    html += '<div class="who"><b>' + esc(p.reference || '#' + p.id) + '</b>'
      + '<em>' + esc(p.provider || '—') + (p.clientName ? ' · ' + esc(p.clientName) : '') + '</em>';
    html += '<div class="pairs">'
      + pair(t('tp.fare'), S.rwf(p.amountRwf))
      + pair(t('ad.fee'), S.rwf(p.platformFeeRwf))
      + pair(t('c.payout'), S.rwf(p.driverPayoutRwf))
      + '</div></div>';
    html += '<div class="tail">' + S.payBadge(p.status)
      + '<span class="money">' + esc(S.rwf(p.amountRwf)) + '</span>'
      + '<em class="subtle">' + esc(t('ad.kCreated')) + ' ' + esc(S.stamp(p.createdAt)) + '</em>'
      + (p.confirmedAt ? '<em class="subtle">' + esc(t('ad.confirmed')) + ' ' + esc(S.stamp(p.confirmedAt)) + '</em>' : '')
      + '</div>';
    return html + '</article>';
  }

  function paymentsHtml() {
    var html = finderHtml('pay');
    var tot = st.pay.totals;
    if (tot) {
      html += '<div class="stats">'
        + statTile(S.rwf(tot.collected_rwf), 'c.collected', 'pos')
        + statTile(S.rwf(tot.fee_rwf), 'ad.sCommission')
        + statTile(S.rwf(tot.payout_rwf), 'c.payout')
        + statTile(S.rwf(tot.open_rwf), 'ad.openMoney', tot.open_rwf ? 'hot' : '')
        + '</div>';
    }
    if (st.pay.rows === null) { return html + skHtml(2); }
    if (!st.pay.rows.length) { return html + subtle(t('ad.noPayments')); }
    html += '<div class="rows">';
    for (var i = 0; i < st.pay.rows.length; i++) { html += payRowHtml(st.pay.rows[i]); }
    return html + '</div>';
  }

  /* =========================================================== passengers */

  function paxRowHtml(p) {
    var html = '<article class="row">';
    html += '<span class="av" aria-hidden="true">' + S.initials(p.name || p.phone) + '</span>';
    html += '<div class="who"><b>' + esc(p.name || '—') + '</b>'
      + '<em>' + (p.phone ? '<a href="' + esc(S.telHref(p.phone)) + '">' + esc(p.phone) + '</a>' : '—')
      + (p.email ? ' · ' + esc(p.email) : '') + '</em>';
    html += '<div class="pairs">'
      + pair(t('ps.tripsCount'), S.num(p.trips || 0))
      + pair(t('ps.spent'), S.rwf(p.spentRwf || 0))
      + pair(t('ad.paxPlaces'), S.num(p.places || 0))
      + pair(t('ad.paxLast'), p.lastLoginAt ? S.stamp(p.lastLoginAt) : '—')
      + '</div></div>';
    html += '<div class="tail"><em class="subtle">' + esc(t('ad.kCreated')) + ' ' + esc(S.stamp(p.createdAt)) + '</em></div>';
    return html + '</article>';
  }

  function passengersHtml() {
    var html = finderHtml('pax');
    if (st.pax.rows === null) { return html + skHtml(2); }
    if (!st.pax.rows.length) { return html + subtle(t('ad.noPassengers')); }
    html += '<div class="rows">';
    for (var i = 0; i < st.pax.rows.length; i++) { html += paxRowHtml(st.pax.rows[i]); }
    return html + '</div>';
  }

  /* ============================================================== painting */

  function paintTabs() {
    qa('#tabs button').forEach(function (b) {
      b.setAttribute('aria-selected', String(b.getAttribute('data-tab') === st.tab));
    });
    var d = (st.stats && st.stats.drivers) || null;
    text(els.cntApps, d ? String((d.pending || 0) + (d.approved || 0) + (d.rejected || 0)) : '');
    text(els.cntRiders, st.riders.rows ? String(st.riders.rows.length) : '');
    text(els.cntTrips, st.trips.rows ? String(st.trips.rows.length) : '');
  }

  function paintFoot() {
    text(els.meName, (st.me && st.me.name) || '—');
    var d = (st.stats && st.stats.drivers) || null;
    text(els.totalCount, d ? String((d.pending || 0) + (d.approved || 0) + (d.rejected || 0)) : '—');
  }

  function paintPanel() {
    if (st.gate !== '') { els.panel.innerHTML = ''; return; }
    if (st.tab === 'overview') {
      els.panel.innerHTML = (st.pending === 'overview') ? skHtml(3) : overviewHtml();
      wirePanel();
      return;
    }
    if (st.tab === 'apps') { els.panel.innerHTML = appsHtml(); wirePanel(); return; }
    if (st.tab === 'riders') { els.panel.innerHTML = st.pending === 'riders' ? skHtml(2) : ridersHtml(); wirePanel(); return; }
    if (st.tab === 'trips') { els.panel.innerHTML = st.pending === 'trips' ? skHtml(2) : tripsHtml(); wirePanel(); return; }
    if (st.tab === 'payments') { els.panel.innerHTML = st.pending === 'payments' ? skHtml(2) : paymentsHtml(); wirePanel(); return; }
    els.panel.innerHTML = st.pending === 'passengers' ? skHtml(2) : passengersHtml();
    wirePanel();
  }

  function paint() {
    paintTabs();
    paintPanel();
    paintFoot();
  }

  /* ================================================================ panels */

  function wirePanel() {
    var input;
    function searchOn(node, apply) {
      if (!node) { return; }
      node.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter') { ev.preventDefault(); apply(); }
      });
    }
    function val(id) {
      var node = q('#' + id, els.panel);
      return node ? node.value : '';
    }
    if (st.tab === 'riders') {
      input = q('#riderQ', els.panel);
      searchOn(input, function () { st.riders.q = S.cleanNames(input.value); loadData('riders', false); });
      var rGo = q('[data-act="riderGo"]', els.panel);
      if (rGo) { rGo.addEventListener('click', function () { st.riders.q = S.cleanNames(val('riderQ')); loadData('riders', false); }); }
      var rS = q('#riderStatus', els.panel);
      if (rS) { rS.addEventListener('change', function () { st.riders.status = rS.value; loadData('riders', false); }); }
      var rV = q('#riderVehicle', els.panel);
      if (rV) { rV.addEventListener('change', function () { st.riders.vehicle = rV.value; loadData('riders', false); }); }
      var rO = q('#riderOnline', els.panel);
      if (rO) { rO.addEventListener('change', function () { st.riders.online = rO.checked; loadData('riders', false); }); }
      var host = q('#riderDiv', els.panel);
      st.riders.cascade = null;
      if (host && window.SERE_DIVISIONS) {
        st.riders.cascade = SERE_DIVISIONS.mount(host, {
          depth: 3,
          onChange: function () {
            var picked = st.riders.cascade ? st.riders.cascade.value() : null;
            var code = picked ? picked.code : '';
            if (code === st.riders.division) { return; }
            st.riders.division = code;
            loadData('riders', false);
          }
        });
        /* The panel is rebuilt on every load, so the chosen division is put back from the filter
           state instead of being lost with the old dropdowns. */
        if (st.riders.division) { st.riders.cascade.set(st.riders.division); }
      }
    }
    if (st.tab === 'trips') {
      input = q('#tripQ', els.panel);
      searchOn(input, function () { st.trips.q = S.cleanNames(input.value); loadData('trips', false); });
      var tGo = q('[data-act="tripGo"]', els.panel);
      if (tGo) { tGo.addEventListener('click', function () { st.trips.q = S.cleanNames(val('tripQ')); loadData('trips', false); }); }
      var tK = q('#tripKind', els.panel);
      if (tK) { tK.addEventListener('change', function () { st.trips.kind = tK.value; loadData('trips', false); }); }
    }
    if (st.tab === 'payments') {
      input = q('#payQ', els.panel);
      searchOn(input, function () { st.pay.q = S.cleanNames(input.value); loadData('payments', false); });
      var pGo = q('[data-act="payGo"]', els.panel);
      if (pGo) { pGo.addEventListener('click', function () { st.pay.q = S.cleanNames(val('payQ')); loadData('payments', false); }); }
      var pS = q('#payStatus', els.panel);
      if (pS) { pS.addEventListener('change', function () { st.pay.status = pS.value; loadData('payments', false); }); }
      var pP = q('#payProvider', els.panel);
      if (pP) { pP.addEventListener('change', function () { st.pay.provider = pP.value; loadData('payments', false); }); }
    }
    if (st.tab === 'passengers') {
      input = q('#paxQ', els.panel);
      searchOn(input, function () { st.pax.q = S.cleanNames(input.value); loadData('passengers', false); });
      var xGo = q('[data-act="paxGo"]', els.panel);
      if (xGo) { xGo.addEventListener('click', function () { st.pax.q = S.cleanNames(val('paxQ')); loadData('passengers', false); }); }
    }
    /* keep typed reasons across a language re-paint? — inputs are rebuilt, so
       the panel is only repainted after an action, when the box closes. */
  }

  function showTab(name) {
    st.tab = name;
    try { localStorage.setItem(TAB_KEY, name); } catch (e) { /* private mode keeps defaults */ }
    S.hideBanner(els.err);
    if (!st.loaded[name]) { loadData(name, false); } else { paint(); }
  }

  /* ============================================================ delegation */

  function onPanelClick(ev) {
    var node = ev.target;
    while (node && node !== els.panel
      && !(node.getAttribute && (node.getAttribute('data-act') || node.getAttribute('data-fill')))) {
      node = node.parentNode;
    }
    if (!node || node === els.panel) { return; }
    var fill = node.getAttribute('data-fill');
    if (fill) {
      var area = q('#r-' + fill);
      if (area) {
        area.value = node.getAttribute('data-text');
        area.focus();
      }
      return;
    }
    var act = node.getAttribute('data-act');
    var id = node.getAttribute('data-id');
    if (st.tab === 'apps') { appsClick(act, id, node); return; }
    if (act === 'riderGo' || act === 'tripGo' || act === 'payGo' || act === 'paxGo') { return; }
    if (act === 'suspendOpen') {
      st.riders.openSuspend = String(st.riders.openSuspend) === String(id) ? '' : id;
      paintPanel();
      var box = q('#sus-' + id);
      if (box) { box.focus(); }
      return;
    }
    if (act === 'suspendCancel') {
      st.riders.openSuspend = '';
      paintPanel();
      return;
    }
    if (act === 'suspendSend') {
      var why = q('#sus-' + id);
      riderAction('suspend', id, why ? S.cleanNames(why.value) : '', node);
      return;
    }
    if (act === 'reinstate') { riderAction('reinstate', id, '', node); return; }
    if (act === 'offline') { riderAction('offline', id, '', node); return; }
    if (act === 'tripScope') {
      st.trips.scope = node.getAttribute('data-scope');
      loadData('trips', false);
      return;
    }
    if (act === 'tripCancel') { cancelTrip(id, node); return; }
    if (act === 'tripsClearRider') {
      st.trips.driverId = '';
      st.trips.driverName = '';
      loadData('trips', false);
      return;
    }
    if (act === 'tripsOf') {
      filterTripsByDriver(node.getAttribute('data-id'), node.getAttribute('data-name'));
    }
  }

  /* ================================================================= boot */

  function boot() {
    if (!S.getToken()) { showGate('401'); return; }
    api('/api/auth/session').then(function (data) {
      var kind = (data && data.kind) || null;
      st.kind = kind || 'none';
      if (kind === 'passenger') { showGate('pax'); return; }
      if (kind !== 'driver') { showGate('401'); return; }
      st.me = data.driver;
      if (!st.me || !st.me.isAdmin) { showGate('403'); return; }
      st.gate = '';
      S.visible(els.gate, false);
      S.visible(els.area, true);
      S.visible(els.btnRefresh, true);
      S.visible(els.btnLogout, true);
      showTab(st.tab);
    }, function () {
      /* a network failure on the session probe must not drop the token */
      showGate('401');
      st.kind = 'none';
    });
  }

  function init() {
    els = {
      gate: q('#gate'), gateIcon: q('#gateIcon'), gateTitle: q('#gateTitle'),
      gateBody: q('#gateBody'), gateCta: q('#gateCta'),
      area: q('#area'), board: q('#boardMsg'), err: q('#errMsg'),
      panel: q('#panel'), zoneList: q('#zoneList'),
      cntApps: q('#cntApps'), cntRiders: q('#cntRiders'), cntTrips: q('#cntTrips'),
      btnRefresh: q('#btnRefresh'), btnLogout: q('#btnLogout'),
      meName: q('#meName'), totalCount: q('#totalCount')
    };
    try {
      var saved = localStorage.getItem(TAB_KEY);
      if (saved && q('#tabs button[data-tab="' + saved + '"]')) { st.tab = saved; }
    } catch (e) { /* private mode keeps defaults */ }

    qa('#tabs button').forEach(function (tab) {
      tab.addEventListener('click', function () { showTab(tab.getAttribute('data-tab')); });
    });
    els.btnRefresh.addEventListener('click', function () {
      loadData(st.tab, true);
      if (st.tab !== 'overview') { refreshStats(); }
    });
    els.btnLogout.addEventListener('click', logout);
    els.panel.addEventListener('click', onPanelClick);

    api('/api/zones').then(function (data) {
      st.zones = (data && data.zones) || [];
      var html = '';
      for (var i = 0; i < st.zones.length; i++) { html += '<option value="' + esc(st.zones[i]) + '"></option>'; }
      els.zoneList.innerHTML = html;
    }, function () { /* the datalist only helps typing */ });

    S.onLang(function () {
      if (st.gate !== '') { showGate(st.gate); return; }
      /* Division labels come back from the server in whichever language was asked for, so the open tab
         is re-read — repainting alone would strand the previous language on every row. */
      if (st.loaded[st.tab]) { loadData(st.tab, true); } else { paint(); }
    });

    boot();
  }

  S.onPage('admin', init);
}());
