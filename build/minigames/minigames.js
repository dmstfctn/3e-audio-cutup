// Minigames ported from 3e-coco-games: game 3 Find It, game 1 Caption Match, game 4 Find Every X.
// They mount into a container the page provides instead of taking over the window, and report
// one result instead of showing their own end screen:
//   MINIGAMES[key].mount(container, data, onComplete) -> { destroy }
//   onComplete({ score, max }) fires once, after the last reveal.
// data is minigames/<key>.json (preprocess/import_minigames.py copies it from 3e-coco-games).
// Photos are hot-linked from COCO's image host, which only serves http.
const MINIGAMES = (() => {
  'use strict';

  const photoUrl = (split, id) => `http://images.cocodataset.org/${split}/${String(id).padStart(12, '0')}.jpg`;
  const pick = a => a[Math.floor(Math.random() * a.length)];
  const shuffle = a => {
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  };
  // resolves on load or error, so a broken photo never stalls a game
  const preload = src => new Promise(res => { const im = new Image(); im.onload = im.onerror = res; im.src = src; });

  // ---------- hit testing (COCO polygons are flat [x1, y1, x2, y2, …] in image pixels) ----------

  function inPoly(x, y, p) {
    let inside = false;
    for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) {
      const xi = p[i], yi = p[i + 1], xj = p[j], yj = p[j + 1];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  // 0 inside the polygon, else the distance to its nearest edge
  function distToPoly(x, y, p) {
    if (inPoly(x, y, p)) return 0;
    let d = Infinity;
    for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) {
      const ax = p[j], ay = p[j + 1], dx = p[i] - ax, dy = p[i + 1] - ay;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
      d = Math.min(d, Math.hypot(x - ax - t * dx, y - ay - t * dy));
    }
    return d;
  }
  const distToInstance = (x, y, polys) => Math.min(...polys.map(p => distToPoly(x, y, p)));

  const polygons = (cls, polys) => polys.map(p => `<polygon class="${cls}" points="${p.join(' ')}"/>`).join('');

  // ---------- shared frame: timer bar, round counter, and everything destroy() has to undo ----------

  function frame(container, html) {
    const root = document.createElement('div');
    root.className = 'mg-root';
    root.innerHTML = `<div class="mg-bar"></div><div class="mg-round"></div>${html}`;
    container.append(root);
    const g = {
      dead: false,
      $: s => root.querySelector(s),
      root,
      bar: frac => { root.firstChild.style.transform = `scaleX(${Math.max(0, frac)})`; },
      round: (i, n) => { g.$('.mg-round').textContent = n ? `${i + 1} / ${n}` : ''; },
    };
    let raf = null;
    const timeouts = new Set(), cleanups = [];
    // counts down secs on the bar, then calls onDone; only runs while the player can act
    g.countdown = (secs, onDone) => {
      const t0 = performance.now();
      const tick = now => {
        const left = 1 - (now - t0) / (secs * 1000);
        g.bar(left);
        if (left <= 0) { raf = null; onDone(); } else raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    };
    g.stop = () => { if (raf) cancelAnimationFrame(raf); raf = null; };
    g.running = () => raf !== null;
    g.later = (fn, ms) => {
      const t = setTimeout(() => { timeouts.delete(t); if (!g.dead) fn(); }, ms);
      timeouts.add(t);
    };
    // listeners outside the game's own elements, removed on destroy
    g.on = (target, type, fn, opts) => { target.addEventListener(type, fn, opts); cleanups.push(() => target.removeEventListener(type, fn, opts)); };
    g.onDestroy = fn => cleanups.push(fn);
    g.destroy = () => {
      g.dead = true;
      g.stop();
      timeouts.forEach(clearTimeout);
      cleanups.forEach(fn => fn());
      root.remove();
    };
    return g;
  }

  // ---------- game 3: find it ----------
  // One click per photo on the named thing, within SECONDS. Any instance of it counts.

  function findIt(container, data, done) {
    const ROUNDS = 3, SECONDS = 5, REVEAL_MS = 1000;
    const TOLERANCE_PX = 10;  // on-screen slack around the outline, so small targets stay clickable
    const url = id => photoUrl('train2017', id);
    const g = frame(container, `
      <div class="mg-center">
        <p class="mg-prompt">loading…</p>
        <div class="mg-find">
          <img class="mg-photo" alt="" draggable="false">
          <svg class="mg-overlay" preserveAspectRatio="none"></svg>
          <div class="mg-dot" hidden></div>
        </div>
      </div>`);
    const photo = g.$('.mg-photo'), overlay = g.$('.mg-overlay'), dot = g.$('.mg-dot'), prompt = g.$('.mg-prompt');
    const rounds = shuffle([...data]).slice(0, ROUNDS);
    let idx = 0, score = 0;

    async function playRound() {
      const item = rounds[idx];
      g.round(idx, rounds.length);
      prompt.textContent = 'loading…';
      overlay.innerHTML = '';
      dot.hidden = true;
      g.bar(1);
      await preload(url(item.id));
      if (g.dead) return;
      if (rounds[idx + 1]) preload(url(rounds[idx + 1].id));
      photo.src = url(item.id);
      overlay.setAttribute('viewBox', `0 0 ${item.w} ${item.h}`);
      const b = document.createElement('b');
      b.textContent = item.tag;
      prompt.replaceChildren('find the ', b);
      g.countdown(SECONDS, () => reveal([]));
    }

    // hit: the instances clicked go green; miss or time-out: every instance goes red
    function reveal(hit) {
      g.stop();
      const item = rounds[idx];
      if (hit.length) score++;
      overlay.innerHTML = hit.length ? polygons('ok', hit.flatMap(k => item.inst[k])) : polygons('bad', item.inst.flat());
      g.later(() => { idx++; idx < rounds.length ? playRound() : done({ score, max: rounds.length }); }, REVEAL_MS);
    }

    g.$('.mg-find').addEventListener('pointerdown', e => {
      if (!g.running()) return;
      const item = rounds[idx], r = photo.getBoundingClientRect();
      const scale = item.w / r.width;  // the photo keeps its aspect ratio
      const x = (e.clientX - r.left) * scale, y = (e.clientY - r.top) * scale;
      dot.style.left = `${e.clientX - r.left}px`;
      dot.style.top = `${e.clientY - r.top}px`;
      dot.hidden = false;
      reveal(item.inst.flatMap((polys, k) => distToInstance(x, y, polys) <= TOLERANCE_PX * scale ? [k] : []));
    });
    playRound();
    return g;
  }

  // ---------- game 1: caption match ----------
  // Pick the photo a caption describes from three. Later rounds have less time,
  // and decoys with the same kinds of things in them.

  function captionMatch(container, data, done) {
    const PLAN = [['random', 6], ['random', 3], ['similar', 6], ['similar', 3], ['similar', 2]];  // decoy pool, seconds
    const REVEAL_MS = 900;
    const url = id => photoUrl('val2017', id);
    const g = frame(container, `
      <div class="mg-center">
        <div class="mg-opts"></div>
        <p class="mg-caption">loading…</p>
      </div>`);
    const opts = g.$('.mg-opts'), caption = g.$('.mg-caption');
    // data: { random, similar }, each entry [answer id, [5 captions], [decoy id, decoy id]]
    const pools = { random: shuffle([...data.random]), similar: shuffle([...data.similar]) };
    const rounds = PLAN.map(([kind, secs]) => {
      const [answer, captions, decoys] = pools[kind].pop();
      return { secs, answer, caption: pick(captions), ids: shuffle([answer, ...decoys]) };
    });
    let idx = 0, score = 0;

    // the timer starts once the photos have loaded, so it never runs over blank boxes
    async function playRound() {
      const r = rounds[idx];
      g.round(idx, rounds.length);
      opts.replaceChildren();
      caption.textContent = 'loading…';
      g.bar(1);
      await Promise.all(r.ids.map(id => preload(url(id))));
      if (g.dead) return;
      rounds[idx + 1]?.ids.forEach(id => preload(url(id)));
      for (const id of r.ids) {
        const b = document.createElement('button');
        b.className = 'mg-opt';
        b.dataset.id = id;
        const img = document.createElement('img');
        img.src = url(id);
        img.alt = '';
        b.append(img);
        opts.append(b);
      }
      caption.textContent = r.caption;
      g.countdown(r.secs, () => finish(null));
    }

    // the answer goes green, a wrong pick red; a time-out only shows the answer
    function finish(chosen) {
      g.stop();
      const r = rounds[idx];
      for (const b of opts.children) {
        const id = +b.dataset.id;
        b.disabled = true;
        if (id === r.answer) b.classList.add('ok');
        else if (id === chosen) b.classList.add('bad');
      }
      if (chosen === r.answer) score++;
      g.later(() => { idx++; idx < rounds.length ? playRound() : done({ score, max: rounds.length }); }, REVEAL_MS);
    }

    opts.addEventListener('click', e => {
      const b = e.target.closest('.mg-opt');
      if (b && !b.disabled && g.running()) finish(+b.dataset.id);
    });
    playRound();
    return g;
  }

  // ---------- game 4: find every x ----------
  // Click every instance of one thing in SECONDS. The photo starts zoomed in and can never be
  // zoomed out to show it whole, so finding them means panning around.

  function findAll(container, data, done) {
    const SECONDS = 15, REVEAL_MS = 1500;  // REVEAL_MS: how long the missed ones show before the result
    const ZOOM = 3;                   // the photo starts ZOOM × the container's width
    const MIN_COVER = 1.25;           // zoom-out floor: MIN_COVER × the size that just covers the container
    const MAX_ZOOM = 2;               // zoom-in ceiling: MAX_ZOOM × the starting size
    const TOLERANCE_PX = 10;          // on-screen slack around each outline
    const DRAG_PX = 6;                // a press that moves further than this is a pan, not a click
    const IRREGULAR = { person: 'people', sheep: 'sheep', skis: 'skis', scissors: 'scissors',
      mouse: 'computer mice', knife: 'knives', tv: 'TVs', broccoli: 'broccoli' };
    const plural = t => IRREGULAR[t] || (/(s|x|ch|sh)$/.test(t) ? t + 'es' : t + 's');
    const g = frame(container, `
      <div class="mg-scroller">
        <div class="mg-stage">
          <img class="mg-photo" alt="" draggable="false">
          <svg class="mg-overlay" preserveAspectRatio="none"></svg>
        </div>
      </div>
      <div class="mg-hud"><span class="mg-prompt">loading…</span><span class="mg-count"></span></div>
      <div class="mg-zoom"><button title="zoom in">+</button><button title="zoom out">−</button></div>`);
    const sc = g.$('.mg-scroller'), stage = g.$('.mg-stage'), photo = g.$('.mg-photo'), overlay = g.$('.mg-overlay');
    const prompt = g.$('.mg-prompt'), count = g.$('.mg-count');
    const item = pick(data);  // { id, tag, w, h, inst }: 5–10 instances, no crowd regions
    const found = new Set();
    let zoom = ZOOM, ready = false;

    const bold = text => { const b = document.createElement('b'); b.textContent = text; return b; };
    const draw = (cls, ks) => overlay.insertAdjacentHTML('beforeend', polygons(cls, ks.flatMap(k => item.inst[k])));
    const updateCount = () => { count.textContent = `${found.size} / ${item.inst.length}`; };

    // nearest instance not found yet within tol image pixels of (x, y), or -1
    function hitInstance(x, y, tol) {
      let best = -1, bestD = Infinity;
      item.inst.forEach((polys, k) => {
        if (found.has(k)) return;
        const d = distToInstance(x, y, polys);
        if (d <= tol && d < bestD) { best = k; bestD = d; }
      });
      return best;
    }

    // zoom = the photo's width as a multiple of the container's
    const startW = () => sc.clientWidth * ZOOM;
    const coverW = () => Math.max(sc.clientWidth, sc.clientHeight * item.w / item.h);
    const minW = () => Math.min(startW(), coverW() * MIN_COVER);
    const maxW = () => startW() * MAX_ZOOM;
    function setWidth(w) {
      photo.style.width = `${w}px`;
      photo.style.height = `${w * item.h / item.w}px`;
      zoom = w / sc.clientWidth;
    }
    // zooms to width w, keeping the photo point under (ax, ay), relative to the scroller, fixed
    function zoomTo(w, ax = sc.clientWidth / 2, ay = sc.clientHeight / 2) {
      const s = sc.getBoundingClientRect(), r = photo.getBoundingClientRect();
      const fx = (s.left + ax - r.left) / r.width, fy = (s.top + ay - r.top) / r.height;
      setWidth(Math.min(maxW(), Math.max(minW(), w)));
      const r2 = photo.getBoundingClientRect();
      sc.scrollLeft += r2.left + fx * r2.width - (s.left + ax);
      sc.scrollTop += r2.top + fy * r2.height - (s.top + ay);
    }
    const zoomBy = (f, ax, ay) => { if (ready) zoomTo(photo.offsetWidth * f, ax, ay); };

    // the timer starts once the photo is on screen, centred at the starting zoom
    photo.style.visibility = 'hidden';
    overlay.setAttribute('viewBox', `0 0 ${item.w} ${item.h}`);
    photo.onload = photo.onerror = () => {
      photo.onload = photo.onerror = null;
      if (g.dead) return;
      setWidth(startW());
      sc.scrollLeft = (sc.scrollWidth - sc.clientWidth) / 2;
      sc.scrollTop = (sc.scrollHeight - sc.clientHeight) / 2;
      photo.style.visibility = '';
      ready = true;
      prompt.replaceChildren('find all the ', bold(plural(item.tag)));
      updateCount();
      g.countdown(SECONDS, end);
    };
    photo.src = photoUrl('train2017', item.id);

    function end() {
      g.stop();
      const n = item.inst.length, missed = item.inst.map((_, k) => k).filter(k => !found.has(k));
      draw('bad', missed);
      prompt.replaceChildren(...(missed.length
        ? ["time's up: ", bold(`${found.size} / ${n}`), ` ${plural(item.tag)}`]
        : ['you found all ', bold(String(n)), ` ${plural(item.tag)}`]));
      count.textContent = '';
      g.later(() => done({ score: found.size, max: n }), REVEAL_MS);
    }

    function clickAt(e) {
      if (!g.running()) return;
      const r = photo.getBoundingClientRect(), scale = item.w / r.width;
      const k = hitInstance((e.clientX - r.left) * scale, (e.clientY - r.top) * scale, TOLERANCE_PX * scale);
      if (k >= 0) {
        found.add(k);
        draw('ok', [k]);
        updateCount();
        if (found.size === item.inst.length) end();
      } else {
        const m = document.createElement('div');
        m.className = 'mg-miss';
        m.style.left = `${e.clientX - r.left}px`;
        m.style.top = `${e.clientY - r.top}px`;
        stage.append(m);
        m.addEventListener('animationend', () => m.remove());
      }
    }

    // drag to pan (mouse or one finger), a press that barely moves is a click, two fingers pinch;
    // wheel and trackpad scrolling pan natively
    const pointers = new Map();  // pointerId -> { x, y }
    let drag = null, pinch = null;
    const rel = (x, y) => { const s = sc.getBoundingClientRect(); return [x - s.left, y - s.top]; };
    const spread = () => { const [a, b] = [...pointers.values()]; return Math.hypot(a.x - b.x, a.y - b.y); };
    const mid = () => { const [a, b] = [...pointers.values()]; return rel((a.x + b.x) / 2, (a.y + b.y) / 2); };

    stage.addEventListener('pointerdown', e => {
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      stage.setPointerCapture(e.pointerId);
      if (pointers.size === 2) {  // second finger: switch from drag to pinch
        drag = null;
        pinch = { d: spread(), w: photo.offsetWidth };
      } else if (pointers.size === 1) {
        drag = { x: e.clientX, y: e.clientY, sl: sc.scrollLeft, st: sc.scrollTop, moved: false };
      }
    });
    stage.addEventListener('pointermove', e => {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch && pointers.size === 2) return zoomBy(pinch.w * spread() / pinch.d / photo.offsetWidth, ...mid());
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) > DRAG_PX) { drag.moved = true; sc.classList.add('dragging'); }
      if (drag.moved) { sc.scrollLeft = drag.sl - dx; sc.scrollTop = drag.st - dy; }
    });
    function release(e, isClick) {
      pointers.delete(e.pointerId);
      if (isClick && drag && !drag.moved && !pinch) clickAt(e);
      if (!pointers.size) { drag = null; pinch = null; }
      sc.classList.remove('dragging');
    }
    stage.addEventListener('pointerup', e => release(e, true));
    stage.addEventListener('pointercancel', e => release(e, false));

    // trackpad pinch (Chrome and Firefox send ctrl + wheel) and ctrl/cmd + mouse wheel
    sc.addEventListener('wheel', e => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      zoomBy(Math.exp(-e.deltaY * 0.01), ...rel(e.clientX, e.clientY));
    }, { passive: false });
    // Safari trackpad pinch
    let gestureW = 0;
    sc.addEventListener('gesturestart', e => { e.preventDefault(); gestureW = photo.offsetWidth; });
    sc.addEventListener('gesturechange', e => { e.preventDefault(); zoomBy(gestureW * e.scale / photo.offsetWidth, ...rel(e.clientX, e.clientY)); });

    const [zin, zout] = g.$('.mg-zoom').children;
    zin.addEventListener('click', () => zoomBy(1.25));
    zout.addEventListener('click', () => zoomBy(0.8));
    g.on(document, 'keydown', e => {
      if (e.key === '+' || e.key === '=') zoomBy(1.25);
      else if (e.key === '-' || e.key === '_') zoomBy(0.8);
    });
    // keep the same zoom, relative to the container's width, when it resizes
    const ro = new ResizeObserver(() => { if (ready) zoomTo(zoom * sc.clientWidth); });
    ro.observe(sc);
    g.onDestroy(() => ro.disconnect());
    return g;
  }

  // ---------- styles, added once ----------

  const CSS = `
    .mg-root { position: absolute; inset: 0; overflow: hidden; }
    .mg-bar { position: absolute; top: 0; left: 0; width: 100%; height: 5px; background: black; transform-origin: left center; z-index: 2; }
    .mg-round { position: absolute; top: 12px; right: 16px; color: #777; z-index: 2; }
    .mg-center { height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 16px; padding: 24px 0; box-sizing: border-box; }
    .mg-prompt { font-size: clamp(20px, 2.6vw, 30px); margin: 0; min-height: 1.4em; }
    .mg-overlay { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
    .mg-overlay polygon { stroke-width: 3; vector-effect: non-scaling-stroke; }
    .mg-overlay .ok { fill: rgb(26 158 75 / .35); stroke: #1a9e4b; }
    .mg-overlay .bad { fill: rgb(210 60 60 / .35); stroke: #d23c3c; }

    .mg-find { position: relative; line-height: 0; cursor: crosshair; user-select: none; }
    .mg-find .mg-photo { display: block; max-width: 92vw; max-height: calc(100vh - 170px); }
    .mg-dot { position: absolute; width: 14px; height: 14px; margin: -7px 0 0 -7px; border-radius: 50%; border: 2px solid white; background: black; pointer-events: none; }
    .mg-dot[hidden] { display: none; }

    .mg-opts { display: flex; gap: 16px; justify-content: center; }
    .mg-opt { width: min(30vw, 380px); aspect-ratio: 4 / 3; padding: 0; border: 0; background: none; cursor: pointer; }
    .mg-opt img { width: 100%; height: 100%; object-fit: contain; display: block; }
    .mg-opt:hover:not(:disabled) { box-shadow: 0 0 0 3px #bbb; }
    .mg-opt:disabled { cursor: default; }
    .mg-opt.ok { box-shadow: 0 0 0 5px #1a9e4b; }
    .mg-opt.bad { box-shadow: 0 0 0 5px #d23c3c; }
    .mg-caption { max-width: min(90vw, 900px); text-align: center; font-size: clamp(18px, 2.2vw, 26px); min-height: 1.4em; margin: 0; }

    /* flex + margin: auto centres the photo when it's shorter than the container and collapses to 0 when it overflows */
    .mg-scroller { position: absolute; inset: 0; overflow: auto; cursor: grab; display: flex; }
    .mg-scroller.dragging { cursor: grabbing; }
    .mg-stage { position: relative; margin: auto; flex: none; line-height: 0; touch-action: none; user-select: none; }
    .mg-stage .mg-photo { display: block; max-width: none; }
    .mg-stage .mg-overlay polygon { stroke-width: 4; }
    .mg-miss { position: absolute; width: 18px; height: 18px; margin: -9px 0 0 -9px; border-radius: 50%; border: 3px solid #d23c3c; pointer-events: none; animation: mg-fade .6s forwards; }
    @keyframes mg-fade { to { opacity: 0; transform: scale(1.8); } }
    .mg-hud { position: absolute; top: 16px; left: 50%; transform: translateX(-50%); z-index: 2; white-space: nowrap;
              background: white; border: 1px solid black; padding: 4px 12px; font-size: clamp(16px, 2vw, 22px); }
    .mg-count { color: #777; margin-left: 12px; font-variant-numeric: tabular-nums; }
    .mg-count:empty { display: none; }
    .mg-zoom { position: absolute; right: 16px; bottom: 16px; z-index: 2; display: flex; flex-direction: column; }
    .mg-zoom button { font: inherit; font-size: 22px; line-height: 1; width: 44px; height: 44px; border: 1px solid black; background: white; cursor: pointer; }
    .mg-zoom button + button { border-top: 0; }
  `;
  let styled = false;
  const GAMES = { 'find': findIt, 'caption-match': captionMatch, 'find-all': findAll };
  return Object.fromEntries(Object.entries(GAMES).map(([key, game]) => [key, {
    mount(container, data, onComplete) {
      if (!styled) { styled = true; const s = document.createElement('style'); s.textContent = CSS; document.head.append(s); }
      let reported = false;
      const g = game(container, data, result => { if (!reported) { reported = true; onComplete(result); } });
      return { destroy: g.destroy };
    },
  }]));
})();
