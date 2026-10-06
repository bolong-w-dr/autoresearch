// Dependency-free SVG chart of val_bpb per experiment, in the spirit of
// analysis.ipynb: kept experiments are prominent, discarded are faint, and a
// step line tracks the running best.

const NS = "http://www.w3.org/2000/svg";

function el(tag, attrs = {}, text) {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text !== undefined) node.textContent = text;
  return node;
}

export function renderProgressChart(container, experiments, { direction = "min" } = {}) {
  container.innerHTML = "";
  const points = experiments.filter((e) => typeof e.val_bpb === "number");
  if (points.length === 0) {
    container.innerHTML = '<div class="empty">No completed experiments yet.</div>';
    return;
  }

  const width = Math.max(480, container.clientWidth || 900);
  const height = 320;
  const pad = { top: 16, right: 20, bottom: 36, left: 70 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;

  const xs = experiments.map((e) => e.index);
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs, xMin + 1);
  const values = points.map((p) => p.val_bpb);
  const baseline = experiments.find((e) => e.index === 0 && typeof e.val_bpb === "number");
  // Focus the y-range around the interesting region (around/below baseline), like the notebook.
  let yLo = Math.min(...values);
  let yHi = Math.max(...values);
  if (baseline) {
    const window = Math.max(Math.abs(baseline.val_bpb - yLo) * 1.6, 0.004);
    yHi = Math.min(yHi, baseline.val_bpb + window * 0.35);
    yLo = Math.min(yLo, baseline.val_bpb - window);
  }
  if (yHi - yLo < 1e-6) {
    yHi += 0.005;
    yLo -= 0.005;
  }
  const margin = (yHi - yLo) * 0.08;
  yLo -= margin;
  yHi += margin;

  const x = (i) => pad.left + ((i - xMin) / (xMax - xMin)) * innerW;
  const y = (v) => pad.top + (1 - (v - yLo) / (yHi - yLo)) * innerH;

  const svg = el("svg", { class: "chart", viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: "none", role: "img" });
  svg.appendChild(el("title", {}, "val_bpb per experiment"));

  // Grid + y axis labels
  const ticks = 6;
  for (let t = 0; t <= ticks; t++) {
    const v = yLo + ((yHi - yLo) * t) / ticks;
    svg.appendChild(el("line", { class: "grid-line", x1: pad.left, x2: width - pad.right, y1: y(v), y2: y(v) }));
    svg.appendChild(el("text", { x: pad.left - 8, y: y(v) + 4, "text-anchor": "end" }, v.toFixed(4)));
  }
  // x axis labels
  const step = Math.max(1, Math.ceil((xMax - xMin) / 12));
  for (let i = xMin; i <= xMax; i += step) {
    svg.appendChild(el("text", { x: x(i), y: height - pad.bottom + 18, "text-anchor": "middle" }, `#${i}`));
  }
  svg.appendChild(el("text", { x: pad.left + innerW / 2, y: height - 4, "text-anchor": "middle" }, "experiment"));
  svg.appendChild(el("line", { class: "axis", x1: pad.left, x2: pad.left, y1: pad.top, y2: height - pad.bottom }));
  svg.appendChild(el("line", { class: "axis", x1: pad.left, x2: width - pad.right, y1: height - pad.bottom, y2: height - pad.bottom }));

  if (baseline) {
    svg.appendChild(el("line", { class: "baseline", x1: pad.left, x2: width - pad.right, y1: y(baseline.val_bpb), y2: y(baseline.val_bpb) }));
  }

  // Running-best frontier (step line through kept experiments)
  const kept = points.filter((p) => p.status === "keep").sort((a, b) => a.index - b.index);
  if (kept.length > 0) {
    let best = kept[0].val_bpb;
    const d = [`M ${x(kept[0].index)} ${y(best)}`];
    for (let i = 1; i < kept.length; i++) {
      best = direction === "min" ? Math.min(best, kept[i].val_bpb) : Math.max(best, kept[i].val_bpb);
      d.push(`H ${x(kept[i].index)}`, `V ${y(best)}`);
    }
    d.push(`H ${x(xMax)}`);
    svg.appendChild(el("path", { class: "frontier", d: d.join(" ") }));
  }

  // Points
  for (const p of points) {
    const yy = Math.min(Math.max(y(p.val_bpb), pad.top), height - pad.bottom);
    const r = p.status === "keep" ? 5 : 3.5;
    const circle = el("circle", { class: `pt-${p.status}`, cx: x(p.index), cy: yy, r });
    circle.appendChild(el("title", {}, `#${p.index} ${p.status}: ${p.val_bpb.toFixed(6)} — ${p.description}`));
    svg.appendChild(circle);
  }
  // Crashes have no value; mark them at the top edge.
  for (const e of experiments.filter((e) => e.status === "crash")) {
    const c = el("circle", { class: "pt-crash", cx: x(e.index), cy: pad.top + 4, r: 3.5 });
    c.appendChild(el("title", {}, `#${e.index} crash — ${e.description}`));
    svg.appendChild(c);
  }
  for (const e of experiments.filter((e) => e.status === "running")) {
    const c = el("circle", { class: "pt-running pulse", cx: x(e.index), cy: height - pad.bottom - 6, r: 4 });
    c.appendChild(el("title", {}, `#${e.index} running — ${e.description}`));
    svg.appendChild(c);
  }

  container.appendChild(svg);
  const legend = document.createElement("div");
  legend.className = "legend";
  legend.innerHTML =
    '<span class="l-keep">kept</span><span class="l-discard">discarded</span><span class="l-crash">crash</span>' +
    '<span class="l-running">running</span><span class="l-baseline">baseline</span>';
  container.appendChild(legend);
}
