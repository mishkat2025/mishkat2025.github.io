/* ============================================================
   Robot cat.

   A small neon robot cat that lives BEHIND the page. It is drawn
   on a fixed, full-screen canvas at z-index -1 with pointer-events
   off, so it never covers content and never blocks a click.

   What it does:
     - lives by its charging pod in the empty space under the
       terminal card (its "home"), sits, blinks, grooms itself
     - now and then strolls around the visible page, then walks
       back home
     - walks BEHIND text, but treats solid blocks (cards, buttons,
       tags, the terminal...) as walls and finds a way around them
     - notices the cursor, trots over, and bats at it from just
       out of reach
     - if you rest the cursor ON the cat, it grabs it and licks it
     - when the mouse has been still for a long time, it goes back
       to its pad and charges (sleeps)
     - gets bored after a while and ignores the cursor for a bit,
       so it does not chase you around while you read

   How the obstacles work: the page is divided into a grid of
   16px cells. Any cell where the cat would overlap a solid block
   is marked blocked, and the cat plans routes with A* (the usual
   game pathfinding) through the free cells. As a last line of
   defence, a move that would enter a blocked cell is refused.

   Everything is kept in PAGE coordinates, so the home scrolls
   with the hero like the rest of the content. The canvas itself
   is viewport-sized; we subtract the scroll offset when drawing.

   Because the canvas is underneath everything, the browser can't
   tell us when the mouse is "over" the cat. So we track the mouse
   ourselves and hit-test in the cat's own coordinates (onCat()).

   Switched off on touch devices, narrow screens, and for anyone
   whose system asks for reduced motion.
   ============================================================ */

(function () {
  "use strict";

  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  var finePointer = window.matchMedia("(hover: hover) and (pointer: fine)");
  var wideEnough = window.matchMedia("(min-width: 900px)");

  var canvas = document.createElement("canvas");
  canvas.className = "cat-layer";
  canvas.setAttribute("aria-hidden", "true");
  document.body.insertBefore(canvas, document.body.firstChild);
  var ctx = canvas.getContext("2d");


  /* ---------- Tuning knobs ---------- */

  var S = 1.15;              // overall size of the cat and its pod
  var WALK_SPEED = 65;       // px per second while wandering
  var CHASE_SPEED = 170;     // px per second while going for the cursor
  var HEADER = 64;           // height of the fixed header; stay below it
  var NOTICE_RANGE = 460;    // how close the cursor must be to be noticed
  var ATTENTION = 12000;     // ms it will play before getting bored
  var TONGUE = "#ff6fae";

  // Solid blocks the cat walks AROUND instead of behind.
  var OBSTACLES = [
    ".terminal", ".dossier", ".learned", ".skill-group",
    ".btn", ".eyebrow", ".tags", ".site-footer"
  ].join(", ");

  var CELL = 16;             // pathfinding grid size, px
  var FOOT_W = 34 * S;       // half the cat's width (matches onCat())
  var FOOT_H = 66 * S;       // the cat's height above its feet
  var PAD = 8;               // breathing room around obstacles


  /* ---------- Small helpers ---------- */

  function lerp(a, b, t) { return a + (b - a) * t; }
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function rand(a, b) { return a + Math.random() * (b - a); }
  function pt(x, y) { return { x: x, y: y }; }
  function mix(p, q, t) { return pt(lerp(p.x, q.x, t), lerp(p.y, q.y, t)); }
  function add(p, x, y) { return pt(p.x + x, p.y + y); }
  function dist(p, q) { return Math.hypot(p.x - q.x, p.y - q.y); }

  // Frame-rate independent smoothing toward a target value.
  function ease(current, target, rate, dt) {
    return current + (target - current) * (1 - Math.exp(-rate * dt));
  }

  function bezier(p0, p1, p2, p3, t) {
    var u = 1 - t;
    return pt(
      u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
      u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y
    );
  }


  /* ---------- Colours follow the site theme ---------- */

  var colors = { accent: "#00ff88", bg: "#0c0d0e" };

  function readColors() {
    var cs = getComputedStyle(document.documentElement);
    colors.accent = cs.getPropertyValue("--accent").trim() || colors.accent;
    colors.bg = cs.getPropertyValue("--bg").trim() || colors.bg;
  }

  readColors();
  new MutationObserver(readColors).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"]
  });


  /* ---------- Mouse tracking ---------- */

  // cx/cy are screen coordinates; x/y are page coordinates, refreshed
  // every frame so they stay right while the page scrolls.
  var mouse = { cx: 0, cy: 0, x: 0, y: 0, inside: false, lastMove: -1e9 };

  window.addEventListener("pointermove", function (e) {
    if (e.pointerType && e.pointerType !== "mouse") return;
    mouse.cx = e.clientX;
    mouse.cy = e.clientY;
    mouse.inside = true;
    mouse.lastMove = performance.now();
  }, { passive: true });

  // relatedTarget is null when the pointer leaves the window entirely.
  document.addEventListener("mouseout", function (e) {
    if (!e.relatedTarget) mouse.inside = false;
  });
  window.addEventListener("blur", function () { mouse.inside = false; });


  /* ---------- The cat ---------- */

  var cat = {
    x: 0, y: 0,              // ground point under the middle of the body
    vx: 0, vy: 0,
    facing: -1,              // 1 = facing right, -1 = facing left
    state: "idle",
    until: 0,                // when the current idle/sleep spell ends
    phase: 0,                // walk cycle
    tailPhase: 0,
    engaged: false,          // currently playing with the cursor
    attnStart: 0,
    cooldown: 0,             // ignore the cursor until this time
    sleepAfter: false,       // walking to the pad to charge
    stuckFor: 0,
    blinkAt: -1e9, nextBlink: 0,
    groomUntil: 0, nextGroom: 0,
    swipeAt: -1e9, nextSwipe: 0,
    nextHeart: 0, nextZ: 0,
    pawAngle: -1.2,          // direction of a reach, local coords
    hold: pt(20, -45),       // where the paws hold the cursor, local coords
    headLocal: pt(22, -34),  // last drawn head position, local coords
    placed: false,
    pose: {
      sit: 1, lie: 0, walk: 0,
      paw: 0, both: 0, groom: 0,
      tongue: 0, happy: 0, closed: 0,
      tilt: 0, lx: 0.6, ly: 0.1
    }
  };

  var particles = [];

  var W = 0, H = 0, docH = 0, dpr = 1;

  // Page-coordinate bounds for the cat's ground point.
  function minX() { return 50 * S; }
  function maxX() { return W - 50 * S; }
  function minY() { return HEADER + 80 * S; }
  function maxY() { return docH - 8; }


  /* ---------- Home: the space under the terminal card ---------- */

  var home = { x0: 0, x1: 0, y0: 0, y1: 0 };
  var dock = pt(0, 0);       // bottom-centre of the charging pod

  function computeHome() {
    var sx = window.scrollX, sy = window.scrollY;
    var term = document.querySelector(".terminal");
    var hero = document.querySelector(".hero");

    if (!term || !hero) {                       // no hero? bottom-right of the first screen
      home = { x0: W * 0.7, x1: W * 0.9, y0: H * 0.7, y1: H * 0.85 };
    } else {
      var t = term.getBoundingClientRect();
      var h = hero.getBoundingClientRect();

      // Just far enough below the card that the cat can't touch it.
      var x0 = t.left + sx + 40 * S;
      var x1 = t.right + sx - 40 * S;
      var y0 = t.bottom + sy + FOOT_H + PAD + CELL;
      var y1 = h.bottom + sy - 16;

      // Stacked (narrower) layout leaves no room underneath:
      // live beside the card instead.
      if (y1 - y0 < 40) {
        x0 = t.right + sx + FOOT_W + PAD + CELL;
        x1 = Math.max(x0, W - 50 * S);
        y0 = t.top + sy + FOOT_H + 24;
        y1 = t.bottom + sy;
      }

      home = { x0: x0, x1: Math.max(x0, x1), y0: y0, y1: Math.max(y0, y1) };
    }

    // Basket bottom sits a little into home so the cat's spot inside
    // it (see sleepSpot) is still clear of the terminal card.
    dock = pt(lerp(home.x0, home.x1, 0.68), home.y0 + 16 * S);
  }

  // Curled up inside the basket, body showing above the rim.
  function sleepSpot() { return pt(dock.x - 2 * S, dock.y - 15 * S); }

  function inBed() {
    return Math.abs(cat.x - dock.x) < 36 * S &&
           cat.y > dock.y - 30 * S && cat.y < dock.y + 2;
  }

  function atHome() {
    return cat.x > home.x0 - 24 && cat.x < home.x1 + 24 &&
           cat.y > home.y0 - 40 && cat.y < home.y1 + 24;
  }

  function homeVisible() {
    return home.y1 > window.scrollY && home.y0 - 90 * S < window.scrollY + H;
  }


  /* ---------- Obstacle grid ---------- */

  var grid = { cols: 0, rows: 0, blocked: new Uint8Array(0) };

  function buildGrid() {
    var sx = window.scrollX, sy = window.scrollY;
    var cols = Math.max(1, Math.ceil(W / CELL));
    var rows = Math.max(1, Math.ceil(docH / CELL));
    var b = new Uint8Array(cols * rows);
    var c, r;

    // Outside the area the cat is allowed in at all.
    for (r = 0; r < rows; r++) {
      var y = r * CELL + CELL / 2;
      var rowOut = y < minY() || y > maxY();
      for (c = 0; c < cols; c++) {
        var x = c * CELL + CELL / 2;
        if (rowOut || x < minX() || x > maxX()) b[r * cols + c] = 1;
      }
    }

    // Each solid block, grown by the cat's size: a ground point in
    // this area would put some part of the cat behind the block.
    var els = document.querySelectorAll(OBSTACLES);
    for (var i = 0; i < els.length; i++) {
      var rect = els[i].getBoundingClientRect();
      if (!rect.width || !rect.height) continue;
      var x0 = rect.left + sx - FOOT_W - PAD;
      var x1 = rect.right + sx + FOOT_W + PAD;
      var y0 = rect.top + sy - PAD;
      var y1 = rect.bottom + sy + FOOT_H + PAD;
      var c0 = Math.max(0, Math.ceil(x0 / CELL - 0.5));
      var c1 = Math.min(cols - 1, Math.floor(x1 / CELL - 0.5));
      var r0 = Math.max(0, Math.ceil(y0 / CELL - 0.5));
      var r1 = Math.min(rows - 1, Math.floor(y1 / CELL - 0.5));
      for (r = r0; r <= r1; r++) {
        for (c = c0; c <= c1; c++) b[r * cols + c] = 1;
      }
    }

    grid = { cols: cols, rows: rows, blocked: b };
    nav.dirty = true;                          // re-plan against the new map
  }

  function cellOf(x, y) {
    return pt(clamp(Math.floor(x / CELL), 0, grid.cols - 1),
              clamp(Math.floor(y / CELL), 0, grid.rows - 1));
  }
  function center(c, r) { return pt(c * CELL + CELL / 2, r * CELL + CELL / 2); }
  function free(c, r) {
    return c >= 0 && r >= 0 && c < grid.cols && r < grid.rows && !grid.blocked[r * grid.cols + c];
  }
  function freeAt(x, y) {
    return x >= 0 && y >= 0 && free(Math.floor(x / CELL), Math.floor(y / CELL));
  }

  function nearestFree(x, y, maxR) {
    var k = cellOf(x, y);
    for (var rad = 0; rad <= maxR; rad++) {
      var best = null, bd = Infinity;
      for (var dy = -rad; dy <= rad; dy++) {
        for (var dx = -rad; dx <= rad; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== rad) continue;
          if (!free(k.x + dx, k.y + dy)) continue;
          var c = center(k.x + dx, k.y + dy);
          var d = Math.hypot(c.x - x, c.y - y);
          if (d < bd) { bd = d; best = c; }
        }
      }
      if (best) return best;
    }
    return null;
  }

  function randomFree(x0, x1, y0, y1) {
    for (var i = 0; i < 24; i++) {
      var p = pt(rand(x0, x1), rand(y0, y1));
      if (freeAt(p.x, p.y)) return p;
    }
    return null;
  }


  /* ---------- A* pathfinding ---------- */

  function heapPush(h, node, f) {
    h.n.push(node); h.f.push(f);
    var i = h.n.length - 1;
    while (i > 0) {
      var p = (i - 1) >> 1;
      if (h.f[p] <= h.f[i]) break;
      heapSwap(h, i, p);
      i = p;
    }
  }

  function heapPop(h) {
    var top = h.n[0];
    var ln = h.n.pop(), lf = h.f.pop();
    if (h.n.length) {
      h.n[0] = ln; h.f[0] = lf;
      var i = 0, len = h.n.length;
      for (;;) {
        var l = 2 * i + 1, r = l + 1, m = i;
        if (l < len && h.f[l] < h.f[m]) m = l;
        if (r < len && h.f[r] < h.f[m]) m = r;
        if (m === i) break;
        heapSwap(h, i, m);
        i = m;
      }
    }
    return top;
  }

  function heapSwap(h, a, b) {
    var t = h.n[a]; h.n[a] = h.n[b]; h.n[b] = t;
    t = h.f[a]; h.f[a] = h.f[b]; h.f[b] = t;
  }

  var DIRS = [
    [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
    [1, 1, 1.414], [1, -1, 1.414], [-1, 1, 1.414], [-1, -1, 1.414]
  ];

  // Searches only a window around start and goal (cheap), which the
  // caller widens if the detour turns out to be bigger than that.
  function astar(s, g, margin) {
    var c0 = Math.max(0, Math.min(s.x, g.x) - margin);
    var c1 = Math.min(grid.cols - 1, Math.max(s.x, g.x) + margin);
    var r0 = Math.max(0, Math.min(s.y, g.y) - margin);
    var r1 = Math.min(grid.rows - 1, Math.max(s.y, g.y) + margin);
    var wc = c1 - c0 + 1, n = wc * (r1 - r0 + 1);

    var gs = new Float32Array(n).fill(Infinity);
    var came = new Int32Array(n).fill(-1);
    var closed = new Uint8Array(n);

    function h(c, r) {
      var dx = Math.abs(c - g.x), dy = Math.abs(r - g.y);
      return dx + dy - 0.586 * Math.min(dx, dy);          // octile distance
    }

    var start = (s.y - r0) * wc + (s.x - c0);
    var goal = (g.y - r0) * wc + (g.x - c0);
    var heap = { n: [], f: [] };
    gs[start] = 0;
    heapPush(heap, start, h(s.x, s.y));

    while (heap.n.length) {
      var cur = heapPop(heap);
      if (cur === goal) break;
      if (closed[cur]) continue;
      closed[cur] = 1;
      var cc = cur % wc + c0, cr = ((cur / wc) | 0) + r0;

      for (var k = 0; k < 8; k++) {
        var d = DIRS[k], nc = cc + d[0], nr = cr + d[1];
        if (nc < c0 || nc > c1 || nr < r0 || nr > r1 || !free(nc, nr)) continue;
        // No cutting diagonally across the corner of a block.
        if (d[0] && d[1] && (!free(cc + d[0], cr) || !free(cc, cr + d[1]))) continue;
        var ni = (nr - r0) * wc + (nc - c0);
        if (closed[ni]) continue;
        var ng = gs[cur] + d[2];
        if (ng < gs[ni]) {
          gs[ni] = ng;
          came[ni] = cur;
          heapPush(heap, ni, ng + h(nc, nr));
        }
      }
    }

    if (goal !== start && came[goal] < 0) return null;
    var out = [];
    for (var i = goal; i !== -1; i = came[i]) {
      out.push(center(i % wc + c0, ((i / wc) | 0) + r0));
    }
    return out.reverse();
  }

  // Can the cat walk straight from a to b without touching a block?
  function clearLine(a, b) {
    var steps = Math.ceil(dist(a, b) / (CELL / 2));
    for (var i = 0; i <= steps; i++) {
      var p = mix(a, b, steps ? i / steps : 0);
      if (!freeAt(p.x, p.y)) return false;
    }
    return true;
  }

  // Turn a staircase of grid cells into a few straight legs.
  function smooth(path) {
    var out = [path[0]], i = 0;
    while (i < path.length - 1) {
      var j = path.length - 1;
      while (j > i + 1 && !clearLine(path[i], path[j])) j--;
      out.push(path[j]);
      i = j;
    }
    return out;
  }

  function findPath(from, to) {
    var s = cellOf(from.x, from.y);
    if (!free(s.x, s.y)) {                     // somehow inside a block: start from the edge
      var nf = nearestFree(from.x, from.y, 24);
      if (!nf) return null;
      s = cellOf(nf.x, nf.y);
    }
    var g = cellOf(to.x, to.y);
    if (!free(g.x, g.y)) return null;

    var cells = astar(s, g, 24) || astar(s, g, 1e6);
    if (!cells) return null;
    cells[0] = pt(from.x, from.y);
    cells.push(pt(to.x, to.y));
    return smooth(cells);
  }


  /* ---------- Following a route ---------- */

  var nav = { path: null, i: 0, goal: null, plannedAt: 0, dirty: false };

  function planTo(target, now) {
    var goal = freeAt(target.x, target.y) ? target : nearestFree(target.x, target.y, 12);
    if (!goal) return false;
    var path = findPath(cat, goal);
    if (!path) return false;
    nav.path = path;
    nav.i = 1;
    nav.goal = goal;
    nav.plannedAt = now;
    nav.dirty = false;
    cat.stuckFor = 0;
    return true;
  }

  function steer(tx, ty, maxSpeed, brake, dt) {
    var dx = tx - cat.x, dy = ty - cat.y;
    var d = Math.hypot(dx, dy);
    var s = d > 1 ? maxSpeed * (brake ? Math.min(1, d / 40) : 1) : 0;
    cat.vx = ease(cat.vx, d > 1 ? dx / d * s : 0, 9, dt);
    cat.vy = ease(cat.vy, d > 1 ? dy / d * s : 0, 9, dt);
  }

  // Returns true once the cat has reached the end of its route.
  function follow(speed, dt) {
    if (!nav.path) return true;
    var last = nav.path.length - 1;
    var wp = nav.path[Math.min(nav.i, last)];
    if (nav.i < last && dist(cat, wp) < 10) {
      nav.i++;
      wp = nav.path[nav.i];
    }
    var final = nav.i >= last;
    steer(wp.x, wp.y, speed, final, dt);
    return final && dist(cat, wp) < 6;
  }

  function stopMoving(dt) {
    cat.vx = ease(cat.vx, 0, 10, dt);
    cat.vy = ease(cat.vy, 0, 10, dt);
  }


  /* ---------- States ---------- */

  function enter(state, now) {
    cat.state = state;

    if (state === "idle") cat.until = now + rand(2500, 6500);
    if (state === "sleep") cat.until = now + rand(30000, 60000);

    if (state === "walk") {
      var target;
      if (cat.sleepAfter) {
        target = sleepSpot();
      } else if (atHome() && homeVisible() && Math.random() < 0.3) {
        // An occasional stroll somewhere on the visible screen.
        var top = window.scrollY;
        target = randomFree(minX(), maxX(), top + HEADER + FOOT_H, top + H - 8);
      } else {
        // Pottering about at home, or heading back to it.
        target = randomFree(home.x0, home.x1, home.y0, home.y1);
      }
      if (!target || !planTo(target, now)) {
        cat.sleepAfter = false;
        cat.state = "idle";
        cat.until = now + 1500;               // try again shortly
      }
    }
  }

  function engage(now) {
    if (!cat.engaged) {
      cat.engaged = true;
      cat.attnStart = now;
    }
    cat.sleepAfter = false;
  }

  // After a short groom, idle -> walk heads home (see enter("walk")).
  function getBored(now) {
    cat.engaged = false;
    cat.cooldown = now + rand(9000, 16000);
    cat.groomUntil = now + 2200;       // a little dignified grooming
    enter("idle", now);
    cat.until = now + 2400;
  }

  // Where the cat sits to play: beside and a bit below the cursor,
  // deliberately just out of paw's reach, and never inside a block.
  function approachPoint() {
    var off = 78 * S, dy = 44 * S;
    var side = cat.x <= mouse.x ? -1 : 1;
    var options = [
      pt(mouse.x + side * off, mouse.y + dy),
      pt(mouse.x - side * off, mouse.y + dy)
    ];
    for (var i = 0; i < options.length; i++) {
      var o = options[i];
      o.x = clamp(o.x, minX(), maxX());
      o.y = clamp(o.y, minY(), maxY());
      if (freeAt(o.x, o.y)) return o;
    }
    return nearestFree(options[0].x, options[0].y, 12);
  }

  function faceMouse() {
    var dx = mouse.x - cat.x;
    if (Math.abs(dx) > 14) cat.facing = dx > 0 ? 1 : -1;
  }

  // Screen point -> the cat's own coordinates (facing right, ground at y=0).
  function toLocal(px, py) {
    return pt((px - cat.x) / S * cat.facing, (py - cat.y) / S);
  }

  // Is the cursor on the cat? Rough box around body, head and ears.
  function onCat(px, py) {
    var l = toLocal(px, py);
    return l.x > -34 && l.x < 34 && l.y > -66 && l.y < 4;
  }

  function spawn(kind) {
    var h = cat.headLocal;
    particles.push({
      kind: kind,
      x: cat.x + h.x * S * cat.facing + rand(-4, 4),
      y: cat.y + (h.y - 18) * S,
      drift: kind === "z" ? 8 * cat.facing : rand(-6, 6),
      life: 1,
      size: kind === "z" ? rand(0, 4) : rand(4, 6)
    });
  }


  /* ---------- Behaviour ---------- */

  function update(dt, now) {
    var p = cat.pose;
    var sec = now / 1000;

    mouse.x = mouse.cx + window.scrollX;
    mouse.y = mouse.cy + window.scrollY;

    var recent = mouse.inside && now - mouse.lastMove < 1500;
    var catching = mouse.inside && onCat(mouse.x, mouse.y);

    var hx = cat.x + cat.headLocal.x * S * cat.facing;
    var hy = cat.y + cat.headLocal.y * S;
    var mouseDist = Math.hypot(mouse.x - hx, mouse.y - hy);

    var interested = recent && now > cat.cooldown && mouseDist < NOTICE_RANGE;

    // Targets for this frame; each state overrides what it needs.
    var moving = false, arrived = false;
    var sit = 1, lie = 0, paw = 0, both = 0, groom = 0, happy = 0, sleepy = 0;
    var watching = false, tailSpeed = 1, tongue = 0;

    if (catching && cat.state !== "catch") {
      engage(now);
      enter("catch", now);
    }

    switch (cat.state) {

      case "idle":
        stopMoving(dt);
        watching = mouse.inside && mouseDist < NOTICE_RANGE * 1.3;
        if (watching) faceMouse();

        if (now < cat.groomUntil) {
          groom = 1;
          tongue = Math.max(0, Math.sin(sec * 8)) * 0.8;
          sleepy = 0.6;
        } else if (now > cat.nextGroom) {
          cat.groomUntil = now + 2000;
          cat.nextGroom = now + rand(15000, 30000);
        }

        if (interested) {
          engage(now);
          enter("chase", now);
        } else if (now > cat.until) {
          // Nobody has moved the mouse for a while: back to the pad to charge.
          if (now - mouse.lastMove > 25000 && Math.random() < 0.6) cat.sleepAfter = true;
          enter("walk", now);
        }
        break;

      case "walk":
        moving = true; sit = 0;
        if (nav.dirty) enter("walk", now);       // the map changed under us
        arrived = follow(WALK_SPEED, dt);
        if (arrived) {
          if (cat.sleepAfter) { cat.sleepAfter = false; enter("sleep", now); }
          else enter("idle", now);
        } else if (interested) {
          engage(now);
          enter("chase", now);
        }
        break;

      case "chase":
        moving = true; sit = 0; watching = true; tailSpeed = 2.5;
        var a = approachPoint();
        if (!a) { getBored(now); break; }
        if (!nav.goal || nav.dirty || (now - nav.plannedAt > 300 && dist(a, nav.goal) > 24)) {
          if (!planTo(a, now)) {
            if (mouseDist < 200) enter("reach", now); else getBored(now);
            break;
          }
        }
        if (follow(CHASE_SPEED, dt)) enter("reach", now);
        if (!mouse.inside || now - cat.attnStart > ATTENTION) getBored(now);
        break;

      case "reach":
        stopMoving(dt);
        watching = true; tailSpeed = 2;
        faceMouse();

        // Bat at the cursor every second or so.
        if (now > cat.nextSwipe) {
          cat.swipeAt = now;
          cat.nextSwipe = now + rand(900, 1800);
        }
        var st = (now - cat.swipeAt) / 450;
        paw = st < 1 ? Math.sin(st * Math.PI) : 0;

        var ap = approachPoint();
        if (recent && ap && dist(ap, cat) > 60) {
          nav.goal = null;
          enter("chase", now);
        }
        if (!mouse.inside || now - cat.attnStart > ATTENTION + 4000 ||
            now - mouse.lastMove > 5000) {
          getBored(now);
        }
        break;

      case "catch":
        stopMoving(dt);
        watching = true; both = 1; happy = 1; tailSpeed = 3;
        faceMouse();
        tongue = Math.max(0, Math.sin(sec * 11));
        if (now > cat.nextHeart) {
          spawn("heart");
          cat.nextHeart = now + 550;
        }
        if (!catching) {
          cat.attnStart = now;            // a fresh burst of interest
          enter("reach", now);
        }
        break;

      case "sleep":
        stopMoving(dt);
        sit = 0; lie = 1; sleepy = 1; tailSpeed = 0.3;
        if (now > cat.nextZ) {
          spawn("z");
          cat.nextZ = now + 1400;
        }
        if ((recent && mouseDist < 260) || now > cat.until) {
          cat.cooldown = now + 3000;       // wakes up groggy
          enter("idle", now);
        }
        break;
    }

    // Movement. Don't slide while still sitting or lying down.
    if (moving) {
      var getUp = clamp(1 - p.sit * 1.3, 0, 1) * (1 - p.lie);
      cat.vx *= getUp;
      cat.vy *= getUp;
    }

    // Never step into a block: try the full move, then slide along
    // one axis. If already inside one (layout shifted), let it out.
    var nx = cat.x + cat.vx * dt, ny = cat.y + cat.vy * dt;
    if (freeAt(nx, ny) || !freeAt(cat.x, cat.y)) {
      cat.x = nx; cat.y = ny;
    } else if (freeAt(nx, cat.y)) {
      cat.x = nx; cat.vy = 0;
    } else if (freeAt(cat.x, ny)) {
      cat.y = ny; cat.vx = 0;
    } else {
      cat.vx = 0; cat.vy = 0;
    }
    cat.x = clamp(cat.x, minX(), maxX());
    cat.y = clamp(cat.y, minY(), Math.max(minY(), maxY()));

    var v = Math.hypot(cat.vx, cat.vy);

    // Wedged somewhere for a second? Plan a fresh route.
    if (moving && !arrived && v < 4) {
      cat.stuckFor += dt;
      if (cat.stuckFor > 1) {
        cat.stuckFor = 0;
        if (cat.state === "walk") enter("walk", now);
        else nav.goal = null;
      }
    } else {
      cat.stuckFor = 0;
    }

    if (moving && Math.abs(cat.vx) > 5) cat.facing = cat.vx > 0 ? 1 : -1;
    cat.phase += v * dt / (6 * S);
    cat.tailPhase += dt * tailSpeed * 2.2;

    // Where is the cursor, from the cat's point of view?
    var ml = toLocal(mouse.x, mouse.y);
    var h = cat.headLocal;
    var lx = ml.x - h.x, ly = ml.y - h.y;
    var ll = Math.hypot(lx, ly) || 1;

    var shoulder = pt(3, -35);
    cat.pawAngle = clamp(Math.atan2(ml.y - shoulder.y, ml.x - shoulder.x), -2.6, -0.2);
    var sd = Math.hypot(ml.x - shoulder.x, ml.y - shoulder.y) || 1;
    var reach = Math.min(22, sd);
    cat.hold = add(shoulder, (ml.x - shoulder.x) / sd * reach, (ml.y - shoulder.y) / sd * reach);

    // Blinking.
    if (now > cat.nextBlink) {
      cat.blinkAt = now;
      cat.nextBlink = now + rand(2500, 6500);
    }
    var bt = (now - cat.blinkAt) / 160;
    var blink = bt < 1 ? Math.sin(bt * Math.PI) : 0;

    // Ease the pose toward this frame's targets.
    p.sit = ease(p.sit, moving && v > 4 ? 0 : sit, 5, dt);
    p.lie = ease(p.lie, lie, 3, dt);
    p.walk = ease(p.walk, clamp(v / 30, 0, 1), 8, dt);
    p.paw = ease(p.paw, paw, 16, dt);
    p.both = ease(p.both, both, 8, dt);
    p.groom = ease(p.groom, groom, 6, dt);
    p.happy = ease(p.happy, happy, 6, dt);
    p.tongue = ease(p.tongue, tongue, 20, dt);
    p.closed = Math.max(blink, sleepy);
    p.lx = ease(p.lx, watching ? lx / ll : 0.6, 6, dt);
    p.ly = ease(p.ly, watching ? ly / ll : 0.1, 6, dt);
    p.tilt = ease(p.tilt, watching ? clamp(ly / ll * 0.3, -0.3, 0.3) : 0, 5, dt);

    // Particles float up and fade.
    for (var i = particles.length - 1; i >= 0; i--) {
      var q = particles[i];
      q.y -= 18 * dt;
      q.x += q.drift * dt;
      q.life -= dt / 1.6;
      if (q.life <= 0) particles.splice(i, 1);
    }
  }


  /* ---------- Drawing helpers ---------- */

  function rrect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  // Filled with the page background (so lines behind it are hidden),
  // tinted faintly with the accent, then outlined in neon.
  function solid(lineWidth) {
    ctx.save();
    ctx.shadowBlur = 0;
    ctx.fillStyle = colors.bg;
    ctx.fill();
    ctx.globalAlpha *= 0.08;
    ctx.fillStyle = colors.accent;
    ctx.fill();
    ctx.restore();
    ctx.lineWidth = lineWidth;
    ctx.stroke();
  }

  function dot(x, y, r) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  function line(x0, y0, x1, y1) {
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
  }

  // A round servo joint with a bolt in the middle.
  function joint(x, y, r) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    solid(1.4);
    dot(x, y, r * 0.35);
  }

  // Two straight segments with a knee joint and a flat foot pad.
  function leg(L, knee, alpha) {
    ctx.globalAlpha = alpha;
    var m = mix(L.top, L.foot, 0.5);
    var k = pt(m.x + knee, m.y);
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    ctx.moveTo(L.top.x, L.top.y);
    ctx.lineTo(k.x, k.y);
    ctx.lineTo(L.foot.x, L.foot.y);
    ctx.stroke();
    joint(k.x, k.y, 1.9);
    rrect(L.foot.x - 2, L.foot.y - 2.2, 6, 2.6, 1.2);
    solid(1.3);
    ctx.globalAlpha = 1;
  }

  function heart(x, y, s) {
    ctx.beginPath();
    ctx.moveTo(x, y + s);
    ctx.bezierCurveTo(x - s * 1.2, y + s * 0.2, x - s * 0.8, y - s * 0.9, x, y - s * 0.2);
    ctx.bezierCurveTo(x + s * 0.8, y - s * 0.9, x + s * 1.2, y + s * 0.2, x, y + s);
    ctx.stroke();
  }

  function neon() {
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = colors.accent;
    ctx.fillStyle = colors.accent;
    ctx.shadowColor = colors.accent;
    ctx.shadowBlur = 6;
  }


  /* ---------- The bed: a woven basket with a charging tower ----------
     Drawn in two halves so the cat can sit INSIDE it:
     back half (tower, rim opening, cushion) -> cat -> front half (bowl). */

  var RIM_Y = -22, RIM_RX = 40, RIM_RY = 8;     // basket rim, local coords

  function drawBedBack(now, charging) {
    var sec = now / 1000;
    ctx.save();
    ctx.translate(dock.x, dock.y);
    ctx.scale(S, S);
    neon();

    // Charging tower, standing just behind the right side of the basket.
    rrect(38, -62, 12, 62, 3);
    solid(1.8);

    // Three charge bars that fill one by one while the cat charges.
    var filled = charging ? Math.floor(sec * 1.5) % 4 : 3;
    for (var i = 0; i < 3; i++) {
      ctx.globalAlpha = i < filled ? 0.9 : 0.25;
      ctx.fillRect(41, -22 - i * 7, 6, 4);
    }
    ctx.globalAlpha = 1;

    // Round cap with a lightning bolt.
    ctx.beginPath();
    ctx.arc(44, -68, 8, 0, Math.PI * 2);
    solid(1.8);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(45.5, -73);
    ctx.lineTo(42, -67.5);
    ctx.lineTo(45.5, -67.5);
    ctx.lineTo(42.5, -62.5);
    ctx.stroke();

    // Arm curving over the bed, ending in a small charging emitter.
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(37, -71);
    ctx.quadraticCurveTo(22, -84, 8, -60);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(7, -57, 4, Math.PI, 0);
    ctx.closePath();
    solid(1.4);

    // Soft beam down onto the cushion while charging.
    if (charging) {
      ctx.save();
      ctx.shadowBlur = 0;
      ctx.globalAlpha = 0.07 + 0.05 * Math.sin(sec * 3);
      ctx.beginPath();
      ctx.moveTo(3, -56);
      ctx.lineTo(11, -56);
      ctx.lineTo(28, RIM_Y);
      ctx.lineTo(-14, RIM_Y);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    // Rim opening and the cushion inside it.
    ctx.beginPath();
    ctx.ellipse(0, RIM_Y, RIM_RX, RIM_RY, 0, 0, Math.PI * 2);
    solid(2);
    // A puffy two-lobed cushion peeking over the rim.
    ctx.beginPath();
    ctx.moveTo(-31, RIM_Y + 2);
    ctx.quadraticCurveTo(-17, RIM_Y - 8, 0, RIM_Y - 3);
    ctx.quadraticCurveTo(17, RIM_Y - 8, 31, RIM_Y + 2);
    ctx.closePath();
    ctx.save();
    ctx.globalAlpha = 0.7;
    solid(1.3);
    ctx.restore();

    ctx.restore();
  }

  function drawBedFront() {
    ctx.save();
    ctx.translate(dock.x, dock.y);
    ctx.scale(S, S);
    neon();

    // The bowl: front half of the rim, down and round the bottom.
    function bowl() {
      ctx.beginPath();
      ctx.ellipse(0, RIM_Y, RIM_RX, RIM_RY, 0, 0, Math.PI);
      ctx.bezierCurveTo(-RIM_RX + 1, -4, -24, 0, -14, 0);
      ctx.lineTo(14, 0);
      ctx.bezierCurveTo(24, 0, RIM_RX - 1, -4, RIM_RX, RIM_Y);
      ctx.closePath();
    }
    bowl();
    solid(2);

    // Basket weave: curved rows, with short ribs offset row by row.
    ctx.save();
    bowl();
    ctx.clip();
    ctx.lineWidth = 1;
    var rows = [-14, -8, -2];
    ctx.globalAlpha = 0.45;
    rows.forEach(function (y) {
      ctx.beginPath();
      ctx.moveTo(-44, y - 2);
      ctx.quadraticCurveTo(0, y + 5, 44, y - 2);
      ctx.stroke();
    });
    ctx.globalAlpha = 0.35;
    for (var r = 0; r < rows.length; r++) {
      var top = r === 0 ? RIM_Y + 6 : rows[r - 1] + 1.5;
      for (var x = -36 + (r % 2) * 5; x <= 36; x += 10) {
        line(x, top + 1, x, rows[r] + 1);
      }
    }
    ctx.restore();

    // Thick braided rim along the front edge.
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.ellipse(0, RIM_Y, RIM_RX, RIM_RY, 0, 0.02, Math.PI - 0.02);
    ctx.stroke();
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.5;
    for (var a = 0.12; a < Math.PI - 0.1; a += 0.2) {
      var bx = Math.cos(a) * RIM_RX, by = RIM_Y + Math.sin(a) * RIM_RY;
      line(bx - 1.5, by - 2, bx + 1.5, by + 2);
    }
    ctx.globalAlpha = 1;

    ctx.restore();
  }


  /* ---------- The robot cat ---------- */

  function drawCat(now) {
    var p = cat.pose;
    var sec = now / 1000;

    ctx.save();
    ctx.translate(cat.x, cat.y);
    ctx.scale(cat.facing * S, S);
    neon();

    // Skeleton: blend standing -> sitting -> lying down.
    var bob = Math.sin(cat.phase * 2) * 1.2 * p.walk;
    var hip = mix(mix(pt(-20, -21), pt(-12, -11), p.sit), pt(-18, -8), p.lie);
    var sh = mix(mix(pt(12, -23), pt(3, -35), p.sit), pt(12, -9), p.lie);
    hip.y += bob;
    sh.y += bob * 0.6;

    var head = mix(mix(add(sh, 11, -11), add(sh, 7, -14), p.sit), add(sh, 13, -1), p.lie);
    head.x += p.both * p.tongue * 1.5;          // leans in for each lick
    cat.headLocal = head;

    var axis = Math.atan2(sh.y - hip.y, sh.x - hip.x);
    var len = Math.hypot(sh.x - hip.x, sh.y - hip.y);
    var mid = mix(hip, sh, 0.5);
    var bw = len + 14;
    var bh = lerp(18, 19, p.sit);
    var rear = pt(mid.x - Math.cos(axis) * (bw / 2 - 3), mid.y - Math.sin(axis) * (bw / 2 - 3));

    // Legs. While walking, pairs swing in opposite phase.
    var swing = 7 * p.walk * (1 - p.sit);
    var lift = 3 * p.walk * (1 - p.sit);
    function foot(x, ph) {
      return pt(x + Math.sin(ph) * swing, -Math.max(0, Math.cos(ph)) * lift);
    }
    var ph = cat.phase;
    var legs = {
      frontFar: { top: add(sh, 3, 5), foot: foot(sh.x + 4 + 3 * p.sit, ph + Math.PI) },
      backFar: { top: add(hip, 3 + 2 * p.sit, 5), foot: foot(hip.x + 1 + 15 * p.sit, ph) },
      backNear: { top: add(hip, 5 * p.sit, 6), foot: foot(hip.x - 2 + 15 * p.sit, ph + Math.PI) },
      frontNear: { top: add(sh, 0, 6), foot: foot(sh.x + 1 + 2 * p.sit, ph) }
    };

    // Lying down: tuck the legs under.
    for (var k in legs) {
      legs[k].foot = mix(legs[k].foot, add(legs[k].top, 5, 2), p.lie);
    }

    // Paw actions override the near front leg (and the far one when holding).
    if (p.paw > 0.01) {
      var r = pt(sh.x + Math.cos(cat.pawAngle) * 24, sh.y + Math.sin(cat.pawAngle) * 24);
      legs.frontNear.foot = mix(legs.frontNear.foot, r, p.paw);
    }
    if (p.groom > 0.01) {
      legs.frontNear.foot = mix(legs.frontNear.foot, add(head, 2, 10), p.groom);
    }
    if (p.both > 0.01) {
      legs.frontNear.foot = mix(legs.frontNear.foot, cat.hold, p.both);
      legs.frontFar.foot = mix(legs.frontFar.foot, add(cat.hold, 3, -2), p.both);
    }

    var backKnee = -4 * (1 - p.sit) - 1;
    var frontKnee = 1.5 * (1 - p.sit);

    // Far side first, so the near side draws over it.
    leg(legs.frontFar, frontKnee, 0.5);
    leg(legs.backFar, backKnee, 0.5);

    // Segmented tail: up and swishing when standing,
    // curled round the feet when sitting.
    var sway = Math.sin(cat.tailPhase);
    var curl = Math.max(p.sit, p.lie);
    var c1 = mix(add(rear, -12, -2), pt(rear.x - 12, -1), curl);
    var c2 = mix(add(rear, -17 + sway * 2, -16), pt(rear.x - 4, 2.5), curl);
    var end = mix(add(rear, -11 + sway * 6, -27), pt(rear.x + 16 + sway * 2, -1.5), curl);
    var tail = [];
    for (var i = 0; i <= 6; i++) tail.push(bezier(rear, c1, c2, end, i / 6));

    ctx.globalAlpha = 0.7;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(tail[0].x, tail[0].y);
    for (i = 1; i < tail.length; i++) ctx.lineTo(tail[i].x, tail[i].y);
    ctx.stroke();
    ctx.globalAlpha = 1;
    for (i = 1; i < 6; i++) {
      var sz = 2.8 - i * 0.25;
      rrect(tail[i].x - sz, tail[i].y - sz, sz * 2, sz * 2, 1);
      solid(1.2);
    }
    ctx.globalAlpha = 0.6 + 0.4 * Math.sin(sec * 4);
    dot(tail[6].x, tail[6].y, 2.2);             // glowing tip
    ctx.globalAlpha = 1;

    // Chassis: a rounded box with a seam, vents, bolts and a status strip.
    ctx.save();
    ctx.translate(mid.x, mid.y);
    ctx.rotate(axis);
    rrect(-bw / 2, -bh / 2, bw, bh, 6);
    solid(2);

    ctx.globalAlpha = 0.55;
    ctx.lineWidth = 1;
    var seam = -bw / 2 + bw * 0.38;
    line(seam, -bh / 2 + 2, seam, bh / 2 - 2);
    for (i = 0; i < 3; i++) {
      line(-bw / 2 + 5 + i * 3, -3, -bw / 2 + 5 + i * 3, 3);
    }
    dot(seam + 4, -bh / 2 + 3, 0.9);
    dot(bw / 2 - 5, -bh / 2 + 3, 0.9);
    ctx.globalAlpha = 0.5 + 0.5 * Math.sin(sec * 2.5);
    ctx.lineWidth = 1.6;
    line(bw * 0.05, 2.5, bw * 0.3, 2.5);
    ctx.globalAlpha = 1;
    ctx.restore();

    // Hip servo when sitting.
    if (p.sit > 0.05) {
      ctx.globalAlpha = p.sit;
      joint(hip.x + 2, hip.y + 1, 7.5);
      ctx.globalAlpha = 1;
    }

    leg(legs.backNear, backKnee, 1);
    leg(legs.frontNear, frontKnee, 1);
    joint(sh.x, sh.y + 5, 2.6);

    // Neck joint.
    var neck = mix(sh, head, 0.5);
    joint(neck.x, neck.y, 3.2);

    // Head.
    ctx.save();
    ctx.translate(head.x, head.y);
    ctx.rotate(p.tilt);

    var bobA = Math.sin(sec * 3) * 0.8;
    ctx.lineWidth = 1.4;
    line(3, -9.5, 5 + bobA, -18);
    ctx.globalAlpha = p.closed > 0.9 ? 0.35 : 0.6 + 0.4 * Math.sin(sec * 5);
    dot(5 + bobA, -19.5, 1.8);                  // antenna tip
    ctx.globalAlpha = 1;

    [-1, 1].forEach(function (s) {              // angular ears
      ctx.beginPath();
      ctx.moveTo(s * 11, -5);
      ctx.lineTo(s * 10, -17);
      ctx.lineTo(s * 3.5, -9.5);
      ctx.closePath();
      solid(1.8);
      ctx.globalAlpha = 0.5;
      ctx.lineWidth = 1;
      line(s * 8.6, -8, s * 8.3, -13);
      ctx.globalAlpha = 1;
    });

    rrect(-12, -10, 24, 19, 6);                 // head shell
    solid(2);

    // Visor screen. The face on it shifts toward where the cat looks.
    var fx = p.lx * 2.4, fy = p.ly * 1.6;
    var vx = fx * 0.5, vy = fy * 0.5;
    rrect(-8.5 + vx, -5.5 + vy, 17, 9, 3);
    ctx.save();
    ctx.shadowBlur = 0;
    ctx.fillStyle = colors.bg;
    ctx.fill();
    ctx.restore();
    ctx.globalAlpha = 0.7;
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.globalAlpha = 1;

    [-1, 1].forEach(function (s) {
      var ex = s * 3.8 + fx * 0.9, ey = -1 + fy;
      if (p.happy > 0.5) {                      // ^ ^
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(ex - 2, ey + 1);
        ctx.lineTo(ex, ey - 1.2);
        ctx.lineTo(ex + 2, ey + 1);
        ctx.stroke();
      } else if (p.closed > 0.8) {              // - -
        ctx.lineWidth = 1.4;
        line(ex - 2, ey, ex + 2, ey);
      } else {                                  // pixel eyes
        var eh = 4.4 * (1 - p.closed * 0.85);
        rrect(ex - 1.2, ey - eh / 2, 2.4, eh, 1);
        ctx.fill();
      }
    });

    dot(-10, 5, 0.9);                           // cheek bolts
    dot(10, 5, 0.9);

    var mx = vx;
    if (p.tongue > 0.02) {
      ctx.save();
      ctx.fillStyle = TONGUE;
      ctx.shadowColor = TONGUE;
      ctx.beginPath();
      ctx.ellipse(mx, 7.2 + 2 * p.tongue, 1.8, 1.2 + 2.4 * p.tongue, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    ctx.lineWidth = 1;                          // mouth
    ctx.beginPath();
    ctx.arc(mx - 1.1, 5.8, 1.1, 0, Math.PI);
    ctx.moveTo(mx + 2.2, 5.8);
    ctx.arc(mx + 1.1, 5.8, 1.1, 0, Math.PI);
    ctx.stroke();

    ctx.globalAlpha = 0.5;                      // wire whiskers
    ctx.lineWidth = 0.8;
    [-1, 1].forEach(function (s) {
      line(s * 12, 3, s * 18, 1.5);
      line(s * 12, 4.5, s * 18, 6);
    });
    ctx.globalAlpha = 1;

    // Charging: a battery that fills up over the head.
    if (p.lie > 0.5) {
      ctx.globalAlpha = (p.lie - 0.5) * 2;
      ctx.lineWidth = 1.2;
      rrect(-6, -31, 12, 6, 1.2);
      ctx.stroke();
      dot(7, -28, 1);
      var level = (sec * 0.35) % 1;
      ctx.fillRect(-4.5, -29.5, 9 * level, 3);
      ctx.globalAlpha = 1;
    }

    ctx.restore();   // head
    ctx.restore();   // cat
  }

  // Hearts and Zs, in page coordinates like the cat.
  function drawParticles() {
    if (!particles.length) return;
    ctx.save();
    neon();
    ctx.lineWidth = 1.5;
    particles.forEach(function (q) {
      ctx.globalAlpha = Math.max(0, q.life);
      if (q.kind === "heart") {
        heart(q.x, q.y, q.size);
      } else {
        ctx.font = "600 " + Math.round(10 + q.size) + "px 'JetBrains Mono', monospace";
        ctx.fillText("z", q.x, q.y);
      }
    });
    ctx.restore();
  }

  function draw(now) {
    var sx = window.scrollX, sy = window.scrollY;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.translate(-sx, -sy);                    // draw in page coordinates

    var catOnScreen = cat.y - sy > -20 && cat.y - sy < H + 100 * S;
    var bedOnScreen = dock.y - sy > -20 && dock.y - sy < H + 95 * S;
    var charging = cat.state === "sleep";

    // Paint back to front: in the basket, behind it, or in front of it.
    if (inBed()) {
      if (bedOnScreen) drawBedBack(now, charging);
      if (catOnScreen) drawCat(now);
      if (bedOnScreen) drawBedFront();
    } else if (cat.y < dock.y + 1) {
      if (catOnScreen) drawCat(now);
      if (bedOnScreen) { drawBedBack(now, charging); drawBedFront(); }
    } else {
      if (bedOnScreen) { drawBedBack(now, charging); drawBedFront(); }
      if (catOnScreen) drawCat(now);
    }

    drawParticles();
  }


  /* ---------- Measuring the page ---------- */

  function measure() {
    docH = document.documentElement.scrollHeight;
    computeHome();
    buildGrid();
  }

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.width = W + "px";
    canvas.style.height = H + "px";

    measure();

    if (!cat.placed) {                          // start beside the pod, sitting
      var start = pt(dock.x - 70 * S, dock.y + 12 * S);
      if (!freeAt(start.x, start.y)) start = nearestFree(start.x, start.y, 20) || start;
      cat.x = start.x;
      cat.y = start.y;
      cat.placed = true;
    }
  }


  /* ---------- Main loop, and when to run at all ---------- */

  var running = false, rafId = 0, last = 0, lastMeasure = 0;

  function frame(now) {
    var dt = Math.min(0.05, (now - last) / 1000);    // cap after tab switches
    last = now;

    // Fonts loading, reveal animations and resizes all move things
    // around, so re-measure home and obstacles every couple of seconds.
    if (now - lastMeasure > 2000) {
      measure();
      lastMeasure = now;
    }

    update(dt, now);
    draw(now);
    rafId = requestAnimationFrame(frame);
  }

  function start() {
    if (running) return;
    running = true;
    canvas.style.display = "";
    resize();
    last = lastMeasure = performance.now();
    if (mouse.lastMove < 0) mouse.lastMove = last;   // start awake, not asleep
    rafId = requestAnimationFrame(frame);
  }

  function stop() {
    running = false;
    cancelAnimationFrame(rafId);
    canvas.style.display = "none";
  }

  function check() {
    if (finePointer.matches && wideEnough.matches && !reduceMotion.matches) start();
    else stop();
  }

  [reduceMotion, finePointer, wideEnough].forEach(function (mq) {
    if (mq.addEventListener) mq.addEventListener("change", check);
    else if (mq.addListener) mq.addListener(check);     // older Safari
  });

  window.addEventListener("resize", function () { if (running) resize(); });

  check();

})();
