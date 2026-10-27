/* Decorative canvas-only Earth/satellite ambience; no geographic feed is connected. */
(() => {
  const hero = document.getElementById('hero-earth-canvas');
  const dashboard = document.getElementById('dashboard-data-canvas');
  if (!hero || !dashboard) return;
  const heroSection = hero.closest('.hero');
  const dashboardSection = dashboard.closest('.dashboard');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const pageHidden = () => document.hidden;
  const active = new Map([[hero, true], [dashboard, false]]);
  const contexts = new Map();
  const sizes = new Map();
  let frame = 0;
  let lastDraw = 0;
  let animationTime = 0;
  let frameInterval = 1000 / (window.innerWidth < 700 ? 24 : 30);
  const continents = [
    [[-168,70],[-150,60],[-135,57],[-128,49],[-124,42],[-117,32],[-108,29],[-104,24],[-96,19],[-88,21],[-83,25],[-81,31],[-75,36],[-69,44],[-61,48],[-66,55],[-80,58],[-96,64],[-112,68],[-130,70],[-146,72]],
    [[-81,12],[-73,9],[-66,7],[-60,-2],[-54,-10],[-49,-19],[-53,-29],[-58,-37],[-65,-50],[-71,-55],[-75,-42],[-78,-27],[-80,-12]],
    [[-11,36],[-5,43],[2,48],[9,54],[18,59],[29,60],[38,55],[45,48],[37,42],[32,35],[25,32],[19,25],[12,20],[8,10],[2,5],[-5,7],[-9,16],[-14,23],[-17,30]],
    [[31,71],[47,67],[61,69],[78,63],[93,70],[112,66],[130,59],[145,53],[154,47],[145,39],[137,35],[130,31],[121,24],[111,20],[106,10],[99,7],[93,16],[84,20],[78,8],[72,8],[68,23],[59,25],[53,33],[45,37],[39,45],[30,48],[24,55]],
    [[-18,35],[-5,37],[9,34],[22,30],[32,20],[40,8],[42,-4],[35,-15],[29,-28],[19,-35],[10,-34],[5,-25],[-1,-15],[-8,-1],[-14,12]],
    [[112,-11],[129,-10],[141,-16],[151,-25],[147,-38],[136,-42],[122,-35],[115,-24]],
    [[-24,64],[-17,66],[-13,63],[-19,59],[-24,60]],
    [[46,-13],[50,-16],[49,-23],[45,-25],[43,-19]],
    [[130,33],[135,35],[140,39],[143,43],[140,45],[136,41]],
    [[95,5],[105,4],[116,-3],[124,-5],[132,-7],[128,-9],[118,-7],[109,-2],[101,1]]
  ];
  const geoPoints = [[-100,40],[-75,20],[-60,-15],[-3,52],[17,5],[31,30],[77,22],[105,15],[135,-25],[10,45]];
  const links = [[0,1],[1,2],[0,3],[3,4],[3,5],[5,6],[6,7],[7,8],[4,9],[2,4],[5,9]];
  const particles = Array.from({length:22}, (_, i) => ({
    x: ((i * 67 + 23) % 997) / 997,
    y: ((i * 139 + 31) % 991) / 991,
    speed: .002 + (i % 4) * .0008,
    phase: i * 1.71
  }));

  for (const canvas of [hero, dashboard]) {
    const context = canvas.getContext('2d', { alpha: true, desynchronized: true });
    if (context) contexts.set(canvas, context);
  }
  if (!contexts.size) return;

  function resize(canvas) {
    const context = contexts.get(canvas);
    if (!context) return;
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(1, rect.width), height = Math.max(1, rect.height);
    const pixelRatio = Math.min(window.devicePixelRatio || 1, window.innerWidth < 700 ? 1.15 : 1.4);
    const pixelWidth = Math.round(width * pixelRatio), pixelHeight = Math.round(height * pixelRatio);
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth; canvas.height = pixelHeight;
    }
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    sizes.set(canvas, { width, height });
  }

  function project(lon, lat, rotation, cx, cy, radius) {
    const phi = lat * Math.PI / 180;
    const lambda = (lon + rotation) * Math.PI / 180;
    const cosPhi = Math.cos(phi);
    return {
      x: cx + radius * cosPhi * Math.sin(lambda),
      y: cy - radius * Math.sin(phi),
      z: cosPhi * Math.cos(lambda)
    };
  }

  function strokeVisibleCurve(ctx, points, color, width) {
    ctx.beginPath();
    let drawing = false;
    for (const point of points) {
      if (point.z > 0.015) {
        if (!drawing) { ctx.moveTo(point.x, point.y); drawing = true; }
        else ctx.lineTo(point.x, point.y);
      } else drawing = false;
    }
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.stroke();
  }

  function drawGlobe(time) {
    const ctx = contexts.get(hero), size = sizes.get(hero);
    if (!ctx || !size) return;
    const { width: w, height: h } = size;
    ctx.clearRect(0, 0, w, h);
    const mobile = w < 700;
    const radius = mobile ? Math.min(h * .265, w * .34, 164) : Math.min(h * .32, w * .22, 284);
    const cx = w * (mobile ? .78 : .79);
    const cy = h * (mobile ? .52 : .52);
    const rotation = time * .045;

    const glow = ctx.createRadialGradient(cx, cy, radius * .7, cx, cy, radius * 1.55);
    glow.addColorStop(0, 'rgba(86,202,139,.16)'); glow.addColorStop(.55, 'rgba(53,168,111,.08)'); glow.addColorStop(1, 'rgba(35,122,87,0)');
    ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(cx, cy, radius * 1.55, 0, Math.PI * 2); ctx.fill();

    ctx.save();
    ctx.shadowColor = 'rgba(85,222,151,.48)'; ctx.shadowBlur = radius * .13;
    ctx.beginPath(); ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    const ocean = ctx.createRadialGradient(cx - radius * .38, cy - radius * .42, radius * .08, cx + radius * .18, cy + radius * .12, radius * 1.25);
    ocean.addColorStop(0, '#357b62'); ocean.addColorStop(.42, '#164f40'); ocean.addColorStop(.78, '#0d352d'); ocean.addColorStop(1, '#071f1d');
    ctx.fillStyle = ocean; ctx.fill(); ctx.shadowBlur = 0;
    ctx.clip();

    const rotationDegrees = rotation * 180 / Math.PI;
    const gridColor = 'rgba(162,227,192,.12)';
    for (const lat of [-60,-30,0,30,60]) {
      const points = [];
      for (let i = 0; i <= 96; i++) points.push(project(-180 + i * 360 / 96, lat, rotationDegrees, cx, cy, radius));
      strokeVisibleCurve(ctx, points, gridColor, .7);
    }
    for (let lon = -150; lon < 180; lon += 30) {
      const points = [];
      for (let i = 0; i <= 72; i++) points.push(project(lon, -89 + i * 178 / 72, rotationDegrees, cx, cy, radius));
      strokeVisibleCurve(ctx, points, gridColor, .65);
    }

    for (const shape of continents) {
      const centerLon = shape.reduce((sum, p) => sum + p[0], 0) / shape.length;
      const centerLat = shape.reduce((sum, p) => sum + p[1], 0) / shape.length;
      if (project(centerLon, centerLat, rotationDegrees, cx, cy, radius).z < -.08) continue;
      const points = shape.map(([lon, lat]) => project(lon, lat, rotationDegrees, cx, cy, radius));
      const previous = points.at(-1);
      ctx.beginPath(); ctx.moveTo((previous.x + points[0].x) / 2, (previous.y + points[0].y) / 2);
      for (let i = 0; i < points.length; i++) {
        const current = points[i], next = points[(i + 1) % points.length];
        ctx.quadraticCurveTo(current.x, current.y, (current.x + next.x) / 2, (current.y + next.y) / 2);
      }
      ctx.closePath();
      const land = ctx.createLinearGradient(cx - radius, cy - radius, cx + radius, cy + radius);
      land.addColorStop(0, '#9abf79'); land.addColorStop(.5, '#5b9b65'); land.addColorStop(1, '#39785b');
      ctx.fillStyle = land; ctx.fill();
      ctx.strokeStyle = 'rgba(190,233,163,.25)'; ctx.lineWidth = .8; ctx.stroke();
      ctx.save(); ctx.globalAlpha = .17; ctx.strokeStyle = '#d4eaa7'; ctx.lineWidth = .5;
      for (let j = 0; j < 3; j++) {
        const offset = (j - 1) * radius * .045;
        ctx.beginPath(); ctx.ellipse(cx + offset, cy, radius * .29, radius * .11 + Math.abs(offset) * .6, .18, 0, Math.PI * 2); ctx.stroke();
      }
      ctx.restore();
    }

    const nodes = geoPoints.map(([lon, lat]) => project(lon, lat, rotationDegrees, cx, cy, radius));
    ctx.lineWidth = .8;
    for (const [a, b] of links) {
      const p = nodes[a], q = nodes[b];
      if (p.z <= 0 || q.z <= 0) continue;
      const mx = (p.x + q.x) / 2, my = (p.y + q.y) / 2;
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.quadraticCurveTo(mx + (cx - mx) * .12, my + (cy - my) * .12, q.x, q.y);
      ctx.strokeStyle = 'rgba(195,240,160,.43)'; ctx.stroke();
    }
    nodes.forEach((point, i) => {
      if (point.z <= 0) return;
      const pulse = .78 + .22 * Math.sin(time * 1.5 + i);
      ctx.beginPath(); ctx.arc(point.x, point.y, (i % 3 === 0 ? 2.5 : 1.6) * pulse, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(220,250,165,.88)'; ctx.shadowColor = '#baff8d'; ctx.shadowBlur = 8; ctx.fill(); ctx.shadowBlur = 0;
    });

    const shade = ctx.createRadialGradient(cx - radius * .38, cy - radius * .42, radius * .05, cx, cy, radius * 1.04);
    shade.addColorStop(0, 'rgba(221,255,226,.17)'); shade.addColorStop(.55, 'rgba(60,140,109,.02)'); shade.addColorStop(1, 'rgba(0,7,11,.72)');
    ctx.fillStyle = shade; ctx.fillRect(cx - radius, cy - radius, radius * 2, radius * 2);
    ctx.restore();

    ctx.beginPath(); ctx.arc(cx, cy, radius, -.9, 1.55);
    ctx.strokeStyle = 'rgba(173,255,204,.58)'; ctx.lineWidth = 1.15; ctx.stroke();
    ctx.beginPath(); ctx.ellipse(cx, cy, radius * 1.2, radius * .37, -.36, Math.PI * 1.02, Math.PI * 1.96);
    ctx.strokeStyle = 'rgba(119,223,167,.28)'; ctx.lineWidth = .8; ctx.stroke();
    const satelliteAngle = time * .11 - .8;
    const sx = cx + Math.cos(satelliteAngle) * radius * 1.2;
    const sy = cy + Math.sin(satelliteAngle) * radius * .37;
    ctx.beginPath(); ctx.arc(sx, sy, 2.1, 0, Math.PI * 2); ctx.fillStyle = '#d5ffad'; ctx.shadowColor = '#b3ff9b'; ctx.shadowBlur = 11; ctx.fill(); ctx.shadowBlur = 0;
  }

  function drawDashboard(time) {
    const ctx = contexts.get(dashboard), size = sizes.get(dashboard);
    if (!ctx || !size) return;
    const { width: w, height: h } = size;
    ctx.clearRect(0, 0, w, h);
    ctx.save();
    const mapX = w * .70, mapY = h * .49;
    const mapGlow = ctx.createRadialGradient(mapX, mapY, 2, mapX, mapY, Math.max(w, h) * .52);
    mapGlow.addColorStop(0, 'rgba(85,151,78,.10)'); mapGlow.addColorStop(1, 'rgba(85,151,78,0)');
    ctx.fillStyle = mapGlow; ctx.fillRect(0, 0, w, h);
    const points = particles.map((p, i) => ({
      x: (p.x * w + time * p.speed * w) % w,
      y: p.y * h + Math.sin(time * .16 + p.phase) * 7,
      phase: p.phase, index: i
    }));
    for (let i = 0; i < points.length; i++) {
      for (let j = i + 1; j < points.length; j++) {
        const a = points[i], b = points[j];
        const dx = a.x - b.x, dy = a.y - b.y, distance = Math.hypot(dx, dy);
        if (distance < Math.min(w, h) * .19) {
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
          ctx.strokeStyle = `rgba(68,132,77,${.09 * (1 - distance / (Math.min(w, h) * .19))})`;
          ctx.lineWidth = .7; ctx.stroke();
        }
      }
    }
    for (const point of points) {
      const pulse = .7 + .3 * Math.sin(time * .8 + point.phase);
      ctx.beginPath(); ctx.arc(point.x, point.y, (point.index % 5 === 0 ? 2.1 : 1.15) * pulse, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(77,143,69,.48)'; ctx.fill();
    }
    const sweepX = ((time * 24) % (w + 120)) - 60;
    const sweep = ctx.createLinearGradient(sweepX - 52, 0, sweepX + 52, 0);
    sweep.addColorStop(0, 'rgba(133,194,84,0)'); sweep.addColorStop(.5, 'rgba(133,194,84,.065)'); sweep.addColorStop(1, 'rgba(133,194,84,0)');
    ctx.fillStyle = sweep; ctx.fillRect(0, 0, w, h);
    ctx.restore();
  }

  function render(time) { drawGlobe(time); drawDashboard(time); }
  function shouldAnimate() { return !pageHidden() && !reducedMotion.matches && [...active.values()].some(Boolean); }
  function tick(now) {
    frame = 0;
    if (!shouldAnimate()) { lastDraw = 0; return; }
    if (now - lastDraw >= frameInterval || !lastDraw) {
      if (lastDraw) animationTime += Math.min((now - lastDraw) / 1000, .12);
      lastDraw = now;
      render(animationTime);
    }
    if (shouldAnimate()) frame = requestAnimationFrame(tick);
  }
  function schedule() {
    if (pageHidden()) { if (frame) cancelAnimationFrame(frame); frame = 0; lastDraw = 0; return; }
    if (frame) return;
    if (shouldAnimate()) frame = requestAnimationFrame(tick);
    else render(animationTime);
  }
  const resizeAll = () => { frameInterval = 1000 / (window.innerWidth < 700 ? 24 : 30); resize(hero); resize(dashboard); schedule(); };
  window.addEventListener('resize', resizeAll, { passive: true });
  if ('ResizeObserver' in window) {
    const observer = new ResizeObserver(resizeAll);
    observer.observe(heroSection); observer.observe(dashboardSection);
  }
  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) active.set(entry.target === heroSection ? hero : dashboard, entry.isIntersecting);
      schedule();
    }, { rootMargin: '100px 0px' });
    observer.observe(heroSection); observer.observe(dashboardSection);
    active.set(hero, true);
  } else { active.set(dashboard, true); }
  document.addEventListener('visibilitychange', schedule);
  reducedMotion.addEventListener?.('change', schedule);
  resizeAll();
})();


