(() => {
  'use strict';

  const UNITS = 20;       // grid units the two panels share
  const MIN_UNITS = 4;    // smallest a panel may get
  const STATE_KEY = 'counter-timer:state';
  const SPLIT_KEY = 'counter-timer:split';

  const $ = (id) => document.getElementById(id);
  const app = $('app');
  const gridEl = $('grid');
  const timerEl = $('timer');
  const counterEl = $('counter');
  const timerPanel = timerEl.querySelector('.panel');
  const counterPanel = counterEl.querySelector('.panel');
  const timerValue = $('timer-value');
  const counterValue = $('counter-value');

  // ---- Storage (wrapped: storage can be unavailable in private modes) ----
  const store = {
    get(key, fallback) {
      try {
        const raw = localStorage.getItem(key);
        return raw == null ? fallback : JSON.parse(raw);
      } catch { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
    },
  };

  // count: sets done. startedAt: wall-clock ms when the current rest began, or null.
  let state = store.get(STATE_KEY, { count: 0, startedAt: null });
  let split = store.get(SPLIT_KEY, 0.5); // timer's share of the screen, 0..1

  // ---- Timer ----
  // Elapsed time is always derived from the device clock (Date.now() - startedAt),
  // never accumulated by ticking. The render loop only repaints, so throttled or
  // paused JS (app switched, screen locked) loses no time.
  function elapsedMs() {
    return state.startedAt == null ? 0 : Math.max(0, Date.now() - state.startedAt);
  }

  function formatElapsed(ms) {
    const total = Math.floor(ms / 1000);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = String(total % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
  }

  let lastText = '';
  function render() {
    const text = formatElapsed(elapsedMs());
    if (text !== lastText) {
      timerValue.textContent = text;
      lastText = text;
    }
    counterValue.textContent = state.count;
    timerPanel.classList.toggle('idle', state.startedAt == null);
  }

  let rafId = 0;
  function loop() {
    render();
    rafId = state.startedAt != null ? requestAnimationFrame(loop) : 0;
  }
  function startLoop() {
    if (!rafId) loop();
  }

  function save() { store.set(STATE_KEY, state); }

  function increment() {
    state = { count: state.count + 1, startedAt: Date.now() };
    save();
    render();
    startLoop();
    requestWakeLock();
    counterPanel.classList.add('pulse');
    setTimeout(() => counterPanel.classList.remove('pulse'), 120);
    if (navigator.vibrate) navigator.vibrate(15);
  }

  function reset() {
    state = { count: 0, startedAt: null };
    save();
    cancelAnimationFrame(rafId);
    rafId = 0;
    render();
    releaseWakeLock();
  }

  // ---- Screen wake lock (keeps the screen on while resting) ----
  let wakeLock = null;
  async function requestWakeLock() {
    if (!('wakeLock' in navigator) || wakeLock || document.visibilityState !== 'visible') return;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch { /* denied or unsupported; not critical */ }
  }
  function releaseWakeLock() {
    if (wakeLock) wakeLock.release();
    wakeLock = null;
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    // Coming back from another app: repaint immediately from the real clock.
    render();
    if (state.startedAt != null) {
      startLoop();
      requestWakeLock(); // the browser drops the lock when the page is hidden
    }
  });

  // ---- Input ----
  let resizing = false;

  counterPanel.addEventListener('click', () => {
    if (!resizing) increment();
  });
  counterPanel.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      increment();
    }
  });
  $('reset').addEventListener('click', (e) => {
    e.stopPropagation();
    if (confirm('Reset sets and timer?')) reset();
  });

  // ---- Layout (gridstack) ----
  const landscapeQuery = matchMedia('(orientation: landscape)');
  let grid = null;
  let landscape = false;

  const clampUnits = (u) => Math.min(UNITS - MIN_UNITS, Math.max(MIN_UNITS, Math.round(u)));

  // Portrait: 1 column x UNITS rows. Landscape: UNITS columns x 1 row.
  function geometry(timerUnits) {
    return landscape
      ? {
          timer: { x: 0, y: 0, w: timerUnits, h: 1 },
          counter: { x: timerUnits, y: 0, w: UNITS - timerUnits, h: 1 },
        }
      : {
          timer: { x: 0, y: 0, w: 1, h: timerUnits },
          counter: { x: 0, y: timerUnits, w: 1, h: UNITS - timerUnits },
        };
  }

  function cellHeight() {
    const h = app.clientHeight;
    return landscape ? h : h / UNITS;
  }

  function setAttrs(el, g, extra) {
    for (const k of ['x', 'y', 'w', 'h']) el.setAttribute(`gs-${k}`, g[k]);
    for (const k of ['min-w', 'max-w', 'min-h', 'max-h', 'no-resize']) el.removeAttribute(`gs-${k}`);
    for (const [k, v] of Object.entries(extra)) el.setAttribute(`gs-${k}`, v);
  }

  function buildGrid() {
    landscape = landscapeQuery.matches;
    if (grid) {
      grid.destroy(false); // keep the DOM, drop gridstack's state
      grid = null;
    }

    const g = geometry(clampUnits(split * UNITS));
    const axis = landscape ? 'w' : 'h';
    setAttrs(timerEl, g.timer, { [`min-${axis}`]: MIN_UNITS, [`max-${axis}`]: UNITS - MIN_UNITS });
    setAttrs(counterEl, g.counter, { 'no-resize': 'true' });

    grid = GridStack.init({
      column: landscape ? UNITS : 1,
      cellHeight: cellHeight(),
      margin: 0,
      float: true,
      animate: false,
      disableDrag: true,
      alwaysShowResizeHandle: true,
      resizable: { handles: landscape ? 'e' : 's' },
    }, gridEl);

    grid.on('resizestart', () => { resizing = true; });
    grid.on('resize', (_e, el) => syncCounter(el));
    grid.on('resizestop', (_e, el) => {
      const units = syncCounter(el);
      split = units / UNITS;
      store.set(SPLIT_KEY, split);
      // Let the click that may follow the drag pass without counting.
      setTimeout(() => { resizing = false; }, 0);
    });
  }

  // Make the counter fill whatever space the timer leaves.
  function syncCounter(el) {
    const node = el.gridstackNode;
    const units = clampUnits(landscape ? node.w : node.h);
    grid.update(counterEl, geometry(units).counter);
    return units;
  }

  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (landscapeQuery.matches !== landscape) buildGrid();
      else if (grid) grid.cellHeight(cellHeight());
    }, 100);
  });
  landscapeQuery.addEventListener('change', buildGrid);

  // ---- Boot ----
  buildGrid();
  render();
  if (state.startedAt != null) {
    startLoop();
    requestWakeLock();
  }

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => { /* offline support is optional */ });
    });
  }
})();
