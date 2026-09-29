(() => {
  'use strict';

  const UNITS = 20;       // grid units the two panels share
  const MIN_UNITS = 4;    // smallest a panel may get
  const STATE_KEY = 'counter-timer:state';
  const SPLIT_KEY = 'counter-timer:split';
  const TARGET_KEY = 'counter-timer:target';
  const PUSH_KEY = 'counter-timer:push';
  const SOUND_KEY = 'counter-timer:sound';
  const ALERT_WINDOW_MS = 2000; // only beep if we see the target cross "live"

  const $ = (id) => document.getElementById(id);
  const app = $('app');
  const gridEl = $('grid');
  const timerEl = $('timer');
  const counterEl = $('counter');
  const timerPanel = timerEl.querySelector('.panel');
  const counterPanel = counterEl.querySelector('.panel');
  const timerValue = $('timer-value');
  const counterValue = $('counter-value');
  const targetChip = $('target-chip');
  const soundToggle = $('sound-toggle');
  const progress = $('progress');
  const progressFill = $('progress-fill');
  const enableAlertsBtn = $('enable-alerts');
  const installHint = $('install-hint');
  const offlineBadge = $('offline-badge');
  const targetDialog = $('target-dialog');
  const targetMin = $('target-min');
  const targetSec = $('target-sec');

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
  let target = store.get(TARGET_KEY, 0); // target rest in seconds, 0 = off
  let push = store.get(PUSH_KEY, null);  // { deviceId, subscription } once alerts are enabled
  let soundOn = store.get(SOUND_KEY, false); // in-app beep, muted by default; push notifications use system sounds

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
  let alertedFor = null; // startedAt of the rest we've already alerted for
  function render() {
    const elapsed = elapsedMs();
    const text = formatElapsed(elapsed);
    if (text !== lastText) {
      timerValue.textContent = text;
      lastText = text;
    }
    counterValue.textContent = state.count;
    timerPanel.classList.toggle('idle', state.startedAt == null);

    const targetMs = target * 1000;
    const running = state.startedAt != null;
    progress.hidden = !target;
    progressFill.style.width = running && target ? `${Math.min(1, elapsed / targetMs) * 100}%` : '0';

    const reached = running && target > 0 && elapsed >= targetMs;
    timerPanel.classList.toggle('reached', reached);
    if (reached && alertedFor !== state.startedAt) {
      alertedFor = state.startedAt;
      // Returning to the app long after the target shows the reached state quietly;
      // the push notification already covered that case.
      if (document.visibilityState === 'visible' && elapsed - targetMs < ALERT_WINDOW_MS) playAlert();
    }
  }

  // ---- In-app alert (works offline) ----
  let audioCtx = null;
  function unlockAudio() {
    // Must run inside a user gesture for iOS to allow sound later.
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    audioCtx ??= new Ctx();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  }

  function playAlert() {
    if (navigator.vibrate) navigator.vibrate([200, 100, 200, 100, 200]);
    if (!soundOn || !audioCtx) return;
    const t0 = audioCtx.currentTime;
    for (let i = 0; i < 3; i++) {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.frequency.value = 880;
      const start = t0 + i * 0.3;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.4, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.2);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(start);
      osc.stop(start + 0.22);
    }
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
    unlockAudio();
    state = { count: state.count + 1, startedAt: Date.now() };
    save();
    render();
    startLoop();
    requestWakeLock();
    syncSchedule();
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
    syncSchedule();
    setOffline(false);
  }

  // ---- Target ----
  const formatTarget = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

  function renderTarget() {
    targetChip.textContent = target ? `Target ${formatTarget(target)}` : 'Target off';
    targetChip.classList.toggle('on', target > 0);
    updateAlertsUI();
    render();
  }

  function setTarget(seconds) {
    target = seconds;
    store.set(TARGET_KEY, target);
    renderTarget();
    syncSchedule();
  }

  function openTargetDialog() {
    const s = target || 90;
    targetMin.value = Math.floor(s / 60);
    targetSec.value = s % 60;
    targetDialog.showModal();
  }

  function saveTargetFromInputs() {
    const min = Math.min(59, Math.max(0, parseInt(targetMin.value, 10) || 0));
    const sec = Math.min(59, Math.max(0, parseInt(targetSec.value, 10) || 0));
    setTarget(Math.max(5, min * 60 + sec));
  }

  // ---- Push notifications (scheduled on the server, so they fire in the background) ----
  const pushSupported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

  function updateAlertsUI() {
    const wantAlerts = target > 0 && !push;
    enableAlertsBtn.hidden = !(wantAlerts && pushSupported && Notification.permission !== 'denied');
    // iOS only exposes push to PWAs launched from the home screen.
    installHint.hidden = !(wantAlerts && isIOS && !standalone);
  }

  function renderSound() {
    soundToggle.setAttribute('aria-pressed', String(soundOn));
    soundToggle.title = soundOn ? 'In-app sound on' : 'In-app sound off';
  }

  function setOffline(offline) { offlineBadge.hidden = !offline; }

  function urlBase64ToUint8Array(b64url) {
    const b64 = (b64url + '='.repeat((4 - (b64url.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
    return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  }

  async function enableAlerts() {
    try {
      unlockAudio();
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') return;
      const reg = await navigator.serviceWorker.ready;
      const res = await fetch('/api/vapid-public-key');
      if (!res.ok) throw new Error(`server returned ${res.status}`);
      const { key } = await res.json();
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(key),
      });
      push = { deviceId: push?.deviceId ?? crypto.randomUUID(), subscription: sub.toJSON() };
      store.set(PUSH_KEY, push);
      syncSchedule();
    } catch (err) {
      alert(`Couldn't enable notifications: ${err.message}`);
    } finally {
      updateAlertsUI();
    }
  }

  // Drop our stored subscription if the browser no longer has it (e.g. permission revoked).
  async function checkSubscription() {
    if (!push || !pushSupported) return;
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (!sub) {
        push = null;
      } else if (sub.endpoint !== push.subscription.endpoint) {
        push = { ...push, subscription: sub.toJSON() };
      } else {
        return;
      }
      store.set(PUSH_KEY, push);
      updateAlertsUI();
    } catch { /* ignore */ }
  }

  // Keep the server in step with the current rest: schedule a push at its target
  // time, or cancel. The push is sent even while the app is open: on iPhone the
  // in-app alert can't vibrate and is muted on silent, so it's easy to miss.
  let serverFireAt = null; // what the server holds: fireAt, 0 = nothing, null = unknown
  let seq = 0;
  function syncSchedule() {
    if (!push) return;
    const fireAt = state.startedAt != null && target ? state.startedAt + target * 1000 : 0;
    const wanted = fireAt > Date.now() ? fireAt : 0;
    if (wanted === serverFireAt) return;
    serverFireAt = wanted;

    // seq lets the server ignore a request that arrives after a newer one.
    seq = Math.max(seq + 1, Date.now());
    const path = wanted ? '/api/schedule' : '/api/cancel';
    const body = wanted
      ? { deviceId: push.deviceId, seq, subscription: push.subscription, fireAt, target }
      : { deviceId: push.deviceId, seq };

    // keepalive lets the request finish even if the page is hidden right after a tap.
    fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      keepalive: true,
    }).then((res) => {
      if (!res.ok) throw new Error(String(res.status));
      if (wanted) setOffline(false);
    }).catch(() => {
      if (serverFireAt === wanted) serverFireAt = null; // unknown: resend next time
      // No signal at the gym: the in-app alert still works.
      if (wanted) setOffline(true);
    });
  }

  // Coming back to the app: a rest notification that's already showing is stale.
  async function clearRestNotifications() {
    if (!pushSupported) return;
    try {
      const reg = await navigator.serviceWorker.ready;
      (await reg.getNotifications({ tag: 'rest' })).forEach((n) => n.close());
    } catch { /* ignore */ }
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
    clearRestNotifications();
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
  targetChip.addEventListener('click', openTargetDialog);
  soundToggle.addEventListener('click', () => {
    soundOn = !soundOn;
    store.set(SOUND_KEY, soundOn);
    renderSound();
    if (soundOn) unlockAudio(); // this tap counts as the gesture iOS needs
  });
  enableAlertsBtn.addEventListener('click', enableAlerts);

  targetDialog.querySelectorAll('[data-seconds]').forEach((btn) => {
    btn.addEventListener('click', () => {
      setTarget(Number(btn.dataset.seconds));
      targetDialog.close();
    });
  });
  targetDialog.addEventListener('close', () => {
    if (targetDialog.returnValue === 'save') saveTargetFromInputs();
    else if (targetDialog.returnValue === 'off') setTarget(0);
    targetDialog.returnValue = '';
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
  // A rest that already passed its target before this load shouldn't beep now.
  if (target && state.startedAt != null && elapsedMs() >= target * 1000) alertedFor = state.startedAt;
  renderTarget();
  renderSound();
  checkSubscription();
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
