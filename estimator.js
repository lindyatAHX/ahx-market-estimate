/*
 * AHX Market Estimator — public, ungated version of the in-product Market Estimate tool.
 *
 * Embed: <link rel="stylesheet" href=".../estimator.css">
 *        <div id="ahx-estimator"></div>
 *        <script>window.AHX_ESTIMATOR_CONFIG = { ... }</script>
 *        <script src=".../estimator.js" defer></script>
 *
 * With no apiUrl configured it runs on demo pricing shaped like the pricing
 * API's response.
 */
(function () {
  'use strict';

  var DEFAULTS = {
    mountId: 'ahx-estimator',
    // Pricing API endpoint (POST). null = demo pricing.
    apiUrl: null,
    signupUrl: 'https://marketplace.autohaulerexchange.com/sign-up/customer',
    loginUrl: 'https://marketplace.autohaulerexchange.com/login',
    directUrl: null, // AHX Direct (personal moves); link hidden until set
    // HubSpot: event fired on every completed estimate (identified visitors get it on their timeline)
    hubspotEventName: null, // e.g. 'pe12345678_market_estimate_completed'
    // HubSpot form for the optional "email me this estimate" box
    hubspotPortalId: null,
    hubspotFormGuid: null,
    hubspotSummaryField: 'market_estimate_summary',
  };
  var cfg = Object.assign({}, DEFAULTS, window.AHX_ESTIMATOR_CONFIG || {});
  var root = document.getElementById(cfg.mountId);
  if (!root) return;

  var VEHICLES = [
    { value: 'car', label: 'Compact car' },
    { value: 'sedan', label: 'Sedan' },
    { value: 'suv', label: 'SUV' },
    { value: 'truck', label: 'Pickup truck' },
    { value: 'van', label: 'Van' },
    { value: 'motorcycle', label: 'Motorcycle' },
    { value: 'other', label: 'Other' },
  ];
  var MAX_QTY = 9;

  var state = { qty: 1, enclosed: false, quote: null, input: null, carrier: null, leadSent: false };
  var urlParams = new URLSearchParams(window.location.search);
  var embedded = window.parent !== window;

  // Keep the parent iframe sized to the content (the Webflow embed snippet listens for this).
  if (embedded && window.ResizeObserver) {
    // Measure the body, not documentElement.scrollHeight: scrollHeight is never less than the iframe's
    // current height, so the frame could grow but never shrink back.
    var lastH = 0;
    new ResizeObserver(function () {
      var h = Math.ceil(document.body.getBoundingClientRect().height);
      if (h && h !== lastH) {
        lastH = h;
        window.parent.postMessage({ type: 'ahx-estimator-height', height: h }, '*');
      }
    }).observe(document.body);

    // Hand mouse-wheel scrolling to the host page. Some hosts (e.g. Webflow's canvas) don't scroll when the
    // wheel is over a cross-origin iframe. Only switches on after the host snippet says it's listening, so a
    // host without the snippet keeps the browser's normal scrolling.
    var hostScrolls = false;
    window.addEventListener('message', function (e) {
      if (e.source === window.parent && e.data && e.data.type === 'ahx-host-ready') hostScrolls = true;
    });
    window.addEventListener('wheel', function (e) {
      if (!hostScrolls || e.ctrlKey) return; // ctrl+wheel is pinch-zoom
      var unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? window.innerHeight : 1;
      window.parent.postMessage({ type: 'ahx-estimator-wheel', dx: e.deltaX * unit, dy: e.deltaY * unit }, '*');
      e.preventDefault();
    }, { passive: false });
  }

  // ---------- helpers ----------
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function num(v) { var n = Number(v); return isFinite(n) ? n : null; }
  function money(v) { return '$' + Math.round(v).toLocaleString('en-US'); }
  function hrs(h) {
    if (h == null) return null;
    if (h < 48) return '~' + Math.round(h) + ' hrs';
    return '~' + Math.round(h / 24) + ' days';
  }
  function $(sel) { return root.querySelector(sel); }
  function vehicleLabel(v) {
    for (var i = 0; i < VEHICLES.length; i++) if (VEHICLES[i].value === v) return VEHICLES[i].label;
    return v;
  }

  // ---------- location lookup (ZIP, "City, ST", or a street address ending in a ZIP) ----------
  var locCache = {};
  function lookupJSON(url) {
    return fetch(url).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
  }
  function resolveLocation(text) {
    text = (text || '').trim();
    if (!text) return Promise.resolve(null);
    if (locCache[text]) return Promise.resolve(locCache[text]);

    var zipMatch = text.match(/\b(\d{5})(?:-\d{4})?\s*$/);
    var p;
    if (zipMatch) {
      p = lookupJSON('https://api.zippopotam.us/us/' + zipMatch[1]).then(function (d) {
        if (!d || !d.places || !d.places.length) return null;
        var pl = d.places[0];
        return { zip: zipMatch[1], city: pl['place name'], state: pl['state abbreviation'],
          lat: num(pl.latitude), lon: num(pl.longitude) };
      });
    } else {
      var cs = text.match(/^(.+?),\s*([A-Za-z]{2})$/);
      if (!cs) return Promise.resolve(null);
      var city = cs[1].trim(), st = cs[2].toUpperCase();
      p = lookupJSON('https://api.zippopotam.us/us/' + st.toLowerCase() + '/' + encodeURIComponent(city.toLowerCase()))
        .then(function (d) {
          if (!d || !d.places || !d.places.length) return null;
          var exact = d.places.filter(function (pl) { return pl['place name'].toLowerCase() === city.toLowerCase(); });
          var pl = (exact.length ? exact : d.places)[0];
          return { zip: pl['post code'], city: pl['place name'], state: st,
            lat: num(pl.latitude), lon: num(pl.longitude) };
        });
    }
    return p.then(function (loc) { if (loc) locCache[text] = loc; return loc; });
  }

  // ---------- pricing ----------
  function fetchQuote(input) {
    // POST /v1/public/quotes, called straight from the browser (no token; the API allows only gated origins).
    // All vehicles in one request: the API prices the whole load, with a multi-vehicle discount,
    // so the returned prices are load totals, not per-vehicle prices.
    var body = {
      pickup: { zip: input.origin.zip, state: input.origin.state, city: input.origin.city },
      dropoff: { zip: input.dest.zip, state: input.dest.state, city: input.dest.city },
      enclosed: input.enclosed,
      vehicles: Array.apply(null, Array(input.qty)).map(function () {
        return { type: input.vehicleType, inoperable: input.inoperable };
      }),
    };
    if (!cfg.apiUrl) return new Promise(function (res) { setTimeout(function () { res(mockQuote(input)); }, 700); });
    // Only Content-Type: the API's CORS allows no other request headers.
    return fetch(cfg.apiUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .catch(function () { throw new Error('Estimates are temporarily unavailable. Please try again shortly.'); })
      .then(function (r) {
        if (!r.ok) throw new Error(r.status === 429
          ? 'Too many estimates in a short time. Please wait a minute and try again.'
          : r.status >= 500 || [401, 403, 404].indexOf(r.status) !== -1
            ? 'Estimates are temporarily unavailable. Please try again shortly.'
            : 'We couldn’t price that route. Check the locations and try again.');
        return r.json();
      });
  }

  // Demo pricing: a rough fit to real market rates, shaped like the pricing API's response.
  function mockQuote(input) {
    var o = input.origin, d = input.dest;
    var R = 3958.8, toRad = Math.PI / 180;
    var a = Math.pow(Math.sin((d.lat - o.lat) * toRad / 2), 2) +
      Math.cos(o.lat * toRad) * Math.cos(d.lat * toRad) * Math.pow(Math.sin((d.lon - o.lon) * toRad / 2), 2);
    var miles = Math.max(15, 2 * R * Math.asin(Math.sqrt(a)) * 1.19);
    var adj = { car: -45, sedan: -35, suv: 0, truck: 55, van: 70, motorcycle: -120, other: 25 }[input.vehicleType] || 0;
    var posted = Math.max(275, 215 + 0.74 * miles + adj);
    if (input.enclosed) posted *= 1.55;
    if (input.inoperable) posted += 125;
    if (input.qty > 1) posted *= input.qty * 0.9; // demo only: load total with a rough multi-vehicle discount
    posted = Math.round(posted);
    var slow = Math.round(posted * 0.943), most = Math.round(posted * 1.18);
    var mid = Math.round((slow + posted) / 2);
    var regHours = Math.round(16 + miles / 120);
    var dLow = Math.max(1, Math.round(miles / 550)), driveSec = Math.round(miles / 51.6 * 3600);
    return {
      _demo: true,
      pickup: { city: o.city, state: o.state, zip: o.zip },
      dropoff: { city: d.city, state: d.state, zip: d.zip },
      postedPrice: posted.toFixed(2), suggestedPostedPrice: posted.toFixed(2),
      slowPrice: slow.toFixed(2), suggestedMost: most.toFixed(2),
      priceLadder: [slow, mid, posted].map(function (c) { return { carrierPrice: c.toFixed(2) }; }),
      priceOptions: { default: posted.toFixed(2), max: posted.toFixed(2), min: slow.toFixed(2), priceBasis: 'carrier', step: '1.00' },
      routeMiles: Math.round(miles * 100) / 100, routeMilesSource: 'demo',
      estimatedDrivingTime: { seconds: driveSec, display: Math.floor(driveSec / 3600) + 'h ' + Math.round(driveSec % 3600 / 60) + 'm' },
      bookingTime: { regularHours: regHours, regularBookWithin48hPct: String(Math.max(52, 80 - miles / 150).toFixed(1)), slowSavingsPct: '5.7' },
      deliveryTime: { bookToDeliverDaysLow: dLow, bookToDeliverDaysHigh: dLow + 2 },
      validUntil: new Date(Date.now() + 864e5).toISOString(),
    };
  }

  // Normalize the pricing API response into what the UI shows.
  function viewModel(q) {
    // Public endpoint names the carrier-side prices transportPrice / slowTransportPrice;
    // postedPrice / slowPrice are older names for the same numbers.
    var posted = num(q.transportPrice != null ? q.transportPrice : q.postedPrice);
    var slow = num(q.slowTransportPrice != null ? q.slowTransportPrice : q.slowPrice);
    var most = num(q.suggestedMost);
    var bt = q.bookingTime || {}, dt = q.deliveryTime || {};
    var opts = q.priceOptions || {};
    return {
      demo: !!q._demo,
      pickup: q.pickup || {}, dropoff: q.dropoff || {},
      posted: posted, most: most,
      slow: slow != null && slow < posted ? slow : null,
      sliderMin: num(opts.min) || slow || posted, sliderMax: num(opts.max) || posted, sliderStep: num(opts.step) || 1,
      miles: num(q.routeMiles),
      drive: q.estimatedDrivingTime && q.estimatedDrivingTime.display,
      regHours: num(bt.regularHours), reg48: num(bt.regularBookWithin48hPct),
      // Shown only if the API returns them
      slowHours: num(bt.slowHours), slow48: num(bt.slowBookWithin48hPct),
      deliverLow: num(dt.bookToDeliverDaysLow), deliverHigh: num(dt.bookToDeliverDaysHigh),
      validUntil: q.validUntil,
    };
  }

  // ---------- tracking (ungated lead signals) ----------
  function track(name, props) {
    try {
      // Inside the Webflow iframe, HubSpot/GA live on the parent page: hand the event up to it.
      if (embedded) window.parent.postMessage({ type: 'ahx-estimator-event', name: name, props: props }, '*');
      window.dataLayer = window.dataLayer || [];
      window.dataLayer.push(Object.assign({ event: name }, props));
      if (cfg.hubspotEventName && name === 'market_estimate_completed') {
        window._hsq = window._hsq || [];
        window._hsq.push(['trackCustomBehavioralEvent', { name: cfg.hubspotEventName, properties: props }]);
      }
    } catch (e) { /* tracking must never break the estimator */ }
  }
  function laneProps() {
    var i = state.input, vm = state.quote;
    return {
      origin_zip: i.origin.zip, origin_city: i.origin.city, origin_state: i.origin.state,
      dest_zip: i.dest.zip, dest_city: i.dest.city, dest_state: i.dest.state,
      vehicle_type: i.vehicleType, quantity: i.qty, enclosed: i.enclosed, inoperable: i.inoperable,
      route_miles: vm.miles, carrier_price: vm.posted, selected_price: state.carrier,
      rep: urlParams.get('rep') || '',
    };
  }

  // ---------- markup ----------
  var vehicleOptions = VEHICLES.map(function (v) {
    return '<option value="' + v.value + '"' + (v.value === 'suv' ? ' selected' : '') + '>' + v.label + '</option>';
  }).join('');

  root.classList.add('ahxe');
  root.innerHTML =
    (cfg.apiUrl ? '' : '<p class="ahxe-demo-flag"><strong>Demo pricing.</strong> Numbers are illustrative until the live AHX quote endpoint is connected.</p>') +
    '<div class="ahxe-grid">' +
      '<form class="ahxe-card ahxe-pad" novalidate data-form>' +
        '<h2 class="ahxe-h">New estimate</h2>' +
        '<div class="ahxe-route">' +
          '<div class="ahxe-field"><label class="ahxe-label" for="ahxe-from">Pickup location</label>' +
            '<div class="ahxe-inbox"><input class="ahxe-input" id="ahxe-from" name="from" autocomplete="off" placeholder="ZIP or City, ST">' +
            '<button type="button" class="ahxe-clear" data-clear="from" aria-label="Clear pickup">×</button></div>' +
            '<div class="ahxe-resolved" data-resolved="from"></div></div>' +
          '<button type="button" class="ahxe-swap" data-swap aria-label="Swap pickup and delivery">' +
            '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M7 4 3 8l4 4M3 8h14M17 20l4-4-4-4M21 16H7"/></svg></button>' +
          '<div class="ahxe-field"><label class="ahxe-label" for="ahxe-to">Delivery location</label>' +
            '<div class="ahxe-inbox"><input class="ahxe-input" id="ahxe-to" name="to" autocomplete="off" placeholder="ZIP or City, ST">' +
            '<button type="button" class="ahxe-clear" data-clear="to" aria-label="Clear delivery">×</button></div>' +
            '<div class="ahxe-resolved" data-resolved="to"></div></div>' +
        '</div>' +
        '<div class="ahxe-row">' +
          '<div><label class="ahxe-label" for="ahxe-type">Vehicle</label><select class="ahxe-select" id="ahxe-type" name="type">' + vehicleOptions + '</select></div>' +
          '<div><span class="ahxe-label">Qty</span><div class="ahxe-stepper">' +
            '<button type="button" data-qty="-1" aria-label="Fewer vehicles">−</button><output data-qty-out>1</output>' +
            '<button type="button" data-qty="1" aria-label="More vehicles">+</button></div></div>' +
          '<div><label class="ahxe-label" for="ahxe-cond">Condition</label><select class="ahxe-select" id="ahxe-cond" name="cond">' +
            '<option value="operable">Operable</option><option value="inoperable">Inoperable</option></select></div>' +
        '</div>' +
        '<div class="ahxe-section"><span class="ahxe-label">Trailer</span><div class="ahxe-toggle">' +
          '<button type="button" data-trailer="open" aria-pressed="true">Open</button>' +
          '<button type="button" data-trailer="enclosed" aria-pressed="false">Enclosed</button></div></div>' +
        '<div class="ahxe-form-error" data-error hidden></div>' +
        '<div class="ahxe-actions"><button type="button" class="ahxe-btn" data-reset>Reset</button>' +
          '<button type="submit" class="ahxe-btn ahxe-btn-primary" data-submit>Get a Market Estimate</button></div>' +
      '</form>' +
      '<section class="ahxe-card" data-result aria-live="polite">' +
        '<div class="ahxe-empty"><strong>Your market rate shows up here</strong>' +
        '<span>Enter a pickup and delivery location to see the current market rate for this lane. No account needed.</span></div>' +
      '</section>' +
    '</div>';

  var form = $('[data-form]'), resultEl = $('[data-result]'), errorEl = $('[data-error]');

  // ---------- form behaviour ----------
  function setResolved(which, loc, err) {
    var el = $('[data-resolved="' + which + '"]'), input = form.elements[which];
    el.classList.toggle('is-error', !!err);
    input.setAttribute('aria-invalid', err ? 'true' : 'false');
    el.textContent = err || (loc ? loc.city + ', ' + loc.state + ' ' + loc.zip : '');
  }
  function checkField(which) {
    var text = form.elements[which].value;
    if (!text.trim()) { setResolved(which, null, ''); return Promise.resolve(null); }
    return resolveLocation(text).then(function (loc) {
      setResolved(which, loc, loc ? '' : 'Couldn’t find that location. Try a 5-digit ZIP.');
      return loc;
    });
  }
  ['from', 'to'].forEach(function (w) {
    form.elements[w].addEventListener('blur', function () { checkField(w); });
  });
  root.querySelectorAll('[data-clear]').forEach(function (b) {
    b.addEventListener('click', function () {
      var w = b.getAttribute('data-clear');
      form.elements[w].value = ''; setResolved(w, null, ''); form.elements[w].focus();
    });
  });
  $('[data-swap]').addEventListener('click', function () {
    var a = form.elements.from.value; form.elements.from.value = form.elements.to.value; form.elements.to.value = a;
    checkField('from'); checkField('to');
  });
  function setQty(n) {
    state.qty = Math.min(MAX_QTY, Math.max(1, n));
    $('[data-qty-out]').textContent = state.qty;
    $('[data-qty="-1"]').disabled = state.qty === 1;
    $('[data-qty="1"]').disabled = state.qty === MAX_QTY;
  }
  root.querySelectorAll('[data-qty]').forEach(function (b) {
    b.addEventListener('click', function () { setQty(state.qty + Number(b.getAttribute('data-qty'))); });
  });
  function setTrailer(enclosed) {
    state.enclosed = enclosed;
    root.querySelectorAll('[data-trailer]').forEach(function (b) {
      b.setAttribute('aria-pressed', String((b.getAttribute('data-trailer') === 'enclosed') === enclosed));
    });
  }
  root.querySelectorAll('[data-trailer]').forEach(function (b) {
    b.addEventListener('click', function () { setTrailer(b.getAttribute('data-trailer') === 'enclosed'); });
  });
  $('[data-reset]').addEventListener('click', function () {
    form.reset(); setQty(1); setTrailer(false); setResolved('from', null, ''); setResolved('to', null, '');
    errorEl.hidden = true; state.quote = null; showEmpty();
  });

  function showError(msg) { errorEl.textContent = msg; errorEl.hidden = !msg; }
  function showEmpty() {
    resultEl.innerHTML = '<div class="ahxe-empty"><strong>Your market rate shows up here</strong>' +
      '<span>Enter a pickup and delivery location to see the current market rate for this lane. No account needed.</span></div>';
  }
  function showLoading() {
    resultEl.innerHTML = '<div class="ahxe-empty"><strong>Pricing your lane</strong><span class="ahxe-dots"><i></i><i></i><i></i></span></div>';
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    showError('');
    var btn = $('[data-submit]');
    btn.disabled = true;
    Promise.all([checkField('from'), checkField('to')]).then(function (locs) {
      if (!locs[0] || !locs[1]) {
        throw new Error(!form.elements.from.value.trim() || !form.elements.to.value.trim()
          ? 'Enter both a pickup and a delivery location.'
          : 'Check the highlighted location and try again.');
      }
      if (locs[0].zip === locs[1].zip) throw new Error('Pickup and delivery are the same ZIP.');
      state.input = {
        origin: locs[0], dest: locs[1], vehicleType: form.elements.type.value, qty: state.qty,
        enclosed: state.enclosed, inoperable: form.elements.cond.value === 'inoperable',
      };
      showLoading();
      if (window.matchMedia('(max-width: 860px)').matches) resultEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return fetchQuote(state.input);
    }).then(function (raw) {
      if (!raw) return;
      state.quote = viewModel(raw);
      if (state.quote.posted == null) throw new Error('We couldn’t price that route. Try nearby ZIPs.');
      state.carrier = state.quote.posted;
      state.leadSent = false;
      renderResult();
      btn.textContent = 'Get Another Estimate';
      track('market_estimate_completed', laneProps());
    }).catch(function (err) {
      showError(err.message || 'Something went wrong. Please try again.');
      if (state.quote) renderResult(); else showEmpty();
    }).then(function () { btn.disabled = false; });
  });

  // ---------- result ----------
  function renderResult() {
    var vm = state.quote, i = state.input, qty = i.qty;
    var slowPctOff = vm.slow ? Math.round((vm.slow - vm.posted) / vm.posted * 100) : 0;
    var perMile = vm.miles ? (vm.posted / vm.miles).toFixed(2) : null;
    var deliver = vm.deliverLow != null
      ? 'Delivers in ~' + vm.deliverLow + (vm.deliverHigh && vm.deliverHigh !== vm.deliverLow ? '–' + vm.deliverHigh : '') + ' days after booking'
      : '';
    var slowMeta = vm.slowHours != null
      ? 'Books in ' + hrs(vm.slowHours) + (vm.slow48 != null ? '<br>' + Math.round(vm.slow48) + '% book within 48 hrs' : '')
      : 'Often takes 1–2 extra days to book';
    var regMeta = (vm.regHours != null ? 'Books in ' + hrs(vm.regHours) : '') +
      (vm.reg48 != null ? '<br>' + Math.round(vm.reg48) + '% book within 48 hrs' : '');
    var originLine = esc(vm.pickup.city || i.origin.city) + ', ' + esc(vm.pickup.state || i.origin.state);
    var destLine = esc(vm.dropoff.city || i.dest.city) + ', ' + esc(vm.dropoff.state || i.dest.state);

    resultEl.innerHTML =
      '<div class="ahxe-pad">' +
        '<span class="ahxe-eyebrow">Market rate</span>' +
        '<span class="ahxe-label">Suggested posting range' + (qty > 1 ? ' (for ' + qty + ' vehicles)' : '') + '</span>' +
        '<div class="ahxe-range">' + (vm.most && vm.most > vm.posted
          ? money(vm.posted) + ' – ' + money(vm.most)
          : (vm.slow ? money(vm.slow) + ' – ' : '') + money(vm.posted)) +
          (perMile ? '<small>$' + perMile + '/mi</small>' : '') + '</div>' +
        '<div class="ahxe-sub">The current market rate paid to the carrier on this lane. You set your own rate when you post.</div>' +
        (vm.slow ?
          '<div class="ahxe-tiers">' +
            '<button type="button" class="ahxe-tier" data-tier="slow"><div class="ahxe-tier-top">Flexible<span class="ahxe-chip">' + slowPctOff + '%</span></div>' +
              '<div class="ahxe-tier-price">' + money(vm.slow) + '</div><div class="ahxe-tier-meta">' + slowMeta + '</div></button>' +
            '<button type="button" class="ahxe-tier" data-tier="standard"><div class="ahxe-tier-top">Standard<span class="ahxe-chip is-accent">Best</span></div>' +
              '<div class="ahxe-tier-price">' + money(vm.posted) + '</div><div class="ahxe-tier-meta">' + regMeta + '</div></button>' +
          '</div>' +
          (deliver ? '<div class="ahxe-note ahxe-center">' + deliver + '</div>' : '') +
          '<div class="ahxe-slider-wrap">' +
            '<input type="range" class="ahxe-slider" data-slider aria-label="Carrier rate" min="' + vm.sliderMin + '" max="' + vm.sliderMax +
              '" step="' + vm.sliderStep + '" value="' + state.carrier + '">' +
            '<div class="ahxe-slider-ends"><span>Lower price</span><span>Faster booking</span></div>' +
            '<div class="ahxe-note ahxe-center">Times based on similar shipments, not guaranteed.</div>' +
          '</div>'
        : (deliver ? '<div class="ahxe-note">' + deliver + '</div>' : '')) +
        '<div class="ahxe-allin" data-allin></div>' +
        '<div class="ahxe-cta">' +
          '<a class="ahxe-btn ahxe-btn-blue" data-post target="_blank" rel="noopener">Post This Load on AHX</a>' +
          '<div class="ahxe-fine ahxe-center">Prices shown are the market rate paid to the carrier. If you ship with AHX, a platform fee, a percentage of the carrier rate, is added on top and applies after your shipment successfully delivers.</div>' +
          '<div class="ahxe-cta-links">' +
            '<a class="ahxe-link" href="' + esc(cfg.loginUrl) + '" target="_blank" rel="noopener">Have an account? Log in &amp; post</a>' +
            '<button type="button" class="ahxe-link" data-share>Copy link to this estimate</button>' +
          '</div>' +
          '<div class="ahxe-toast" data-toast></div>' +
        '</div>' +
      '</div>' +
      '<div class="ahxe-routebar"><div class="ahxe-pad"><span class="ahxe-label">Route</span>' +
        '<div class="ahxe-route-line">' + originLine + ' <span class="zip">' + esc(i.origin.zip) + '</span> <span class="arrow">→</span> ' + destLine +
          ' <span class="zip">' + esc(i.dest.zip) + '</span></div>' +
        '<div class="ahxe-sub">' + esc(vehicleLabel(i.vehicleType)) + ' × ' + qty + ' · ' + (i.inoperable ? 'Inoperable' : 'Operable') +
          ' · ' + (i.enclosed ? 'Enclosed' : 'Open') + ' trailer</div></div>' +
        statsHtml([
          ['Distance', vm.miles ? Math.round(vm.miles).toLocaleString('en-US') + ' mi' : null],
          ['Drive time', vm.drive ? esc(vm.drive) : null],
          ['Booking', vm.regHours != null ? hrs(vm.regHours) : null],
        ]) + '</div>' +
      '<div class="ahxe-lead"><div class="ahxe-pad" data-lead></div></div>';

    renderLead();
    var slider = $('[data-slider]');
    if (slider) slider.addEventListener('input', function () { state.carrier = Number(slider.value); updatePrice(); });
    root.querySelectorAll('[data-tier]').forEach(function (b) {
      b.addEventListener('click', function () {
        state.carrier = b.getAttribute('data-tier') === 'slow' ? vm.sliderMin : vm.sliderMax;
        if (slider) slider.value = state.carrier;
        updatePrice();
      });
    });
    $('[data-share]').addEventListener('click', copyShareLink);
    $('[data-post]').addEventListener('click', function () { track('market_estimate_post_click', laneProps()); });
    updatePrice();
  }

  // Only show the stats the endpoint actually returned.
  function statsHtml(stats) {
    var cells = stats.filter(function (s) { return s[1]; }).map(function (s) {
      return '<div class="ahxe-stat"><span class="ahxe-label">' + s[0] + '</span><b>' + s[1] + '</b></div>';
    });
    return cells.length ? '<div class="ahxe-stats">' + cells.join('') + '</div>' : '';
  }

  function updatePrice() {
    var vm = state.quote, qty = state.input.qty, c = state.carrier;
    var atMin = vm.slow && c <= vm.sliderMin, atMax = c >= vm.sliderMax;
    root.querySelectorAll('[data-tier]').forEach(function (b) {
      var isSlow = b.getAttribute('data-tier') === 'slow';
      b.classList.toggle('is-active', isSlow ? atMin : atMax);
      b.classList.toggle('is-soft', !atMin && !atMax);
    });
    var slider = $('[data-slider]');
    if (slider && vm.sliderMax > vm.sliderMin) {
      slider.style.setProperty('--fill', ((c - vm.sliderMin) / (vm.sliderMax - vm.sliderMin) * 100) + '%');
    }
    // Public version shows the carrier rate only; the AHX fee varies by shipper and is never shown here,
    // only that it's a percentage added on top. Prices are load totals; per vehicle is the total ÷ quantity.
    $('[data-allin]').innerHTML =
      '<div class="ahxe-allin-main">Market estimate <b>' + money(c) + '</b>' + (qty > 1 ? ' for ' + qty + ' vehicles' : '') + '</div>' +
      (qty > 1 ? '<div class="ahxe-allin-split">About <strong>' + money(c / qty) + '</strong> per vehicle</div>' : '') +
      '<div class="ahxe-allin-split">Paid to the carrier. AHX’s platform fee is added on top.</div>';

    var u = new URL(cfg.signupUrl);
    u.searchParams.set('utm_source', 'market-estimate');
    u.searchParams.set('utm_medium', 'website');
    u.searchParams.set('lane', state.input.origin.zip + '-' + state.input.dest.zip);
    $('[data-post]').href = u.toString();
  }

  // Shareable link: reps send it, prospects land on a pre-run estimate. Keeps rep/utm params.
  function shareUrl() {
    // In the iframe, share the Webflow page URL (passed in as ?page=) rather than the iframe's own URL.
    var i = state.input, u = new URL(urlParams.get('page') || window.location.href);
    ['from', 'to', 'type', 'qty', 'cond', 'trailer', 'run', 'page', 'hutk'].forEach(function (k) { u.searchParams.delete(k); });
    u.searchParams.set('from', i.origin.zip);
    u.searchParams.set('to', i.dest.zip);
    u.searchParams.set('type', i.vehicleType);
    if (i.qty > 1) u.searchParams.set('qty', i.qty);
    if (i.inoperable) u.searchParams.set('cond', 'inoperable');
    if (i.enclosed) u.searchParams.set('trailer', 'enclosed');
    u.hash = '';
    return u.toString();
  }
  function copyShareLink() {
    var url = shareUrl(), toast = $('[data-toast]');
    var done = function () { toast.textContent = 'Link copied. Anyone who opens it sees this estimate.'; };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(done, function () { window.prompt('Copy this link:', url); });
    else window.prompt('Copy this link:', url);
    track('market_estimate_link_copied', laneProps());
  }

  // ---------- optional email capture (never required to see the price) ----------
  function renderLead() {
    var box = $('[data-lead]');
    if (state.leadSent) {
      box.innerHTML = '<div class="ahxe-lead-done">Sent. Check your inbox for this estimate.</div>';
      return;
    }
    box.innerHTML =
      '<p><strong>Want this estimate in your inbox?</strong> We’ll email you the lane and price so you can come back to it.</p>' +
      '<form data-lead-form novalidate><input class="ahxe-input" type="email" name="email" placeholder="you@dealership.com" autocomplete="email" aria-label="Email address">' +
      '<button class="ahxe-btn" type="submit">Email me this</button></form>' +
      '<div class="ahxe-form-error" data-lead-error hidden></div>' +
      (cfg.directUrl ? '<div class="ahxe-fine">Shipping a personal vehicle? <a class="ahxe-link" href="' + esc(cfg.directUrl) + '" target="_blank" rel="noopener">Visit AHX Direct</a>.</div>' : '') +
      '<div class="ahxe-fine">An estimate based on current market data, not a quote. Final rates depend on carrier availability.</div>';
    $('[data-lead-form]').addEventListener('submit', submitLead);
  }
  function hubspotCookie() {
    // Inside the iframe the HubSpot cookie belongs to the parent page, which passes it in as ?hutk=.
    var m = document.cookie.match(/(?:^|;\s*)hubspotutk=([^;]+)/);
    return m ? m[1] : (urlParams.get('hutk') || undefined);
  }
  function submitLead(e) {
    e.preventDefault();
    var email = e.target.elements.email.value.trim(), err = $('[data-lead-error]');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { err.textContent = 'Enter a valid email address.'; err.hidden = false; return; }
    err.hidden = true;
    var p = laneProps();
    // Separate HubSpot properties so the follow-up email can show each piece (and use the link in a button).
    var lane = p.origin_city + ', ' + p.origin_state + ' ' + p.origin_zip + ' → ' + p.dest_city + ', ' + p.dest_state + ' ' + p.dest_zip;
    var vehicle = vehicleLabel(p.vehicle_type) + ' × ' + p.quantity + ' · ' + (p.inoperable ? 'Inoperable' : 'Operable') +
      ' · ' + (p.enclosed ? 'Enclosed' : 'Open') + ' trailer';
    var price = money(state.carrier) + (p.quantity > 1 ? ' for ' + p.quantity + ' vehicles' : '');
    var summary = lane + ' | ' + vehicle + ' | ' + price + (p.rep ? ' | rep ' + p.rep : '') + ' | ' + shareUrl();

    var send;
    if (cfg.hubspotPortalId && cfg.hubspotFormGuid) {
      send = fetch('https://api.hsforms.com/submissions/v3/integration/submit/' + cfg.hubspotPortalId + '/' + cfg.hubspotFormGuid, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fields: [
            { name: 'email', value: email },
            { name: cfg.hubspotSummaryField, value: summary },
            { name: 'market_estimate_lane', value: lane },
            { name: 'market_estimate_vehicle', value: vehicle },
            { name: 'market_estimate_price', value: price },
            { name: 'market_estimate_link', value: shareUrl() },
            { name: 'market_estimate_rep', value: p.rep || '' },
          ],
          context: { hutk: hubspotCookie(), pageUri: window.location.href, pageName: document.title },
        }),
      }).then(function (r) { if (!r.ok) throw new Error('send failed'); });
    } else {
      console.info('[AHX estimator] demo mode, lead not sent:', { email: email, summary: summary });
      send = Promise.resolve();
    }
    send.then(function () {
      state.leadSent = true;
      track('market_estimate_email_captured', p);
      renderLead();
      if (!cfg.hubspotFormGuid) $('[data-lead]').insertAdjacentHTML('beforeend', '<div class="ahxe-fine">Demo mode: nothing was actually sent.</div>');
    }).catch(function () { err.textContent = 'Couldn’t send right now. Copy the link above instead.'; err.hidden = false; });
  }

  // ---------- pre-filled links (?from=17545&to=30318&type=suv&qty=2&cond=inoperable&trailer=enclosed&rep=frank) ----------
  setQty(Number(urlParams.get('qty')) || 1);
  if (urlParams.get('trailer') === 'enclosed') setTrailer(true);
  if (urlParams.get('cond') === 'inoperable') form.elements.cond.value = 'inoperable';
  if (VEHICLES.some(function (v) { return v.value === urlParams.get('type'); })) form.elements.type.value = urlParams.get('type');
  if (urlParams.get('from')) form.elements.from.value = urlParams.get('from');
  if (urlParams.get('to')) form.elements.to.value = urlParams.get('to');
  // Lane pages pass run=0 so the form is pre-filled without pricing on every page view (or every crawl).
  if (urlParams.get('from') && urlParams.get('to') && urlParams.get('run') !== '0') form.requestSubmit();
})();
