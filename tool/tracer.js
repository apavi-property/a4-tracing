/* Article 4 boundary tracer — shared app. Page supplies window.JOB (see any borough's index.html). */
(function () {
  'use strict';
  var JOB = window.JOB;
  var KEY = 'a4trace:' + JOB.slug;
  var $ = function (id) { return document.getElementById(id); };

  // ---------- state ----------
  var shapes = [];            // {sheet, name, latlngs, layer}
  var sheetState = {};        // sheetId -> {done:bool, note:string}
  var drawing = null;         // {sheet, latlngs, line, firstMarker}
  var selected = -1, editMarkers = [], midMarkers = [];
  var activeSheet = JOB.sheets[0].id;
  JOB.sheets.forEach(function (s) { sheetState[s.id] = { done: false, note: '' }; });

  // ---------- map ----------
  var map = L.map('map', { doubleClickZoom: false, zoomSnap: 0.5 }).setView([JOB.home.lat, JOB.home.lng], JOB.home.zoom);
  var osm = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap' }).addTo(map);
  var sat = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, attribution: 'Esri World Imagery' });
  L.control.layers({ 'Street map': osm, 'Satellite': sat }, null, { position: 'topright' }).addTo(map);
  L.control.scale({ imperial: false }).addTo(map);
  // the side panel and drawing bar sit inside the map div: their clicks must not plant corners
  [document.querySelector('.panel'), $('drawbar')].forEach(function (el) {
    L.DomEvent.disableClickPropagation(el); L.DomEvent.disableScrollPropagation(el);
  });

  var refLayer = null;
  if (JOB.reference && JOB.reference.features && JOB.reference.features.length) {
    refLayer = L.geoJSON(JOB.reference, { style: { color: '#777', weight: 2, dashArray: '6 6', fillOpacity: 0.06 }, interactive: false }).addTo(map);
  }

  function status(t) { $('status').textContent = t || ''; }

  // ---------- drawing ----------
  function startDraw(sheetId) {
    finishEdit();
    if (drawing) cancelDraw();
    activeSheet = sheetId; renderSheets();
    drawing = { sheet: sheetId, latlngs: [], line: L.polyline([], { color: '#d00', weight: 3 }).addTo(map), firstMarker: null };
    $('map').classList.add('drawing');
    $('drawbar').style.display = 'block';
    $('drawcount').textContent = '0';
    status('Click around the edge of the shaded area.');
  }
  function addVertex(ll) {
    var prev = drawing.latlngs[drawing.latlngs.length - 1];
    if (prev && map.latLngToLayerPoint(ll).distanceTo(map.latLngToLayerPoint(prev)) < 4) return;
    // a click back near the first corner closes the shape
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
    var sheet = drawing.sheet;
    map.removeLayer(drawing.line);
    if (drawing.firstMarker) map.removeLayer(drawing.firstMarker);
    drawing = null;
    $('map').classList.remove('drawing');
    $('drawbar').style.display = 'none';
    var n = shapes.filter(function (s) { return s.sheet === sheet; }).length + 1;
    addShape(sheet, 'Shape ' + n, pts);
    save(); renderSheets(); selectShape(shapes.length - 1);
    status('Shape saved. Drag the yellow dots to adjust it, or draw the next one.');
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
  function addShape(sheet, name, latlngs) {
    var layer = L.polygon(latlngs, { color: '#d00', weight: 3, fillOpacity: 0.18 }).addTo(map);
    var s = { sheet: sheet, name: name, latlngs: latlngs.map(function (ll) { return L.latLng(ll); }), layer: layer };
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
    save(); renderSheets();
  }
  function finishEdit() {
    editMarkers.forEach(function (m) { map.removeLayer(m); });
    midMarkers.forEach(function (m) { map.removeLayer(m); });
    editMarkers = []; midMarkers = []; selected = -1;
    renderSheets();
  }
  function selectShape(i) {
    finishEdit();
    selected = i;
    var s = shapes[i];
    activeSheet = s.sheet;
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
    renderSheets();
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

  // ---------- sheets panel ----------
  function sheetById(id) { for (var i = 0; i < JOB.sheets.length; i++) if (JOB.sheets[i].id === id) return JOB.sheets[i]; }
  function esc(s) { return (s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }
  function renderSheets() {
    var div = $('sheets'); div.innerHTML = '';
    var doneCount = 0;
    JOB.sheets.forEach(function (sh, idx) {
      var st = sheetState[sh.id], mine = [];
      shapes.forEach(function (s, i) { if (s.sheet === sh.id) mine.push(i); });
      if (st.done) doneCount++;
      var box = document.createElement('div');
      box.className = 'sheet' + (sh.id === activeSheet ? ' active' : '') + (st.done ? ' done' : '');
      var h = '<div class="title"><span class="num">' + (idx + 1) + '</span><span>' + esc(sh.name) + '</span></div>';
      h += '<div class="hint">' + esc(sh.hint) + '</div>';
      h += '<div class="btns"><button data-act="show" data-s="' + sh.id + '">&#128196; Show this map</button>' +
           '<button data-act="goto" data-s="' + sh.id + '">&#9992; Go there on the map</button>' +
           '<button data-act="draw" data-s="' + sh.id + '" class="primary">&#9998; Draw a shape</button></div>';
      if (!mine.length) h += '<div class="small">No shapes drawn yet for this map.</div>';
      mine.forEach(function (i) {
        var s = shapes[i];
        h += '<div class="shape' + (i === selected ? ' sel' : '') + '"><span class="nm">' + esc(s.name) + ' <span class="small">(' + s.latlngs.length + ' corners)</span></span>' +
             '<button data-act="edit" data-i="' + i + '">' + (i === selected ? 'editing' : 'adjust') + '</button>' +
             '<button data-act="zoom" data-i="' + i + '">zoom</button>' +
             '<button data-act="del" data-i="' + i + '" class="danger">delete</button></div>';
      });
      h += '<label class="done"><input type="checkbox" data-act="done" data-s="' + sh.id + '"' + (st.done ? ' checked' : '') + '> All ' + sh.expected_parts + ' shaded area' + (sh.expected_parts === 1 ? '' : 's') + ' on this map ' + (sh.expected_parts === 1 ? 'is' : 'are') + ' traced</label>';
      h += '<textarea data-act="note" data-s="' + sh.id + '" placeholder="Anything unclear about this map? Write it here (optional)">' + esc(st.note) + '</textarea>';
      box.innerHTML = h;
      div.appendChild(box);
    });
    var pill = $('progress');
    pill.textContent = doneCount + ' of ' + JOB.sheets.length + ' maps done';
    pill.className = 'pill' + (doneCount === JOB.sheets.length ? ' done' : '');
    div.querySelectorAll('button').forEach(function (b) {
      b.onclick = function (ev) {
        ev.stopPropagation();   // re-rendering below detaches this button; never let the click reach the map
        var act = this.dataset.act, sid = this.dataset.s, i = +this.dataset.i;
        if (act === 'show') showSheet(sid);
        else if (act === 'goto') { var sh = sheetById(sid); activeSheet = sid; map.setView([sh.center.lat, sh.center.lng], sh.zoom); showSheet(sid); }
        else if (act === 'draw') { showSheet(sid); var sh2 = sheetById(sid); if (!map.getBounds().contains([sh2.center.lat, sh2.center.lng])) map.setView([sh2.center.lat, sh2.center.lng], sh2.zoom); startDraw(sid); }
        else if (act === 'edit') selectShape(i);
        else if (act === 'zoom') map.fitBounds(shapes[i].layer.getBounds().pad(0.3));
        else if (act === 'del') { if (window.confirm('Delete this shape?')) deleteShape(i); }
      };
    });
    div.querySelectorAll('input[type=checkbox]').forEach(function (c) {
      c.onchange = function () { sheetState[this.dataset.s].done = this.checked; save(); renderSheets(); };
    });
    div.querySelectorAll('textarea').forEach(function (t) {
      t.onchange = function () { sheetState[this.dataset.s].note = this.value; save(); };
    });
  }

  // ---------- document viewer (pan + zoom) ----------
  var viewer = $('viewer'), img = $('docimg'), sel = $('docsel');
  var tab = 'sheets', vs = { scale: 1, x: 0, y: 0 }, natural = { w: 1, h: 1 };
  function docList() { return tab === 'sheets' ? JOB.sheets.map(function (s) { return { name: s.name, image: s.image, id: s.id }; }) : JOB.docs; }
  function fillSel() {
    sel.innerHTML = '';
    docList().forEach(function (d, i) { var o = document.createElement('option'); o.value = i; o.textContent = (i + 1) + '. ' + d.name; sel.appendChild(o); });
  }
  function showDoc(i) {
    var list = docList(); i = Math.max(0, Math.min(list.length - 1, i));
    sel.value = i;
    img.onload = function () { natural = { w: img.naturalWidth, h: img.naturalHeight }; fitDoc(); };
    img.src = list[i].image;
  }
  function showSheet(id) {
    if (tab !== 'sheets') setTab('sheets');
    for (var i = 0; i < JOB.sheets.length; i++) if (JOB.sheets[i].id === id) { showDoc(i); break; }
    activeSheet = id; renderSheets();
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
    tab = t;
    $('tab-sheets').classList.toggle('active', t === 'sheets');
    $('tab-docs').classList.toggle('active', t === 'docs');
    fillSel(); showDoc(0);
  }
  $('tab-sheets').onclick = function () { setTab('sheets'); };
  $('tab-docs').onclick = function () { setTab('docs'); };
  sel.onchange = function () { showDoc(+sel.value); };
  $('docprev').onclick = function () { showDoc(+sel.value - 1); };
  $('docnext').onclick = function () { showDoc(+sel.value + 1); };
  $('docfit').onclick = fitDoc;
  window.addEventListener('resize', fitDoc);

  // ---------- persistence ----------
  function snapshot() {
    return {
      slug: JOB.slug, saved: new Date().toISOString(),
      sheets: sheetState,
      shapes: shapes.map(function (s) { return { sheet: s.sheet, name: s.name, pts: s.latlngs.map(function (ll) { return [ll.lat, ll.lng]; }) }; })
    };
  }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(snapshot())); } catch (e) {} }
  function load(d) {
    finishEdit();
    shapes.forEach(function (s) { map.removeLayer(s.layer); }); shapes = [];
    (d.shapes || []).forEach(function (r) { addShape(r.sheet, r.name, r.pts.map(function (c) { return L.latLng(c[0], c[1]); })); });
    JOB.sheets.forEach(function (s) { var st = (d.sheets || {})[s.id]; sheetState[s.id] = { done: !!(st && st.done), note: (st && st.note) || '' }; });
    renderSheets();
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
    var d = { slug: fc.metadata && fc.metadata.slug, sheets: (fc.metadata && fc.metadata.sheets) || {}, shapes: [] };
    fc.features.forEach(function (f) {
      var rings = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
      rings.forEach(function (poly) {
        var ring = poly[0].slice(); if (ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]) ring.pop();
        d.shapes.push({ sheet: f.properties.sheet_id, name: f.properties.name || 'Shape', pts: ring.map(function (c) { return [c[1], c[0]]; }) });
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
      metadata: { slug: JOB.slug, display: JOB.display, submitted: new Date().toISOString(), tool: 'a4-tracer/1', sheets: sheetState },
      features: shapes.map(function (s, i) {
        var ring = s.latlngs.map(function (ll) { return [+ll.lng.toFixed(6), +ll.lat.toFixed(6)]; }); ring.push(ring[0]);
        var sh = sheetById(s.sheet);
        return { type: 'Feature', properties: { id: i + 1, sheet_id: s.sheet, sheet_name: sh ? sh.name : s.sheet, name: s.name, note: sheetState[s.sheet].note || '', source: 'human-traced', lpa: JOB.slug, traced_date: today },
                 geometry: { type: 'Polygon', coordinates: [ring] } };
      })
    };
  }
  $('submit').onclick = function () {
    finishEdit(); if (drawing) cancelDraw();
    var problems = [], warnings = [];
    JOB.sheets.forEach(function (sh, idx) {
      var n = shapes.filter(function (s) { return s.sheet === sh.id; }).length, st = sheetState[sh.id];
      if (!n && !st.note) problems.push('Map ' + (idx + 1) + ' has no shapes and no note explaining why.');
      else if (!st.done && !st.note) problems.push('Map ' + (idx + 1) + ' is not ticked as finished (tick the box, or write a note if something is unclear).');
      if (n && n !== sh.expected_parts) warnings.push('Map ' + (idx + 1) + ': the map shows ' + sh.expected_parts + ' shaded area' + (sh.expected_parts === 1 ? '' : 's') + ' but you have drawn ' + n + ' shape' + (n === 1 ? '' : 's') + '. Fine if the map really differs — just check.');
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
    body += '<div class="ok">You have drawn <b>' + shapes.length + ' shape' + (shapes.length === 1 ? '' : 's') + '</b> across ' + JOB.sheets.length + ' maps. Clicking <b>Download</b> saves the file <code>' + JOB.slug + '-traced.geojson</code>.</div>';
    body += '<ol><li>Click <b>Download the file</b> below.</li><li>Reply to Anshul\'s email (subject <i>Article 4 tracing: ' + esc(JOB.display) + '</i>) and <b>attach the downloaded file</b>.</li><li>That\'s it — the shapes get checked automatically and you\'ll get an email back if anything needs a second look.</li></ol>';
    body += '<div class="actions"><button id="closesubmit">Not yet</button><button class="good" id="dosubmit">&#11015; Download the file</button></div>';
    openCard('Ready to send', body);
    $('dosubmit').onclick = function () {
      download(JOB.slug + '-traced.geojson', JSON.stringify(toGeoJSON()), 'application/geo+json');
      $('dosubmit').textContent = 'Downloaded — now attach it to your reply';
      $('dosubmit').disabled = true;
    };
  };

  // ---------- help / cards ----------
  function openCard(title, html) {
    $('cardtitle').textContent = title; $('cardbody').innerHTML = html; $('overlay').classList.add('show');
    var c = $('closesubmit'); if (c) c.onclick = closeCard;
  }
  function closeCard() { $('overlay').classList.remove('show'); }
  $('overlay').addEventListener('click', function (e) { if (e.target === this) closeCard(); });
  function showHelp() {
    openCard('How to trace the Article 4 areas', '<ol>' +
      '<li><b>Look at the council map on the right.</b> The ' + esc(JOB.shade_description) + ' are the areas to trace. Scroll to zoom it, drag to move it. The <i>Full document</i> tab has every page of the legal direction.</li>' +
      '<li><b>Click "Go there on the map"</b> for a map sheet: the live map on the left jumps to the same place. Use the street names on both to line them up. The <i>Satellite</i> view (top-right of the map) can help too.</li>' +
      '<li><b>Click "Draw a shape"</b>, then click around the edge of one shaded area, corner by corner. Click the first dot again (or press <span class="kbd">Enter</span>) to finish. <span class="kbd">z</span> undoes the last corner, <span class="kbd">Esc</span> cancels.</li>' +
      '<li><b>Adjust</b> any shape later: click it (or "adjust"), then drag the yellow dots. Drag a white dot to add a corner; right-click a dot to remove it.</li>' +
      '<li>Draw one shape per shaded area. When every shaded area on a sheet is traced, <b>tick the box</b>. If something is unclear, write a note in the box instead — don\'t guess.</li>' +
      '<li>Your work <b>saves automatically in this browser</b>. Use <i>Download a backup</i> if you switch computers.</li>' +
      '<li>When all maps are ticked, press <b>Submit</b>, download the file and attach it to a reply to Anshul\'s email.</li></ol>' +
      '<p class="small">Be as exact as you can: follow the edge of the shading, not the road. If the shading stops halfway along a building, so should your shape.</p>' +
      '<div class="actions"><button class="primary" id="closesubmit">Got it</button></div>');
  }
  $('help').onclick = showHelp;

  // ---------- boot ----------
  fillSel(); showDoc(0);
  restore(); renderSheets();
  try { if (!localStorage.getItem(KEY + ':seen')) { showHelp(); localStorage.setItem(KEY + ':seen', '1'); } } catch (e) {}
})();
