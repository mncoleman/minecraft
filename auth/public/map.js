// Map tab client: the world map (terrain tiles + features) and the area view
// (floor plans + live redstone + levers). Plain JS on Leaflet, no build step.
(function () {
  'use strict';
  var B = window.MAP_BOOT;
  if (!B || !window.L) return;
  var $ = function (id) { return document.getElementById(id); };
  // Minecraft axes: x east, z SOUTH. On Leaflet's plain CRS lat = -z, lng = x, so
  // north is up and the tile maths (pixel y = z * 2^zoom) lines up with the tiles.
  var CRS = L.CRS.Simple;
  function P(x, z) { return [-z, x]; }
  var EMPTY = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function getJ(url) {
    return fetch(url, { credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then(function (r) { return r.json().catch(function () { return { error: 'HTTP ' + r.status }; }).then(function (j) { if (!r.ok && !j.error) j.error = 'HTTP ' + r.status; return j; }); });
  }
  function postJ(url, body) {
    return fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body || {}) })
      .then(function (r) { return r.json().catch(function () { return { error: 'HTTP ' + r.status }; }).then(function (j) { if (!r.ok && !j.error) j.error = 'HTTP ' + r.status; return j; }); });
  }
  // The panel's own form routes (Command Center teleport, saved places) answer a
  // from=map request by redirecting to /map/api/ack?msg|err, which fetch follows.
  function postForm(url, form) {
    form.from = 'map';
    return fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form) })
      .then(function (r) { return r.json().catch(function () { return { err: "That didn't work (HTTP " + r.status + ')' }; }); })
      .catch(function () { return { err: 'Network error.' }; });
  }
  var toastEl, toastT;
  function toast(msg, isErr) {
    if (!toastEl) { toastEl = document.createElement('div'); toastEl.className = 'mp-toast'; toastEl.setAttribute('role', 'status'); document.body.appendChild(toastEl); }
    toastEl.textContent = msg; toastEl.className = 'mp-toast show' + (isErr ? ' err' : '');
    clearTimeout(toastT); toastT = setTimeout(function () { toastEl.className = 'mp-toast'; }, isErr ? 6000 : 3500);
  }
  function ago(t) {
    if (!t) return 'never';
    var s = Math.max(0, Math.floor(Date.now() / 1000 - t));
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + ' min ago';
    if (s < 86400) return Math.floor(s / 3600) + ' h ago';
    var d = new Date(t * 1000);
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }
  function layerBtn(L0, on, count) {
    return '<button type="button" class="mp-layer" data-layer="' + L0[0] + '" aria-pressed="' + (on ? 'true' : 'false') + '">' +
      '<span class="sw" style="background:' + L0[2] + '"></span><span class="lb">' + esc(L0[1]) + '</span>' +
      '<span class="ct">' + (count ? count : '') + '</span><span class="on">' + (on ? 'On' : 'Off') + '</span></button>';
  }
  function coordsReadout(map, el, fmt) {
    map.on('mousemove', function (e) { el.textContent = fmt(Math.floor(e.latlng.lng), Math.floor(-e.latlng.lat)); });
    map.on('click', function (e) { el.textContent = fmt(Math.floor(e.latlng.lng), Math.floor(-e.latlng.lat)) + '  (tapped)'; });
  }
  // A light grid: blocks when close, chunks, then 64s, then regions.
  var Grid = L.GridLayer.extend({
    createTile: function (c) {
      var t = document.createElement('canvas'), size = this.getTileSize();
      t.width = size.x; t.height = size.y;
      var g = t.getContext('2d'), scale = Math.pow(2, c.z), step = c.z >= 3 ? 1 : c.z >= 1 ? 16 : c.z >= -1 ? 64 : 512;
      var bx0 = c.x * size.x / scale, bz0 = c.y * size.y / scale, bw = size.x / scale;
      g.lineWidth = 1;
      for (var v = Math.ceil(bx0 / step) * step; v <= bx0 + bw; v += step) {
        var px = Math.round((v - bx0) * scale) + 0.5; g.strokeStyle = v % 512 === 0 ? 'rgba(255,255,255,.35)' : 'rgba(255,255,255,.14)';
        g.beginPath(); g.moveTo(px, 0); g.lineTo(px, size.y); g.stroke();
      }
      for (var w = Math.ceil(bz0 / step) * step; w <= bz0 + bw; w += step) {
        var py = Math.round((w - bz0) * scale) + 0.5; g.strokeStyle = w % 512 === 0 ? 'rgba(255,255,255,.35)' : 'rgba(255,255,255,.14)';
        g.beginPath(); g.moveTo(0, py); g.lineTo(size.x, py); g.stroke();
      }
      return t;
    }
  });

  // Floating cards: each header collapses its card (remembered per page); one
  // button hides them all. On a phone they start collapsed so the map shows.
  var PHONE = window.matchMedia && window.matchMedia('(max-width: 700px)').matches;
  function cardKey(id) { return 'mp-card2:' + B.mode + ':' + id; }
  function setCard(el, open, remember) {
    el.classList.toggle('collapsed', !open);
    el.querySelector('.mpc-h').setAttribute('aria-expanded', open ? 'true' : 'false');
    if (remember) try { localStorage.setItem(cardKey(el.getAttribute('data-card')), open ? '1' : '0'); } catch (e) { /* private mode */ }
  }
  function openCard(id) { var el = document.querySelector('.mpc[data-card="' + id + '"]'); if (el) setCard(el, true, false); }
  document.querySelectorAll('.mpc').forEach(function (el) {
    var saved = null;
    try { saved = localStorage.getItem(cardKey(el.getAttribute('data-card'))); } catch (e) { /* private mode */ }
    // Only the main card starts open (Selected on the map, Lever on floor plans); the rest fold.
    var dflt = !PHONE && (el.getAttribute('data-card') === 'sel' || el.getAttribute('data-card') === 'lever');
    if (el.getAttribute('data-card') === 'help') {   // open on a first visit, folded after that
      var seen = null; try { seen = localStorage.getItem('mp-help-seen:' + B.mode); localStorage.setItem('mp-help-seen:' + B.mode, '1'); } catch (e) { /* private mode */ }
      dflt = !seen && !PHONE;   // on a phone it would cover the map: the ? button opens it
    }
    setCard(el, saved === null ? dflt : saved === '1', false);
    el.querySelector('.mpc-h').addEventListener('click', function () { setCard(el, el.classList.contains('collapsed'), true); });
  });
  var helpBtn = $('mp-help-btn');
  if (helpBtn) helpBtn.addEventListener('click', function () {
    var el = document.querySelector('.mpc[data-card="help"]'); if (!el) return;
    $('mpf').classList.remove('nocards'); if ($('mpf-cards')) { $('mpf-cards').textContent = 'Hide cards'; $('mpf-cards').setAttribute('aria-pressed', 'false'); }
    setCard(el, true, true); el.scrollIntoView({ block: 'nearest' }); el.querySelector('.mpc-h').focus();
  });
  var cardsBtn = $('mpf-cards');
  if (cardsBtn) cardsBtn.addEventListener('click', function () {
    var hide = !$('mpf').classList.contains('nocards');
    $('mpf').classList.toggle('nocards', hide);
    cardsBtn.setAttribute('aria-pressed', hide ? 'true' : 'false');
    cardsBtn.textContent = hide ? 'Show cards' : 'Hide cards';
  });
  // The top bar wraps on narrow screens: keep the floor tabs and card columns just below it.
  function layoutCols() {
    var t = document.querySelector('.mpf-top'); if (!t) return;
    var h = t.offsetTop + t.offsetHeight + 8, fl = $('mp-floors');
    if (fl) { fl.style.top = h + 'px'; if (fl.offsetHeight) h += fl.offsetHeight + 8; }
    document.querySelectorAll('.mpf-col').forEach(function (c) {
      if (PHONE && c.classList.contains('mpf-right') && document.querySelector('.mpf-left')) return; // bottom-anchored on phones
      c.style.top = h + 'px';
    });
  }
  window.addEventListener('resize', layoutCols);
  if (window.ResizeObserver) { var top0 = document.querySelector('.mpf-top'); if (top0) new ResizeObserver(layoutCols).observe(top0); var fl0 = $('mp-floors'); if (fl0) new ResizeObserver(layoutCols).observe(fl0); }
  layoutCols();
  function sidePad(map) { return PHONE ? 8 : Math.round(Math.min(340, map.getSize().x * 0.28)); }
  function baseMap(opts, fit) {
    var map = L.map('mp-map', L.extend({ crs: CRS, attributionControl: false, zoomControl: false, keyboard: true }, opts));
    L.control.zoom({ position: 'bottomleft' }).addTo(map);
    var Fit = L.Control.extend({
      options: { position: 'bottomleft' },
      onAdd: function () {
        var d = L.DomUtil.create('div', 'leaflet-bar'), a = L.DomUtil.create('a', 'mp-fit', d);
        a.href = '#'; a.title = 'Fit to view'; a.setAttribute('role', 'button'); a.setAttribute('aria-label', 'Fit to view'); a.innerHTML = '&#x2922;';
        L.DomEvent.on(a, 'click', function (e) { L.DomEvent.preventDefault(e); L.DomEvent.stopPropagation(e); fit(); });
        L.DomEvent.disableClickPropagation(d);
        return d;
      }
    });
    new Fit().addTo(map);
    return map;
  }
  var sel = document.getElementById('mp-world');
  if (sel) sel.addEventListener('change', function () { location.href = sel.value; });

  if (B.mode === 'world') worldView(); else areaView();

  // ═══════════════════════════════════════════════════════════════ world map
  function worldView() {
    // [colour, layer, size px, radius, label priority (lower shows first)]
    var KIND = {
      gate: ['#46d17f', 'gates', 10, '2px', 1], wall: ['#46d17f', 'gates', 7, '2px', 5],
      area: ['#ffb454', 'buildings', 9, '3px', 2], building: ['#ffb454', 'buildings', 9, '50%', 2],
      saved: ['#5aa9ff', 'places', 7, '50%', 3], place: ['#5aa9ff', 'places', 7, '50%', 3],
      tower: ['#e6e9ee', 'towers', 7, '2px', 4], control: ['#e3b34a', 'controls', 7, '1px', 5],
      passage: ['#c08cff', 'underground', 7, '50%', 6], rail: ['#c08cff', 'underground', 7, '50%', 6],
      planned: ['#ffd166', 'planned', 8, '2px', 6], keepclear: ['#ff6b6b', 'keepclear', 8, '50%', 6]
    };
    var SECRET = '#ff8ad8';
    // [id, label, swatch, default ('on' | 'off' | 'auto'), zoom at which 'auto' shows it]
    var LAYERS = [['gates', 'Gates and walls', '#46d17f', 'on'], ['buildings', 'Buildings and areas', '#ffb454', 'on'], ['places', 'Places', '#5aa9ff', 'on'],
      ['towers', 'Towers', '#e6e9ee', 'auto', 2], ['controls', 'Controls (levers, buttons)', '#e3b34a', 'auto', 4], ['underground', 'Underground and rails', '#c08cff', 'auto', 3],
      ['planned', 'Planned', '#ffd166', 'auto', 2], ['keepclear', 'Keep clear', '#ff6b6b', 'auto', 2], ['secret', 'Secret passages', SECRET, 'auto', 3],
      ['labels', 'Labels', '#e6e9ee', 'on'], ['grid', 'Grid', '#8b95a3', 'off']];
    var KEY = [['Grass', 'rgb(112,157,49)'], ['Trees', 'rgb(0,109,0)'], ['Cherry trees', 'rgb(213,112,145)'], ['Water', 'rgb(56,56,224)'], ['Sand and birch', 'rgb(217,205,143)'],
      ['Stone and cobble', 'rgb(99,99,99)'], ['Snow', 'rgb(224,224,224)'], ['Dirt and paths', 'rgb(133,96,68)'], ['Deepslate (walls)', 'rgb(88,88,88)'], ['Copper and lamps', 'rgb(190,112,45)']];
    var LKEY = 'mp-layers2:' + B.srv + '/' + B.mv, show = {}, REVEAL = {};
    LAYERS.forEach(function (L0) { show[L0[0]] = L0[3]; if (L0[4] != null) REVEAL[L0[0]] = L0[4]; });
    try { var savedL = JSON.parse(localStorage.getItem(LKEY) || 'null'); if (savedL) for (var k0 in savedL) if (k0 in show && /^(on|off|auto)$/.test(savedL[k0])) show[k0] = savedL[k0]; } catch (e) { /* private mode */ }
    function visible(layer) { var v = show[layer]; return v === 'on' || (v === 'auto' && REVEAL[layer] != null && map.getZoom() >= REVEAL[layer]); }
    var data = null, selId = null, tiles = null, gridLayer = null, featureGroup = L.layerGroup(), markers = {}, fitted = false, pollT = null;

    $('mp-key').innerHTML = KEY.map(function (k) { return '<span><i style="background:' + k[1] + '"></i>' + esc(k[0]) + '</span>'; }).join('');
    var map = baseMap({ minZoom: -5, maxZoom: 5, zoomSnap: 1 }, function () { fitView(); });
    featureGroup.addTo(map);
    map.setView(P(150, 150), -1);
    coordsReadout(map, $('mp-coords'), function (x, z) { return 'x ' + x + '  ·  z ' + z; });
    function zoomLabel() { var z = map.getZoom(); $('mp-zoom').textContent = z >= 0 ? Math.pow(2, z) + ' px per block' : '1 px = ' + Math.pow(2, -z) + ' blocks'; }
    map.on('zoomend', function () { zoomLabel(); drawFeatures(); if (data) renderLayers(); });
    zoomLabel();

    function layerOf(f) {
      if (f.saved) return 'places';
      if (f.secret) return 'secret';
      var l = (KIND[f.kind] || KIND.place)[1];
      if (f.underground && l !== 'planned' && l !== 'keepclear' && l !== 'controls') return 'underground';
      return l;
    }
    function colorOf(f) { return f.secret ? SECRET : (KIND[f.kind] || KIND.place)[0]; }

    // ── 3D view (BlueMap, proxied at /map/3d/) over the same cards ──
    var view = null, frame = null;
    function setView(v) {
      view = v;
      try { localStorage.setItem('mp-view:' + B.srv + '/' + B.mv, v); } catch (e) { /* private mode */ }
      var three = v === '3d';
      if (three && !frame) {
        frame = document.createElement('iframe');
        frame.id = 'mp-3d'; frame.className = 'mpf-3d'; frame.title = '3D map of ' + (data ? data.world.name : B.mv);
        var anchor = null;
        (data ? data.features : []).forEach(function (f) { if (!anchor && f.kind === 'area' && f.x != null) anchor = f; });
        frame.src = '/map/3d/#' + B.mv + (anchor ? ':' + (anchor.x + 0.5) + ':' + (anchor.y || 80) + ':' + (anchor.z + 0.5) + ':450:0:0.75:0:0:perspective' : '');
        frame.addEventListener('load', function () {
          try {
            var d = frame.contentDocument, st = d.createElement('style'), lastPop = null;
            // BlueMap's own control bar moves to the bottom, clear of the floating cards.
            st.textContent = '#app .control-bar{top:auto!important;bottom:8px!important;left:8px!important;right:56px!important}.bm-marker-poi-label{width:max-content;max-width:280px;white-space:normal}';
            d.head.appendChild(st);
            // Marker details carry data-mp-f=<feature id>: a click on a marker (POI) or a
            // line/area popup shows that feature in the Selected card.
            var pickSlug = function (slug) {
              if (!slug || !data) return;
              data.features.forEach(function (f) { if (f.slug === slug) { selId = f.id; renderSel(); openCard('sel'); } });
            };
            d.addEventListener('click', function (e) {
              var m = e.target && e.target.closest && e.target.closest('.bm-marker-html');
              var el = m && m.querySelector('[data-mp-f]');
              if (el) pickSlug(el.getAttribute('data-mp-f'));
            }, true);
            new MutationObserver(function () {
              var el = d.querySelector('.bm-marker-popup [data-mp-f]'), slug = el ? el.getAttribute('data-mp-f') : null;
              if (slug === lastPop) return;
              lastPop = slug; pickSlug(slug);
            }).observe(d.body, { childList: true, subtree: true });
          } catch (e) { /* not same-origin (should not happen) */ }
        });
        $('mpf').insertBefore(frame, $('mp-map').nextSibling);
      }
      if (frame) frame.hidden = !three;
      $('mpf').classList.toggle('three', three);
      var b = $('mp-view'); b.hidden = !data || !data.bluemap;
      b.textContent = three ? 'Top-down' : '3D';
      b.setAttribute('aria-label', three ? 'Switch to the top-down map' : 'Switch to the 3D map');
      if (!three) setTimeout(function () { map.invalidateSize(); }, 50);
    }
    $('mp-view').addEventListener('click', function () { setView(view === '3d' ? '2d' : '3d'); });
    function fly(x, y, z, dist) {
      if (view !== '3d' || !frame) return false;
      try { frame.contentWindow.location.hash = B.mv + ':' + (x + 0.5) + ':' + (y == null ? 80 : y) + ':' + (z + 0.5) + ':' + (dist || 120) + ':0:0.9:0:0:perspective'; return true; } catch (e) { return false; }
    }
    function load(first) {
      return getJ(B.api).then(function (j) {
        if (j.error) { $('mp-status').textContent = j.error; $('mp-status').className = 'mp-status err'; return; }
        data = j;
        if (first) { var pref = null; try { pref = localStorage.getItem('mp-view:' + B.srv + '/' + B.mv); } catch (e) { /* private mode */ } setView(data.bluemap && pref !== '2d' ? '3d' : '2d'); }
        var openGroups = [].map.call(document.querySelectorAll('.mp-cg[open] summary span:first-child'), function (x) { return x.textContent; });
        renderStatus(); renderTiles(); renderLayers(); drawFeatures(); renderUpdates(); renderControls(); renderSel();
        document.querySelectorAll('.mp-cg').forEach(function (d) { if (openGroups.indexOf(d.querySelector('summary span').textContent) >= 0) d.open = true; });
        if (first && !fitted) fitView();
      });
    }
    function fitView() {
      var pts = [];
      data.features.forEach(function (f) { if (f.x != null && f.z != null && !f.secret) pts.push(P(f.x, f.z)); });
      var pad = { animate: fitted, paddingTopLeft: [sidePad(map), PHONE ? 120 : 70], paddingBottomRight: [sidePad(map), 12] };
      if (pts.length >= 2) { map.fitBounds(L.latLngBounds(pts), pad); fitted = true; return; }
      var b = data.map && data.map.bounds;
      if (b) { map.fitBounds([P(b.x0, b.z0), P(b.x1 + 1, b.z1 + 1)], pad); fitted = true; }
    }
    function renderStatus() {
      var m = data.map, el = $('mp-status'), btn = $('mp-render');
      el.className = 'mp-status';
      if (!m) { el.textContent = 'Not mapped yet'; btn.textContent = 'Map this world'; btn.hidden = false; return; }
      btn.textContent = 'Render now';
      var busy = m.status === 'queued' || m.status === 'rendering' || m.status === 'partial' || (m.pending > 0);
      if (busy) el.innerHTML = '<span class="spinner"></span> Rendering terrain' + (m.pending ? ' (' + m.pending + ' regions to go)' : '') + '…';
      else if (/^error/.test(m.status)) { el.textContent = 'Last render failed · ' + ago(m.rendered_at); el.className = 'mp-status err'; }
      else el.textContent = 'Terrain from the world save · ' + ago(m.rendered_at);
      btn.disabled = busy;
      if (data.map.bounds && $('mp-extent')) $('mp-extent').textContent = 'x ' + data.map.bounds.x0 + ' … ' + data.map.bounds.x1 + ' · z ' + data.map.bounds.z0 + ' … ' + data.map.bounds.z1;
      clearTimeout(pollT);
      if (busy) pollT = setTimeout(function () { load(false); }, 5000);
    }
    $('mp-render').addEventListener('click', function () {
      var btn = $('mp-render'); btn.disabled = true;
      postJ(B.api + '/render', {}).then(function (j) {
        if (j.error) { toast(j.error, true); btn.disabled = false; return; }
        toast('Rendering. The map refreshes when it\'s done.');
        setTimeout(function () { load(false); }, 1500);
      });
    });
    function renderTiles() {
      var m = data.map;
      if (!m) return;
      if (!tiles) {
        var Layer = L.TileLayer.extend({
          getTileUrl: function (c) {
            var v = data.map && data.map.tiles[c.z + '/' + c.x + '/' + c.y];
            return v ? '/map/tiles/' + B.srv + '/' + B.mv + '/' + c.z + '/' + c.x + '_' + c.y + '.png?v=' + v : EMPTY;
          }
        });
        tiles = new Layer('', { tileSize: 512, minNativeZoom: m.min_zoom, maxNativeZoom: 0, minZoom: -5, maxZoom: 5, noWrap: true, keepBuffer: 2, errorTileUrl: EMPTY });
        tiles.addTo(map); tiles.bringToBack();
        tiles._mpKey = JSON.stringify(m.tiles);
      } else {
        var key = JSON.stringify(m.tiles);
        if (key !== tiles._mpKey) { tiles._mpKey = key; tiles.options.minNativeZoom = m.min_zoom; tiles.redraw(); }
      }
      if (show.grid === 'on' && !gridLayer) gridLayer = new Grid({ tileSize: 256, minZoom: -5, maxZoom: 5 }).addTo(map);
      if (show.grid !== 'on' && gridLayer) { map.removeLayer(gridLayer); gridLayer = null; }
    }
    function renderLayers() {
      var counts = {};
      allItems().forEach(function (f) { var l = layerOf(f); counts[l] = (counts[l] || 0) + 1; });
      $('mp-layers').innerHTML = LAYERS.filter(function (L0) { return L0[0] !== 'secret' || counts.secret; }).map(function (L0) {
        var v = show[L0[0]], on = visible(L0[0]);
        var word = v === 'auto' ? (on ? 'Auto · on' : 'Auto') : v === 'on' ? 'On' : 'Off';
        return '<button type="button" class="mp-layer" data-layer="' + L0[0] + '" aria-pressed="' + (on ? 'true' : 'false') + '" title="' +
          (v === 'auto' ? 'Shows by itself once you zoom in close. Click to turn it on everywhere.' : 'Click to change') + '"><span class="sw" style="background:' + L0[2] + '"></span><span class="lb">' + esc(L0[1]) + '</span>' +
          '<span class="ct">' + (counts[L0[0]] || '') + '</span><span class="on">' + word + '</span></button>';
      }).join('');
    }
    $('mp-layers').addEventListener('click', function (e) {
      var b = e.target.closest('.mp-layer'); if (!b) return;
      var k = b.getAttribute('data-layer'), L0 = LAYERS.filter(function (x) { return x[0] === k; })[0];
      var cyc = L0[4] != null ? ['auto', 'on', 'off'] : ['on', 'off'];
      show[k] = cyc[(cyc.indexOf(show[k]) + 1) % cyc.length];
      try { localStorage.setItem(LKEY, JSON.stringify(show)); } catch (err) { /* private mode */ }
      renderLayers(); renderTiles(); drawFeatures();
    });

    function allItems() {
      var list = data.features.slice();
      data.places.forEach(function (p) { list.push({ id: 'place:' + p.id, saved: true, kind: 'saved', kindLabel: 'Your saved place', name: p.name, x: p.x, y: p.y, z: p.z, detail: 'One of your saved places (also in the Command Center).', status: '' }); });
      return list;
    }
    // Markers: small dots; nearby ones merge into a numbered bubble when zoomed out;
    // labels only where they don't overlap, most important first.
    function drawFeatures() {
      if (!data) return;
      featureGroup.clearLayers(); markers = {};
      var z = map.getZoom(), pts = [];
      allItems().forEach(function (f) {
        var layer = layerOf(f), isSel = selId === f.id;
        if (!visible(layer) && !isSel) return;
        var col = f.saved ? KIND.saved[0] : colorOf(f);
        var pick = function () { select(f.id, false); };
        if (f.points && f.points.length > 1) {
          var ll = f.points.map(function (p) { return P(p[0] + 0.5, p[p.length - 1] + 0.5); });
          var dash = f.kind === 'wall' ? null : f.kind === 'planned' ? '6 5' : f.secret ? '2 4' : '7 5';
          L.polyline(ll, { color: col, weight: f.kind === 'wall' ? 2.5 : 2, opacity: isSel ? 1 : 0.7, dashArray: dash, lineCap: 'round', lineJoin: 'round' }).on('click', pick).addTo(featureGroup);
        }
        if (f.box) {
          var b = f.box;
          L.rectangle([P(b.from[0], b.from[2]), P(b.to[0] + 1, b.to[2] + 1)], {
            color: col, weight: isSel ? 2 : 1, opacity: isSel ? 0.9 : 0.55, fillColor: col, fillOpacity: isSel ? 0.12 : 0.05,
            dashArray: f.kind === 'keepclear' || f.kind === 'planned' || f.secret ? '6 4' : null
          }).on('click', pick).addTo(featureGroup);
        }
        if (f.x == null || f.z == null) return;
        if ((f.kind === 'wall' || f.kind === 'rail' || f.kind === 'passage') && f.points && f.points.length > 1 && !isSel) return; // the line is the feature
        pts.push({ f: f, col: col, isSel: isSel, k: KIND[f.saved ? 'saved' : f.kind] || KIND.place, px: map.project(P(f.x + 0.5, f.z + 0.5), z) });
      });
      // cluster: below 2 px per block, markers within ~30 px share one bubble
      var singles = [], clusters = {};
      if (z < 1) {
        var CELL = 30;
        pts.forEach(function (p) {
          if (p.isSel) { singles.push(p); return; }
          var key = Math.floor(p.px.x / CELL) + ':' + Math.floor(p.px.y / CELL);
          (clusters[key] = clusters[key] || []).push(p);
        });
        Object.keys(clusters).forEach(function (key) { if (clusters[key].length === 1) { singles.push(clusters[key][0]); delete clusters[key]; } });
      } else singles = pts;
      var boxes = [];
      function hits(r) { for (var i = 0; i < boxes.length; i++) { var o = boxes[i]; if (r.x < o.x + o.w && o.x < r.x + r.w && r.y < o.y + o.h && o.y < r.y + r.h) return true; } return false; }
      Object.keys(clusters).forEach(function (key) {
        var g = clusters[key], sx = 0, sy = 0;
        g.forEach(function (p) { sx += p.px.x; sy += p.px.y; });
        var c = L.point(sx / g.length, sy / g.length);
        boxes.push({ x: c.x - 14, y: c.y - 14, w: 28, h: 28 });
        var m = L.marker(map.unproject(c, z), {
          icon: L.divIcon({ className: 'mk-cl', iconSize: [44, 44], iconAnchor: [22, 22], html: '<span>' + g.length + '</span>' }),
          title: g.length + ' places here: ' + g.slice(0, 6).map(function (p) { return p.f.name; }).join(', ') + (g.length > 6 ? '…' : '') + '. Click to zoom in.', keyboard: true
        });
        m.on('click', function () { map.fitBounds(L.latLngBounds(g.map(function (p) { return P(p.f.x + 0.5, p.f.z + 0.5); })).pad(0.4), { maxZoom: Math.max(z + 2, 1) }); });
        m.addTo(featureGroup);
      });
      singles.forEach(function (p) { boxes.push({ x: p.px.x - 6, y: p.px.y - 6, w: 12, h: 12 }); });
      singles.sort(function (a, b) { return (b.isSel - a.isSel) || (a.k[4] - b.k[4]) || a.f.name.localeCompare(b.f.name); });
      singles.forEach(function (p) {
        var f = p.f, k = p.k, s = k[2];
        var pick = function () { select(f.id, false); };
        var icon = L.divIcon({ className: 'mk' + (p.isSel ? ' sel' : ''), iconSize: [32, 32], iconAnchor: [16, 16],
          html: '<span class="dot" style="width:' + s + 'px;height:' + s + 'px;background:' + p.col + ';border-radius:' + k[3] + (f.kind === 'control' ? ';transform:rotate(45deg)' : '') + '"></span>' });
        var m = L.marker(P(f.x + 0.5, f.z + 0.5), { icon: icon, title: f.name + ' (' + (f.kindLabel || f.kind) + ')', alt: f.name, keyboard: true, riseOnHover: true, zIndexOffset: p.isSel ? 1000 : 0 });
        m.on('click', pick);
        m.on('keypress', function (e) { if (e.originalEvent.key === 'Enter' || e.originalEvent.key === ' ') pick(); });
        // label: by priority and zoom, only where it fits
        var minZ = k[4] <= 2 ? -2 : k[4] === 3 ? -1 : 1;
        if (visible('labels') && (p.isSel || z >= minZ)) {
          var w = Math.min(220, 7 * f.name.length + 16), r = { x: p.px.x - w / 2, y: p.px.y + 8, w: w, h: 20 };
          if (p.isSel || !hits(r)) { boxes.push(r); m.bindTooltip(esc(f.name), { permanent: true, direction: 'bottom', offset: [0, 6], className: 'mp-label' + (p.isSel ? ' sel' : '') }); }
        }
        m.addTo(featureGroup); markers[f.id] = m;
      });
    }
    function find(id) { var all = allItems(); for (var i = 0; i < all.length; i++) if (all[i].id === id) return all[i]; return null; }
    function select(id, pan) {
      selId = id; drawFeatures(); renderSel(); openCard('sel');
      var f = find(id);
      if (pan && f && f.x != null && !fly(f.x, f.y, f.z, f.kind === 'control' ? 22 : f.kind === 'tower' || f.saved ? 70 : 140)) map.setView(P(f.x + 0.5, f.z + 0.5), Math.max(map.getZoom(), f.kind === 'control' ? 4 : f.kind === 'tower' || f.saved ? 2 : 1));
    }
    function chip(text, col) { return '<span class="mp-chip" style="color:' + col + '">' + esc(text) + '</span>'; }
    function renderSel() {
      var el = $('mp-sel'), f = selId ? find(selId) : null;
      if (!f) { el.innerHTML = '<p class="muted" style="margin:0">Click a tower, gate, building or place on the map.</p>'; return; }
      var col = f.saved ? KIND.saved[0] : colorOf(f);
      var stc = /plan|building now/i.test(f.status) ? '#ffd166' : /protect/i.test(f.status) ? '#ff6b6b' : '#46d17f';
      var where = f.x != null ? f.x + ', ' + (f.y == null ? '?' : f.y) + ', ' + f.z : '—';
      var h = '<div class="mp-chips">' + chip(f.kindLabel || f.kind, col) + (f.status ? chip(f.status, stc) : '') + (f.secret ? chip('Secret', SECRET) : '') + '</div>' +
        '<h4>' + esc(f.name) + '</h4>' + (f.detail ? '<p class="d">' + esc(f.detail) + '</p>' : '') +
        '<div class="mp-facts"><div class="mp-fact"><div class="k">Where</div><div class="v">' + esc(where) + '</div></div>' +
        '<div class="mp-fact"><div class="k">Updated</div><div class="v t">' + (f.updated_at ? esc(ago(f.updated_at)) : '—') + '</div></div></div><div class="mp-acts">';
      if (f.kind === 'control') h = h.replace('<div class="mp-acts">', controlFacts(f) + '<div class="mp-acts">');
      if (f.y != null) h += '<button type="button" class="btn-primary" data-act="tp">Teleport here</button>';
      if (f.x != null && f.y != null && !f.saved) h += '<button type="button" class="btn-ghost" data-act="save">Save as place</button>';
      if (f.drill) h += '<a class="btn-area" href="/map/' + B.srv + '/' + encodeURIComponent(B.mv) + '/area/' + encodeURIComponent(f.id) + '">Open floor plans and power</a>';
      h += '</div>';
      if (f.y == null && f.x != null) h += '<p class="mp-note">No height stored for this one, so there\'s no teleport.</p>';
      el.innerHTML = h;
    }
    $('mp-sel').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-act]'); if (!b) return;
      var f = find(selId); if (!f) return;
      b.disabled = true;
      var done = function (j) { b.disabled = false; if (j.err) toast(j.err, true); else toast(j.msg || 'Done.'); };
      if (b.getAttribute('data-act') === 'tp') {
        postForm('/worlds/' + encodeURIComponent(B.worldId) + '/run', { cmd: 'tp_loc', world: B.mv, x: f.x, y: f.y, z: f.z, label: f.name.slice(0, 40) }).then(done);
      } else {
        postForm('/worlds/' + encodeURIComponent(B.worldId) + '/saveloc', { name: f.name.slice(0, 40), x: f.x, y: f.y, z: f.z }).then(function (j) { done(j); if (!j.err) load(false); });
      }
    });
    function statePill(f) {
      var st = f.state || {};
      if (st.on == null) return '<span class="mp-pill" title="Its chunk is not loaded and it is not in the last save">?</span>';
      var word = st.label ? st.label : (st.on ? 'ON' : 'OFF');
      return '<span class="mp-pill' + (st.on ? ' on' : '') + '" title="' + (st.source === 'live' ? 'Live from the server' : 'From the last save') + '">' + esc(word) + (st.source === 'save' ? ' · saved' : '') + '</span>';
    }
    function controlFacts(f) {
      var c = f.control || {}, h = '<dl class="mp-ctl">';
      if (c.reach) h += '<dt>Reach</dt><dd>' + esc(c.reach) + '</dd>';
      if (c.on) h += '<dt>ON</dt><dd>' + esc(c.on) + '</dd>';
      if (c.off) h += '<dt>OFF</dt><dd>' + esc(c.off) + '</dd>';
      if (c.drives) h += '<dt>Drives</dt><dd>' + esc(c.drives) + '</dd>';
      h += '<dt>Now</dt><dd>' + statePill(f) + (c.verified === false ? ' <span class="mp-chip" style="color:#ffd166">Unverified</span>' : '') + '</dd></dl>';
      return h;
    }
    function renderControls() {
      var el = $('mp-controls'); if (!el) return;
      var cs = data.features.filter(function (f) { return f.kind === 'control'; });
      if (!cs.length) { el.innerHTML = '<p class="muted" style="margin:0">No controls mapped in this world yet.</p>'; return; }
      var groups = {}, order = [];
      cs.forEach(function (f) { var g = (f.control && f.control.group) || 'Other'; if (!groups[g]) { groups[g] = []; order.push(g); } groups[g].push(f); });
      var rank = function (g) { return /gate|postern|harbour/i.test(g) ? 0 : /tower/i.test(g) ? 1 : 2; };
      order.sort(function (a, b) { return rank(a) - rank(b) || a.localeCompare(b); });
      order.forEach(function (g) { groups[g].sort(function (a, b) { return ((b.control || {}).verified !== false) - ((a.control || {}).verified !== false) || ((a.control || {}).type === 'lever' ? 0 : 1) - ((b.control || {}).type === 'lever' ? 0 : 1) || a.name.localeCompare(b.name); }); });
      el.innerHTML = order.map(function (g) {
        return '<details class="mp-cg"><summary><span>' + esc(g) + '</span><span class="mp-hint">' + groups[g].length + '</span></summary>' + groups[g].map(function (f) {
          var c = f.control || {};
          return '<div class="mp-ci"><div class="mp-ci-h"><b>' + esc(f.name) + '</b>' + statePill(f) + '</div>' +
            '<div class="mp-hint">' + f.x + ' ' + f.y + ' ' + f.z + (c.verified === false ? ' · unverified' : '') + '</div>' +
            (c.reach ? '<div class="mp-ci-t"><b>Reach</b> ' + esc(c.reach) + '</div>' : '') +
            (c.on ? '<div class="mp-ci-t"><b>ON</b> ' + esc(c.on) + '</div>' : '') +
            (c.off ? '<div class="mp-ci-t"><b>OFF</b> ' + esc(c.off) + '</div>' : '') +
            (c.drives ? '<div class="mp-ci-t"><b>Drives</b> ' + esc(c.drives) + '</div>' : '') +
            '<button type="button" class="mp-show" data-f="' + esc(f.id) + '">Show on map</button></div>';
        }).join('') + '</details>';
      }).join('');
    }
    $('mp-controls').addEventListener('click', function (e) {
      var b = e.target.closest('.mp-show'); if (!b) return;
      var id = b.getAttribute('data-f');
      select(id, true);
    });
    function renderUpdates() {
      var el = $('mp-updates');
      if (!data.updates.length) { el.innerHTML = '<p class="muted" style="margin:0">Nothing yet. When Claude builds something, it adds it here.</p>'; return; }
      el.innerHTML = data.updates.map(function (u) {
        return '<button type="button" class="mp-upd" data-f="' + esc(u.feature || '') + '"><span class="t"><b>' + esc(u.title) + '</b><span>' + esc(ago(u.at)) + '</span></span><span class="w">' + esc(u.what) + '</span></button>';
      }).join('');
    }
    $('mp-updates').addEventListener('click', function (e) {
      var b = e.target.closest('.mp-upd'); if (!b) return;
      var id = b.getAttribute('data-f');
      if (id && find(id)) select(id, true);
      else toast('That one has been removed from the map.');
    });
    // ── search: features, controls, areas and saved places by name and kind; "x z" or "x y z" jumps ──
    var GROUPS = [['control', 'Controls'], ['gate', 'Gates'], ['area', 'Areas and buildings'], ['building', 'Areas and buildings'], ['tower', 'Towers'], ['passage', 'Passages'], ['rail', 'Rail lines'], ['saved', 'Your places'], ['place', 'Places'], ['wall', 'Walls'], ['planned', 'Planned'], ['keepclear', 'Keep clear']];
    function groupOf(f) { for (var i = 0; i < GROUPS.length; i++) if (GROUPS[i][0] === f.kind) return GROUPS[i][1]; return 'Other'; }
    function words(s) { return String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean); }
    function near(a, b) {   // one typo allowed in words of 4+ letters
      if (a === b) return true;
      if (a.length < 4 || Math.abs(a.length - b.length) > 1) return false;
      var i = 0, j = 0, e = 0;
      while (i < a.length && j < b.length) { if (a[i] === b[j]) { i++; j++; continue; } if (++e > 1) return false; if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; } }
      return e + (a.length - i) + (b.length - j) <= 1;
    }
    function scoreOf(f, q, qw) {
      var c = f.control || {}, nameW = words(f.name), extraW = words([f.kindLabel, f.kind, c.group, c.type, f.status, f.drill ? 'floor plans area' : '', f.saved ? 'saved place' : ''].join(' '));
      var total = 0;
      for (var i = 0; i < qw.length; i++) {
        var t = qw[i], best = 0;
        nameW.forEach(function (w) { if (w.indexOf(t) === 0) best = Math.max(best, 3); else if (w.indexOf(t) >= 0) best = Math.max(best, 2); else if (near(t, w)) best = Math.max(best, 1.5); });
        if (!best) extraW.forEach(function (w) { if (w.indexOf(t) === 0 || near(t, w)) best = Math.max(best, 1); });
        if (!best) return 0;
        total += best;
      }
      if (f.name.toLowerCase().indexOf(q) === 0) total += 3;
      return total;
    }
    var sIn = $('mp-search'), sOut = $('mp-results'), sActive = -1, sList = [];
    function closeSearch() { sOut.hidden = true; sActive = -1; sIn.setAttribute('aria-expanded', 'false'); }
    function runSearch() {
      var q = sIn.value.trim().toLowerCase();
      if (!q || !data) { closeSearch(); return; }
      sList = [];
      var m = q.match(/^(-?\d+)[\s,]+(?:(-?\d+)[\s,]+)?(-?\d+)$/);
      if (m) sList.push({ coords: true, x: +m[1], y: m[2] != null ? +m[2] : null, z: +m[3], name: 'Go to ' + m[1] + (m[2] != null ? ' ' + m[2] : '') + ' ' + m[3], group: 'Coordinates' });
      var qw = words(q);
      allItems().map(function (f) { return { f: f, s: f.x != null ? scoreOf(f, q, qw) : 0 }; }).filter(function (r) { return r.s > 0; })
        .sort(function (a, b) { return b.s - a.s || a.f.name.localeCompare(b.f.name); }).slice(0, 40)
        .forEach(function (r) { sList.push({ f: r.f, name: r.f.name, group: groupOf(r.f) }); });
      if (!sList.length) { sOut.innerHTML = '<div class="mp-r-none">Nothing matches "' + esc(sIn.value.trim()) + '".</div>'; sOut.hidden = false; return; }
      var order = []; sList.forEach(function (r) { if (order.indexOf(r.group) < 0) order.push(r.group); });
      var flat = [];
      sOut.innerHTML = order.map(function (g) {
        return '<div class="mp-r-g">' + esc(g) + '</div>' + sList.filter(function (r) { return r.group === g; }).map(function (r) {
          flat.push(r); var i = flat.length - 1, f = r.f, c = f && f.control;
          var sub = r.coords ? '' : (c && c.group ? esc(c.group) + ' · ' : '') + f.x + ' ' + (f.y == null ? '' : f.y + ' ') + f.z;
          return '<button type="button" class="mp-r" role="option" data-i="' + i + '" id="mp-r-' + i + '"><span class="mp-r-n">' + esc(r.name) + '</span>' + (sub ? '<span class="mp-r-s">' + sub + '</span>' : '') + '</button>';
        }).join('');
      }).join('');
      sList = flat; sActive = 0; markActive(); sOut.hidden = false; sIn.setAttribute('aria-expanded', 'true');
    }
    function markActive() { [].forEach.call(sOut.querySelectorAll('.mp-r'), function (b) { var on = +b.getAttribute('data-i') === sActive; b.classList.toggle('on', on); if (on) { b.scrollIntoView({ block: 'nearest' }); sIn.setAttribute('aria-activedescendant', b.id); } }); }
    function choose(i) {
      var r = sList[i]; if (!r) return;
      closeSearch(); sIn.blur();
      if (r.coords) {
        if (!fly(r.x, r.y, r.z, 60)) map.setView(P(r.x + 0.5, r.z + 0.5), Math.max(map.getZoom(), 2));
        $('mp-coords').textContent = 'x ' + r.x + '  ·  z ' + r.z;
        return;
      }
      select(r.f.id, true);
    }
    sIn.addEventListener('input', runSearch);
    sIn.addEventListener('focus', function () { if (sIn.value.trim()) runSearch(); });
    sIn.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); if (sActive < sList.length - 1) { sActive++; markActive(); } }
      else if (e.key === 'ArrowUp') { e.preventDefault(); if (sActive > 0) { sActive--; markActive(); } }
      else if (e.key === 'Enter') { e.preventDefault(); choose(sActive < 0 ? 0 : sActive); }
      else if (e.key === 'Escape') { closeSearch(); sIn.blur(); }
    });
    sOut.addEventListener('mousedown', function (e) { var b = e.target.closest('.mp-r'); if (b) { e.preventDefault(); choose(+b.getAttribute('data-i')); } });
    document.addEventListener('click', function (e) { if (!e.target.closest('.mp-search')) closeSearch(); });
    document.addEventListener('keydown', function (e) {
      var t = e.target || {}, n = (t.tagName || '').toUpperCase();
      if (e.key === '/' && n !== 'INPUT' && n !== 'TEXTAREA' && n !== 'SELECT' && !t.isContentEditable) { e.preventDefault(); e.stopPropagation(); sIn.focus(); sIn.select(); }
    }, true);
    load(true);
    setInterval(function () { if (!document.hidden) load(false); }, 60000);
  }

  // ═══════════════════════════════════════════════════════════════ area view
  function areaView() {
    var CAT = { w: 'power', r: 'power', t: 'power', B: 'power', O: 'power', L: 'lights', d: 'lights', Z: 'lights', V: 'controls', U: 'controls', D: 'doors', K: 'doors', P: 'traps', S: 'traps', X: 'traps', R: 'rails' };
    var LAYERS = [['power', 'Power lines', '#ff3b2f'], ['lights', 'Lights and sensors', '#ffe28a'], ['controls', 'Levers and buttons', '#46d17f'], ['doors', 'Doors and pistons', '#cfd6df'],
      ['traps', 'Traps and triggers', '#ff5c93'], ['rails', 'Rails', '#e7c35a'], ['rooms', 'Room names', '#e6e9ee'], ['grid', 'Block grid', '#8b95a3']];
    var NAMES = { w: 'wire', r: 'repeater', t: 'torch', L: 'lamp', D: 'door', K: 'piston' };
    // conduct power onward from these when tracing; everything else is an end point
    var CONDUCT = { w: 1, r: 1, t: 1, O: 1, V: 1 };
    var show = { power: true, lights: true, controls: true, doors: true, traps: true, rails: true, rooms: true, grid: false };
    var data = null, floorY = null, selKey = null, net = null, overlay = null, gridLayer = null, busy = false;
    var renderer = L.canvas({ padding: 0.3 });
    var compGroup = L.layerGroup(), leverGroup = L.layerGroup(), roomGroup = L.layerGroup();
    var map = baseMap({ minZoom: -1, maxZoom: 6, zoomSnap: 0.5 }, function () { if (data) fitBox(false); });
    compGroup.addTo(map); roomGroup.addTo(map); leverGroup.addTo(map);
    coordsReadout(map, $('mp-coords'), function (x, z) { return 'x ' + x + '  ·  y ' + (floorY == null ? '?' : floorY) + '  ·  z ' + z; });

    function key(r) { return r[0] + ',' + r[1] + ',' + r[2]; }
    function floors() { return data ? data.floors.map(function (f) { return f.y; }) : []; }
    function bucket(y) { var fs = floors(), b = fs[0]; for (var i = 0; i < fs.length; i++) if (fs[i] <= y) b = fs[i]; return b; }
    function onFloor(r) { return bucket(r[1]) === floorY; }
    function leverName(r) { return (data.area.levers && data.area.levers[key(r)]) || 'Lever'; }

    function load(fresh) {
      return getJ(B.api + (fresh ? '?fresh=1' : '')).then(function (j) {
        if (j.error) { $('mp-status').textContent = j.error; $('mp-status').className = 'mp-status err'; return; }
        var first = !data;
        data = j;
        if (!data.floors.length) {
          $('mp-status').innerHTML = '<span class="spinner"></span> Cutting floor plans…';
          $('mp-lever').innerHTML = '<p class="muted" style="margin:0">The floor plans for this area are being made from the save. This takes a minute the first time.</p>';
          setTimeout(function () { load(false); }, 6000);
          return;
        }
        if (first || floors().indexOf(floorY) < 0) {
          var want = Number((location.hash.match(/y=(-?\d+)/) || [])[1]);
          floorY = floors().indexOf(want) >= 0 ? want : pickStartFloor();
        }
        if (first) fitBox(true);
        if (selKey && !data.comps.some(function (r) { return key(r) === selKey; })) selKey = null;
        status(); tabs(); layoutCols(); draw();
      });
    }
    function fitBox(instant) {
      var b = data.box;
      map.fitBounds([P(b.from[0], b.from[2]), P(b.to[0] + 1, b.to[2] + 1)], { animate: !instant, paddingTopLeft: [12, PHONE ? 170 : 130], paddingBottomRight: [sidePad(map), 12] });
    }
    function pickStartFloor() {
      // the floor with the most levers, else the busiest one
      var fs = floors(), best = fs[0], bestN = -1;
      fs.forEach(function (y) { var n = 0; data.comps.forEach(function (r) { if (bucket(r[1]) === y) n += r[3] === 'V' ? 50 : 1; }); if (n > bestN) { bestN = n; best = y; } });
      return best;
    }
    function status() {
      var el = $('mp-status');
      el.className = 'mp-status';
      el.textContent = data.live ? 'Live from the server · ' + data.comps.length + ' parts' : 'From the last save · ' + ago(data.generated_at);
      $('mp-live').textContent = (data.live ? 'Live power' : 'Last save') + ' · plans ' + ago(data.generated_at);

    }
    function tabs() {
      $('mp-floors').innerHTML = data.floors.map(function (f) {
        var s = f.y === floorY;
        return '<button type="button" class="mp-floor" role="tab" data-y="' + f.y + '" aria-selected="' + (s ? 'true' : 'false') + '"><span class="y">y ' + f.y + '</span><span>' + esc(f.name) + '</span></button>';
      }).join('');
    }
    $('mp-floors').addEventListener('click', function (e) {
      var b = e.target.closest('.mp-floor'); if (!b) return;
      floorY = Number(b.getAttribute('data-y'));
      history.replaceState(null, '', '#y=' + floorY);
      tabs(); draw();
    });
    function trace() {
      net = null;
      if (!selKey) return;
      var idx = {};
      data.comps.forEach(function (r, i) { idx[key(r)] = i; });
      var start = data.comps[idx[selKey]];
      if (!start) return;
      var seen = {}; seen[selKey] = 1; var q = [start];
      while (q.length) {
        var cur = q.shift();
        if (!CONDUCT[cur[3]]) continue;
        for (var dx = -2; dx <= 2; dx++) for (var dy = -2; dy <= 2; dy++) for (var dz = -2; dz <= 2; dz++) {
          var d = Math.abs(dx) + Math.abs(dy) + Math.abs(dz);
          if (d === 0 || d > 2) continue;
          var k = (cur[0] + dx) + ',' + (cur[1] + dy) + ',' + (cur[2] + dz);
          if (seen[k] || idx[k] === undefined) continue;
          var nb = data.comps[idx[k]];
          if (nb[3] === 'R' || nb[3] === 'V') continue;   // rails and other levers aren't part of this circuit
          seen[k] = 1; q.push(nb);
        }
      }
      net = seen;
    }
    function style(r, inNet) {
      var c = r[3], v = r[4], fill = '#888', s = 0.62, stroke = false, sc = '#000';
      if (c === 'w') { fill = v > 0 ? 'rgb(255,' + Math.round(40 + v * 9) + ',40)' : '#6e1a14'; s = 0.5; }
      else if (c === 'r') { fill = v ? '#ff8a3d' : '#7a4a2a'; s = 0.7; }
      else if (c === 't') { fill = v ? '#ff3b2f' : '#5b1612'; s = 0.42; }
      else if (c === 'B') { fill = '#d0241a'; s = 0.9; }
      else if (c === 'O') { fill = v ? '#ff8a3d' : '#8a8f99'; s = 0.7; }
      else if (c === 'L') { fill = v ? '#ffe28a' : '#4a3a20'; s = 0.86; stroke = true; sc = v ? '#fff4c4' : '#000'; }
      else if (c === 'd') { fill = v ? '#e9d79a' : '#8a7a58'; s = 0.86; }
      else if (c === 'Z') { fill = v ? '#ffb070' : '#d9894a'; s = 0.4; }
      else if (c === 'D') { fill = v ? '#ffffff' : '#a9b2bd'; s = 0.86; stroke = true; }
      else if (c === 'K') { fill = v ? '#9be37d' : '#6f8f55'; s = 0.86; stroke = true; }
      else if (c === 'P' || c === 'X') { fill = v ? '#ff9cc0' : '#ff5c93'; s = 0.7; stroke = true; }
      else if (c === 'S') { fill = v ? '#7fe8f5' : '#2fb5c9'; s = 0.7; stroke = true; }
      else if (c === 'R') { fill = v ? '#ffd76a' : '#9a8a70'; s = 0.36; }
      else if (c === 'U') { fill = v ? '#e6e6e6' : '#9a9a9a'; s = 0.4; }
      var op = selKey && !inNet && c !== 'R' ? 0.28 : 1;
      if (selKey && inNet) { stroke = true; sc = '#ffffff'; }
      return { fill: fill, s: s, stroke: stroke, sc: sc, op: op };
    }
    function draw() {
      if (!data) return;
      var f = data.floors.filter(function (x) { return x.y === floorY; })[0];
      var b = data.box, bounds = [P(b.from[0], b.from[2]), P(b.to[0] + 1, b.to[2] + 1)];
      if (!overlay) overlay = L.imageOverlay(f.img, bounds, { className: 'mp-planimg', alt: 'Floor plan at y ' + f.y }).addTo(map);
      else if (overlay._url !== f.img) overlay.setUrl(f.img);
      overlay.bringToBack();
      if (show.grid && !gridLayer) gridLayer = new Grid({ tileSize: 256, minZoom: -1, maxZoom: 6 }).addTo(map);
      if (!show.grid && gridLayer) { map.removeLayer(gridLayer); gridLayer = null; }
      trace();
      compGroup.clearLayers(); leverGroup.clearLayers(); roomGroup.clearLayers();
      data.comps.forEach(function (r) {
        if (!onFloor(r)) return;
        var cat = CAT[r[3]] || 'power';
        if (!show[cat]) return;
        var inNet = !!(net && net[key(r)]);
        if (r[3] === 'V') {
          var k = key(r), isSel = selKey === k;
          var m = L.marker(P(r[0] + 0.5, r[2] + 0.5), {
            icon: L.divIcon({ className: 'lv' + (r[4] ? ' on' : '') + (isSel ? ' sel' : ''), iconSize: [44, 44], iconAnchor: [22, 22], html: '<span class="dot"></span>' }),
            title: leverName(r) + ', ' + (r[4] ? 'on' : 'off'), alt: leverName(r), keyboard: true, zIndexOffset: isSel ? 1000 : 500
          });
          m.on('click', function () { pick(k); });
          m.on('keypress', function (e) { if (e.originalEvent.key === 'Enter' || e.originalEvent.key === ' ') pick(k); });
          m.addTo(leverGroup);
          return;
        }
        var st = style(r, inNet), pad = (1 - st.s) / 2;
        L.rectangle([P(r[0] + pad, r[2] + pad), P(r[0] + 1 - pad, r[2] + 1 - pad)], {
          renderer: renderer, interactive: false, stroke: st.stroke, color: st.sc, weight: 1, fillColor: st.fill, fillOpacity: st.op, opacity: st.op
        }).addTo(compGroup);
      });
      if (show.rooms) (data.area.rooms || []).forEach(function (rm) {
        if (rm.y != null && bucket(rm.y) !== floorY) return;
        L.marker(P(rm.x + 0.5, rm.z + 0.5), { icon: L.divIcon({ className: 'mp-roomicon', html: '<span class="mp-room">' + esc(rm.name) + '</span>' }), interactive: false, keyboard: false }).addTo(roomGroup);
      });
      layers(); switchboard(); leverPanel();
    }
    function layers() {
      var counts = {};
      data.comps.forEach(function (r) { if (onFloor(r)) { var c = CAT[r[3]] || 'power'; counts[c] = (counts[c] || 0) + 1; } });
      counts.rooms = (data.area.rooms || []).filter(function (rm) { return rm.y == null || bucket(rm.y) === floorY; }).length;
      $('mp-layers').innerHTML = LAYERS.map(function (L0) { return layerBtn(L0, show[L0[0]], counts[L0[0]]); }).join('');
    }
    $('mp-layers').addEventListener('click', function (e) {
      var b = e.target.closest('.mp-layer'); if (!b) return;
      var k = b.getAttribute('data-layer'); show[k] = !show[k]; draw();
    });
    function levers(all) { return data.comps.filter(function (r) { return r[3] === 'V' && (all || onFloor(r)); }); }
    function switchboard() {
      var ls = levers(false), total = levers(true).length;
      var h = ls.map(function (r) {
        var k = key(r);
        return '<button type="button" class="mp-srow' + (selKey === k ? ' sel' : '') + '" data-k="' + k + '"><span class="sq' + (r[4] ? ' on' : '') + '"></span><span class="nm">' + esc(leverName(r)) +
          '</span><span class="xyz">' + r[0] + ', ' + r[1] + ', ' + r[2] + '</span><span class="mp-pill' + (r[4] ? ' on' : '') + '">' + (r[4] ? 'ON' : 'OFF') + '</span></button>';
      }).join('');
      if (!ls.length) h = '<p class="muted" style="margin:0">No levers on this floor' + (total ? ' (' + total + ' on other floors).' : '.') + '</p>';
      $('mp-switch').innerHTML = h;
    }
    $('mp-switch').addEventListener('click', function (e) {
      var b = e.target.closest('.mp-srow'); if (!b) return;
      var k = b.getAttribute('data-k'); pick(k);
      var p = k.split(',').map(Number); map.panTo(P(p[0] + 0.5, p[2] + 0.5));
    });
    function pick(k) { selKey = selKey === k ? null : k; if (selKey) openCard('lever'); draw(); }
    function leverPanel() {
      var el = $('mp-lever');
      var r = selKey ? data.comps.filter(function (c) { return key(c) === selKey; })[0] : null;
      if (!r) {
        el.innerHTML = '<p class="muted" style="margin:0">' + (levers(true).length ? 'Pick a lever on the plan or in the switchboard to trace what it powers.' : 'No levers in this area.') + '</p>';
        return;
      }
      var cnt = { w: 0, L: 0, K: 0, D: 0, r: 0, t: 0, other: 0 };
      if (net) data.comps.forEach(function (c) { if (net[key(c)] && key(c) !== selKey) { if (cnt[c[3]] !== undefined) cnt[c[3]]++; else cnt.other++; } });
      var fl = data.floors.filter(function (f) { return f.y === bucket(r[1]); })[0];
      var h = '<div class="mp-chips"><span class="mp-pill' + (r[4] ? ' on' : '') + '">' + (r[4] ? 'ON' : 'OFF') + '</span><span class="mp-hint">' + r[0] + ', ' + r[1] + ', ' + r[2] + '</span></div>' +
        '<h4 style="margin:.5rem 0 .25rem">' + esc(leverName(r)) + '</h4>' +
        '<p style="color:#b9c1cc;margin:0 0 .7rem">' + (fl ? esc(fl.name) + '. ' : '') + 'Traced from the blocks it touches: the highlighted wire, lamps, doors and pistons are what this lever drives.</p>' +
        '<div class="mp-stats"><div><b>' + cnt.w + '</b><span>wire</span></div><div><b>' + cnt.L + '</b><span>lamps</span></div><div><b>' + (cnt.K + cnt.D) + '</b><span>pistons, doors</span></div></div>';
      if (data.canFlip) h += '<button type="button" class="btn-primary mp-flip" id="mp-flip"' + (busy ? ' disabled' : '') + '>' + (busy ? 'Flipping…' : r[4] ? 'Flip off in the game' : 'Flip on in the game') + '</button>' +
        '<p class="mp-note">Flips the real lever. The map reads the result back from the server.</p>';
      else h += '<p class="mp-note">Only the world\'s owner and admins can flip levers from here.</p>';
      el.innerHTML = h;
      var fb = $('mp-flip');
      if (fb) fb.addEventListener('click', function () { flip(r); });
    }
    function flip(r) {
      if (busy) return;
      busy = true; leverPanel();
      postJ(B.api + '/lever', { x: r[0], y: r[1], z: r[2] }).then(function (j) {
        busy = false;
        if (j.error) { toast(j.error, true); leverPanel(); return; }
        data.comps = j.comps; data.live = j.live;
        toast('Lever ' + (j.powered ? 'on' : 'off') + '.');
        status(); draw();
        setTimeout(function () { load(true); }, 1500);   // pistons and repeaters settle over a few ticks
      });
    }
    load(false);
    setInterval(function () { if (!document.hidden && !busy) load(false); }, 8000);
  }
})();
