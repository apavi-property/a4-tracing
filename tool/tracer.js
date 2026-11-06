/* Article 4 boundary tracer — shared app. The page supplies window.JOB:
   { slug, display, shade_description, home, sheets[], areas[], docs[], reference }
   One "area" = one shaded area on a council map sheet, shown as a close-up snippet on
   the right; the live map on the left follows whichever area is selected. */
(function () {
  'use strict';
  var JOB = window.JOB;
  var KEY = 'a4trace:' + JOB.slug;
  var $ = function (id) { return document.getElementById(id); };

  // ---------- receiver (Google Apps Script -> Drive); see tool/config.js ----------
  var RECEIVER = (window.A4_RECEIVER && window.A4_RECEIVER.url) ? window.A4_RECEIVER : null;
  var CLIENT = (function () {
    try {
      var c = localStorage.getItem('a4trace:client');
      if (!c) { c = Math.random().toString(36).slice(2, 10); localStorage.setItem('a4trace:client', c); }
      return c;
    } catch (e) { return 'nostore'; }
  })();
  function payload(kind) { return JSON.stringify({ key: RECEIVER.key, kind: kind, slug: JOB.slug, client: CLIENT, data: toGeoJSON() }); }
  function send(kind) {
    // text/plain body = a "simple" request (no CORS preflight), which Apps Script accepts
    return fetch(RECEIVER.url, { method: 'POST', body: payload(kind), redirect: 'follow' })
      .then(function (r) { return r.json(); })
      .then(function (j) { if (!j || !j.ok) throw new Error((j && j.error) || 'not saved'); return j; });
  }
  var draftTimer = null, lastSent = '';
  function cloud(t, ok) { var c = $('cloud'); if (c) { c.textContent = t; c.className = 'cloud' + (ok ? ' ok' : ''); } }
  function syncDraft() {
    if (!RECEIVER || !shapes.length) return;
    var body = payload('draft');
    if (body === lastSent) return;
    send('draft').then(function () {
      lastSent = body;
      cloud('☁ Saved to Anshul’s Drive at ' + new Date().toTimeString().slice(0, 5), true);
    }).catch(function () { cloud('☁ Not synced yet (will retry) — your work is still saved in this browser', false); });
  }
  function scheduleDraft() { if (!RECEIVER) return; clearTimeout(draftTimer); draftTimer = setTimeout(syncDraft, 20000); }
  // last-chance sync when the tab is hidden or closed (no response needed)
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden' && RECEIVER && shapes.length && navigator.sendBeacon) {
      try { navigator.sendBeacon(RECEIVER.url, payload('draft')); } catch (e) {}
    }
  });
  var AREAS = JOB.areas;
  var SHEETS = {}; JOB.sheets.forEach(function (s) { SHEETS[s.id] = s; });

  // ---------- state ----------
  var shapes = [];            // {area, name, latlngs, layer}
  var areaState = {};         // areaId -> {done:bool, note:string}
  var drawing = null;         // {area, latlngs, line, firstMarker}
  var selected = -1, editMarkers = [], midMarkers = [];
  var cur = 0;                // index into AREAS of the area being worked on
  AREAS.forEach(function (a) { areaState[a.id] = { done: false, note: '' }; });

  // ---------- map ----------
  var map = L.map('map', { doubleClickZoom: false, zoomSnap: 0.5 }).setView([JOB.home.lat, JOB.home.lng], JOB.home.zoom);
  var osm = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap' }).addTo(map);
  var sat = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, attribution: 'Esri World Imagery' });
  L.control.layers({ 'Street map': osm, 'Satellite': sat }, null, { position: 'topright' }).addTo(map);
  L.control.scale({ imperial: false }).addTo(map);
  [document.querySelector('.panel'), $('drawbar')].forEach(function (el) {
    L.DomEvent.disableClickPropagation(el); L.DomEvent.disableScrollPropagation(el);
  });
  // faint box showing where the current snippet sits on the live map
  var areaBox = L.rectangle([[0, 0], [0, 0]], { color: '#1a73e8', weight: 2, dashArray: '6 6', fill: false, interactive: false }).addTo(map);

  function status(t) { $('status').textContent = t || ''; }
  // keep the area clear of the side panel when centring the map on it
  function fitArea(bounds) {
    var p = document.querySelector('.panel');
    var left = (p && !p.classList.contains('collapsed')) ? p.offsetWidth + 24 : 30;
    map.fitBounds(bounds, { paddingTopLeft: [left, 30], paddingBottomRight: [30, 30], maxZoom: 18 });
  }
  function areaById(id) { for (var i = 0; i < AREAS.length; i++) if (AREAS[i].id === id) return AREAS[i]; }
  function areaIndex(id) { for (var i = 0; i < AREAS.length; i++) if (AREAS[i].id === id) return i; return -1; }
  function shapesFor(id) { var out = []; shapes.forEach(function (s, i) { if (s.area === id) out.push(i); }); return out; }

  // ---------- selecting an area: right snippet + left map move together ----------
  function goTo(i, flyMap) {
    if (drawing) cancelDraw();
    finishEdit();
    cur = Math.max(0, Math.min(AREAS.length - 1, i));
    var a = AREAS[cur];
    if (flyMap !== false) fitArea(a.bounds);
    areaBox.setBounds(a.bounds);
    setTab('areas');
    showImage(a.image);
    renderRight(); renderList();
  }
  function renderRight() {
    var a = AREAS[cur], sh = SHEETS[a.sheet], st = areaState[a.id], mine = shapesFor(a.id);
    $('areahead').innerHTML = '<b>Area ' + (cur + 1) + ' of ' + AREAS.length + '</b> &middot; ' + esc(sh ? sh.name : a.sheet) +
      (a.hint ? '<div class="hint">' + esc(a.hint) + '</div>' : '');
    $('areastat').textContent = mine.length ? (mine.length + ' shape' + (mine.length === 1 ? '' : 's') + ' drawn' + (st.done ? ' — done' : '')) : 'Nothing drawn yet for this area';
    $('areastat').className = 'areastat' + (st.done ? ' ok' : (mine.length ? ' part' : ''));
    $('aprev').disabled = cur === 0;
    $('anext').disabled = cur === AREAS.length - 1;
    $('adone').textContent = cur === AREAS.length - 1 ? '✓ Done with this area' : '✓ Done — next area →';
    $('anote').value = st.note;
  }
  $('aprev').onclick = function () { goTo(cur - 1); };
  $('anext').onclick = function () { goTo(cur + 1); };
  $('adraw').onclick = function () { startDraw(AREAS[cur].id); };
  $('arecentre').onclick = function () { fitArea(AREAS[cur].bounds); };
  $('anote').onchange = function () { areaState[AREAS[cur].id].note = this.value; save(); renderList(); };
  $('adone').onclick = function () {
    var a = AREAS[cur], st = areaState[a.id], n = shapesFor(a.id).length;
    if (!n && !st.note.trim()) {
      openCard('Nothing drawn for this area', '<p>Draw a shape around the shaded area first. If you really cannot trace it (the map is unclear, or you can\'t find the place), write a note in the box under the snippet and press Done again.</p><div class="actions"><button class="primary" id="closesubmit">OK</button></div>');
      return;
    }
    st.done = true; save();
    if (cur < AREAS.length - 1) goTo(cur + 1);
    else { renderRight(); renderList(); openCard('All areas visited', '<p>Every area is marked done. Check the list on the left: anything without a tick still needs a shape or a note. Then press <b>Submit</b>.</p><div class="actions"><button class="primary" id="closesubmit">OK</button></div>'); }
  };

  // ---------- drawing ----------
  function startDraw(areaId) {
    finishEdit();
    if (drawing) cancelDraw();
    var a = areaById(areaId);
    if (!map.getBounds().intersects(L.latLngBounds(a.bounds))) fitArea(a.bounds);
    drawing = { area: areaId, latlngs: [], line: L.polyline([], { color: '#d00', weight: 3 }).addTo(map), firstMarker: null };
    $('map').classList.add('drawing');
    $('drawbar').style.display = 'block';
    $('drawcount').textContent = '0';
    status('Click around the edge of the shaded area.');
  }
  function addVertex(ll) {
    var prev = drawing.latlngs[drawing.latlngs.length - 1];
    if (prev && map.latLngToLayerPoint(ll).distanceTo(map.latLngToLayerPoint(prev)) < 4) return;
    if (drawing.latlngs.length >= 3 && map.latLngToLayerPoint(ll).distanceTo(map.latLngToLayerPoint(drawing.latlngs[0])) < 14) { closeDraw(); return; }
    drawing.latlngs.push(ll);
    drawing.line.setLatLngs(drawing.latlngs);
    $('drawcount').textContent = drawing.latlngs.length;
    if (drawing.latlngs.length === 1) {
      drawing.firstMarker = L.circleMarker(ll, { radius: 8, color: '#d00', fillColor: '#fff', fillOpacity: 1 }).addTo(map);
      drawing.firstMarker.on('click', function (e) { L.DomEvent.stop(e.originalEvent); closeDraw(); });
    }
  }
  function undoVertex() {
    if (!drawing || !drawing.latlngs.length) return;
    drawing.latlngs.pop(); drawing.line.setLatLngs(drawing.latlngs);
    $('drawcount').textContent = drawing.latlngs.length;
    if (!drawing.latlngs.length) cancelDraw();
  }
  function cancelDraw() {
    if (!drawing) return;
    map.removeLayer(drawing.line);
    if (drawing.firstMarker) map.removeLayer(drawing.firstMarker);
    drawing = null;
    $('map').classList.remove('drawing');
    $('drawbar').style.display = 'none';
    status('');
  }
  function closeDraw() {
    if (!drawing) return;
    var pts = [], last = null;
    drawing.latlngs.forEach(function (ll) {
      if (!last || map.latLngToLayerPoint(ll).distanceTo(map.latLngToLayerPoint(last)) > 4) { pts.push(ll); last = ll; }
    });
    if (pts.length < 3) { status('A shape needs at least 3 corners — keep clicking.'); return; }
    var area = drawing.area;
    map.removeLayer(drawing.line);
    if (drawing.firstMarker) map.removeLayer(drawing.firstMarker);
    drawing = null;
    $('map').classList.remove('drawing');
    $('drawbar').style.display = 'none';
    var n = shapesFor(area).length + 1;
    addShape(area, 'Shape ' + n, pts);
    save(); renderList(); renderRight(); selectShape(shapes.length - 1);
    status('Shape saved. Drag the yellow dots to adjust it, then press "Done — next area" on the right.');
  }
  function onMapItself(e) {
    var t = e.originalEvent && e.originalEvent.target;
    return !t || (t.closest && t.closest('.leaflet-pane, .leaflet-container') && !t.closest('.panel, #drawbar'));
  }
  map.on('click', function (e) { if (drawing && onMapItself(e)) addVertex(e.latlng); });
  map.on('dblclick', function (e) { if (drawing) closeDraw(); });
  document.addEventListener('keydown', function (e) {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
    if ((e.key === 'z' || e.key === 'Backspace') && drawing) { e.preventDefault(); undoVertex(); }
    if (e.key === 'Escape') { if (drawing) cancelDraw(); else finishEdit(); }
    if (e.key === 'Enter' && drawing) closeDraw();
  });
  $('drawfinish').onclick = closeDraw;
  $('drawundo').onclick = undoVertex;
  $('drawcancel').onclick = cancelDraw;

  // ---------- shapes ----------
  function addShape(area, name, latlngs) {
    var layer = L.polygon(latlngs, { color: '#d00', weight: 3, fillOpacity: 0.18 }).addTo(map);
    var s = { area: area, name: name, latlngs: latlngs.map(function (ll) { return L.latLng(ll); }), layer: layer };
    layer.on('click', function (e) {
      if (drawing) { addVertex(e.latlng); return; }
      L.DomEvent.stop(e.originalEvent); selectShape(shapes.indexOf(s));
    });
    shapes.push(s);
    return s;
  }
  function deleteShape(i) {
    finishEdit();
    map.removeLayer(shapes[i].layer);
    shapes.splice(i, 1);
    save(); renderList(); renderRight();
  }
  function finishEdit() {
    editMarkers.forEach(function (m) { map.removeLayer(m); });
    midMarkers.forEach(function (m) { map.removeLayer(m); });
    editMarkers = []; midMarkers = []; selected = -1;
    renderList();
  }
  function selectShape(i) {
    finishEdit();
    selected = i;
    var s = shapes[i];
    var ai = areaIndex(s.area);
    if (ai >= 0 && ai !== cur) { cur = ai; areaBox.setBounds(AREAS[cur].bounds); showImage(AREAS[cur].image); renderRight(); }
    s.latlngs.forEach(function (ll, vi) {
      var m = L.circleMarker(ll, { radius: 8, weight: 2, color: '#d00', fillColor: '#ffe600', fillOpacity: 1 }).addTo(map);
      enableDrag(m, function (nll) { s.latlngs[vi] = nll; s.layer.setLatLngs(s.latlngs); }, function () { rebuildMids(s); save(); });
      m.on('contextmenu', function (e) {
        L.DomEvent.stop(e.originalEvent);
        if (s.latlngs.length <= 3) { status('A shape needs at least 3 corners.'); return; }
        s.latlngs.splice(vi, 1); s.layer.setLatLngs(s.latlngs); save(); selectShape(i);
      });
      editMarkers.push(m);
    });
    rebuildMids(s);
    renderList();
    status('Editing: drag a yellow dot to move it, drag a white dot to add a corner, right-click a dot to remove it. Esc when done.');
  }
  function rebuildMids(s) {
    midMarkers.forEach(function (m) { map.removeLayer(m); });
    midMarkers = [];
    s.latlngs.forEach(function (a, vi) {
      var b = s.latlngs[(vi + 1) % s.latlngs.length];
      var mid = L.latLng((a.lat + b.lat) / 2, (a.lng + b.lng) / 2);
      var m = L.circleMarker(mid, { radius: 6, weight: 2, color: '#d00', fillColor: '#fff', fillOpacity: 0.9, opacity: 0.6 }).addTo(map);
      enableDrag(m, function () {}, function (nll) {
        s.latlngs.splice(vi + 1, 0, nll); s.layer.setLatLngs(s.latlngs); save(); selectShape(shapes.indexOf(s));
      });
      midMarkers.push(m);
    });
  }
  function enableDrag(marker, onMove, onEnd) {
    var dragging = false;
    marker.on('mousedown', function (e) {
      L.DomEvent.stop(e.originalEvent); dragging = true; map.dragging.disable();
      function mv(ev) { marker.setLatLng(ev.latlng); onMove(ev.latlng); }
      function up() {
        if (!dragging) return; dragging = false; map.dragging.enable();
        map.off('mousemove', mv); map.off('mouseup', up);
        onEnd(marker.getLatLng());
      }
      map.on('mousemove', mv); map.on('mouseup', up);
    });
  }

  // ---------- left list (overview) ----------
  function esc(s) { return (s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }
  function renderList() {
    var div = $('arealist'); div.innerHTML = '';
    var doneCount = 0, lastSheet = null;
    AREAS.forEach(function (a, i) {
      var st = areaState[a.id], mine = shapesFor(a.id);
      if (st.done) doneCount++;
      if (a.sheet !== lastSheet) {
        var h = document.createElement('div'); h.className = 'sheethead';
        h.textContent = SHEETS[a.sheet] ? SHEETS[a.sheet].name : a.sheet; div.appendChild(h); lastSheet = a.sheet;
      }
      var row = document.createElement('div');
      row.className = 'arow' + (i === cur ? ' active' : '') + (st.done ? ' done' : '');
      var mark = st.done ? '✓' : (mine.length ? '●' : '○');
      var html = '<span class="mark">' + mark + '</span><span class="nm">Area ' + (i + 1) + '</span><span class="cnt">' + (mine.length ? mine.length + ' shape' + (mine.length === 1 ? '' : 's') : (st.note ? 'note' : '')) + '</span>';
      row.innerHTML = html;
      row.onclick = function (ev) { ev.stopPropagation(); goTo(i); };
      div.appendChild(row);
      if (i === cur && mine.length) {
        mine.forEach(function (si) {
          var s = shapes[si];
          var sr = document.createElement('div');
          sr.className = 'shape' + (si === selected ? ' sel' : '');
          sr.innerHTML = '<span class="nm">' + esc(s.name) + ' <span class="small">(' + s.latlngs.length + ' corners)</span></span>' +
            '<button data-act="edit" data-i="' + si + '">' + (si === selected ? 'editing' : 'adjust') + '</button>' +
            '<button data-act="zoom" data-i="' + si + '">zoom</button>' +
            '<button data-act="del" data-i="' + si + '" class="danger">delete</button>';
          div.appendChild(sr);
        });
      }
    });
    var pill = $('progress');
    pill.textContent = doneCount + ' of ' + AREAS.length + ' areas done';
    pill.className = 'pill' + (doneCount === AREAS.length ? ' done' : '');
    div.querySelectorAll('button').forEach(function (b) {
      b.onclick = function (ev) {
        ev.stopPropagation();
        var act = this.dataset.act, i = +this.dataset.i;
        if (act === 'edit') selectShape(i);
        else if (act === 'zoom') map.fitBounds(shapes[i].layer.getBounds().pad(0.3));
        else if (act === 'del') { if (window.confirm('Delete this shape?')) deleteShape(i); }
      };
    });
  }
  $('togglelist').onclick = function () {
    var p = document.querySelector('.panel'); p.classList.toggle('collapsed');
    this.textContent = p.classList.contains('collapsed') ? 'show list' : 'hide list';
  };

  // ---------- right-hand viewer (snippets / full document), pan + zoom ----------
  var viewer = $('viewer'), img = $('docimg'), sel = $('docsel');
  var tab = 'areas', vs = { scale: 1, x: 0, y: 0 }, natural = { w: 1, h: 1 };
  function showImage(src) {
    img.onload = function () { natural = { w: img.naturalWidth, h: img.naturalHeight }; fitDoc(); };
    img.src = src;
  }
  function fitDoc() {
    var W = viewer.clientWidth, H = viewer.clientHeight;
    vs.scale = Math.min(W / natural.w, H / natural.h);
    vs.x = (W - natural.w * vs.scale) / 2; vs.y = (H - natural.h * vs.scale) / 2;
    applyView();
  }
  function applyView() { img.style.transform = 'translate(' + vs.x + 'px,' + vs.y + 'px) scale(' + vs.scale + ')'; }
  viewer.addEventListener('wheel', function (e) {
    e.preventDefault();
    var r = viewer.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
    var f = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    var ns = Math.max(0.1, Math.min(8, vs.scale * f)); f = ns / vs.scale;
    vs.x = mx - (mx - vs.x) * f; vs.y = my - (my - vs.y) * f; vs.scale = ns;
    applyView();
  }, { passive: false });
  (function () {
    var drag = null;
    viewer.addEventListener('mousedown', function (e) { drag = { x: e.clientX, y: e.clientY, ox: vs.x, oy: vs.y }; viewer.classList.add('dragging'); e.preventDefault(); });
    window.addEventListener('mousemove', function (e) { if (!drag) return; vs.x = drag.ox + e.clientX - drag.x; vs.y = drag.oy + e.clientY - drag.y; applyView(); });
    window.addEventListener('mouseup', function () { drag = null; viewer.classList.remove('dragging'); });
  })();
  function setTab(t) {
    if (tab === t) return;
    tab = t;
    $('tab-areas').classList.toggle('active', t === 'areas');
    $('tab-docs').classList.toggle('active', t === 'docs');
    $('areabar').style.display = t === 'areas' ? '' : 'none';
    $('docbar').style.display = t === 'docs' ? '' : 'none';
    $('areaactions').style.display = t === 'areas' ? '' : 'none';
    if (t === 'docs') { sel.innerHTML = ''; JOB.docs.forEach(function (d, i) { var o = document.createElement('option'); o.value = i; o.textContent = (i + 1) + '. ' + d.name; sel.appendChild(o); }); showDoc(0); }
    else showImage(AREAS[cur].image);
  }
  function showDoc(i) { i = Math.max(0, Math.min(JOB.docs.length - 1, i)); sel.value = i; showImage(JOB.docs[i].image); }
  $('tab-areas').onclick = function () { setTab('areas'); };
  $('tab-docs').onclick = function () { setTab('docs'); };
  sel.onchange = function () { showDoc(+sel.value); };
  $('docprev').onclick = function () { showDoc(+sel.value - 1); };
  $('docnext').onclick = function () { showDoc(+sel.value + 1); };
  $('docfit').onclick = fitDoc;
  $('areafit').onclick = fitDoc;
  window.addEventListener('resize', fitDoc);

  // ---------- persistence ----------
  function snapshot() {
    return {
      slug: JOB.slug, saved: new Date().toISOString(), cur: cur,
      areas: areaState,
      shapes: shapes.map(function (s) { return { area: s.area, name: s.name, pts: s.latlngs.map(function (ll) { return [ll.lat, ll.lng]; }) }; })
    };
  }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(snapshot())); } catch (e) {} scheduleDraft(); }
  function load(d) {
    finishEdit();
    shapes.forEach(function (s) { map.removeLayer(s.layer); }); shapes = [];
    (d.shapes || []).forEach(function (r) {
      var area = r.area;
      if (!area && r.sheet) { for (var i = 0; i < AREAS.length; i++) if (AREAS[i].sheet === r.sheet) { area = AREAS[i].id; break; } }   // older saves
      if (!area) area = AREAS[0].id;
      addShape(area, r.name, r.pts.map(function (c) { return L.latLng(c[0], c[1]); }));
    });
    AREAS.forEach(function (a) { var st = (d.areas || {})[a.id]; areaState[a.id] = { done: !!(st && st.done), note: (st && st.note) || '' }; });
    if (typeof d.cur === 'number') cur = Math.max(0, Math.min(AREAS.length - 1, d.cur));
    renderList(); renderRight();
  }
  function restore() {
    try { var d = JSON.parse(localStorage.getItem(KEY) || 'null'); if (d) { load(d); if (shapes.length) status('Welcome back — your ' + shapes.length + ' saved shape(s) are restored.'); } } catch (e) {}
  }
  function download(name, text, type) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: type || 'application/json' }));
    a.download = name; document.body.appendChild(a); a.click(); document.body.removeChild(a);
  }
  $('backup').onclick = function () { download(JOB.slug + '-work-in-progress.json', JSON.stringify(snapshot())); status('Backup downloaded — keep it somewhere safe.'); };
  $('restorefile').onchange = function () {
    var f = this.files[0]; if (!f) return;
    var rd = new FileReader();
    rd.onload = function () {
      try {
        var d = JSON.parse(rd.result);
        if (d.type === 'FeatureCollection') d = fromGeoJSON(d);
        if (d.slug && d.slug !== JOB.slug && !window.confirm('This file is for a different borough (' + d.slug + '). Load it anyway?')) return;
        load(d); save(); status('Loaded ' + shapes.length + ' shape(s) from file.');
      } catch (e) { status('Could not read that file.'); }
    };
    rd.readAsText(f); this.value = '';
  };
  function fromGeoJSON(fc) {
    var d = { slug: fc.metadata && fc.metadata.slug, areas: (fc.metadata && fc.metadata.areas) || {}, shapes: [] };
    fc.features.forEach(function (f) {
      var rings = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
      rings.forEach(function (poly) {
        var ring = poly[0].slice(); if (ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]) ring.pop();
        d.shapes.push({ area: f.properties.area_id, sheet: f.properties.sheet_id, name: f.properties.name || 'Shape', pts: ring.map(function (c) { return [c[1], c[0]]; }) });
      });
    });
    return d;
  }
  $('clearall').onclick = function () {
    if (!window.confirm('Delete ALL your shapes for ' + JOB.display + '? (Download a backup first if unsure.)')) return;
    load({ shapes: [] }); save();
  };

  // ---------- submit ----------
  function ringAreaM2(latlngs) {
    var k = Math.cos(latlngs[0].lat * Math.PI / 180) * 111320, m = 111320, a = 0;
    for (var i = 0; i < latlngs.length; i++) {
      var p = latlngs[i], q = latlngs[(i + 1) % latlngs.length];
      a += (p.lng * k) * (q.lat * m) - (q.lng * k) * (p.lat * m);
    }
    return Math.abs(a) / 2;
  }
  function toGeoJSON() {
    var today = new Date().toISOString().slice(0, 10);
    return {
      type: 'FeatureCollection',
      metadata: { slug: JOB.slug, display: JOB.display, submitted: new Date().toISOString(), tool: 'a4-tracer/2', areas: areaState },
      features: shapes.map(function (s, i) {
        var ring = s.latlngs.map(function (ll) { return [+ll.lng.toFixed(6), +ll.lat.toFixed(6)]; }); ring.push(ring[0]);
        var a = areaById(s.area), sh = a && SHEETS[a.sheet];
        return { type: 'Feature', properties: { id: i + 1, area_id: s.area, area_name: a ? a.name : s.area, sheet_id: a ? a.sheet : '', sheet_name: sh ? sh.name : '', name: s.name, note: areaState[s.area] ? areaState[s.area].note : '', source: 'human-traced', lpa: JOB.slug, traced_date: today },
                 geometry: { type: 'Polygon', coordinates: [ring] } };
      })
    };
  }
  $('submit').onclick = function () {
    finishEdit(); if (drawing) cancelDraw();
    var problems = [], warnings = [];
    AREAS.forEach(function (a, i) {
      var n = shapesFor(a.id).length, st = areaState[a.id];
      if (!n && !st.note.trim()) problems.push('Area ' + (i + 1) + ' (' + (SHEETS[a.sheet] ? SHEETS[a.sheet].name.split(':')[0] : a.sheet) + ') has no shape and no note explaining why.');
      else if (!st.done && !st.note.trim()) problems.push('Area ' + (i + 1) + ' is not marked done (press "Done — next area" on it, or write a note if something is unclear).');
      if (n && (a.parts_rule === 'min' ? n < a.expected_parts : n !== a.expected_parts)) warnings.push('Area ' + (i + 1) + ': expected ' + (a.parts_rule === 'min' ? 'at least ' : '') + a.expected_parts + ' shape' + (a.expected_parts === 1 ? '' : 's') + ' but ' + n + ' drawn. Fine if the snippet really shows that — just check.');
    });
    shapes.forEach(function (s) { if (ringAreaM2(s.latlngs) < 150) warnings.push('"' + s.name + '" is tiny (under 150 m²) — was that a slip?'); });
    var body = '';
    if (problems.length) {
      body += '<div class="warn"><b>Not ready yet:</b><ul>' + problems.map(function (p) { return '<li>' + esc(p) + '</li>'; }).join('') + '</ul></div>';
      body += '<div class="actions"><button class="primary" id="closesubmit">Back to tracing</button></div>';
      openCard('Almost there', body);
      return;
    }
    if (warnings.length) body += '<div class="warn"><b>Worth a quick double-check:</b><ul>' + warnings.map(function (p) { return '<li>' + esc(p) + '</li>'; }).join('') + '</ul></div>';
    body += '<div class="ok">You have drawn <b>' + shapes.length + ' shape' + (shapes.length === 1 ? '' : 's') + '</b> across ' + AREAS.length + ' areas.</div>';
    if (RECEIVER) {
      body += '<p>Press <b>Send to Anshul</b>. Your shapes go straight to him — no file to download or attach. You\'ll get an email back if anything needs a second look.</p>';
      body += '<div class="actions"><button id="closesubmit">Not yet</button><button class="good" id="dosend">&#10148; Send to Anshul</button></div><div id="sendresult"></div>';
    } else {
      body += manualSteps();
    }
    openCard('Ready to send', body);
    if (RECEIVER) {
      $('dosend').onclick = function () {
        var b = this; b.disabled = true; b.textContent = 'Sending…';
        send('submit').then(function () {
          syncDraft();
          openCard('Sent ✓', '<div class="ok"><b>Thank you!</b> Your ' + shapes.length + ' shape' + (shapes.length === 1 ? '' : 's') + ' for ' + esc(JOB.display) + ' reached Anshul. There is nothing else to do — you\'ll get an email if anything needs a second look.</div><div class="actions"><button class="primary" id="closesubmit">Close</button></div>');
        }).catch(function () {
          b.textContent = 'Could not send';
          $('sendresult').innerHTML = '<div class="warn">Sending didn\'t work (internet hiccup?). Try again in a minute, or use the backup way:</div>' + manualSteps();
          b.disabled = false; b.textContent = '↻ Try again';
          wireDownload();
        });
      };
    } else wireDownload();
  };
  function manualSteps() {
    return '<ol><li>Click <b>Download the file</b> below (it saves <code>' + JOB.slug + '-traced.geojson</code>).</li><li>Reply to Anshul\'s email (subject <i>Article 4 tracing: ' + esc(JOB.display) + '</i>) and <b>attach the downloaded file</b>.</li></ol>' +
      '<div class="actions"><button class="good" id="dosubmit">&#11015; Download the file</button></div>';
  }
  function wireDownload() {
    var d = $('dosubmit'); if (!d) return;
    d.onclick = function () {
      download(JOB.slug + '-traced.geojson', JSON.stringify(toGeoJSON()), 'application/geo+json');
      d.textContent = 'Downloaded — now attach it to your reply'; d.disabled = true;
    };
  }

  // ---------- help / cards ----------
  function openCard(title, html) {
    $('cardtitle').textContent = title; $('cardbody').innerHTML = html; $('overlay').classList.add('show');
    var c = $('closesubmit'); if (c) c.onclick = closeCard;
  }
  function closeCard() { $('overlay').classList.remove('show'); }
  $('overlay').addEventListener('click', function (e) { if (e.target === this) closeCard(); });
  function showHelp() {
    openCard('How to trace the Article 4 areas', '<ol>' +
      '<li><b>The right-hand side shows one shaded area at a time</b>, cut from the council\'s official map. The ' + esc(JOB.shade_description) + ' are what you trace. Scroll to zoom the snippet, drag to move it.</li>' +
      '<li><b>The live map on the left is already at the same place</b> (the dashed blue box shows roughly where the snippet sits). Line them up using the street names; the <i>Satellite</i> view (top right of the map) helps with building outlines.</li>' +
      '<li>Press <b>Draw a shape</b>, then click around the edge of the shaded area, corner by corner. Click the first dot again (or press <span class="kbd">Enter</span>) to finish. <span class="kbd">z</span> undoes the last corner, <span class="kbd">Esc</span> cancels.</li>' +
      '<li><b>Adjust</b> a shape by clicking it: drag the yellow dots. Drag a white dot to add a corner; right-click a dot to remove it.</li>' +
      '<li>Press <b>Done — next area</b>. The snippet and the map both move on to the next area. Use ← → to go back to any area.</li>' +
      '<li>If a snippet is unclear or you can\'t find the place, write a note in the box under it instead of guessing, then press Done.</li>' +
      '<li>Your work <b>saves automatically in this browser</b>. When every area is done, press <b>Submit</b> (bottom left), download the file and attach it to a reply to Anshul\'s email.</li></ol>' +
      '<p class="small">Be exact: follow the edge of the shading, not the road. If the shading stops halfway along a building, so should your shape. The <i>Full document</i> tab shows every page of the signed direction if you need context.</p>' +
      '<div class="actions"><button class="primary" id="closesubmit">Got it</button></div>');
  }
  $('help').onclick = showHelp;

  // ---------- boot ----------
  restore();
  goTo(cur);
  // send anything already saved in this browser as soon as the page opens
  if (RECEIVER && shapes.length) setTimeout(syncDraft, 2500);
  try { if (!localStorage.getItem(KEY + ':seen')) { showHelp(); localStorage.setItem(KEY + ':seen', '1'); } } catch (e) {}
})();
