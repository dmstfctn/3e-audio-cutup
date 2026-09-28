// The minigames: find it, pair it, find them all and caption match.
// The page picks what's played and works out the words won; the games only play it and report
// what happened:
//   MINIGAMES[key].mount(container, data, onComplete, onProgress) -> { destroy }
//   find:          data { photo, viewBox, shapes: [el], target, prompt, seconds, tolerance }
//                  -> onProgress({ seconds, x, y }) when it's found
//                  -> onComplete({ found: bool, seconds })
//   find-all:      data { photo, viewBox, shapes: [{ key, el }], target, prompt, seconds, tolerance, found: [key] }
//                  -> onProgress({ found: [key], x, y }) with the keys each click finds
//                  -> onComplete({ found: [key], seconds })
//                  found comes in as the keys already found and goes out with the new ones added; reach
//                  (optional), in the photo's pixels, makes a click find every shape that near instead of the nearest one
//   caption-match: data { rounds: [{ prompt, caption, answer, options: [photo], seconds }] }
//                  -> onProgress({ round, x, y }) for each round matched
//                  -> onComplete({ matched: [round index] })
//                  prompt is the line shown over the photos, with the caption in it
//   pair-it:       data { pairs: [[photo, photo]], prompt, seconds }
//                  -> onProgress({ pair, x, y }) for each pair matched
//                  -> onComplete({ matched: [pair index], seconds })
// x, y: where on screen the click that won it was, for the words to fly from.
// seconds: how long the player took, from the timer starting to the click that found it (find) or
// the last one (find-all); the whole time if the timer ran out.
// onComplete fires once, after the last reveal. Shapes are SVG elements in the photo's pixel space.
// seconds: null plays with no timer (and no bar) until the game's done or destroyed.
const MINIGAMES = (() => {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const REVEAL_MS = 1000;  // how long the end of a play shows before the game moves on
  const shuffle = a => {
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  };
  // resolves on load or error, so a broken photo never stalls a game
  const preload = src => new Promise(res => { const im = new Image(); im.onload = im.onerror = res; im.src = src; });
  // a photo's pixel size, from its shapes' viewBox (drawn at the photo's size)
  const viewSize = viewBox => viewBox.split(/[\s,]+/).map(Number).slice(2, 4);
  const bold = text => { const b = document.createElement('b'); b.textContent = text; return b; };

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
      out.push(bold(m[0]));
      last = m.index + m[0].length;
    }
    out.push(text.slice(last));
    return out;
  }

  // a red ring where a click missed, fading out
  function missAt(parent, e) {
    const r = parent.getBoundingClientRect();
    const m = document.createElement('div');
    m.className = 'mg-miss';
    m.style.left = `${e.clientX - r.left}px`;
    m.style.top = `${e.clientY - r.top}px`;
    parent.append(m);
    m.addEventListener('animationend', () => m.remove());
  }

  // ---------- shared frame: timer bar, and everything destroy() has to undo ----------

  function frame(container, html) {
    const root = document.createElement('div');
    root.className = 'mg-root';
    root.innerHTML = `<div class="mg-bar"></div>${html}`;
    container.append(root);
    const g = {
      dead: false,
      $: s => root.querySelector(s),
      root,
      bar: frac => { root.firstChild.style.transform = `scaleX(${Math.max(0, frac)})`; },
    };
    let raf = null, started = null, stopped = null, live = false;
    const timeouts = new Set(), cleanups = [];
    // counts down secs on the bar, then calls onDone; only runs while the player can act. With no secs
    // there's no bar, and it runs until stopped.
    g.countdown = (secs, onDone) => {
      const t0 = started = performance.now();
      stopped = null;
      live = true;
      root.firstChild.hidden = secs == null;
      if (secs == null) return;
      const tick = now => {
        const left = 1 - (now - t0) / (secs * 1000);
        g.bar(left);
        if (left <= 0) { raf = null; live = false; onDone(); } else raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    };
    g.stop = () => { if (live) stopped ??= performance.now(); cancelAnimationFrame(raf); raf = null; live = false; };
    // seconds from the countdown starting to it stopping (or to now, while it runs)
    g.elapsed = () => started === null ? 0 : ((stopped ?? performance.now()) - started) / 1000;
    g.running = () => live;
    // replaces a prompt's text at the end of a play, keeping its height, so the photo under it doesn't move
    g.say = (el, nodes) => {
      el.style.minHeight = `${el.offsetHeight}px`;
      el.replaceChildren(...nodes);
    };
    g.later = (fn, ms) => {
      const t = setTimeout(() => { timeouts.delete(t); if (!g.dead) fn(); }, ms);
      timeouts.add(t);
    };
    // listeners outside the game's own elements, removed on destroy
    g.on = (target, type, fn, opts) => { target.addEventListener(type, fn, opts); cleanups.push(() => target.removeEventListener(type, fn, opts)); };
    g.onDestroy = fn => cleanups.push(fn);
    // sizes el (w × h) to the largest it can be inside box, and keeps it so when box resizes
    g.fit = (box, el, w, h) => {
      const size = () => {
        const s = Math.min(box.clientWidth / w, box.clientHeight / h);
        if (!(s > 0)) return;
        el.style.width = `${w * s}px`;
        el.style.height = `${h * s}px`;
      };
      const ro = new ResizeObserver(size);
      ro.observe(box);
      cleanups.push(() => ro.disconnect());
      size();
    };
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
  // Click the named thing within data.seconds. Any of its shapes counts; a miss leaves the time running.

  function findIt(container, data, done, progress) {
    const g = frame(container, `
      <div class="mg-center">
        <p class="mg-prompt">loading…</p>
        <div class="mg-fitbox">
          <div class="mg-find">
            <img class="mg-photo" alt="" draggable="false">
            <svg class="mg-overlay" preserveAspectRatio="none"></svg>
          </div>
        </div>
      </div>`);
    const photo = g.$('.mg-photo'), overlay = g.$('.mg-overlay'), find = g.$('.mg-find'), prompt = g.$('.mg-prompt');
    const shapes = drawShapes(overlay, data.viewBox, data.shapes);
    g.bar(1);

    preload(data.photo).then(() => {
      if (g.dead) return;
      photo.src = data.photo;
      g.fit(g.$('.mg-fitbox'), photo, ...viewSize(data.viewBox));
      prompt.replaceChildren(...promptNodes(data.prompt, data.target));
      g.countdown(data.seconds, () => finish(false));
    });

    // found: the shapes clicked are green; time-out: the shapes stay hidden, to find next time
    function finish(found) {
      g.stop();
      const seconds = g.elapsed();
      g.later(() => done({ found, seconds }), REVEAL_MS);
    }

    find.addEventListener('pointerdown', e => {
      if (!g.running() || e.button > 0) return;
      const hit =shapes.filter(s => hitDistance(s, e.clientX, e.clientY, data.tolerance) < Infinity);
      if (!hit.length) return missAt(find, e);
      g.stop();
      hit.forEach(s => s.classList.add('ok'));
      progress({ seconds: g.elapsed(), x: e.clientX, y: e.clientY });
      finish(true);
    });
    return g;
  }

  // ---------- caption match ----------
  // Pick the photo a caption describes from it and its decoys, each round with its own time.

  function captionMatch(container, data, done, progress) {
    const g = frame(container, `
      <div class="mg-center">
        <p class="mg-prompt">loading…</p>
        <div class="mg-fitbox"><div class="mg-opts"></div></div>
      </div>`);
    const opts = g.$('.mg-opts'), caption = g.$('.mg-prompt');
    const rounds = data.rounds;
    const matched = [];
    let idx = 0;

    // the timer starts once the photos have loaded, so it never runs over blank boxes
    async function playRound() {
      const r = rounds[idx];
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
      caption.replaceChildren(...promptNodes(r.prompt, r.caption));
      g.countdown(r.seconds, () => finish(null));
    }

    // a right pick goes green, a wrong one red without giving the answer away; a time-out shows nothing, as in find it
    function finish(chosen, e) {
      g.stop();
      const r = rounds[idx];
      for (const b of opts.children) {
        b.disabled = true;
        if (chosen === r.answer && b.dataset.src === r.answer) b.classList.add('ok');
        else if (b.dataset.src === chosen) b.classList.add('bad');
      }
      if (chosen === r.answer) {
        matched.push(idx);
        progress({ round: idx, x: e.clientX, y: e.clientY });
      }
      g.later(() => { idx++; idx < rounds.length ? playRound() : done({ matched }); }, REVEAL_MS);
    }

    opts.addEventListener('pointerdown', e => {
      const b = e.target.closest('.mg-opt');
      if (b && !b.disabled && g.running() && e.button <= 0) finish(b.dataset.src, e);
    });
    playRound();
    return g;
  }

  // ---------- pair it ----------
  // Every pair's photos shuffled into one grid. Click one, then the one with the same energy: a match
  // shrinks away, leaving its gap; a wrong pair flashes red. Clicking the picked photo again drops it.

  function pairIt(container, data, done, progress) {
    const BAD_MS = 1000, SHRINK_MS = 350;
    const g = frame(container, `
      <div class="mg-center">
        <p class="mg-prompt">loading…</p>
        <div class="mg-fitbox"><div class="mg-pairs"></div></div>
      </div>`);
    const grid = g.$('.mg-pairs'), prompt = g.$('.mg-prompt');
    const matched = [];
    let picked = null, bad = [];
    g.bar(1);
    const clearBad = () => { bad.forEach(c => c.classList.remove('bad')); bad = []; };

    const cells = shuffle(data.pairs.flatMap((pair, k) => pair.map(src => {
      const b = document.createElement('button');
      b.className = 'mg-cell';
      b.dataset.pair = k;
      const img = document.createElement('img');
      img.alt = '';
      img.draggable = false;
      b.append(img);
      return [b, img, src];
    })));
    grid.style.visibility = 'hidden';  // the timer starts once every photo has loaded
    grid.append(...cells.map(([b]) => b));
    Promise.all(cells.map(([, , src]) => preload(src))).then(() => {
      if (g.dead) return;
      cells.forEach(([, img, src]) => img.src = src);
      grid.style.visibility = '';
      prompt.textContent = data.prompt;
      g.countdown(data.seconds, end);
    });

    function end() {
      g.stop();
      clearBad();
      if (picked) picked.classList.remove('picked');
      grid.querySelectorAll('.mg-cell').forEach(c => c.disabled = true);
      g.say(prompt, matched.length < data.pairs.length
        ? ["time's up: ", bold(`${matched.length} / ${data.pairs.length}`), ' paired']
        : ['you paired all ', bold(String(data.pairs.length))]);
      const seconds = g.elapsed();
      g.later(() => done({ matched, seconds }), REVEAL_MS);
    }

    grid.addEventListener('pointerdown', e => {
      const c = e.target.closest('.mg-cell');
      if (!c || c.disabled || !g.running() || e.button > 0) return;
      e.preventDefault();
      clearBad();  // a click during the red flash is a new first pick
      if (c === picked) { c.classList.remove('picked'); picked = null; return; }
      if (!picked) { c.classList.add('picked'); picked = c; return; }
      const pair = [picked, c];
      picked = null;
      pair[0].classList.remove('picked');
      if (pair[0].dataset.pair === c.dataset.pair) {
        pair.forEach(p => { p.disabled = true; p.classList.add('ok', 'gone'); });
        g.later(() => pair.forEach(p => p.classList.add('out')), SHRINK_MS);  // the gap stays
        matched.push(Number(c.dataset.pair));
        progress({ pair: Number(c.dataset.pair), x: e.clientX, y: e.clientY });
        if (matched.length === data.pairs.length) { g.stop(); g.later(end, SHRINK_MS + 150); }
      } else {
        pair.forEach(p => p.classList.add('bad'));
        bad = pair;
        g.later(() => { if (bad[0] === pair[0]) clearBad(); }, BAD_MS);
      }
    });
    return g;
  }

  // ---------- find them all ----------
  // Click every shape of one thing in data.seconds, on the whole photo, the count found after the prompt.
  // Shapes found on earlier plays start found.

  function findAll(container, data, done, progress) {
    const g = frame(container, `
      <div class="mg-center">
        <p class="mg-prompt"><span class="mg-say">loading…</span><span class="mg-count"></span></p>
        <div class="mg-fitbox">
          <div class="mg-find">
            <img class="mg-photo" alt="" draggable="false">
            <svg class="mg-overlay" preserveAspectRatio="none"></svg>
          </div>
        </div>
      </div>`);
    const photo = g.$('.mg-photo'), overlay = g.$('.mg-overlay'), find = g.$('.mg-find');
    const line = g.$('.mg-prompt'), prompt = g.$('.mg-say'), count = g.$('.mg-count');
    const shapes = drawShapes(overlay, data.viewBox, data.shapes.map(s => s.el));
    const n = shapes.length;
    const found = new Set(data.shapes.flatMap((s, k) => data.found.includes(s.key) ? [k] : []));
    found.forEach(k => shapes[k].classList.add('ok'));
    g.bar(1);
    const updateCount = () => { count.textContent = ` (${found.size}/${n})`; };

    // the shapes a click finds: the nearest one not found yet within tol screen pixels, or with data.reach,
    // every one not found yet within reach of the photo's pixels
    function hitShapes(cx, cy) {
      if (data.reach) return hitWithin(cx, cy, data.reach);
      let best = -1, bestD = Infinity;
      shapes.forEach((s, k) => {
        if (found.has(k)) return;
        const d = hitDistance(s, cx, cy, data.tolerance);
        if (d < bestD) { best = k; bestD = d; }
      });
      return best < 0 ? [] : [best];
    }

    // Shapes whose bounding box is within reach of the click, in the photo's pixels. A shape no bigger
    // than the reach counts whole; a bigger one needs its fill within reach, so its box's empty corners don't.
    let boxes = null;
    function hitWithin(cx, cy, reach) {
      const m = overlay.getScreenCTM();
      if (!m) return [];
      const p = new DOMPoint(cx, cy).matrixTransform(m.inverse());
      boxes ??= shapes.map(s => s.getBBox());
      return shapes.flatMap((s, k) => {
        if (found.has(k)) return [];
        const b = boxes[k];
        const dx = Math.max(b.x - p.x, 0, p.x - b.x - b.width), dy = Math.max(b.y - p.y, 0, p.y - b.y - b.height);
        if (Math.hypot(dx, dy) > reach) return [];
        const small = b.width <= 2 * reach && b.height <= 2 * reach;
        return small || hitDistance(s, cx, cy, reach * m.a) < Infinity ? [k] : [];
      });
    }

    // the timer starts once the photo is on screen
    preload(data.photo).then(() => {
      if (g.dead) return;
      photo.src = data.photo;
      g.fit(g.$('.mg-fitbox'), photo, ...viewSize(data.viewBox));
      prompt.replaceChildren(...promptNodes(data.prompt, data.target));
      updateCount();
      g.countdown(data.seconds, end);
    });

    function end() {
      g.stop();
      // the ones not found stay hidden, so they're still there to find next time
      g.say(line, found.size < n
        ? ["time's up: ", bold(`${found.size} / ${n}`), ' found']
        : ['you found all ', bold(String(n))]);
      const seconds = g.elapsed();
      g.later(() => done({ found: data.shapes.filter((_, k) => found.has(k)).map(s => s.key), seconds }), REVEAL_MS);
    }

    find.addEventListener('pointerdown', e => {
      if (!g.running() || e.button > 0) return;
      const hits = hitShapes(e.clientX, e.clientY);
      if (!hits.length) return missAt(find, e);
      hits.forEach(k => { found.add(k); shapes[k].classList.add('ok'); });
      updateCount();
      progress({ found: hits.map(k => data.shapes[k].key), x: e.clientX, y: e.clientY });
      if (found.size === n) end();
    });
    return g;
  }

  const GAMES = { 'find': findIt, 'pair-it': pairIt, 'caption-match': captionMatch, 'find-all': findAll };
  return Object.fromEntries(Object.entries(GAMES).map(([key, game]) => [key, {
    mount(container, data, onComplete, onProgress) {
      let reported = false;
      const g = game(container, data,
        result => { if (!reported) { reported = true; onComplete(result); } },
        event => { if (!reported) onProgress?.(event); });
      return { destroy: g.destroy };
    },
  }]));
})();
