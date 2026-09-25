// Prototype-06's minigames: minigames.js (prototype-05) with local photos, shapes from SVG files
// and content from games.yaml. The page picks what's played and works out the words won; the
// games only play it and report what happened:
//   MINIGAMES[key].mount(container, data, onComplete) -> { destroy }
//   find:          data { photo, viewBox, shapes: [el], target, prompt, seconds, tolerance }
//                  -> onComplete({ found: bool })
//   find-all:      data { photo, viewBox, shapes: [{ key, el }], target, prompt, seconds, zoom,
//                  tolerance, found: [key], steps: [count] } -> onComplete({ found: [key] })
//                  found comes in as the keys found on earlier plays and goes out with the new ones added;
//                  steps are the counts that each win a word, for the progress bar
//   caption-match: data { rounds: [{ caption, answer, options: [photo], seconds }] }
//                  -> onComplete({ matched: [round index] })
// onComplete fires once, after the last reveal. Shapes are SVG elements in the photo's pixel space.
const MINIGAMES = (() => {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const shuffle = a => {
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  };
  // resolves on load or error, so a broken photo never stalls a game
  const preload = src => new Promise(res => { const im = new Image(); im.onload = im.onerror = res; im.src = src; });

  // ---------- shapes ----------

  // Copies shapes into an overlay that has the SVG file's viewBox, one <g> per shape,
  // so a shape can be coloured as a whole by class.
  function drawShapes(overlay, viewBox, els) {
    overlay.setAttribute('viewBox', viewBox);
    overlay.replaceChildren();
    return els.map(el => {
      const g = document.createElementNS(SVG_NS, 'g');
      g.append(document.importNode(el, true));
      overlay.append(g);
      return g;
    });
  }

  // The browser's own fill test, so paths, curves and transforms all work. The click point is
  // tested first, then rings around it out to tol screen pixels. Returns the ring it hit at
  // (0 = on the shape) or Infinity.
  const RINGS = [0, 0.5, 1];
  function hitDistance(g, cx, cy, tol) {
    const parts = [...g.querySelectorAll('polygon, polyline, path, rect, circle, ellipse, line')];
    for (let r = 0; r < RINGS.length; r++) {
      const rad = RINGS[r] * tol, n = r ? 8 : 1;
      for (let k = 0; k < n; k++) {
        const x = cx + rad * Math.cos(k * Math.PI / 4), y = cy + rad * Math.sin(k * Math.PI / 4);
        for (const el of parts) {
          const m = el.getScreenCTM();
          if (m && el.isPointInFill(new DOMPoint(x, y).matrixTransform(m.inverse()))) return r;
        }
      }
    }
    return Infinity;
  }

  // the prompt, with the thing's name in bold wherever it appears
  function promptNodes(text, target) {
    const out = [];
    const re = new RegExp(target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    let last = 0;
    for (const m of text.matchAll(re)) {
      out.push(text.slice(last, m.index));
      const b = document.createElement('b');
      b.textContent = m[0];
      out.push(b);
      last = m.index + m[0].length;
    }
    out.push(text.slice(last));
    return out;
  }

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
      round: (i, n) => { g.$('.mg-round').textContent = n > 1 ? `${i + 1} / ${n}` : ''; },
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

  // ---------- find it ----------
  // One click on the named thing within data.seconds. Any of its shapes counts.

  function findIt(container, data, done) {
    const REVEAL_MS = 1000;
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
    const shapes = drawShapes(overlay, data.viewBox, data.shapes);
    g.bar(1);

    preload(data.photo).then(() => {
      if (g.dead) return;
      photo.src = data.photo;
      prompt.replaceChildren(...promptNodes(data.prompt, data.target));
      g.countdown(data.seconds, () => reveal([]));
    });

    // hit: the shapes clicked go green; miss or time-out: the shapes stay hidden, to find next time
    function reveal(hit) {
      g.stop();
      hit.forEach(s => s.classList.add('ok'));
      g.later(() => done({ found: hit.length > 0 }), REVEAL_MS);
    }

    g.$('.mg-find').addEventListener('pointerdown', e => {
      if (!g.running()) return;
      const r = photo.getBoundingClientRect();
      dot.style.left = `${e.clientX - r.left}px`;
      dot.style.top = `${e.clientY - r.top}px`;
      dot.hidden = false;
      reveal(shapes.filter(s => hitDistance(s, e.clientX, e.clientY, data.tolerance) < Infinity));
    });
    return g;
  }

  // ---------- caption match ----------
  // Pick the photo a caption describes from it and its decoys, each round with its own time.

  function captionMatch(container, data, done) {
    const REVEAL_MS = 900;
    const g = frame(container, `
      <div class="mg-center">
        <div class="mg-opts"></div>
        <p class="mg-caption">loading…</p>
      </div>`);
    const opts = g.$('.mg-opts'), caption = g.$('.mg-caption');
    const rounds = data.rounds;
    const matched = [];
    let idx = 0;

    // the timer starts once the photos have loaded, so it never runs over blank boxes
    async function playRound() {
      const r = rounds[idx];
      g.round(idx, rounds.length);
      opts.replaceChildren();
      caption.textContent = 'loading…';
      g.bar(1);
      await Promise.all(r.options.map(preload));
      if (g.dead) return;
      rounds[idx + 1]?.options.forEach(preload);
      for (const src of r.options) {
        const b = document.createElement('button');
        b.className = 'mg-opt';
        b.dataset.src = src;
        const img = document.createElement('img');
        img.src = src;
        img.alt = '';
        b.append(img);
        opts.append(b);
      }
      caption.textContent = r.caption;
      g.countdown(r.seconds, () => finish(null));
    }

    // the answer goes green, a wrong pick red; a time-out only shows the answer
    function finish(chosen) {
      g.stop();
      const r = rounds[idx];
      for (const b of opts.children) {
        b.disabled = true;
        if (b.dataset.src === r.answer) b.classList.add('ok');
        else if (b.dataset.src === chosen) b.classList.add('bad');
      }
      if (chosen === r.answer) matched.push(idx);
      g.later(() => { idx++; idx < rounds.length ? playRound() : done({ matched }); }, REVEAL_MS);
    }

    opts.addEventListener('click', e => {
      const b = e.target.closest('.mg-opt');
      if (b && !b.disabled && g.running()) finish(b.dataset.src);
    });
    playRound();
    return g;
  }

  // ---------- find them all ----------
  // Click every shape of one thing in data.seconds. The photo starts zoomed in and can never be
  // zoomed out to show it whole, so finding them means panning around. Shapes found on earlier
  // plays start found.

  function findAll(container, data, done) {
    const REVEAL_MS = 1500;           // how long the final count shows before the result
    const MIN_COVER = 1.25;           // zoom-out floor: MIN_COVER × the size that just covers the container
    const MAX_ZOOM = 2;               // zoom-in ceiling: MAX_ZOOM × the starting size
    const DRAG_PX = 6;                // a press that moves further than this is a pan, not a click
    const g = frame(container, `
      <div class="mg-scroller">
        <div class="mg-stage">
          <img class="mg-photo" alt="" draggable="false">
          <svg class="mg-overlay" preserveAspectRatio="none"></svg>
        </div>
      </div>
      <div class="mg-hud"><span class="mg-prompt">loading…</span><span class="mg-count"></span>
        <div class="mg-progress"><div class="mg-fill"></div></div></div>
      <div class="mg-zoom"><button title="zoom in">+</button><button title="zoom out">−</button></div>`);
    const sc = g.$('.mg-scroller'), stage = g.$('.mg-stage'), photo = g.$('.mg-photo'), overlay = g.$('.mg-overlay');
    const prompt = g.$('.mg-prompt'), count = g.$('.mg-count'), progress = g.$('.mg-progress');
    const shapes = drawShapes(overlay, data.viewBox, data.shapes.map(s => s.el));
    const n = shapes.length;
    const found = new Set(data.shapes.flatMap((s, k) => data.found.includes(s.key) ? [k] : []));
    found.forEach(k => shapes[k].classList.add('ok'));
    let w = 0, h = 0, zoom = data.zoom, ready = false;

    // one notch per word, at the count that wins it; notches passed are filled
    const notches = data.steps.map(step => {
      const d = document.createElement('div');
      d.className = 'mg-notch';
      d.style.left = `${step / n * 100}%`;
      progress.append(d);
      return d;
    });
    function updateCount() {
      count.textContent = `${found.size} / ${n}`;
      g.$('.mg-fill').style.width = `${found.size / n * 100}%`;
      notches.forEach((d, k) => d.classList.toggle('passed', found.size >= data.steps[k]));
    }
    updateCount();

    // nearest shape not found yet within tol screen pixels of the click, or -1
    function hitShape(cx, cy) {
      let best = -1, bestD = Infinity;
      shapes.forEach((s, k) => {
        if (found.has(k)) return;
        const d = hitDistance(s, cx, cy, data.tolerance);
        if (d < bestD) { best = k; bestD = d; }
      });
      return best;
    }

    // zoom = the photo's width as a multiple of the container's
    const startW = () => sc.clientWidth * data.zoom;
    const coverW = () => Math.max(sc.clientWidth, sc.clientHeight * w / h);
    const minW = () => Math.min(startW(), coverW() * MIN_COVER);
    const maxW = () => startW() * MAX_ZOOM;
    function setWidth(pw) {
      photo.style.width = `${pw}px`;
      photo.style.height = `${pw * h / w}px`;
      zoom = pw / sc.clientWidth;
    }
    // zooms to width pw, keeping the photo point under (ax, ay), relative to the scroller, fixed
    function zoomTo(pw, ax = sc.clientWidth / 2, ay = sc.clientHeight / 2) {
      const s = sc.getBoundingClientRect(), r = photo.getBoundingClientRect();
      const fx = (s.left + ax - r.left) / r.width, fy = (s.top + ay - r.top) / r.height;
      setWidth(Math.min(maxW(), Math.max(minW(), pw)));
      const r2 = photo.getBoundingClientRect();
      sc.scrollLeft += r2.left + fx * r2.width - (s.left + ax);
      sc.scrollTop += r2.top + fy * r2.height - (s.top + ay);
    }
    const zoomBy = (f, ax, ay) => { if (ready) zoomTo(photo.offsetWidth * f, ax, ay); };

    // the timer starts once the photo is on screen, centred at the starting zoom
    photo.style.visibility = 'hidden';
    photo.onload = photo.onerror = () => {
      photo.onload = photo.onerror = null;
      if (g.dead) return;
      const vb = data.viewBox.split(/[\s,]+/).map(Number);
      w = photo.naturalWidth || vb[2];
      h = photo.naturalHeight || vb[3];
      setWidth(startW());
      sc.scrollLeft = (sc.scrollWidth - sc.clientWidth) / 2;
      sc.scrollTop = (sc.scrollHeight - sc.clientHeight) / 2;
      photo.style.visibility = '';
      ready = true;
      prompt.replaceChildren(...promptNodes(data.prompt, data.target));
      g.countdown(data.seconds, end);
    };
    photo.src = data.photo;

    const bold = text => { const b = document.createElement('b'); b.textContent = text; return b; };
    function end() {
      g.stop();
      // the ones not found stay hidden, so they're still there to find next time
      prompt.replaceChildren(...(found.size < n
        ? ["time's up: ", bold(`${found.size} / ${n}`), ' found']
        : ['you found all ', bold(String(n))]));
      count.textContent = '';
      g.later(() => done({ found: data.shapes.filter((_, k) => found.has(k)).map(s => s.key) }), REVEAL_MS);
    }

    function clickAt(e) {
      if (!g.running()) return;
      const k = hitShape(e.clientX, e.clientY);
      if (k >= 0) {
        found.add(k);
        shapes[k].classList.add('ok');
        updateCount();
        if (found.size === n) end();
      } else {
        const r = photo.getBoundingClientRect();
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
    /* shapes are invisible until revealed, whatever colours the SVG file gave them */
    .mg-overlay g * { fill: transparent; stroke: none; stroke-width: 3; vector-effect: non-scaling-stroke; }
    .mg-overlay g.ok * { fill: rgb(26 158 75 / .35); stroke: #1a9e4b; }

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
    .mg-stage .mg-overlay g * { stroke-width: 4; }
    .mg-miss { position: absolute; width: 18px; height: 18px; margin: -9px 0 0 -9px; border-radius: 50%; border: 3px solid #d23c3c; pointer-events: none; animation: mg-fade .6s forwards; }
    @keyframes mg-fade { to { opacity: 0; transform: scale(1.8); } }
    .mg-hud { position: absolute; top: 16px; left: 50%; transform: translateX(-50%); z-index: 2; white-space: nowrap;
              background: white; border: 1px solid black; padding: 4px 12px 8px; font-size: clamp(16px, 2vw, 22px); }
    .mg-count { color: #777; margin-left: 12px; font-variant-numeric: tabular-nums; }
    .mg-count:empty { display: none; }
    /* progress over every play of this photo; a notch where each word is won */
    .mg-progress { position: relative; height: 8px; margin-top: 6px; border: 1px solid black; }
    .mg-fill { height: 100%; width: 0; background: #1a9e4b; transition: width .2s; }
    .mg-notch { position: absolute; top: -5px; bottom: -5px; width: 7px; margin-left: -4px; border: 1px solid black; background: white; box-sizing: border-box; }
    .mg-notch.passed { background: black; }
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
