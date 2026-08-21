// The self-contained D3 diagram: markup, styling and client-side behaviour.
//
// Kept as a template string rather than a bundled asset so the rendered file has
// no runtime dependency on the repo — a peer can be handed the HTML and open it
// straight from their downloads folder.
//
// @module

import type { TopologyGraph } from "./topology_graph.ts";

/** Escape a payload for safe embedding inside a <script> block. */
function embedJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

const STYLES = String.raw`
:root {
  --bg: #04070a;
  --grid: rgba(70, 120, 100, 0.07);
  --panel: rgba(9, 17, 16, 0.72);
  --edge: #16332a;
  --edge-soft: rgba(80, 150, 120, 0.22);
  --ink: #cfe8dd;
  --dim: #5d7970;
  --dimmer: #38504a;
  --green: #7ee787;
  --cyan: #4cc9f0;
  --amber: #f2a65a;
  --violet: #c792ea;
  --blue: #58a6ff;
  --grey: #8b949e;
}
* { box-sizing: border-box; }
html, body {
  margin: 0; padding: 0; height: 100%;
  background: var(--bg); color: var(--ink);
  font: 12px/1.5 "SFMono-Regular", "JetBrains Mono", Menlo, Consolas, monospace;
  -webkit-font-smoothing: antialiased;
}
body::before {
  content: ""; position: fixed; inset: 0; pointer-events: none; z-index: 0;
  background-image:
    linear-gradient(var(--grid) 1px, transparent 1px),
    linear-gradient(90deg, var(--grid) 1px, transparent 1px);
  background-size: 34px 34px;
}
.shell { position: relative; z-index: 1; display: flex; flex-direction: column; height: 100vh; }

.statusbar {
  display: flex; justify-content: space-between; align-items: center;
  padding: 6px 14px; border-bottom: 1px solid var(--edge);
  font-size: 10.5px; letter-spacing: 0.14em; text-transform: uppercase;
  color: var(--dim);
}
.statusbar .live { color: var(--green); }
.statusbar .live::before {
  content: "●"; margin-right: 6px; animation: blink 2.4s ease-in-out infinite;
}
@keyframes blink { 0%,100% { opacity: 1; } 50% { opacity: 0.25; } }

.masthead { padding: 14px 20px 10px; }
.crumb {
  font-size: 10.5px; letter-spacing: 0.16em; text-transform: uppercase;
  color: var(--dim); display: flex; gap: 8px; align-items: center;
}
.crumb .dot { width: 7px; height: 7px; background: var(--green); display: inline-block; }
.crumb .accent { color: var(--green); }
h1 {
  margin: 8px 0 4px; font-size: 30px; letter-spacing: 0.06em; font-weight: 600;
  text-transform: uppercase; color: #eafff5;
}
.subtitle { font-size: 11.5px; color: var(--dim); letter-spacing: 0.04em; }
.subtitle b { color: var(--green); font-weight: 500; }
.subtitle .cy { color: var(--cyan); }

.workspace {
  flex: 1; min-height: 0; display: grid;
  grid-template-columns: 232px minmax(0, 1fr) 268px;
  gap: 12px; padding: 0 20px 12px;
}
.pane {
  border: 1px solid var(--edge); background: var(--panel);
  display: flex; flex-direction: column; min-height: 0;
}
.pane-title {
  padding: 8px 11px; font-size: 10.5px; letter-spacing: 0.16em;
  text-transform: uppercase; color: var(--dim); display: flex; gap: 8px;
  border-bottom: 1px solid var(--edge);
}
.pane-title .n { color: var(--green); }
.pane-title .hint { margin-left: auto; color: var(--dimmer); letter-spacing: 0.08em; }
.pane-body { overflow: auto; padding: 9px 11px; flex: 1; min-height: 0; }

.btnrow { display: flex; gap: 5px; margin-bottom: 11px; }
.btn {
  flex: 1; padding: 5px 0; text-align: center; cursor: pointer;
  border: 1px solid var(--edge); background: transparent; color: var(--dim);
  font: inherit; font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase;
  transition: all 0.16s;
}
.btn:hover { border-color: var(--green); color: var(--green); }

.grouplabel {
  font-size: 10px; letter-spacing: 0.14em; text-transform: uppercase;
  color: var(--dimmer); margin: 13px 0 6px;
}
.grouplabel:first-child { margin-top: 0; }
.check {
  display: flex; align-items: center; gap: 7px; padding: 2.5px 0;
  cursor: pointer; color: var(--ink); font-size: 11px;
}
.check:hover { color: #fff; }
.check .box {
  width: 9px; height: 9px; border: 1px solid currentColor; flex: none;
  position: relative;
}
.check.on .box::after {
  content: ""; position: absolute; inset: 1.5px; background: currentColor;
}
.check .count { margin-left: auto; color: var(--dimmer); font-size: 10px; }
.check.off { color: var(--dimmer); }
.check .val { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.check.untagged .val { font-style: italic; }

.tabs { display: flex; border-bottom: 1px solid var(--edge); flex: none; }
.tab {
  flex: 1; padding: 6px 0; cursor: pointer; background: transparent;
  border: 0; border-bottom: 1px solid transparent; color: var(--dimmer);
  font: inherit; font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase;
}
.tab:hover { color: var(--ink); }
.tab.on { color: var(--green); border-bottom-color: var(--green); }
.tab .badge {
  display: none; margin-left: 5px; padding: 0 4px;
  background: var(--green); color: #04070a; font-size: 9px;
}
.tab .badge.show { display: inline-block; }

.tagsearch {
  width: 100%; margin-bottom: 8px; padding: 4px 6px;
  background: rgba(0, 0, 0, 0.35); border: 1px solid var(--edge);
  color: var(--ink); font: inherit; font-size: 10.5px;
}
.tagsearch::placeholder { color: var(--dimmer); }
.tagsearch:focus { outline: none; border-color: var(--green); }

.chips { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 10px; }
.chip {
  border: 1px solid var(--edge); padding: 1px 5px; font-size: 9.5px;
  color: var(--dim); cursor: pointer; max-width: 100%; overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap;
}
.chip:hover { border-color: var(--green); color: var(--green); }
.chip.active { border-color: var(--green); color: var(--green); }
.chip.active::after { content: " ✕"; color: var(--dimmer); }
.chip.inert { cursor: default; color: var(--dimmer); }
.chip.inert:hover { border-color: var(--edge); color: var(--dimmer); }

.tagkey {
  display: flex; align-items: center; gap: 6px; margin: 12px 0 5px;
  cursor: pointer; font-size: 10px; letter-spacing: 0.14em;
  text-transform: uppercase; color: var(--dim);
}
.tagkey:first-child { margin-top: 0; }
.tagkey:hover { color: var(--ink); }
.tagkey.active { color: var(--green); }
.tagkey .caret { color: var(--dimmer); font-size: 9px; }
.tagkey .n { margin-left: auto; color: var(--dimmer); letter-spacing: 0.06em; }
.more { color: var(--dimmer); font-size: 10px; cursor: pointer; padding: 3px 0 0 16px; }
.more:hover { color: var(--green); }

#canvas { flex: 1; min-height: 0; }
svg { display: block; width: 100%; height: 100%; cursor: grab; }
svg.dragging { cursor: grabbing; }

.boundary { fill: rgba(20, 40, 34, 0.16); }
.boundary.vpc { stroke: rgba(90, 200, 160, 0.4); stroke-dasharray: 2 4; }
.boundary.subnet { stroke: rgba(80, 160, 200, 0.34); stroke-dasharray: 6 4; }
.boundary.external { stroke: rgba(199, 146, 234, 0.38); stroke-dasharray: 9 3 2 3; fill: rgba(40, 24, 50, 0.16); }
.boundary-label {
  font-size: 9.5px; letter-spacing: 0.14em; text-transform: uppercase;
  fill: var(--dim); pointer-events: none;
}
.boundary-sub { font-size: 8.5px; fill: var(--dimmer); pointer-events: none; }

.link { fill: none; stroke-width: 1; opacity: 0.5; }
.link.public { stroke: var(--amber); stroke-dasharray: 5 4; }
.link.private { stroke: var(--cyan); stroke-dasharray: 1 4; stroke-linecap: round; }
.link.flowing { animation: dashflow 1.1s linear infinite; }
@keyframes dashflow { to { stroke-dashoffset: -18; } }
.link.faded { opacity: 0.06; }
.link.hot { opacity: 1; stroke-width: 1.8; }
.linklabel { font-size: 8px; fill: var(--dimmer); pointer-events: none; }

.particle { pointer-events: none; }

.node { cursor: pointer; }
.node rect {
  fill: rgba(6, 14, 12, 0.94); stroke-width: 1.1;
  transition: filter 0.2s;
}
.node text { pointer-events: none; }
.node .nkind {
  font-size: 8px; font-weight: 700; letter-spacing: 0.08em;
  fill: currentColor;
}
.node .nlabel { font-size: 9.5px; fill: #e6fff4; }
.node.faded { opacity: 0.14; }
.node.hot rect { filter: drop-shadow(0 0 7px currentColor); }
.node.pinned rect { stroke-width: 2; filter: drop-shadow(0 0 11px currentColor); }

.inspect-empty { color: var(--dimmer); font-size: 10.5px; letter-spacing: 0.08em; }
.inspect h2 {
  margin: 0 0 2px; font-size: 15px; color: #eafff5; letter-spacing: 0.03em;
  font-weight: 600; overflow-wrap: anywhere;
}
.inspect .kind {
  font-size: 9.5px; letter-spacing: 0.15em; text-transform: uppercase;
  margin-bottom: 11px;
}
.inspect .kindsub { color: var(--dimmer); }
.kv { display: grid; grid-template-columns: 74px 1fr; gap: 3px 8px; margin-bottom: 12px; }
.kv dt {
  font-size: 9.5px; letter-spacing: 0.09em; text-transform: uppercase;
  color: var(--dimmer);
}
.kv dd { margin: 0; font-size: 10.5px; color: var(--ink); word-break: break-all; }
.paths-title {
  font-size: 9.5px; letter-spacing: 0.14em; text-transform: uppercase;
  color: var(--dimmer); margin-bottom: 5px;
}
.path-item {
  display: flex; gap: 6px; align-items: baseline; padding: 2px 0;
  font-size: 10px; color: var(--dim); cursor: pointer;
  overflow-wrap: anywhere;
}
.path-item:hover { color: var(--ink); }
.path-item .dir { color: var(--green); }
.path-item .port { color: var(--amber); }

.footer {
  border-top: 1px solid var(--edge); padding: 7px 20px;
  display: flex; flex-wrap: wrap; gap: 14px; align-items: center;
  font-size: 10px; color: var(--dim); letter-spacing: 0.05em;
}
.footer .k { color: var(--green); }
.legend { display: flex; flex-wrap: wrap; gap: 11px; margin-left: auto; }
.legend span { display: flex; align-items: center; gap: 5px; }
.legend i { width: 8px; height: 8px; border: 1px solid currentColor; display: inline-block; }
.asbuilt {
  padding: 9px 20px 16px; font-size: 10.5px; line-height: 1.65;
  color: var(--dim); border-top: 1px solid var(--edge);
}
.asbuilt b { color: var(--ink); font-weight: 600; }
.asbuilt .pub { color: var(--amber); }
.asbuilt .priv { color: var(--cyan); }
.warn { color: var(--amber); }
.stalebar {
  background: rgba(180, 90, 30, 0.18); border-bottom: 1px solid #7a4418;
  color: #ffcf9a; padding: 7px 20px; font-size: 11px; letter-spacing: 0.05em;
}
.stale { color: var(--amber); }
`;

const SCRIPT = String.raw`
const G = window.__TOPOLOGY__;
const colourOf = {};
G.categories.forEach(function (c) { colourOf[c.key] = c.colour; });

// Sentinel value standing for "this object carries no such tag". Filtering on a
// tag would otherwise silently drop untagged infrastructure with no way to ask
// for it back.
const UNTAGGED = "\u2400untagged";
const TAG_VALUE_LIMIT = 18;
const facets = G.tagFacets || [];
const facetKeys = new Set(facets.map(function (f) { return f.key; }));

const state = {
  categories: new Set(G.categories.map(function (c) { return c.key; })),
  paths: new Set(G.pathTypes.map(function (p) { return p.key; })),
  boundaries: new Set(["vpc", "subnet", "external"]),
  // Tag key -> Set of accepted values. A key that is absent, or holds an empty
  // set, imposes no constraint: values are OR-ed within a key, AND-ed across.
  // A Map, not an object: AWS accepts "__proto__" and "constructor" as tag
  // keys, and a plain object would mangle both.
  tags: new Map(),
  pinned: null,
};

// ---- layout ------------------------------------------------------------
// Boxes are packed deterministically so the diagram is stable week to week;
// the force simulation only animates nodes into their slots and keeps labels
// from colliding. A purely force-directed layout would reshuffle on every run
// and make two Mondays impossible to compare.

const NODE_W = 142, NODE_H = 34, PAD = 13, HEADER = 22, GAP = 16;

// Labels are clamped to the box they sit in rather than allowed to run over the
// canvas. The font stack is monospace throughout, so a character's advance is a
// fixed fraction of its size — enough to size a label without measuring it.
function clampText(text, widthPx, charPx) {
  const value = String(text === undefined || text === null ? "" : text);
  const max = Math.floor(widthPx / charPx);
  if (max < 2) return "";
  return value.length <= max ? value : value.slice(0, max - 1) + "…";
}

const nodesByGroup = new Map();
G.nodes.forEach(function (n) {
  if (!nodesByGroup.has(n.group)) nodesByGroup.set(n.group, []);
  nodesByGroup.get(n.group).push(n);
});

const groupById = new Map();
G.groups.forEach(function (g) { groupById.set(g.id, g); });

const childGroups = new Map();
G.groups.forEach(function (g) {
  if (!g.parent) return;
  if (!childGroups.has(g.parent)) childGroups.set(g.parent, []);
  childGroups.get(g.parent).push(g);
});

function gridFor(count) {
  if (count <= 0) return { cols: 0, rows: 0 };
  const cols = Math.max(1, Math.ceil(Math.sqrt(count * 1.9)));
  return { cols: cols, rows: Math.ceil(count / cols) };
}

// Measure a group: its own nodes in a grid, plus any nested subnet boxes.
function measure(group) {
  const own = nodesByGroup.get(group.id) || [];
  const kids = (childGroups.get(group.id) || []).map(measure)
    .filter(function (k) { return k.used; });

  const g = gridFor(own.length);
  const ownW = g.cols ? g.cols * NODE_W + (g.cols - 1) * 10 : 0;
  const ownH = g.rows ? g.rows * NODE_H + (g.rows - 1) * 10 : 0;

  let kidsW = 0, kidsH = 0;
  if (kids.length) {
    const perRow = Math.max(1, Math.ceil(Math.sqrt(kids.length * 1.3)));
    let rowW = 0, rowH = 0, i = 0;
    kids.forEach(function (k) {
      rowW += k.w + GAP;
      rowH = Math.max(rowH, k.h);
      i++;
      if (i % perRow === 0) { kidsW = Math.max(kidsW, rowW); kidsH += rowH + GAP; rowW = 0; rowH = 0; }
    });
    kidsW = Math.max(kidsW, rowW);
    kidsH += rowH;
  }

  const w = Math.max(ownW, kidsW, 150) + PAD * 2;
  const h = HEADER + ownH + (ownH && kidsH ? 12 : 0) + kidsH + PAD * 2;
  return {
    group: group, w: w, h: h, own: own, kids: kids, grid: g,
    used: own.length > 0 || kids.length > 0,
  };
}

function place(box, x, y, out) {
  box.x = x; box.y = y;
  out.push(box);

  let cursorY = y + HEADER + PAD;
  if (box.own.length) {
    box.own.forEach(function (n, i) {
      const col = i % box.grid.cols, row = Math.floor(i / box.grid.cols);
      n.slotX = x + PAD + col * (NODE_W + 10) + NODE_W / 2;
      n.slotY = cursorY + row * (NODE_H + 10) + NODE_H / 2;
    });
    cursorY += box.grid.rows * NODE_H + (box.grid.rows - 1) * 10 + 12;
  }

  if (box.kids.length) {
    const perRow = Math.max(1, Math.ceil(Math.sqrt(box.kids.length * 1.3)));
    let cx = x + PAD, rowH = 0, i = 0;
    box.kids.forEach(function (k) {
      place(k, cx, cursorY, out);
      cx += k.w + GAP;
      rowH = Math.max(rowH, k.h);
      i++;
      if (i % perRow === 0) { cx = x + PAD; cursorY += rowH + GAP; rowH = 0; }
    });
  }
}

const roots = G.groups.filter(function (g) { return !g.parent; }).map(measure)
  .filter(function (b) { return b.used; })
  .sort(function (a, b) { return b.w * b.h - a.w * a.h; });

const boxes = [];
(function packRoots() {
  const maxW = Math.max(1500, Math.ceil(Math.sqrt(
    roots.reduce(function (s, b) { return s + b.w * b.h; }, 0)
  ) * 1.35));
  let cx = 0, cy = 0, rowH = 0;
  roots.forEach(function (b) {
    if (cx > 0 && cx + b.w > maxW) { cx = 0; cy += rowH + GAP * 2.2; rowH = 0; }
    place(b, cx, cy, boxes);
    cx += b.w + GAP * 2.2;
    rowH = Math.max(rowH, b.h);
  });
})();

const extentW = Math.max.apply(null, boxes.map(function (b) { return b.x + b.w; }));
const extentH = Math.max.apply(null, boxes.map(function (b) { return b.y + b.h; }));

// ---- render ------------------------------------------------------------

const svg = d3.select("#canvas").append("svg");

// One shared clip, applied inside each tile's own translated space: a belt to
// clampText's braces, so an unexpected font can't spill a label over the canvas.
svg.append("defs").append("clipPath").attr("id", "tileclip")
  .append("rect")
  .attr("x", -NODE_W / 2 + 3).attr("y", -NODE_H / 2)
  .attr("width", NODE_W - 6).attr("height", NODE_H);

const root = svg.append("g");
const layerBox = root.append("g");
const layerLink = root.append("g");
const layerParticle = root.append("g");
const layerNode = root.append("g");

const zoom = d3.zoom().scaleExtent([0.12, 3.5]).on("zoom", function (event) {
  root.attr("transform", event.transform);
});
svg.call(zoom);

const boxSel = layerBox.selectAll("g.bx").data(boxes, function (d) { return d.group.id; })
  .enter().append("g").attr("class", "bx");
boxSel.append("rect")
  .attr("class", function (d) { return "boundary " + d.group.kind; })
  .attr("x", function (d) { return d.x; })
  .attr("y", function (d) { return d.y; })
  .attr("width", function (d) { return d.w; })
  .attr("height", function (d) { return d.h; });
boxSel.append("text").attr("class", "boundary-label")
  .attr("x", function (d) { return d.x + PAD; })
  .attr("y", function (d) { return d.y + 14; })
  .text(function (d) {
    return clampText(d.group.label, d.w - PAD * 2, 7.05);
  });
boxSel.append("text").attr("class", "boundary-sub")
  .attr("x", function (d) { return d.x + PAD; })
  .attr("y", function (d) { return d.y + 24; })
  .text(function (d) { return clampText(d.group.sub, d.w - PAD * 2, 5.15); });

const nodeById = new Map();
G.nodes.forEach(function (n) {
  n.x = n.slotX !== undefined ? n.slotX : extentW / 2;
  n.y = n.slotY !== undefined ? n.slotY : extentH / 2;
  nodeById.set(n.id, n);
});

const links = G.links.filter(function (l) {
  return nodeById.has(l.source) && nodeById.has(l.target);
}).map(function (l) {
  return { id: l.id, source: nodeById.get(l.source), target: nodeById.get(l.target),
           pathType: l.pathType, scope: l.scope, label: l.label };
});

const adjacency = new Map();
links.forEach(function (l) {
  if (!adjacency.has(l.source.id)) adjacency.set(l.source.id, []);
  if (!adjacency.has(l.target.id)) adjacency.set(l.target.id, []);
  adjacency.get(l.source.id).push({ other: l.target, link: l, dir: "out" });
  adjacency.get(l.target.id).push({ other: l.source, link: l, dir: "in" });
});

const linkSel = layerLink.selectAll("path").data(links, function (d) { return d.id; })
  .enter().append("path")
  .attr("class", function (d) { return "link " + d.scope + " flowing"; });

const nodeSel = layerNode.selectAll("g.node").data(G.nodes, function (d) { return d.id; })
  .enter().append("g")
  .attr("class", "node")
  .style("color", function (d) { return colourOf[d.category] || "#8b949e"; })
  .on("click", function (event, d) { event.stopPropagation(); pin(d); });

nodeSel.append("rect")
  .attr("x", -NODE_W / 2).attr("y", -NODE_H / 2)
  .attr("width", NODE_W).attr("height", NODE_H)
  .attr("stroke", function (d) { return colourOf[d.category] || "#8b949e"; });

// A tile says what the thing is, then what it is called. The full name — and
// everything else about it — belongs in the inspect pane, so the tile can
// truncate without losing anything.
const TILE_TEXT_W = NODE_W - 14;
nodeSel.append("text").attr("class", "nkind")
  .attr("x", -NODE_W / 2 + 7).attr("y", -3)
  .attr("clip-path", "url(#tileclip)")
  .text(function (d) {
    return clampText((d.kind || "").toUpperCase(), TILE_TEXT_W, 5.5);
  });
nodeSel.append("text").attr("class", "nlabel")
  .attr("x", -NODE_W / 2 + 7).attr("y", 9)
  .attr("clip-path", "url(#tileclip)")
  .text(function (d) { return clampText(d.label, TILE_TEXT_W, 5.75); });

nodeSel.call(d3.drag()
  .on("start", function (event, d) {
    if (!event.active) sim.alphaTarget(0.25).restart();
    d.fx = d.x; d.fy = d.y;
    svg.classed("dragging", true);
  })
  .on("drag", function (event, d) { d.fx = event.x; d.fy = event.y; })
  .on("end", function (event, d) {
    if (!event.active) sim.alphaTarget(0);
    d.fx = null; d.fy = null;
    svg.classed("dragging", false);
  }));

// Nodes are pulled to their computed slot; collision keeps overlapping labels
// apart and the (weak) link force lets related things lean toward each other
// without escaping their boundary box.
const sim = d3.forceSimulation(G.nodes)
  .force("slot-x", d3.forceX(function (d) { return d.slotX; }).strength(0.55))
  .force("slot-y", d3.forceY(function (d) { return d.slotY; }).strength(0.55))
  .force("collide", d3.forceCollide(NODE_W * 0.53).strength(0.85))
  .force("link", d3.forceLink(links).id(function (d) { return d.id; })
    .distance(90).strength(0.012))
  .alpha(0.9).alphaDecay(0.022)
  .on("tick", tick);

function curve(d) {
  const dx = d.target.x - d.source.x, dy = d.target.y - d.source.y;
  const dr = Math.sqrt(dx * dx + dy * dy) * 1.9;
  return "M" + d.source.x + "," + d.source.y + "A" + dr + "," + dr + " 0 0,1 " +
    d.target.x + "," + d.target.y;
}

function tick() {
  linkSel.attr("d", curve);
  nodeSel.attr("transform", function (d) { return "translate(" + d.x + "," + d.y + ")"; });
}

// ---- animated traffic --------------------------------------------------
// Particles ride the visible paths so direction of flow is readable at a
// glance: amber for anything crossing the internet, cyan for traffic that
// stays inside the VPC.

const particleLayer = layerParticle;
let particles = [];

function seedParticles() {
  particleLayer.selectAll("*").remove();
  const visible = links.filter(isLinkVisible);
  const budget = Math.min(visible.length, 220);
  const step = Math.max(1, Math.floor(visible.length / budget));
  particles = [];
  for (let i = 0; i < visible.length; i += step) {
    const l = visible[i];
    particles.push({
      link: l,
      t: Math.random(),
      speed: 0.0022 + Math.random() * 0.0026,
      el: particleLayer.append("circle")
        .attr("class", "particle").attr("r", 1.7)
        .attr("fill", l.scope === "public" ? "#f2a65a" : "#4cc9f0"),
    });
  }
}

function animate() {
  particles.forEach(function (p) {
    p.t += p.speed;
    if (p.t > 1) p.t -= 1;
    const s = p.link.source, t = p.link.target;
    const hidden = p.link.__hidden;
    p.el.attr("opacity", hidden ? 0 : (p.link.__hot ? 0.95 : 0.4))
      .attr("cx", s.x + (t.x - s.x) * p.t)
      .attr("cy", s.y + (t.y - s.y) * p.t);
  });
  requestAnimationFrame(animate);
}

// ---- filtering and selection -------------------------------------------

function activeTagKeys() {
  const keys = [];
  state.tags.forEach(function (values, key) {
    if (values && values.size) keys.push(key);
  });
  return keys;
}

/** Own-property lookup, so an inherited member can't masquerade as a tag. */
function tagValue(node, key) {
  const tags = node.tags;
  if (!tags || !Object.prototype.hasOwnProperty.call(tags, key)) return undefined;
  const value = tags[key];
  return typeof value === "string" ? value : undefined;
}

function activeTagPairs() {
  const pairs = [];
  activeTagKeys().forEach(function (key) {
    state.tags.get(key).forEach(function (value) { pairs.push([key, value]); });
  });
  return pairs;
}

function matchesTags(n) {
  const keys = activeTagKeys();
  if (!keys.length) return true;
  // The internet, PrivateLink and on-premises actors are drawn rather than
  // discovered; keeping them means a filtered view still shows how traffic
  // reaches the slice you asked for.
  if (n.alwaysVisible) return true;
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const value = tagValue(n, key);
    const wanted = value === undefined ? UNTAGGED : value;
    if (!state.tags.get(key).has(wanted)) return false;
  }
  return true;
}

function isNodeVisible(n) {
  return state.categories.has(n.category) && matchesTags(n);
}
function isLinkVisible(l) {
  return state.paths.has(l.pathType) && isNodeVisible(l.source) && isNodeVisible(l.target);
}

// A boundary with nothing left inside it is just an empty box taking up room —
// the whole point of filtering is to shrink the picture, so drop it.
function boxHasContent(box) {
  for (let i = 0; i < box.own.length; i++) {
    if (isNodeVisible(box.own[i])) return true;
  }
  for (let j = 0; j < box.kids.length; j++) {
    if (boxHasContent(box.kids[j])) return true;
  }
  return false;
}

function apply() {
  const pinnedId = state.pinned;
  const near = new Set();
  if (pinnedId) {
    near.add(pinnedId);
    (adjacency.get(pinnedId) || []).forEach(function (a) { near.add(a.other.id); });
  }

  nodeSel
    .style("display", function (d) { return isNodeVisible(d) ? null : "none"; })
    .classed("faded", function (d) { return pinnedId ? !near.has(d.id) : false; })
    .classed("hot", function (d) { return pinnedId ? near.has(d.id) : false; })
    .classed("pinned", function (d) { return d.id === pinnedId; });

  linkSel.each(function (d) {
    const visible = isLinkVisible(d);
    const hot = pinnedId && (d.source.id === pinnedId || d.target.id === pinnedId);
    d.__hidden = !visible || (pinnedId && !hot);
    d.__hot = !!hot;
  });
  linkSel
    .style("display", function (d) { return isLinkVisible(d) ? null : "none"; })
    .classed("faded", function (d) { return pinnedId && !d.__hot; })
    .classed("hot", function (d) { return !!d.__hot; });

  boxSel.style("display", function (d) {
    return state.boundaries.has(d.group.kind) && boxHasContent(d) ? null : "none";
  });

  const vn = G.nodes.filter(isNodeVisible).length;
  const vl = links.filter(isLinkVisible).length;
  document.getElementById("stat-objects").textContent = vn;
  document.getElementById("stat-paths").textContent = vl;

  const pairs = activeTagPairs();
  const scope = document.getElementById("scope-label");
  if (scope) {
    scope.textContent = pairs.length
      ? pairs.slice(0, 3).map(function (p) {
        return (p[0] + "=" + (p[1] === UNTAGGED ? "untagged" : p[1])).toUpperCase();
      }).join(" + ") + (pairs.length > 3 ? " +" + (pairs.length - 3) + " MORE" : "")
      : "FULL TOPOLOGY";
  }
  const badge = document.getElementById("tag-badge");
  if (badge) {
    badge.textContent = pairs.length;
    badge.classList.toggle("show", pairs.length > 0);
  }
  const total = document.getElementById("stat-total");
  if (total) {
    total.style.display = vn < G.nodes.length ? null : "none";
    total.textContent = "of " + G.nodes.length;
  }
}

function pin(node) {
  state.pinned = state.pinned === node.id ? null : node.id;
  apply();
  renderInspect(state.pinned ? node : null);
}

svg.on("click", function () {
  if (!state.pinned) return;
  state.pinned = null; apply(); renderInspect(null);
});

function renderInspect(node) {
  const host = document.getElementById("inspect");
  if (!node) {
    host.innerHTML = '<div class="inspect-empty">Click any object to inspect it — ' +
      'its details and every path in and out.</div>';
    return;
  }
  const cat = G.categories.find(function (c) { return c.key === node.category; });
  const colour = colourOf[node.category] || "#8b949e";
  // The tile truncates; this pane is where the whole name lives.
  let html = '<div class="inspect"><h2>' + esc(node.label) + "</h2>" +
    '<div class="kind" style="color:' + colour + '">' +
    esc(node.kind || (cat ? cat.label : node.category)) +
    (node.sub ? ' <span class="kindsub">· ' + esc(node.sub) + "</span>" : "") +
    "</div><dl class=\"kv\">";
  node.detail.forEach(function (row) {
    html += "<dt>" + esc(row[0]) + "</dt><dd>" + esc(row[1]) + "</dd>";
  });
  html += "</dl>";

  // Tags double as filter controls: clicking one narrows the whole diagram to
  // everything sharing it, which is the fastest route from "what is this?" to
  // "show me the rest of this service".
  const nodeTags = node.tags || {};
  const tagKeys = Object.keys(nodeTags).sort();
  if (tagKeys.length) {
    html += '<div class="paths-title">Tags (' + tagKeys.length +
      ") — click to filter</div><div class=\"chips\">";
    tagKeys.forEach(function (key) {
      // Keys the rail doesn't offer — Name and friends — are shown but inert:
      // filtering on one leaves a single object and no way to see why.
      if (!facetKeys.has(key)) {
        html += '<div class="chip inert">' + esc(key) + "=" +
          esc(nodeTags[key]) + "</div>";
        return;
      }
      const chosen = state.tags.get(key);
      const on = !!(chosen && chosen.has(nodeTags[key]));
      html += '<div class="chip' + (on ? " active" : "") + '" data-tagkey="' +
        esc(key) + '" data-tagval="' + esc(nodeTags[key]) + '">' +
        esc(key) + "=" + esc(nodeTags[key]) + "</div>";
    });
    html += "</div>";
  }

  const edges = (adjacency.get(node.id) || []).filter(function (a) {
    return isLinkVisible(a.link);
  });
  html += '<div class="paths-title">Paths (' + edges.length + ")</div>";
  edges.slice(0, 60).forEach(function (a) {
    html += '<div class="path-item" data-goto="' + esc(a.other.id) + '">' +
      '<span class="dir">' + (a.dir === "out" ? "→" : "←") + "</span>" +
      "<span>" + esc(a.other.label) + "</span>" +
      (a.link.label ? '<span class="port">[' + esc(a.link.label) + "]</span>" : "") +
      "</div>";
  });
  if (edges.length > 60) {
    html += '<div class="path-item">… ' + (edges.length - 60) + " more</div>";
  }
  html += "</div>";
  host.innerHTML = html;

  host.querySelectorAll("[data-goto]").forEach(function (el) {
    el.addEventListener("click", function () {
      const target = nodeById.get(el.getAttribute("data-goto"));
      if (target) { pin(target); focusOn(target); }
    });
  });

  host.querySelectorAll("[data-tagkey]").forEach(function (el) {
    el.addEventListener("click", function () {
      showTab("tags");
      toggleTag(el.getAttribute("data-tagkey"), el.getAttribute("data-tagval"));
    });
  });
}

function focusOn(node) {
  const box = svg.node().getBoundingClientRect();
  svg.transition().duration(600).call(
    zoom.transform,
    d3.zoomIdentity.translate(box.width / 2, box.height / 2).scale(1.1)
      .translate(-node.x, -node.y)
  );
}

function esc(value) {
  return String(value === undefined || value === null ? "" : value)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---- filter rail --------------------------------------------------------

function buildRail() {
  const counts = {};
  G.nodes.forEach(function (n) { counts[n.category] = (counts[n.category] || 0) + 1; });
  const pathCounts = {};
  links.forEach(function (l) { pathCounts[l.pathType] = (pathCounts[l.pathType] || 0) + 1; });

  let html = '<div class="btnrow">' +
    '<button class="btn" data-all="1">All</button>' +
    '<button class="btn" data-none="1">None</button>' +
    '<button class="btn" data-paths="1">Paths</button></div>';

  html += '<div class="grouplabel">Object category</div>';
  G.categories.forEach(function (c) {
    if (!counts[c.key]) return;
    html += '<div class="check on" data-cat="' + c.key + '" style="color:' + c.colour + '">' +
      '<span class="box"></span><span>' + esc(c.label) + '</span>' +
      '<span class="count">' + counts[c.key] + "</span></div>";
  });

  html += '<div class="grouplabel">Path type</div>';
  G.pathTypes.forEach(function (p) {
    if (!pathCounts[p.key]) return;
    html += '<div class="check on" data-path="' + p.key + '">' +
      '<span class="box"></span><span>' + esc(p.label) + '</span>' +
      '<span class="count">' + pathCounts[p.key] + "</span></div>";
  });

  html += '<div class="grouplabel">Boundaries</div>';
  [["vpc", "VPCs (dashed)"], ["subnet", "Subnets (dotted)"], ["external", "External (dash-dot)"]]
    .forEach(function (b) {
      html += '<div class="check on" data-boundary="' + b[0] + '">' +
        '<span class="box"></span><span>' + b[1] + "</span></div>";
    });

  const rail = document.getElementById("filters");
  rail.innerHTML = html;

  rail.querySelectorAll("[data-cat],[data-path],[data-boundary]").forEach(function (el) {
    el.addEventListener("click", function () {
      const on = el.classList.toggle("on");
      el.classList.toggle("off", !on);
      const cat = el.getAttribute("data-cat");
      const path = el.getAttribute("data-path");
      const boundary = el.getAttribute("data-boundary");
      if (cat) { on ? state.categories.add(cat) : state.categories.delete(cat); }
      if (path) { on ? state.paths.add(path) : state.paths.delete(path); }
      if (boundary) { on ? state.boundaries.add(boundary) : state.boundaries.delete(boundary); }
      apply(); seedParticles();
    });
  });

  rail.querySelector("[data-all]").addEventListener("click", function () { setAll(true); });
  rail.querySelector("[data-none]").addEventListener("click", function () { setAll(false); });
  rail.querySelector("[data-paths]").addEventListener("click", function () {
    // "Paths" strips the scaffolding — boundaries and membership lines — so only
    // real traffic remains.
    state.boundaries.clear();
    state.paths = new Set(G.pathTypes.map(function (p) { return p.key; }));
    state.paths.delete("member");
    syncRail(); apply(); seedParticles();
  });

  function setAll(on) {
    if (on) {
      state.categories = new Set(G.categories.map(function (c) { return c.key; }));
      state.paths = new Set(G.pathTypes.map(function (p) { return p.key; }));
      state.boundaries = new Set(["vpc", "subnet", "external"]);
    } else {
      state.categories.clear(); state.paths.clear(); state.boundaries.clear();
    }
    syncRail(); apply(); seedParticles();
  }

  function syncRail() {
    rail.querySelectorAll("[data-cat]").forEach(function (el) {
      const on = state.categories.has(el.getAttribute("data-cat"));
      el.classList.toggle("on", on); el.classList.toggle("off", !on);
    });
    rail.querySelectorAll("[data-path]").forEach(function (el) {
      const on = state.paths.has(el.getAttribute("data-path"));
      el.classList.toggle("on", on); el.classList.toggle("off", !on);
    });
    rail.querySelectorAll("[data-boundary]").forEach(function (el) {
      const on = state.boundaries.has(el.getAttribute("data-boundary"));
      el.classList.toggle("on", on); el.classList.toggle("off", !on);
    });
  }
}

// ---- tag rail -----------------------------------------------------------
// A whole-region diagram is only digestible once you can cut it to one
// environment or one service, so tags get their own tab: keys ranked by how
// useful they are to slice on, values offered as facets with counts.

const tagOpen = new Map();
const tagExpanded = new Set();
let tagQuery = "";

// How many objects lack each key entirely — offered as "(no X tag)" so
// filtering never hides infrastructure with no way to ask for it back.
const untaggedCounts = new Map();
facets.forEach(function (f) {
  let missing = 0;
  G.nodes.forEach(function (n) {
    if (n.alwaysVisible) return;
    if (tagValue(n, f.key) === undefined) missing++;
  });
  untaggedCounts.set(f.key, missing);
});

function toggleTag(key, value) {
  if (!key || value === null || value === undefined) return;
  let chosen = state.tags.get(key);
  if (!chosen) { chosen = new Set(); state.tags.set(key, chosen); }
  if (chosen.has(value)) chosen.delete(value);
  else { chosen.add(value); tagOpen.set(key, true); }
  if (!chosen.size) state.tags.delete(key);
  afterTagChange();
}

function afterTagChange() {
  renderTagList();
  apply();
  seedParticles();
  // A pinned object can fall outside the new slice; leaving it pinned would
  // keep the rest of the diagram faded against something no longer drawn.
  if (state.pinned) {
    const node = nodeById.get(state.pinned);
    if (!node || !isNodeVisible(node)) {
      state.pinned = null;
      apply();
      renderInspect(null);
    } else {
      renderInspect(node);
    }
  }
  fitVisible(true);
}

function tagCheck(key, value, label, count, on, extra) {
  return '<div class="check ' + (on ? "on" : "off") + (extra || "") +
    '" data-tagkey="' + esc(key) + '" data-tagval="' + esc(value) + '">' +
    '<span class="box"></span><span class="val">' + esc(label) + "</span>" +
    '<span class="count">' + count + "</span></div>";
}

function renderActiveChips() {
  const host = document.getElementById("tagactive");
  if (!host) return;
  const pairs = activeTagPairs();
  if (!pairs.length) { host.innerHTML = ""; return; }
  host.innerHTML = '<div class="chips">' + pairs.map(function (p) {
    return '<div class="chip active" data-tagkey="' + esc(p[0]) +
      '" data-tagval="' + esc(p[1]) + '">' + esc(p[0]) + "=" +
      esc(p[1] === UNTAGGED ? "untagged" : p[1]) + "</div>";
  }).join("") + "</div>";
  bindTagToggles(host);
}

function bindTagToggles(host) {
  host.querySelectorAll("[data-tagkey]").forEach(function (el) {
    el.addEventListener("click", function () {
      toggleTag(el.getAttribute("data-tagkey"), el.getAttribute("data-tagval"));
    });
  });
}

function renderTagList() {
  const list = document.getElementById("taglist");
  if (!list) return;

  let html = "";
  let shown = 0;
  facets.forEach(function (f) {
    const keyMatches = !tagQuery || f.key.toLowerCase().indexOf(tagQuery) !== -1;
    const values = f.values.filter(function (v) {
      return keyMatches || v.value.toLowerCase().indexOf(tagQuery) !== -1;
    });
    if (!values.length) return;
    shown++;

    const chosen = state.tags.get(f.key);
    const active = !!(chosen && chosen.size);
    const open = !!tagOpen.get(f.key) || (tagQuery !== "");
    html += '<div class="tagkey' + (active ? " active" : "") +
      '" data-tagsection="' + esc(f.key) + '">' +
      '<span class="caret">' + (open ? "▾" : "▸") + "</span><span>" +
      esc(f.key) + '</span><span class="n">' +
      (active ? chosen.size + " / " : "") + f.values.length + "</span></div>";
    if (!open) return;

    const limit = tagExpanded.has(f.key)
      ? values.length
      : Math.min(values.length, TAG_VALUE_LIMIT);
    for (let i = 0; i < limit; i++) {
      const v = values[i];
      html += tagCheck(
        f.key, v.value, v.value, v.count, !!(chosen && chosen.has(v.value)), "",
      );
    }
    if (limit < values.length) {
      html += '<div class="more" data-tagmore="' + esc(f.key) + '">+ ' +
        (values.length - limit) + " more</div>";
    }
    if (untaggedCounts.get(f.key) && keyMatches) {
      html += tagCheck(
        f.key, UNTAGGED, "(no " + f.key + " tag)", untaggedCounts.get(f.key),
        !!(chosen && chosen.has(UNTAGGED)), " untagged",
      );
    }
  });

  list.innerHTML = shown
    ? html
    : '<div class="inspect-empty">Nothing matches that search.</div>';

  list.querySelectorAll("[data-tagsection]").forEach(function (el) {
    el.addEventListener("click", function () {
      const key = el.getAttribute("data-tagsection");
      tagOpen.set(key, !tagOpen.get(key));
      renderTagList();
    });
  });
  list.querySelectorAll("[data-tagmore]").forEach(function (el) {
    el.addEventListener("click", function () {
      tagExpanded.add(el.getAttribute("data-tagmore"));
      renderTagList();
    });
  });
  bindTagToggles(list);
  renderActiveChips();
}

function mountTagRail() {
  const host = document.getElementById("tagfilters");
  if (!facets.length) {
    host.innerHTML = '<div class="inspect-empty">No tags were found on the ' +
      "discovered resources. Tag them with something like Environment or " +
      "Service and the next run will let you slice the diagram by it.</div>";
    return;
  }

  host.innerHTML =
    '<input class="tagsearch" id="tagsearch" placeholder="search keys and values">' +
    '<div class="btnrow"><button class="btn" data-tagclear="1">Clear</button>' +
    '<button class="btn" data-tagfit="1">Fit view</button></div>' +
    '<div id="tagactive"></div><div id="taglist"></div>';

  const search = document.getElementById("tagsearch");
  search.addEventListener("input", function () {
    tagQuery = search.value.trim().toLowerCase();
    renderTagList();
  });
  host.querySelector("[data-tagclear]").addEventListener("click", function () {
    state.tags = new Map();
    afterTagChange();
  });
  host.querySelector("[data-tagfit]").addEventListener("click", function () {
    fitVisible(true);
  });

  // The first couple of keys are the ones worth slicing on; the rest stay
  // folded so a busy tagging convention doesn't bury them.
  facets.forEach(function (f, i) { tagOpen.set(f.key, i < 2); });
  renderTagList();
}

function showTab(name) {
  document.querySelectorAll("[data-tab]").forEach(function (el) {
    el.classList.toggle("on", el.getAttribute("data-tab") === name);
  });
  document.getElementById("filters").hidden = name !== "objects";
  document.getElementById("tagfilters").hidden = name !== "tags";
}

function bindTabs() {
  document.querySelectorAll("[data-tab]").forEach(function (el) {
    el.addEventListener("click", function () {
      showTab(el.getAttribute("data-tab"));
    });
  });
}

/** Zoom to what is actually on screen, so a filtered view fills the canvas. */
function fitVisible(animated) {
  const box = svg.node().getBoundingClientRect();
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  G.nodes.forEach(function (n) {
    if (!isNodeVisible(n)) return;
    if (n.x - NODE_W / 2 < minX) minX = n.x - NODE_W / 2;
    if (n.y - NODE_H / 2 < minY) minY = n.y - NODE_H / 2;
    if (n.x + NODE_W / 2 > maxX) maxX = n.x + NODE_W / 2;
    if (n.y + NODE_H / 2 > maxY) maxY = n.y + NODE_H / 2;
  });
  if (minX === Infinity) { fit(); return; }

  const pad = 44;
  minX -= pad; minY -= pad; maxX += pad; maxY += pad;
  const w = Math.max(1, maxX - minX), h = Math.max(1, maxY - minY);
  const scale = Math.min(box.width / w, box.height / h, 1.6);
  const transform = d3.zoomIdentity
    .translate(
      (box.width - w * scale) / 2 - minX * scale,
      (box.height - h * scale) / 2 - minY * scale,
    )
    .scale(scale);
  if (animated) svg.transition().duration(520).call(zoom.transform, transform);
  else svg.call(zoom.transform, transform);
}

function fit() {
  const box = svg.node().getBoundingClientRect();
  const scale = Math.min(box.width / (extentW + 60), box.height / (extentH + 60), 1);
  svg.call(zoom.transform, d3.zoomIdentity
    .translate((box.width - extentW * scale) / 2, (box.height - extentH * scale) / 2)
    .scale(scale));
}

buildRail();
bindTabs();
mountTagRail();
showTab("objects");
apply();
seedParticles();
renderInspect(null);
fit();
animate();
window.addEventListener("resize", fit);
`;

/** Render the complete standalone HTML document for a topology graph. */
export function renderDiagram(
  graph: TopologyGraph,
  d3Source: { inline?: string; url: string },
): string {
  const generated = graph.meta.generatedAt.replace("T", " ").slice(0, 16);
  const revision = graph.meta.generatedAt.slice(0, 10).replace(/-/g, ".");
  const regionUpper = graph.meta.region.toUpperCase();

  const nodeCount = graph.nodes.length;
  const linkCount = graph.links.length;
  const vpcCount = graph.groups.filter((g) => g.kind === "vpc").length;
  const subnetCount = graph.groups.filter((g) => g.kind === "subnet").length;

  const domainLine = graph.meta.domains
    .map((d) =>
      d.stale
        ? `<span class="stale">${d.domain} ${d.resourceCount} (stale)</span>`
        : `${d.domain} <b>${d.resourceCount}</b>`
    )
    .join(" · ");

  const staleBanner = graph.meta.staleDomains.length
    ? `<div class="stalebar">⚠ STALE DATA — ${
      graph.meta.staleDomains.map(escapeHtml).join(", ")
    } did not refresh in this run. Those parts of the diagram show the last successful discovery, not the estate as of now.</div>`
    : "";

  const warningBlock = graph.meta.warnings.length
    ? `<p class="warn">Incomplete: ${
      graph.meta.warnings.map(escapeHtml).join(" ")
    }</p>`
    : "";

  const d3Tag = d3Source.inline
    ? `<script>${d3Source.inline}</script>`
    : `<script src="${d3Source.url}"></script>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AWS Architecture — ${escapeHtml(regionUpper)} — ${
    escapeHtml(revision)
  }</title>
<style>${STYLES}</style>
</head>
<body>
<div class="shell">
  <div class="statusbar">
    <span>SWAMP // AWS ESTATE // ${
    escapeHtml(regionUpper)
  } // <span id="scope-label">FULL TOPOLOGY</span></span>
    <span class="live">GENERATED ${escapeHtml(generated)} UTC</span>
  </div>
  ${staleBanner}

  <div class="masthead">
    <div class="crumb">
      <span class="dot"></span><span>DOC / AWS-ESTATE</span>
      <span class="accent">REV ${escapeHtml(revision)}</span>
    </div>
    <h1>AWS Architecture — ${escapeHtml(regionUpper)}</h1>
    <div class="subtitle">
      REGION <b>${escapeHtml(graph.meta.region)}</b> ·
      VPCS <b>${vpcCount}</b> · SUBNETS <b>${subnetCount}</b> ·
      OBJECTS <b>${nodeCount}</b> · PATHS <span class="cy">${linkCount}</span> ·
      DISCOVERED ${domainLine}
    </div>
  </div>

  <div class="workspace">
    <div class="pane">
      <div class="pane-title"><span class="n">01</span><span>Filter</span></div>
      <div class="tabs">
        <button class="tab on" data-tab="objects">Objects</button>
        <button class="tab" data-tab="tags">Tags<span class="badge" id="tag-badge"></span></button>
      </div>
      <div class="pane-body" id="filters"></div>
      <div class="pane-body" id="tagfilters" hidden></div>
    </div>
    <div class="pane">
      <div class="pane-title">
        <span class="n">02</span><span>Topology</span>
        <span class="hint">drag nodes · scroll to zoom · click node = pin</span>
      </div>
      <div id="canvas"></div>
    </div>
    <div class="pane">
      <div class="pane-title"><span class="n">03</span><span>Inspect</span></div>
      <div class="pane-body" id="inspect"></div>
    </div>
  </div>

  <div class="footer">
    <span>objects <span class="k" id="stat-objects">0</span>
      <span id="stat-total" style="display:none"></span></span>
    <span>paths <span class="k" id="stat-paths">0</span></span>
    <span>traffic flows toward target</span>
    <div class="legend">
      <span style="color:#f2a65a"><i></i>public (internet)</span>
      <span style="color:#4cc9f0"><i></i>private (VPC)</span>
      ${
    graph.categories.map((c) =>
      `<span style="color:${c.colour}"><i></i>${escapeHtml(c.label)}</span>`
    ).join("\n      ")
  }
    </div>
  </div>

  <div class="asbuilt">
    <b>AS-BUILT</b> — discovered from the live AWS account via swamp on
    ${escapeHtml(generated)} UTC, region <b>${
    escapeHtml(graph.meta.region)
  }</b>.
    Boundaries: VPCs (dashed) contain subnets (dotted), each labelled with its AZ,
    CIDR and whether its route table reaches an internet gateway.
    <span class="pub">Public</span> paths cross the internet — inbound through an
    internet gateway to an internet-facing load balancer, outbound via NAT or
    directly from a public subnet. <span class="priv">Private</span> paths stay
    inside AWS — listener to target group to compute, and VPC endpoints reaching
    AWS services over PrivateLink without touching the internet. Egress lines are
    read from real route table entries, not inferred.
    The <b>Tags</b> filter cuts the picture down to one environment or service;
    objects carrying no such tag can be added back with the "(no … tag)" option,
    boundaries left empty stop being drawn, and the header above records whichever
    slice is on screen so a screenshot says what it shows. ${warningBlock}
  </div>
</div>

${d3Tag}
<script>window.__TOPOLOGY__ = ${embedJson(graph)};</script>
<script>${SCRIPT}</script>
</body>
</html>
`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
