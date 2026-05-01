import * as d3 from 'd3';

/* ============================================================
   Configuration
   ============================================================ */
const NODE_STYLE = {
  habsburg: { r: 3.5, color: '#D4AF37', glow: true },
  consort:  { r: 2.5, color: '#F5F0E6', glow: false },
  relative: { r: 2,   color: '#8FA8C8', glow: false },
};

const EDGE_STYLE = {
  parent: { color: '#4A7FB5', label: 'parent' },
  spouse: { color: '#D4A574', label: 'spouse' },
};

const LABEL_ZOOM_THRESHOLD = 2.5; // labels appear only when zoomed in past this scale

/* ============================================================
   Starfield animation (homepage)
   ============================================================ */
let starCanvas, starCtx, starAnimId, starAnimRunning = true;
const stars = [];

function initStarCanvas() {
  starCanvas = document.getElementById('star-canvas');
  const dpr = window.devicePixelRatio || 1;
  starCanvas.width = window.innerWidth * dpr;
  starCanvas.height = window.innerHeight * dpr;
  starCanvas.style.width = window.innerWidth + 'px';
  starCanvas.style.height = window.innerHeight + 'px';
  starCtx = starCanvas.getContext('2d');
  starCtx.scale(dpr, dpr);

  const count = 200;
  for (let i = 0; i < count; i++) {
    stars.push({
      x: Math.random() * window.innerWidth,
      y: Math.random() * window.innerHeight,
      r: 0.4 + Math.random() * 1.3,
      baseAlpha: 0.15 + Math.random() * 0.5,
      phase: Math.random() * Math.PI * 2,
      speed: 0.3 + Math.random() * 1.2,
    });
  }

  animateStars();
}

function animateStars() {
  if (!starAnimRunning) return;

  starCtx.clearRect(0, 0, window.innerWidth, window.innerHeight);

  const t = performance.now() / 1000;
  for (const s of stars) {
    const alpha = s.baseAlpha * (0.45 + 0.55 * Math.sin(t * s.speed + s.phase));
    starCtx.beginPath();
    starCtx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
    starCtx.fillStyle = `rgba(245,240,230,${alpha.toFixed(3)})`;
    starCtx.fill();
  }

  starAnimId = requestAnimationFrame(animateStars);
}

function stopStarAnimation() {
  starAnimRunning = false;
  if (starAnimId) {
    cancelAnimationFrame(starAnimId);
    starAnimId = null;
  }
}

function resumeStarAnimation() {
  if (starAnimRunning) return;
  starAnimRunning = true;
  animateStars();
}

/* ============================================================
   State
   ============================================================ */
let chartInitialized = false;
let nodes, edges, nodeById, adjIndex;
let descriptions = {};
let hoveredId = null;
let hlNodes = new Set();
let hlEdges = new Set();

let selectedNodeId = null;       // first pick
let pathResult = null;           // { nodeIds: [...], edgeIndices: [...] }

let filterState = { habsburg: true, consort: true, relative: true };
let yearRange = [null, null];    // [min, max] – set after data load

let lang = 'en';                     // 'en' | 'zh'
function displayName(d) {
  if (lang === 'zh') return d.name_zh || d.name;
  return d.name;
}

let sim;
let canvas, ctx, svg, mainG, nodeG, labelG;
let zoom;
let currentTransform = d3.zoomIdentity;
let tooltipDiv;

let w, h;
const dpr = window.devicePixelRatio || 1;
let yearScale;

/* ============================================================
   Characters module state
   ============================================================ */
let importantNodes = [];
let importantDescs = {};
let charactersInitialized = false;
let currentNodeById = null;

/* ============================================================
   Load & prepare data
   ============================================================ */
async function loadData() {
  const [nd, ed, desc] = await Promise.all([
    fetch(import.meta.env.BASE_URL + 'nodes.json').then(r => r.json()),
    fetch(import.meta.env.BASE_URL + 'edges.json').then(r => r.json()),
    fetch(import.meta.env.BASE_URL + 'descriptions.json').then(r => r.json()),
  ]);

  nd.forEach(d => { if (d.born == null) d.born = null; d._jx = (Math.random() - 0.5) * 40; });
  nodes = nd;
  edges = ed;
  descriptions = desc;

  // Id → node lookup
  nodeById = new Map(nodes.map(d => [d.id, d]));

  // Adjacency index: nodeId → edge indices
  adjIndex = new Map();
  edges.forEach((e, i) => {
    if (!adjIndex.has(e.source)) adjIndex.set(e.source, []);
    if (!adjIndex.has(e.target)) adjIndex.set(e.target, []);
    adjIndex.get(e.source).push(i);
    adjIndex.get(e.target).push(i);
  });

  // Y scale: birth year → world y position
  const years = nodes.filter(d => d.born != null).map(d => d.born);
  const [ymin, ymax] = d3.extent(years);
  const padYears = 50;
  yearScale = d3.scaleLinear()
    .domain([ymin - padYears, ymax + padYears])
    .range([80, 1500]);

  // Set year range filter from data extent
  yearRange[0] = ymin;
  yearRange[1] = ymax;

  return { ymin, ymax };
}

/* ============================================================
   DOM setup
   ============================================================ */
function setupDOM() {
  w = window.innerWidth;
  h = window.innerHeight;

  canvas = document.getElementById('edge-canvas');
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  ctx = canvas.getContext('2d');

  svg = d3.select('#node-svg')
    .attr('width', w)
    .attr('height', h);

  const defs = svg.append('defs');
  const glowFilter = defs.append('filter').attr('id', 'glow');
  glowFilter.append('feGaussianBlur').attr('stdDeviation', '1.8').attr('result', 'blur');
  const merge = glowFilter.append('feMerge');
  merge.append('feMergeNode').attr('in', 'blur');
  merge.append('feMergeNode').attr('in', 'SourceGraphic');

  mainG = svg.append('g').attr('class', 'main');

  // Screen-space label layer (outside zoom transform – labels stay constant size)
  labelG = svg.append('g').attr('class', 'labels');

  tooltipDiv = d3.select('#tooltip');
}

/* ============================================================
   Simulation
   ============================================================ */
function runSimulation() {
  sim = d3.forceSimulation(nodes)
    .force('link', d3.forceLink(edges)
      .id(d => d.id)
      .strength(e => e.type === 'parent' ? 0.3 : 0.15)
    )
    .force('y', d3.forceY(d => yearScale(d.born || 1500)).strength(0.25))
    .force('x', d3.forceX(d => {
      if (d.role === 'habsburg') return w * 0.35 + d._jx;
      if (d.role === 'consort')  return w * 0.50 + d._jx;
      return w * 0.65 + d._jx;
    }).strength(0.03))
    .force('collide', d3.forceCollide(d => {
      if (d.role === 'habsburg') return 6.5;
      if (d.role === 'consort')  return 5.5;
      return 5;
    }))
    .alpha(0.5)
    .alphaDecay(0.025)
    .alphaMin(0.001)
    .on('end', render);

  sim.restart();
}

/* ============================================================
   Render (called once when simulation stabilizes)
   ============================================================ */
function render() {
  // ----- compute content bounds for initial fit -----
  const xs = nodes.map(d => d.x);
  const ys = nodes.map(d => d.y);
  const x0 = d3.min(xs), x1 = d3.max(xs);
  const y0 = d3.min(ys), y1 = d3.max(ys);
  const pad = 100;

  const ctrX = (x0 + x1) / 2;
  const ctrY = (y0 + y1) / 2;
  const cw = x1 - x0 + pad * 2;
  const ch = y1 - y0 + pad * 2;

  // ----- century axis -----
  const centuries = [];
  const year0 = yearScale.invert(y0);
  const yearN = yearScale.invert(y1);
  for (let y = Math.ceil(year0 / 100) * 100; y <= yearN; y += 100) {
    centuries.push(y);
  }
  const centuryG = mainG.append('g').attr('class', 'centuries');
  centuries.forEach(year => {
    const wy = yearScale(year);
    centuryG.append('line')
      .attr('x1', x0 - pad)
      .attr('x2', x1 + pad)
      .attr('y1', wy)
      .attr('y2', wy)
      .attr('stroke', 'rgba(255,255,255,0.05)')
      .attr('stroke-dasharray', '4,4');
    centuryG.append('text')
      .attr('x', x0 - pad + 12)
      .attr('y', wy - 6)
      .attr('fill', 'rgba(255,255,255,0.2)')
      .attr('font-size', 11)
      .attr('font-family', 'Georgia, serif')
      .text(`${Math.floor(year / 100)} 世纪`);
  });

  // ----- edges (canvas) -----
  drawEdges(d3.zoomIdentity);

  // ----- nodes (SVG circles) -----
  nodeG = mainG.append('g').attr('class', 'nodes');

  nodeG.selectAll('circle')
    .data(nodes)
    .join('circle')
    .attr('cx', d => d.x)
    .attr('cy', d => d.y)
    .attr('r', d => (NODE_STYLE[d.role] || NODE_STYLE.relative).r)
    .attr('fill', d => (NODE_STYLE[d.role] || NODE_STYLE.relative).color)
    .attr('filter', d => (NODE_STYLE[d.role] || NODE_STYLE.relative).glow ? 'url(#glow)' : null)
    .attr('stroke', 'rgba(255,255,255,0.08)')
    .attr('stroke-width', 0.5)
    .style('cursor', 'pointer')
    .on('mouseenter', onHover)
    .on('mouseleave', offHover)
    .on('click', onNodeClick);

  // ----- screen-space labels (outside zoom, constant visual size) -----
  labelG.selectAll('text')
    .data(nodes)
    .join('text')
    .attr('text-anchor', 'middle')
    .attr('fill', 'rgba(255,255,255,0.6)')
    .attr('font-size', 22)
    .attr('font-family', 'Georgia, serif')
    .attr('pointer-events', 'none')
    .attr('opacity', 0)
    .text(d => displayName(d))
    .each(function (d) { d._labelEl = this; }); // store ref for fast updates

  // ----- background click to clear selection -----
  // Circles call stopPropagation, so clicks here mean empty-space / labels etc.
  svg.on('click', onBackgroundClick);

  // ----- zoom -----
  zoom = d3.zoom()
    .scaleExtent([0.15, 20])
    .on('zoom', event => {
      const t = event.transform;
      currentTransform = t;
      mainG.attr('transform', t);
      drawEdges(t);
      updateLabelPositions(t);
    });

  svg.call(zoom);

  // Initial zoom: fit all content in viewport
  const initScale = Math.min(w / cw, h / ch, 1.5);
  const initT = d3.zoomIdentity
    .translate(w / 2, h / 2)
    .scale(initScale)
    .translate(-ctrX, -ctrY);
  svg.call(zoom.transform, initT);

  // ----- hide loader -----
  d3.select('#loader').classed('hidden', true);
}

/* ---- Screen-space label positioning & visibility ---- */
function updateLabelPositions(t) {
  const showLabels = t.k >= LABEL_ZOOM_THRESHOLD;

  // Build set of node IDs whose labels should be visible
  let visibleSet = new Set(); // empty = nothing shown
  if (showLabels) {
    const hasPath = pathResult != null;
    const hasSelection = selectedNodeId != null;
    if (hasPath) {
      visibleSet = new Set(pathResult.nodeIds);
    } else if (hasSelection) {
      visibleSet = new Set([selectedNodeId]);
    } else if (hoveredId != null) {
      visibleSet = new Set(hlNodes);
    }
  }

  labelG.selectAll('text').each(function (d) {
    // Always update position so labels follow nodes on pan/zoom
    const sx = t.applyX(d.x);
    const sy = t.applyY(d.y);
    const r = (NODE_STYLE[d.role] || NODE_STYLE.relative).r;
    const offsetY = -r * t.k - 6;

    d3.select(this)
      .attr('x', sx)
      .attr('y', sy + offsetY);

    // Opacity: visible only when zoomed in AND this node is in the visible set
    const visible = isNodeVisible(d.id) && visibleSet.has(d.id);
    d3.select(this).attr('opacity', visible ? 1 : 0);
  });
}

/* ============================================================
   Visibility / filter helpers
   ============================================================ */
function isNodeVisible(nodeId) {
  const n = nodeById.get(nodeId);
  if (!n) return false;
  if (!filterState[n.role]) return false;
  if (n.born != null && yearRange[0] != null && n.born < yearRange[0]) return false;
  if (n.born != null && yearRange[1] != null && n.born > yearRange[1]) return false;
  return true;
}

function getVisibleNodeIds() {
  const s = new Set();
  nodes.forEach(n => { if (isNodeVisible(n.id)) s.add(n.id); });
  return s;
}

/* ============================================================
   BFS pathfinding
   ============================================================ */
function findPath(sourceId, targetId) {
  if (sourceId === targetId) return null;

  const visible = getVisibleNodeIds();
  if (!visible.has(sourceId) || !visible.has(targetId)) return null;

  const visited = new Set([sourceId]);
  const queue = [sourceId];
  const parent = new Map(); // nodeId → { parentNodeId, edgeIdx }

  while (queue.length > 0) {
    const current = queue.shift();
    const edgeIndices = adjIndex.get(current) || [];

    for (const idx of edgeIndices) {
      const edge = edges[idx];
      const srcId = typeof edge.source === 'object' ? edge.source.id : edge.source;
      const tgtId = typeof edge.target === 'object' ? edge.target.id : edge.target;
      const neighbor = srcId === current ? tgtId : srcId;

      if (!visible.has(neighbor)) continue;
      if (visited.has(neighbor)) continue;

      visited.add(neighbor);
      parent.set(neighbor, { parentNodeId: current, edgeIdx: idx });

      if (neighbor === targetId) {
        // Reconstruct path (sourceId … targetId)
        const pathNodes = [];
        const pathEdges = [];
        let node = targetId;
        while (node !== sourceId) {
          pathNodes.unshift(node);
          const p = parent.get(node);
          pathEdges.unshift(p.edgeIdx);
          node = p.parentNodeId;
        }
        pathNodes.unshift(sourceId);
        return { nodeIds: pathNodes, edgeIndices: pathEdges };
      }

      queue.push(neighbor);
    }
  }

  return null; // no path
}

/* ============================================================
   Path description (Chinese)
   ============================================================ */
function describePath(nodeIds, edgeIndices) {
  const parts = [];
  for (let i = 0; i < edgeIndices.length; i++) {
    const edge = edges[edgeIndices[i]];
    const a = nodeById.get(nodeIds[i]);
    const b = nodeById.get(nodeIds[i + 1]);
    if (!a || !b) continue;

    if (edge.type === 'spouse') {
      parts.push(`${displayName(a)} 是 ${displayName(b)} 的配偶`);
    } else if (edge.type === 'parent') {
      const aBorn = a.born, bBorn = b.born;
      if (aBorn != null && bBorn != null && aBorn < bBorn) {
        const label = a.sex === 'female' ? '母亲' : a.sex === 'male' ? '父亲' : '父/母';
        parts.push(`${displayName(a)} 是 ${displayName(b)} 的${label}`);
      } else if (aBorn != null && bBorn != null) {
        const label = b.sex === 'female' ? '母亲' : b.sex === 'male' ? '父亲' : '父/母';
        parts.push(`${displayName(b)} 是 ${displayName(a)} 的${label}`);
      } else {
        parts.push(`${displayName(a)} ⟷ ${displayName(b)} (亲子关系)`);
      }
    }
  }
  return parts;
}

/* ============================================================
   Node click interaction
   ============================================================ */
function onNodeClick(event, d) {
  event.stopPropagation();
  if (!isNodeVisible(d.id)) return;

  // Hover tooltip lingers – hide it
  hideTooltip();

  if (selectedNodeId == null) {
    // ---- First selection ----
    selectedNodeId = d.id;
    pathResult = null;
    updateView();
    updatePathPanel();
    openInfoPanel(d);
  } else if (selectedNodeId === d.id) {
    // ---- Click same person → deselect ----
    clearSelection();
  } else {
    // ---- Second selection → BFS path ----
    const src = selectedNodeId;
    const tgt = d.id;
    const result = findPath(src, tgt);

    if (result && result.nodeIds.length > 1) {
      pathResult = result;
      updateView();
      updatePathPanel();
    } else {
      pathResult = null;
      updateView();
      updatePathPanel(src, tgt, true /* noPath */);
    }
    openInfoPanel(d);
  }
}

function onBackgroundClick() {
  if (selectedNodeId != null) {
    clearSelection();
  }
}

function clearSelection() {
  selectedNodeId = null;
  pathResult = null;
  hoveredId = null;
  hlNodes = new Set();
  hlEdges = new Set();
  updateView();
  updatePathPanel();
  closeInfoPanel();
}

/* ============================================================
   View update (node / edge opacities)
   ============================================================ */
function updateView() {
  if (!nodeG) return;
  const hasSelection = selectedNodeId != null;
  const hasPath = pathResult != null;
  const pathNodeSet = hasPath ? new Set(pathResult.nodeIds) : new Set();

  // ---- Node opacities ----
  nodeG.selectAll('circle')
    .attr('opacity', n => {
      if (!isNodeVisible(n.id)) return 0.03;
      if (hasPath) return pathNodeSet.has(n.id) ? 1 : 0.08;
      if (hasSelection) return n.id === selectedNodeId ? 1 : 0.08;
      return 1;
    });

  // ---- Labels ----
  updateLabelPositions(currentTransform);

  // ---- Edges ----
  drawEdges(currentTransform);
}

/* ============================================================
   Canvas edge drawing (multi-mode)
   ============================================================ */
function drawEdges(t) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(t.k * dpr, 0, 0, t.k * dpr, t.x * dpr, t.y * dpr);

  const hasPath = pathResult && pathResult.edgeIndices.length > 0;
  const hasSelection = selectedNodeId != null;
  const isHovering = hlEdges.size > 0 && !hasSelection && !hasPath;

  const pathEdgeSet = hasPath ? new Set(pathResult.edgeIndices) : new Set();

  // Edges connected to the selected node (dim but visible during selection)
  let selConnected = new Set();
  if (hasSelection && !hasPath) {
    (adjIndex.get(selectedNodeId) || []).forEach(idx => selConnected.add(idx));
  }

  ['parent', 'spouse'].forEach(type => {
    const color = EDGE_STYLE[type].color;

    // ---- Pass 1: highlighted edges ----
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = color + 'cc';
    ctx.beginPath();
    let hlCount = 0;
    edges.forEach((e, i) => {
      if (e.type !== type) return;
      const src = e.source, tgt = e.target;
      if (!src || src.x == null || !tgt || tgt.x == null) return;

      const isHL = hasPath ? pathEdgeSet.has(i)
        : isHovering ? hlEdges.has(i)
        : hasSelection ? selConnected.has(i)
        : false;
      if (!isHL) return;
      ctx.moveTo(src.x, src.y);
      ctx.lineTo(tgt.x, tgt.y);
      hlCount++;
    });
    if (hlCount) ctx.stroke();

    // ---- Pass 2: dimmed background edges ----
    const dim = hasPath || hasSelection || isHovering;
    ctx.lineWidth = dim ? 0.3 : 0.5;
    ctx.strokeStyle = dim ? (color + '08') : (color + '55');
    ctx.beginPath();
    let dimCount = 0;
    edges.forEach((e, i) => {
      if (e.type !== type) return;
      const src = e.source, tgt = e.target;
      if (!src || src.x == null || !tgt || tgt.x == null) return;

      const isHL = hasPath ? pathEdgeSet.has(i)
        : isHovering ? hlEdges.has(i)
        : hasSelection ? selConnected.has(i)
        : false;
      if (isHL) return;
      ctx.moveTo(src.x, src.y);
      ctx.lineTo(tgt.x, tgt.y);
      dimCount++;
    });
    if (dimCount) ctx.stroke();
  });
}

/* ============================================================
   Hover interaction (only in default mode)
   ============================================================ */
function onHover(event, d) {
  // Suppress hover when a selection is active
  if (selectedNodeId != null) return;
  if (!isNodeVisible(d.id)) return;
  if (hoveredId === d.id) return;

  hoveredId = d.id;

  hlNodes = new Set([d.id]);
  hlEdges = new Set();

  const conn = adjIndex.get(d.id) || [];
  conn.forEach(idx => {
    hlEdges.add(idx);
    const e = edges[idx];
    const srcId = typeof e.source === 'object' ? e.source.id : e.source;
    const tgtId = typeof e.target === 'object' ? e.target.id : e.target;
    const other = srcId === d.id ? tgtId : srcId;
    hlNodes.add(other);
  });

  drawEdges(currentTransform);

  nodeG.selectAll('circle')
    .attr('opacity', n => hlNodes.has(n.id) && isNodeVisible(n.id) ? 1 : 0.12);
  updateLabelPositions(currentTransform);

  showTooltip(event, d);
}

function offHover() {
  if (selectedNodeId != null) return;
  hoveredId = null;
  hlNodes = new Set();
  hlEdges = new Set();

  // Redraw edges – still need to respect selection
  drawEdges(currentTransform);

  if (selectedNodeId == null) {
    nodeG.selectAll('circle').attr('opacity', n => isNodeVisible(n.id) ? 1 : 0.03);
  }
  updateLabelPositions(currentTransform);

  hideTooltip();
}

/* ============================================================
   Tooltip
   ============================================================ */
function showTooltip(event, d) {
  const years = d.born ? `${d.born} — ${d.died || '?'}` : '生卒年不详';
  const html = `
    <div class="ti-name">${escHtml(displayName(d))}</div>
    <div class="ti-years">${escHtml(years)}</div>
    ${d.title ? `<div class="ti-meta">${escHtml(d.title)}</div>` : ''}
    ${d.dynasty ? `<div class="ti-meta">${escHtml(d.dynasty)}</div>` : ''}
  `;
  tooltipDiv.html(html).classed('visible', true);

  const rect = tooltipDiv.node().getBoundingClientRect();
  let tx = event.clientX + 16;
  let ty = event.clientY - 12;
  if (tx + rect.width > w - 8) tx = event.clientX - rect.width - 16;
  if (ty + rect.height > h - 8) ty = h - rect.height - 8;
  if (ty < 8) ty = 8;
  tooltipDiv.style('left', tx + 'px').style('top', ty + 'px');
}

function hideTooltip() {
  tooltipDiv.classed('visible', false);
}

function escHtml(s) {
  if (!s) return '';
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* ============================================================
   Info panel (slide-out character description)
   ============================================================ */
function openInfoPanel(d) {
  const panel = document.getElementById('info-panel');
  const desc = descriptions[d.id];

  // Header
  document.getElementById('info-name-zh').textContent = d.name_zh || d.name;
  document.getElementById('info-name-en').textContent = d.name;

  const metaParts = [];
  if (d.born) metaParts.push(`${d.born} — ${d.died || '?'}`);
  if (d.dynasty) metaParts.push(d.dynasty);
  if (d.title) metaParts.push(d.title);
  document.getElementById('info-meta').textContent = metaParts.join(' · ');

  // Body
  const body = document.getElementById('info-body');
  const wikiBtn = document.getElementById('info-wiki');
  const wikiFooter = document.getElementById('info-footer');

  if (desc && desc.text) {
    const paragraphs = desc.text.split('\n\n').filter(p => p.trim());
    body.innerHTML = paragraphs.map(p => `<p>${escHtml(p.trim())}</p>`).join('');

    if (desc.wiki_title) {
      const base = desc.source === 'en'
        ? 'https://en.wikipedia.org/wiki/'
        : 'https://zh.wikipedia.org/wiki/';
      wikiBtn.href = base + encodeURIComponent(desc.wiki_title);
      wikiFooter.style.display = '';
    } else {
      wikiFooter.style.display = 'none';
    }
  } else {
    const roleMap = { habsburg: '哈布斯堡主线', consort: '配偶', relative: '关联亲属' };
    const lines = [];
    if (d.born) lines.push(`生卒年：${d.born} — ${d.died || '不详'}`);
    if (d.dynasty) lines.push(`王朝：${d.dynasty}`);
    if (d.role) lines.push(`角色：${roleMap[d.role] || d.role}`);
    body.innerHTML = lines.map(l => `<p>${escHtml(l)}</p>`).join('')
      + '<p style="color:rgba(255,255,255,0.3);font-style:italic">暂无详细介绍</p>';
    wikiFooter.style.display = 'none';
  }

  // Scroll body to top
  body.scrollTop = 0;

  panel.classList.add('open');
}

function closeInfoPanel() {
  document.getElementById('info-panel').classList.remove('open');
}

/* ============================================================
   Path panel
   ============================================================ */
function updatePathPanel(srcIdOverride, tgtIdOverride, noPath) {
  const panel = document.getElementById('path-panel');
  const content = document.getElementById('path-content');

  if (selectedNodeId == null && !noPath) {
    panel.classList.remove('visible');
    return;
  }

  panel.classList.add('visible');

  const firstId = srcIdOverride || selectedNodeId;
  const first = nodeById.get(firstId);

  if (noPath) {
    const second = nodeById.get(tgtIdOverride);
    content.innerHTML = `
      <div class="path-error">未找到 ${escHtml(first ? displayName(first) : '')} 与 ${escHtml(second ? displayName(second) : '')} 之间的关系路径</div>
      <div class="path-length" style="text-align:center">两个人物在筛选范围内可能没有关联</div>
      <div class="path-length" style="text-align:center;margin-top: 4px">按 ESC 或点击空白处返回</div>
    `;
    return;
  }

  if (!pathResult) {
    // First selected – show person info
    let html = `<div class="path-first">已选: <strong>${escHtml(displayName(first))}</strong></div>`;
    html += `<div class="path-hint">请点击另一个人物查找关系路径</div>`;
    if (first.title) html += `<div class="path-meta">${escHtml(first.title)}</div>`;
    if (first.born) html += `<div class="path-meta">${first.born} — ${first.died || '?'}</div>`;
    content.innerHTML = html;
    return;
  }

  // Path found
  const lastId = pathResult.nodeIds[pathResult.nodeIds.length - 1];
  const last = nodeById.get(lastId);
  const steps = describePath(pathResult.nodeIds, pathResult.edgeIndices);

  let html = `<div class="path-title">${escHtml(displayName(first))} → ${escHtml(displayName(last))}</div>`;
  html += `<div class="path-steps">`;
  steps.forEach(line => {
    html += `<div class="path-step">${escHtml(line)}</div>`;
  });
  html += `</div>`;
  html += `<div class="path-length">路径长度: ${pathResult.nodeIds.length - 1} 步，${pathResult.nodeIds.length} 人</div>`;

  content.innerHTML = html;
}

/* ============================================================
   Search
   ============================================================ */
function initSearch() {
  const input = document.getElementById('search-input');
  const results = document.getElementById('search-results');

  input.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase();
    if (!q) {
      results.innerHTML = '';
      results.style.display = 'none';
      return;
    }

    const matches = nodes
      .filter(n => {
        const searchField = lang === 'zh' ? (n.name_zh || n.name) : n.name;
        return searchField.toLowerCase().includes(q) && isNodeVisible(n.id);
      })
      .slice(0, 10);

    if (matches.length === 0) {
      results.innerHTML = '<div class="sr-item sr-none">未找到匹配</div>';
    } else {
      results.innerHTML = matches.map(n => `
        <div class="sr-item" data-id="${n.id}">
          <span class="sr-name">${escHtml(displayName(n))}</span>
          ${n.title ? `<span class="sr-title">${escHtml(n.title)}</span>` : ''}
          ${n.born ? `<span class="sr-year">${n.born}</span>` : ''}
        </div>
      `).join('');
    }

    results.style.display = 'block';
  });

  // Delegated click on results
  results.addEventListener('click', e => {
    const item = e.target.closest('.sr-item[data-id]');
    if (!item) return;
    const id = item.dataset.id;
    focusOnNode(id);
    input.value = '';
    results.innerHTML = '';
    results.style.display = 'none';
  });

  input.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      input.value = '';
      results.innerHTML = '';
      results.style.display = 'none';
      input.blur();
    }
  });

  // Click outside closes results
  document.addEventListener('click', e => {
    if (!e.target.closest('#search-box')) {
      results.style.display = 'none';
    }
  });
}

/* ============================================================
   Language toggle
   ============================================================ */
function refreshLanguage() {
  if (!nodeG) return;

  // Update all text labels
  labelG.selectAll('text').text(d => displayName(d));

  // Update path panel if visible
  updatePathPanel();

  // Refresh search results if search has input
  const input = document.getElementById('search-input');
  if (input && input.value.trim()) {
    input.dispatchEvent(new Event('input'));
  }
}

function initLangToggle() {
  d3.select('#lang-en').on('click', () => {
    if (lang === 'en') return;
    lang = 'en';
    d3.select('#lang-en').classed('active', true);
    d3.select('#lang-zh').classed('active', false);
    refreshLanguage();
  });
  d3.select('#lang-zh').on('click', () => {
    if (lang === 'zh') return;
    lang = 'zh';
    d3.select('#lang-en').classed('active', false);
    d3.select('#lang-zh').classed('active', true);
    refreshLanguage();
  });
}

function focusOnNode(nodeId) {
  const node = nodeById.get(nodeId);
  if (!node || node.x == null) return;

  // Temporarily highlight the node circle
  const circles = nodeG.selectAll('circle');
  circles.attr('opacity', n => n.id === nodeId ? 1 : 0.08);

  setTimeout(() => {
    if (selectedNodeId == null) {
      circles.attr('opacity', n => isNodeVisible(n.id) ? 1 : 0.03);
      drawEdges(currentTransform);
    } else {
      updateView();
    }
  }, 2000);

  // Zoom to node
  const targetScale = Math.max(currentTransform.k, 2.5);
  const t = d3.zoomIdentity
    .translate(w / 2, h / 2)
    .scale(targetScale)
    .translate(-node.x, -node.y);

  svg.transition()
    .duration(500)
    .ease(d3.easeCubicOut)
    .call(zoom.transform, t);
}

/* ============================================================
   Filter panel
   ============================================================ */
function initFilters(ymin, ymax) {
  const cbHabs = document.querySelector('[data-role="habsburg"]');
  const cbConsort = document.querySelector('[data-role="consort"]');
  const cbRelative = document.querySelector('[data-role="relative"]');

  const sliderMin = document.getElementById('year-min');
  const sliderMax = document.getElementById('year-max');
  const labelMin = document.getElementById('year-min-label');
  const labelMax = document.getElementById('year-max-label');

  // Set slider range from data
  sliderMin.min = sliderMax.min = ymin;
  sliderMin.max = sliderMax.max = ymax;
  sliderMin.value = ymin;
  sliderMax.value = ymax;
  labelMin.textContent = ymin;
  labelMax.textContent = ymax;

  function applyFilters() {
    filterState.habsburg = cbHabs.checked;
    filterState.consort = cbConsort.checked;
    filterState.relative = cbRelative.checked;

    const vmin = Math.min(+sliderMin.value, +sliderMax.value);
    const vmax = Math.max(+sliderMin.value, +sliderMax.value);
    yearRange[0] = vmin;
    yearRange[1] = vmax;
    labelMin.textContent = vmin;
    labelMax.textContent = vmax;

    // Ensure min slider <= max slider (and vice versa)
    sliderMin.value = vmin;
    sliderMax.value = vmax;

    // Clear selection on filter change
    if (selectedNodeId != null) clearSelection();
    else updateView();
  }

  cbHabs.addEventListener('change', applyFilters);
  cbConsort.addEventListener('change', applyFilters);
  cbRelative.addEventListener('change', applyFilters);
  sliderMin.addEventListener('input', applyFilters);
  sliderMax.addEventListener('input', applyFilters);
}

/* ============================================================
   Keyboard shortcuts
   ============================================================ */
function initKeyboard() {
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      // Clear search input if focused
      const input = document.getElementById('search-input');
      if (document.activeElement === input && input.value) {
        input.value = '';
        document.getElementById('search-results').style.display = 'none';
        return;
      }
      // Clear selection
      if (selectedNodeId != null) {
        clearSelection();
      }
    }
  });
}

/* ============================================================
   Window resize
   ============================================================ */
window.addEventListener('resize', () => {
  w = window.innerWidth;
  h = window.innerHeight;

  if (canvas) {
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
  }

  if (svg) svg.attr('width', w).attr('height', h);

  if (nodes && nodes.length) drawEdges(currentTransform);

  // Resize star canvas
  if (starCanvas) {
    const sdpr = window.devicePixelRatio || 1;
    starCanvas.width = w * sdpr;
    starCanvas.height = h * sdpr;
    starCanvas.style.width = w + 'px';
    starCanvas.style.height = h + 'px';
    if (starCtx) starCtx.setTransform(sdpr, 0, 0, sdpr, 0, 0);
  }
});

/* ============================================================
   Bootstrap
   ============================================================ */
(async () => {
  try {
    // Start starfield animation immediately
    initStarCanvas();

    // Load data (needed for homepage stats and chart)
    const { ymin, ymax } = await loadData();

    // Update homepage stat cards with actual numbers
    document.getElementById('stat-people').textContent = nodes.length;
    document.getElementById('stat-edges').textContent = edges.length;
    document.getElementById('stat-years').textContent = (ymax - ymin);

    // Explore button → switch to chart
    document.getElementById('explore-btn').addEventListener('click', () => {
      switchToChart(ymin, ymax);
    });

    // Back-home button → switch to homepage
    document.getElementById('back-home-btn').addEventListener('click', () => {
      switchToHome();
    });

    // History button → switch to history page
    document.getElementById('history-btn').addEventListener('click', () => {
      switchToHistory();
    });

    // History back button → switch to homepage
    document.getElementById('history-back-btn').addEventListener('click', () => {
      switchToHomeFromHistory();
    });

    // Characters button → switch to characters page
    document.getElementById('characters-btn').addEventListener('click', () => {
      switchToCharacters();
    });

    // Characters back button → switch to homepage
    document.getElementById('characters-back-btn').addEventListener('click', () => {
      switchToHomeFromCharacters();
    });

    // Detail back button → switch to characters list
    document.getElementById('detail-back-btn').addEventListener('click', () => {
      switchToCharactersFromDetail();
    });

  } catch (err) {
    console.error(err);
    d3.select('#loader').html('数据加载失败，请检查控制台错误信息。');
  }
})();

/* ============================================================
   Page switching
   ============================================================ */
let _switching = false;

function switchToChart(ymin, ymax) {
  if (_switching) return;
  _switching = true;

  const homePage = document.getElementById('home-page');
  const chartPage = document.getElementById('chart-page');
  const backBtn = document.getElementById('back-home-btn');

  // Fade out homepage
  homePage.classList.add('hidden');
  stopStarAnimation();

  // After homepage fade-out, show chart page
  setTimeout(() => {
    chartPage.classList.add('visible');
    backBtn.classList.add('visible');

    if (!chartInitialized) {
      setupDOM();
      runSimulation();
      initSearch();
      initFilters(ymin, ymax);
      initKeyboard();
      initLangToggle();

      document.getElementById('info-close').addEventListener('click', (e) => {
        e.stopPropagation();
        closeInfoPanel();
      });

      chartInitialized = true;
    }

    _switching = false;
  }, 600);
}

function switchToHome() {
  if (_switching) return;
  _switching = true;

  const homePage = document.getElementById('home-page');
  const chartPage = document.getElementById('chart-page');
  const historyPage = document.getElementById('history-page');
  const backBtn = document.getElementById('back-home-btn');

  // Fade out all sub-pages
  chartPage.classList.remove('visible');
  historyPage.classList.remove('visible');
  document.getElementById('characters-page').classList.remove('visible');
  document.getElementById('character-detail-page').classList.remove('visible');
  backBtn.classList.remove('visible');

  setTimeout(() => {
    homePage.classList.remove('hidden');
    resumeStarAnimation();
    _switching = false;
  }, 600);
}

/* ============================================================
   History page
   ============================================================ */
let historyData = null;
let historyTree = null;
let historyActiveKey = null;
let historyInitialized = false;

const HISTORY_ROOT_ORDER = ['世界史', '东亚史', '未分类', '欧洲史'];
const HISTORY_CHILD_ORDER = {
  '东亚史': ['周边国家', '天朝史', '近现代史'],
  '欧洲史': ['其他', '古代史', '哈布斯堡史', '帝国史', '拿破仑战争史', '文献', '欧洲通史', '殖民史'],
};

function switchToHistory() {
  if (_switching) return;
  _switching = true;

  const homePage = document.getElementById('home-page');
  const historyPage = document.getElementById('history-page');

  homePage.classList.add('hidden');
  stopStarAnimation();

  setTimeout(async () => {
    historyPage.classList.add('visible');

    if (!historyInitialized) {
      await initHistoryPage();
      historyInitialized = true;
    }

    _switching = false;
  }, 600);
}

function switchToHomeFromHistory() {
  switchToHome();
}

async function initHistoryPage() {
  const res = await fetch(import.meta.env.BASE_URL + 'files.json');
  historyData = await res.json();
  historyTree = buildTree(historyData);
  renderTree();
}

function buildTree(data) {
  const root = { name: '历史', key: '', children: [], files: null };

  for (const [key, files] of Object.entries(data)) {
    const parts = key.split('/');
    if (parts.length === 1) {
      root.children.push({ name: parts[0], key, children: null, files, expanded: false });
    } else if (parts.length === 2) {
      let parent = root.children.find(c => c.name === parts[0]);
      if (!parent) {
        parent = { name: parts[0], key: parts[0], children: [], files: null, expanded: false };
        root.children.push(parent);
      }
      if (!parent.children) parent.children = [];
      parent.children.push({ name: parts[1], key, children: null, files, expanded: false });
    }
  }

  // Sort root
  root.children.sort((a, b) => {
    const ai = HISTORY_ROOT_ORDER.indexOf(a.name);
    const bi = HISTORY_ROOT_ORDER.indexOf(b.name);
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1;
    if (bi !== -1) return 1;
    return a.name.localeCompare(b.name);
  });

  // Sort children
  for (const node of root.children) {
    if (node.children) {
      const order = HISTORY_CHILD_ORDER[node.name] || [];
      node.children.sort((a, b) => {
        const ai = order.indexOf(a.name);
        const bi = order.indexOf(b.name);
        if (ai !== -1 && bi !== -1) return ai - bi;
        if (ai !== -1) return -1;
        if (bi !== -1) return 1;
        return a.name.localeCompare(b.name);
      });
    }
  }

  // Auto-expand first level
  for (const node of root.children) {
    if (node.children) node.expanded = true;
  }

  return root;
}

function renderTree() {
  const container = document.getElementById('history-tree');
  container.innerHTML = '';
  container.appendChild(buildTreeDOM(historyTree, 0));
}

function buildTreeDOM(node, depth) {
  const div = document.createElement('div');
  div.className = 'ht-node';

  const row = document.createElement('div');
  row.className = 'ht-row';
  if (historyActiveKey === node.key && node.files) {
    row.classList.add('active');
  }
  row.addEventListener('click', (e) => {
    e.stopPropagation();
    if (node.children && node.children.length > 0) {
      node.expanded = !node.expanded;
      renderTree();
      if (node.files) selectTreeNode(node);
    } else if (node.files) {
      selectTreeNode(node);
    }
  });

  // Arrow
  const arrow = document.createElement('span');
  arrow.className = 'ht-arrow';
  if (node.children && node.children.length > 0) {
    arrow.textContent = '▶';
    if (node.expanded) arrow.classList.add('expanded');
  } else {
    arrow.classList.add('leaf');
  }
  row.appendChild(arrow);

  // Folder icon
  const icon = document.createElement('span');
  icon.className = 'ht-folder';
  icon.textContent = node.children && node.children.length > 0
    ? (node.expanded ? '▼' : '▶')
    : '📄';
  row.appendChild(icon);

  // Name
  const name = document.createElement('span');
  name.className = 'ht-name';
  name.textContent = node.name;
  row.appendChild(name);

  // File count
  const count = document.createElement('span');
  count.className = 'ht-count';
  if (node.children) {
    const total = node.children.reduce((s, c) => s + (c.files ? c.files.length : 0), 0);
    if (total > 0) count.textContent = total;
  } else if (node.files) {
    count.textContent = node.files.length;
  }
  row.appendChild(count);

  div.appendChild(row);

  // Children
  if (node.children && node.expanded) {
    const childContainer = document.createElement('div');
    childContainer.className = 'ht-children';
    for (const child of node.children) {
      childContainer.appendChild(buildTreeDOM(child, depth + 1));
    }
    div.appendChild(childContainer);
  }

  return div;
}

function selectTreeNode(node) {
  historyActiveKey = node.key;

  // Update tree highlight
  renderTree();

  // Breadcrumb
  const bc = document.getElementById('history-breadcrumb');
  bc.innerHTML = '<span>历史</span> ' + node.key.split('/').map((p, i, arr) => {
    return i === arr.length - 1
      ? ' / <span class="current">' + escHtml(p) + '</span>'
      : ' / ' + escHtml(p);
  }).join('');

  // File list
  renderFileList(node.files || []);
}

function renderFileList(files) {
  const container = document.getElementById('history-file-list');

  if (files.length === 0) {
    container.innerHTML = '<div class="hfl-empty">此分类暂无文件</div>';
    return;
  }

  container.innerHTML = files.map(f => {
    const ext = f.name.split('.').pop().toLowerCase();
    const iconCls = ['pdf', 'epub', 'docx', 'pptx'].includes(ext) ? ext : 'other';
    const iconLabel = ext.toUpperCase().slice(0, 4);
    return `
      <div class="hf-item" data-path="${escHtml(f.path)}">
        <div class="hf-icon ${iconCls}">${iconLabel}</div>
        <div class="hf-info">
          <div class="hf-name">${escHtml(f.name)}</div>
          <div class="hf-meta">${formatFileSize(f.size)}</div>
        </div>
      </div>
    `;
  }).join('');

  // Click to download
  container.querySelectorAll('.hf-item').forEach(item => {
    item.addEventListener('click', () => {
      const path = item.dataset.path;
      const a = document.createElement('a');
      a.href = import.meta.env.BASE_URL + path;
      a.download = path.split('/').pop();
      a.click();
    });
  });
}

function formatFileSize(bytes) {
  if (bytes == null) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

/* ============================================================
   Characters module
   ============================================================ */

async function initCharactersPage() {
  const [nd, desc] = await Promise.all([
    fetch(import.meta.env.BASE_URL + 'important_nodes.json').then(r => r.json()),
    fetch(import.meta.env.BASE_URL + 'important_descriptions.json').then(r => r.json()),
  ]);
  importantNodes = nd;
  importantDescs = desc;

  // Sort by birth year ascending
  importantNodes.sort((a, b) => (a.born || 9999) - (b.born || 9999));

  // Build lookup for nodes.json by id
  currentNodeById = new Map(nodes.map(d => [d.id, d]));

  renderCharactersGrid();
  charactersInitialized = true;
}

function renderCharactersGrid() {
  const grid = document.getElementById('characters-grid');
  grid.innerHTML = '';

  for (const p of importantNodes) {
    const nameZh = p.name_zh || p.name;
    const born = p.born != null ? p.born : '?';
    const died = p.died != null ? p.died : '?';
    const tags = p.importance || [];
    const imgPath = import.meta.env.BASE_URL + 'pictures/' + p.id + '.jpg';

    const card = document.createElement('div');
    card.className = 'cr-card';
    card.innerHTML =
      '<img class="cr-card-img" src="' + imgPath + '" alt="' + nameZh + '" loading="lazy" />' +
      '<div class="cr-card-body">' +
        '<div class="cr-card-name">' + nameZh + '</div>' +
        '<div class="cr-card-year">' + born + ' — ' + died + '</div>' +
      '</div>' +
      (tags.length
        ? '<div class="cr-card-tags">' +
            tags.map(t => '<span class="cr-tag">' + t + '</span>').join('') +
          '</div>'
        : '');

    card.addEventListener('click', () => openCharacterDetail(p));
    grid.appendChild(card);
  }
}

/* ---- Page switching ---- */

function switchToCharacters() {
  if (_switching) return;
  _switching = true;

  const homePage = document.getElementById('home-page');
  const charsPage = document.getElementById('characters-page');
  const detailPage = document.getElementById('character-detail-page');

  homePage.classList.add('hidden');
  stopStarAnimation();

  setTimeout(async () => {
    detailPage.classList.remove('visible');
    charsPage.classList.add('visible');

    if (!charactersInitialized) {
      await initCharactersPage();
    }

    _switching = false;
  }, 600);
}

function switchToHomeFromCharacters() {
  if (_switching) return;
  _switching = true;

  const homePage = document.getElementById('home-page');
  const charsPage = document.getElementById('characters-page');
  const detailPage = document.getElementById('character-detail-page');

  charsPage.classList.remove('visible');
  detailPage.classList.remove('visible');

  setTimeout(() => {
    homePage.classList.remove('hidden');
    resumeStarAnimation();
    _switching = false;
  }, 600);
}

function switchToCharactersFromDetail() {
  if (_switching) return;
  _switching = true;

  const charsPage = document.getElementById('characters-page');
  const detailPage = document.getElementById('character-detail-page');
  const detailBackBtn = document.getElementById('detail-back-btn');

  detailPage.classList.remove('visible');

  setTimeout(() => {
    charsPage.classList.add('visible');
    _switching = false;
  }, 500);
}

function openCharacterDetail(person) {
  if (_switching) return;
  _switching = true;

  const charsPage = document.getElementById('characters-page');
  const detailPage = document.getElementById('character-detail-page');

  charsPage.classList.remove('visible');

  setTimeout(() => {
    renderDetailPage(person);
    detailPage.classList.add('visible');
    _switching = false;

    // Build mini relation graph after layout is visible
    requestAnimationFrame(() => {
      buildRelationGraph(person.id);
    });
  }, 500);
}

/* ---- Detail page rendering ---- */

function renderDetailPage(person) {
  const nameZh = person.name_zh || person.name;
  const nameEn = person.name;
  const born = person.born != null ? person.born : '?';
  const died = person.died != null ? person.died : '?';
  const dynasty = person.dynasty || '';
  const tags = person.importance || [];

  document.getElementById('detail-name-zh').textContent = nameZh;
  document.getElementById('detail-name-en').textContent = nameEn;
  document.getElementById('detail-years').textContent = born + ' — ' + died;
  document.getElementById('detail-dynasty').textContent = dynasty;

  const imgEl = document.getElementById('detail-img');
  imgEl.src = import.meta.env.BASE_URL + 'pictures/' + person.id + '.jpg';
  imgEl.alt = nameZh;

  const tagsDiv = document.getElementById('detail-tags');
  tagsDiv.innerHTML = tags.map(t => '<span class="dtl-tag">' + t + '</span>').join('');

  const descDiv = document.getElementById('detail-desc');
  const descData = importantDescs[person.id];
  if (descData && descData.text) {
    const text = descData.text;
    // Split on double newlines into paragraphs
    const paragraphs = text.split(/\n\n+/).filter(p => p.trim());
    descDiv.innerHTML = paragraphs.map(p => '<p>' + p.replace(/\n/g, '') + '</p>').join('');
  } else {
    descDiv.innerHTML = '<p style="color:rgba(143,168,200,0.4);font-style:italic">暂无详细介绍</p>';
  }
}

/* ---- Mini relation graph (D3) ---- */

function buildRelationGraph(personId) {
  const svgEl = document.getElementById('detail-relation-svg');
  const container = svgEl.parentElement;
  const rect = container.getBoundingClientRect();
  const W = rect.width - 4; // slight padding for scrollbar

  // Gather connected nodes and edges
  const selfNode = currentNodeById.get(personId);
  if (!selfNode) return;

  const connectedIds = new Set();
  const relatedEdges = [];

  for (const e of edges) {
    if (e.source === personId || e.target === personId) {
      relatedEdges.push(e);
      connectedIds.add(e.source);
      connectedIds.add(e.target);
    }
  }

  // Collect node data
  const graphNodes = [];
  for (const nid of connectedIds) {
    const n = currentNodeById.get(nid);
    if (n) graphNodes.push(n);
  }

  // Categorize nodes
  const self = graphNodes.find(n => n.id === personId);
  if (!self) return;

  const spouses = [];
  const parents = [];
  const children = [];

  for (const e of relatedEdges) {
    const otherId = e.source === personId ? e.target : e.source;
    const other = graphNodes.find(n => n.id === otherId);
    if (!other) continue;

    if (e.type === 'spouse') {
      if (!spouses.find(s => s.id === otherId)) {
        spouses.push({ node: other, edge: e });
      }
    } else if (e.type === 'parent') {
      if (e.source === otherId) {
        if (!parents.find(p => p.id === otherId)) {
          parents.push({ node: other, edge: e });
        }
      } else {
        if (!children.find(c => c.id === otherId)) {
          children.push({ node: other, edge: e });
        }
      }
    }
  }

  // ---- Compute content height for SVG sizing ----
  const selfR = 22;                // was 28, ~20% smaller
  const otherR = 13;               // spouse/parent: was 18, ~28% smaller
  const childR = 10;               // was 15, ~33% smaller
  const labelH = 18;               // label offset
  const CHILD_ROW_GAP = 80;        // vertical gap between child rows
  const MIN_CHILD_SPACING = 40;    // minimum horizontal spacing
  const FAN_ANGLE = Math.PI / 3;   // ±60 degrees total fan

  const hasTwoChildRows = children.length > 5;

  // Content height: parents + gap + self + gap + children fan radius + label margin
  const parentZone = parents.length > 0 ? 120 : 40;
  // CHILD_RADIUS_ROW2 is defined below, but we need it here for height calc
  const maxChildRadius = 180 + (hasTwoChildRows ? CHILD_ROW_GAP : 0);
  const childZone = children.length > 0 ? (maxChildRadius + childR + 80) : 40;
  const contentH = parentZone + 120 + childZone + 40;
  const H = Math.max(rect.height, contentH);

  const svg = d3.select('#detail-relation-svg');
  svg.selectAll('*').remove();
  svg.attr('viewBox', [0, 0, W, H]);
  svg.style('min-height', contentH + 'px');

  // Make container scrollable
  container.style.overflowY = 'auto';

  // ---- Layout ----
  const cx = W / 2;
  const cy = parentZone + 60; // self center Y depends on parent zone

  // Unique ID for each node in the graph
  const nodeMeta = new Map(); // nid → { role, color, r }
  nodeMeta.set(personId, { role: 'self', color: '#D4AF37', r: selfR });

  for (const p of parents) nodeMeta.set(p.node.id, { role: 'parent', color: p.node.sex === 'male' ? '#7B9DBF' : '#9DB5CC', r: otherR });
  for (const s of spouses) nodeMeta.set(s.node.id, { role: 'spouse', color: '#D4A574', r: otherR });
  for (let i = 0; i < children.length; i++) {
    nodeMeta.set(children[i].node.id, { role: 'child', color: '#F5F0E6', r: childR, childIdx: i });
  }

  // ---- Compute positions ----
  const nodePos = new Map();

  // Self at center
  nodePos.set(personId, { x: cx, y: cy });

  // Parents above self
  if (parents.length > 0) {
    const pSpacing = Math.max(MIN_CHILD_SPACING + otherR * 2, W / (parents.length + 1));
    const pBaseY = cy - 120;
    for (let i = 0; i < parents.length; i++) {
      const px = pSpacing * (i + 1);
      const py = pBaseY + (Math.random() - 0.5) * 20;
      nodePos.set(parents[i].node.id, { x: px, y: py });
    }
  }

  // Spouses on left and right
  for (let i = 0; i < spouses.length; i++) {
    const side = i % 2 === 0 ? 1 : -1;
    const sx = cx + side * (90 + Math.random() * 30);
    const sy = cy + (i - (spouses.length - 1) / 2) * 60 + (Math.random() - 0.5) * 16;
    nodePos.set(spouses[i].node.id, { x: sx, y: sy });
  }

  // ---- Child positions: fan out from mother (first spouse) or below self ----
  let motherX = cx;
  let motherY = cy + 50;
  if (spouses.length > 0) {
    const spos = nodePos.get(spouses[0].node.id);
    if (spos) {
      motherX = spos.x;
      motherY = spos.y;
    }
  }

  // Wider spread for children
  const CHILD_RADIUS_ROW1 = 180;
  const CHILD_RADIUS_ROW2 = CHILD_RADIUS_ROW1 + CHILD_ROW_GAP;
  const CHILD_FAN_ANGLE = Math.PI * 0.7; // ±63°, wider than before

  if (children.length > 0) {
    const row1Count = hasTwoChildRows ? Math.ceil(children.length / 2) : children.length;
    const row2Count = hasTwoChildRows ? children.length - row1Count : 0;

    const positionRow = (startIdx, count, radius, angleOffset) => {
      for (let i = 0; i < count; i++) {
        const childIdx = startIdx + i;
        const countForAngle = Math.max(count, 1);
        const fraction = count === 1 ? 0.5 : i / (countForAngle - 1);
        const angle = -CHILD_FAN_ANGLE / 2 + fraction * CHILD_FAN_ANGLE + angleOffset;

        const chX = motherX + radius * Math.sin(angle);
        const chY = motherY + radius * Math.cos(angle);

        // Enforce minimum horizontal spacing between siblings in same row
        const pos = { x: chX, y: chY };
        if (i > 0) {
          const prev = nodePos.get(children[childIdx - 1].node.id);
          if (prev && Math.abs(pos.x - prev.x) < MIN_CHILD_SPACING) {
            pos.x = prev.x + (pos.x >= prev.x ? MIN_CHILD_SPACING : -MIN_CHILD_SPACING);
          }
        }
        nodePos.set(children[childIdx].node.id, pos);
      }
    };

    positionRow(0, row1Count, CHILD_RADIUS_ROW1, 0);
    if (hasTwoChildRows) {
      // Row 2: offset angle slightly to stagger visually
      const offsetAngle = (CHILD_FAN_ANGLE / Math.max(row2Count - 1, 1)) * 0.5;
      positionRow(row1Count, row2Count, CHILD_RADIUS_ROW2, offsetAngle);
    }
  }

  // ---- Pan/zoom layer ----
  const panG = svg.append('g').attr('class', 'pan-layer');

  const panZoom = d3.zoom()
    .scaleExtent([1, 1])  // pan only, no zoom
    .on('zoom', (event) => {
      panG.attr('transform', event.transform);
      svg.style('cursor', event.sourceEvent && event.sourceEvent.type === 'mousemove' ? 'grabbing' : 'grab');
    });

  svg.call(panZoom)
    .style('cursor', 'grab');

  // ---- Draw edges ----
  const edgeG = panG.append('g');

  for (const e of relatedEdges) {
    const spos = nodePos.get(e.source);
    const tpos = nodePos.get(e.target);
    if (!spos || !tpos) continue;

    if (e.type === 'parent' && e.source === personId) {
      // Self → child: draw direct line from mother to child (fan pattern)
      edgeG.append('line')
        .attr('x1', motherX).attr('y1', motherY)
        .attr('x2', tpos.x).attr('y2', tpos.y)
        .attr('stroke', 'rgba(245,240,230,0.28)')
        .attr('stroke-width', 1)
        .attr('stroke-dasharray', '3,5');
    } else if (e.type === 'parent') {
      // Parent → self edge with label
      const pNode = graphNodes.find(n => n.id === e.source);
      const label = pNode ? (pNode.sex === 'male' ? '父亲' : '母亲') : '';
      edgeG.append('line')
        .attr('x1', spos.x).attr('y1', spos.y)
        .attr('x2', tpos.x).attr('y2', tpos.y)
        .attr('stroke', 'rgba(123,157,191,0.35)')
        .attr('stroke-width', 1.2);

      if (label) {
        const mx = (spos.x + tpos.x) / 2;
        const my = (spos.y + tpos.y) / 2 - 8;
        edgeG.append('text')
          .attr('x', mx).attr('y', my)
          .attr('text-anchor', 'middle')
          .attr('fill', 'rgba(123,157,191,0.5)')
          .attr('font-size', 10)
          .attr('font-family', 'Georgia, serif')
          .text(label);
      }
    } else {
      // Spouse edge with label
      edgeG.append('line')
        .attr('x1', spos.x).attr('y1', spos.y)
        .attr('x2', tpos.x).attr('y2', tpos.y)
        .attr('stroke', 'rgba(212,165,116,0.35)')
        .attr('stroke-width', 1.2);

      const mx = (spos.x + tpos.x) / 2;
      const my = (spos.y + tpos.y) / 2 - 8;
      edgeG.append('text')
        .attr('x', mx).attr('y', my)
        .attr('text-anchor', 'middle')
        .attr('fill', 'rgba(212,165,116,0.5)')
        .attr('font-size', 10)
        .attr('font-family', 'Georgia, serif')
        .text('配偶');
    }
  }

  // ---- Draw circles (bottom layer) ----
  const circleG = panG.append('g');

  for (const [nid, pos] of nodePos) {
    const meta = nodeMeta.get(nid);

    circleG.append('circle')
      .attr('cx', pos.x).attr('cy', pos.y)
      .attr('r', meta.r)
      .attr('fill', meta.color)
      .attr('stroke', 'rgba(255,255,255,0.12)')
      .attr('stroke-width', 0.8);

    // Glow for self
    if (meta.role === 'self') {
      circleG.append('circle')
        .attr('cx', pos.x).attr('cy', pos.y)
        .attr('r', meta.r + 4)
        .attr('fill', 'none')
        .attr('stroke', 'rgba(212,175,55,0.15)')
        .attr('stroke-width', 2);
    }
  }

  // ---- Draw labels (top layer, above circles) ----
  const labelG = panG.append('g');

  // Determine which row each child belongs to
  const childRows_y = new Map();
  for (const c of children) {
    const inRow1 = children.filter((_, j) => j < (hasTwoChildRows ? Math.ceil(children.length / 2) : children.length))
      .some(rc => rc.node.id === c.node.id);
    childRows_y.set(c.node.id, inRow1 ? 0 : 1);
  }

  // Within each row, sort by x and assign stagger pattern
  const childLabelInfo = new Map();
  for (let rowIdx = 0; rowIdx <= (hasTwoChildRows ? 1 : 0); rowIdx++) {
    const rowChildren = children.filter(c => (childRows_y.get(c.node.id) || 0) === rowIdx)
      .sort((a, b) => {
        const ap = nodePos.get(a.node.id);
        const bp = nodePos.get(b.node.id);
        return (ap ? ap.x : 0) - (bp ? bp.x : 0);
      });

    rowChildren.forEach((c, localIdx) => {
      const pos = nodePos.get(c.node.id);
      if (!pos) return;
      const isEven = localIdx % 2 === 0;
      childLabelInfo.set(c.node.id, {
        labelX: pos.x + (isEven ? 22 : -22),
        labelY: pos.y + childR + 12 + (isEven ? 0 : 12),
        textAnchor: isEven ? 'start' : 'end',
      });
    });
  }

  for (const [nid, pos] of nodePos) {
    const n = graphNodes.find(d => d.id === nid);
    if (!n) continue;
    const meta = nodeMeta.get(nid);
    const nameZh = n.name_zh || n.name;

    let labelX = pos.x;
    let labelY = pos.y + meta.r + labelH;
    let textAnchor = 'middle';
    let fontSize = 11;

    if (meta.role === 'spouse') {
      if (pos.x > cx) {
        labelX = pos.x + meta.r + 6;
        labelY = pos.y;
        textAnchor = 'start';
      } else {
        labelX = pos.x - meta.r - 6;
        labelY = pos.y;
        textAnchor = 'end';
      }
    } else if (meta.role === 'parent') {
      labelY = pos.y - meta.r - 6;
    } else if (meta.role === 'child') {
      fontSize = 10;
      const info = childLabelInfo.get(nid);
      if (info) {
        labelX = info.labelX;
        labelY = info.labelY;
        textAnchor = info.textAnchor;
      }
    }

    labelG.append('text')
      .attr('x', labelX).attr('y', labelY)
      .attr('text-anchor', textAnchor)
      .attr('fill', meta.role === 'self' ? '#D4AF37' : 'rgba(208,200,184,0.75)')
      .attr('font-size', fontSize)
      .attr('font-family', 'Georgia, serif')
      .attr('font-weight', meta.role === 'self' ? 'bold' : 'normal')
      .text(nameZh);
  }
}
