import { api, newRequestId } from "./lib/api.js";
import { renderProgressChart } from "./lib/chart.js";
import { validate } from "./lib/validate.js";

const cfg = window.AUTORESEARCH_CONFIG || {};
const app = document.getElementById("app");
const state = { index: null, me: null, schema: null, commandSchema: null, timer: null };

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmtNum = (v, d = 6) => (typeof v === "number" ? v.toFixed(d) : "—");
const fmtDelta = (v) => (typeof v === "number" ? (v > 0 ? "+" : "") + v.toFixed(6) : "—");
const badge = (s) => `<span class="badge badge-${esc(s)}">${esc(s)}</span>`;
const TERMINAL = new Set(["completed", "stopped", "cancelled", "failed"]);

function fmtTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return isNaN(d) ? "—" : d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function ago(iso) {
  if (!iso) return "never";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${Math.round(s)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${(s / 3600).toFixed(1)}h ago`;
  return `${(s / 86400).toFixed(1)}d ago`;
}

function duration(startIso, endIso) {
  if (!startIso) return "—";
  const end = endIso ? new Date(endIso) : new Date();
  const s = Math.max(0, (end - new Date(startIso)) / 1000);
  if (s < 90) return `${Math.round(s)}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  return `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`;
}

function toast(message, kind = "ok") {
  const node = document.createElement("div");
  node.className = `toast ${kind}`;
  node.textContent = message;
  document.getElementById("toasts").appendChild(node);
  setTimeout(() => node.remove(), 6000);
}

function setActiveNav(route) {
  document.querySelectorAll(".nav a").forEach((a) => a.classList.toggle("active", a.dataset.route === route));
}

function updateServicePill() {
  const pill = document.getElementById("service-pill");
  const svc = state.index && state.index.service;
  if (!svc) {
    pill.className = "pill pill-bad";
    pill.innerHTML = '<span class="dot"></span>service unreachable';
    return;
  }
  const ageSec = (Date.now() - new Date(svc.last_heartbeat).getTime()) / 1000;
  const stale = ageSec > 180;
  pill.className = `pill ${stale ? "pill-warn" : "pill-ok"}`;
  pill.innerHTML = `<span class="dot ${stale ? "" : "pulse"}"></span>${esc(svc.host)} · heartbeat ${ago(svc.last_heartbeat)}`;
}

async function sendCommand(command, label) {
  const body = { schema_version: "1", request_id: newRequestId(), issued_at: new Date().toISOString(), ...command };
  if (state.me && state.me.user && !body.issued_by) body.issued_by = state.me.user;
  try {
    const res = await api.sendCommand(body);
    toast(`${label}: queued (${res.request_id || body.request_id})`, "ok");
    return res;
  } catch (err) {
    toast(`${label} failed: ${err.message}`, "bad");
    throw err;
  }
}

// ---------------------------------------------------------------------------
// data loading
// ---------------------------------------------------------------------------

async function loadIndex() {
  try {
    state.index = await api.index();
  } catch (err) {
    state.index = null;
    console.warn(err);
  }
  updateServicePill();
}

async function ensureSchema() {
  if (!state.schema) state.schema = await api.missionSchema();
  return state.schema;
}

// ---------------------------------------------------------------------------
// views
// ---------------------------------------------------------------------------

function viewOverview() {
  setActiveNav("overview");
  const idx = state.index;
  if (!idx) {
    app.innerHTML = `<div class="error-box">Could not load <code>${esc(cfg.dataBaseUrl)}/index.json</code>. Is the service running and publishing to this bucket?</div>`;
    return;
  }
  const svc = idx.service;
  const missions = idx.missions || [];
  const current = missions.find((m) => m.mission_id === svc.current_mission_id);
  const last = svc.last_command;
  const stateFilter = app.dataset.stateFilter || "";
  const search = app.dataset.search || "";
  const filtered = missions.filter((m) => (!stateFilter || m.state === stateFilter) && (!search || `${m.name} ${m.tag} ${m.mission_id} ${(m.tags || []).join(" ")} ${m.requested_by || ""}`.toLowerCase().includes(search.toLowerCase())));
  const states = [...new Set(missions.map((m) => m.state))].sort();

  app.innerHTML = `
    <div class="page-head"><h1>Overview</h1><span class="muted">updated ${ago(idx.generated_at)}</span><span class="spacer"></span>
      <a class="btn btn-primary" href="#/new">New mission</a></div>
    <div class="grid cards">
      <div class="card"><div class="label">Service</div><div class="value small">${esc(svc.host)}</div><div class="sub">${esc(svc.service_id)} · v${esc(svc.version)}</div></div>
      <div class="card"><div class="label">GPU</div><div class="value small">${esc(svc.gpu || "not detected")}</div><div class="sub">up since ${fmtTime(svc.started_at)}</div></div>
      <div class="card"><div class="label">Current mission</div><div class="value small">${current ? `<a href="#/missions/${esc(current.mission_id)}">${esc(current.name)}</a>` : '<span class="muted">idle</span>'}</div><div class="sub">${current ? `${current.num_experiments} experiments · ${badge(current.state)}` : "waiting for commands"}</div></div>
      <div class="card"><div class="label">Queued</div><div class="value">${svc.queued_mission_ids.length}</div><div class="sub">missions waiting for the GPU</div></div>
      <div class="card"><div class="label">Commands</div><div class="value">${svc.commands_processed}</div><div class="sub">${last ? `last: <code>${esc(last.command)}</code> ${last.ok ? "ok" : '<span class="badge badge-crash">error</span>'} · ${ago(last.received_at)}` : "none yet"}</div></div>
      <div class="card"><div class="label">Missions</div><div class="value">${missions.length}</div><div class="sub">${missions.filter((m) => m.state === "completed").length} completed · ${missions.filter((m) => m.state === "failed").length} failed</div></div>
    </div>

    <div class="section">
      <h2>Mission history</h2>
      <div class="filters">
        <input id="f-search" type="search" placeholder="Search name, tag, id, requester…" value="${esc(search)}" />
        <select id="f-state"><option value="">All states</option>${states.map((s) => `<option value="${esc(s)}" ${s === stateFilter ? "selected" : ""}>${esc(s)}</option>`).join("")}</select>
        <span class="muted">${filtered.length} of ${missions.length}</span>
      </div>
      ${filtered.length === 0 ? '<div class="empty">No missions yet. Create one from <a href="#/new">New mission</a> or publish a <code>start_mission</code> command to the queue.</div>' : `
      <div class="table-wrap"><table>
        <thead><tr><th>Mission</th><th>State</th><th>Strategy</th><th class="num">Experiments</th><th class="num">Baseline</th><th class="num">Best</th><th class="num">Δ</th><th>Requested by</th><th>Created</th><th>Duration</th></tr></thead>
        <tbody>${filtered.map((m) => {
          const c = m.experiment_counts || {};
          const delta = typeof m.best_val_bpb === "number" && typeof m.baseline_val_bpb === "number" ? m.best_val_bpb - m.baseline_val_bpb : null;
          return `<tr class="clickable" data-href="#/missions/${esc(m.mission_id)}">
            <td><div><a href="#/missions/${esc(m.mission_id)}">${esc(m.name)}</a></div><div class="muted mono">${esc(m.tag)} · ${esc(m.mission_id)}</div>${(m.tags || []).length ? `<div class="chips" style="margin-top:4px">${m.tags.map((t) => `<span class="chip">${esc(t)}</span>`).join("")}</div>` : ""}</td>
            <td>${badge(m.state)}</td>
            <td class="muted">${esc(m.strategy)}</td>
            <td class="num" title="keep / discard / crash">${m.num_experiments} <span class="muted">(${c.keep || 0}/${c.discard || 0}/${c.crash || 0})</span></td>
            <td class="num">${fmtNum(m.baseline_val_bpb)}</td>
            <td class="num">${fmtNum(m.best_val_bpb)}</td>
            <td class="num" style="color:${delta < 0 ? "var(--keep)" : "inherit"}">${fmtDelta(delta)}</td>
            <td class="muted">${esc(m.requested_by || "—")}</td>
            <td class="muted">${fmtTime(m.created_at)}</td>
            <td class="muted">${duration(m.started_at, m.finished_at)}</td></tr>`;
        }).join("")}</tbody></table></div>`}
    </div>`;

  app.querySelector("#f-search").addEventListener("input", (e) => { app.dataset.search = e.target.value; viewOverview(); app.querySelector("#f-search").focus(); });
  app.querySelector("#f-state").addEventListener("change", (e) => { app.dataset.stateFilter = e.target.value; viewOverview(); });
  app.querySelectorAll("tr.clickable").forEach((tr) => tr.addEventListener("click", (e) => { if (e.target.tagName !== "A") location.hash = tr.dataset.href; }));
}

async function viewMission(id) {
  setActiveNav("overview");
  const record = await api.mission(id);
  if (!record) {
    app.innerHTML = `<div class="page-head"><h1>Mission not found</h1></div><div class="empty">No record for <code>${esc(id)}</code> in the result store.</div>`;
    return;
  }
  const m = record.mission;
  const exps = record.experiments || [];
  const best = record.best;
  const improvement = best && typeof record.baseline_val_bpb === "number" ? record.baseline_val_bpb - best.val_bpb : null;
  const counts = exps.reduce((acc, e) => ((acc[e.status] = (acc[e.status] || 0) + 1), acc), {});
  const canPause = record.state === "running";
  const canResume = record.state === "paused";
  const canStop = ["running", "paused"].includes(record.state);
  const canCancel = !TERMINAL.has(record.state);
  const direction = (m.keep_policy && m.keep_policy.direction) || "min";

  app.innerHTML = `
    <div class="page-head">
      <h1>${esc(m.name)}</h1>${badge(record.state)}
      <span class="muted mono">${esc(m.mission_id)}</span>
      <span class="spacer"></span>
      <div class="btn-group">
        <button class="btn btn-sm" data-cmd="pause_mission" ${canPause ? "" : "disabled"}>Pause</button>
        <button class="btn btn-sm" data-cmd="resume_mission" ${canResume ? "" : "disabled"}>Resume</button>
        <button class="btn btn-sm" data-cmd="stop_mission" ${canStop ? "" : "disabled"} title="Finish the current experiment, then end">Stop</button>
        <button class="btn btn-sm btn-danger" data-cmd="cancel_mission" ${canCancel ? "" : "disabled"} title="Kill the running experiment immediately">Cancel</button>
        <button class="btn btn-sm" id="clone-btn" title="Open a new mission pre-filled from this one">Clone</button>
      </div>
    </div>
    ${record.error ? `<div class="error-box" style="margin-bottom:14px"><strong>Error:</strong> ${esc(record.error)}</div>` : ""}
    <div class="grid cards">
      <div class="card"><div class="label">Baseline val_bpb</div><div class="value">${fmtNum(record.baseline_val_bpb)}</div></div>
      <div class="card ${improvement > 0 ? "good" : ""}"><div class="label">Best val_bpb</div><div class="value">${best ? fmtNum(best.val_bpb) : "—"}</div><div class="sub">${best ? `#${best.experiment_index} · ${esc(best.commit || "")}` : ""}</div></div>
      <div class="card ${improvement > 0 ? "good" : ""}"><div class="label">Improvement</div><div class="value">${improvement != null ? fmtDelta(-improvement) : "—"}</div><div class="sub">${improvement != null && record.baseline_val_bpb ? `${((improvement / record.baseline_val_bpb) * 100).toFixed(2)}% vs baseline` : ""}</div></div>
      <div class="card"><div class="label">Experiments</div><div class="value">${exps.length}<span class="muted" style="font-size:14px"> / ${m.budget.max_experiments}</span></div><div class="sub">${counts.keep || 0} kept · ${counts.discard || 0} discarded · ${counts.crash || 0} crashed</div></div>
      <div class="card"><div class="label">Duration</div><div class="value">${duration(record.started_at, record.finished_at)}</div><div class="sub">started ${fmtTime(record.started_at)}</div></div>
      <div class="card"><div class="label">Branch</div><div class="value small mono">${esc(record.branch || "—")}</div><div class="sub mono">${esc((record.head_commit || "").slice(0, 7))} ← ${esc((record.base_commit || "").slice(0, 7))}</div></div>
    </div>

    <div class="section"><h2>Progress</h2><div class="card"><div id="chart"></div></div></div>

    <div class="section grid two">
      <div>
        <h2>Experiments</h2>
        ${exps.length === 0 ? '<div class="empty">No experiments yet.</div>' : `<div class="table-wrap"><table>
          <thead><tr><th>#</th><th>Commit</th><th>Description</th><th class="num">val_bpb</th><th class="num">Δ best</th><th class="num">VRAM GB</th><th>Status</th><th class="num">Time</th></tr></thead>
          <tbody>${exps.slice().reverse().map((e, i, arr) => {
            // Δ relative to the best value before this experiment ran.
            const prior = exps.filter((p) => p.index < e.index && p.status === "keep").map((p) => p.val_bpb);
            const priorBest = prior.length ? (direction === "min" ? Math.min(...prior) : Math.max(...prior)) : null;
            const delta = typeof e.val_bpb === "number" && priorBest != null ? e.val_bpb - priorBest : null;
            const detail = [e.reason ? `<div class="muted">${esc(e.reason)}</div>` : "", Object.keys(e.overrides || {}).length ? `<div class="chips" style="margin-top:4px">${Object.entries(e.overrides).map(([k, v]) => `<span class="chip">${esc(k)}=${esc(JSON.stringify(v))}</span>`).join("")}</div>` : "", e.log_tail && (e.status === "crash" || e.status === "cancelled") ? `<details style="margin-top:6px"><summary>log tail</summary><pre class="log">${esc(e.log_tail)}</pre></details>` : ""].join("");
            return `<tr><td class="num">${e.index}</td><td class="mono muted">${esc(e.commit || "—")}</td><td><div>${esc(e.description)}</div>${detail}</td>
              <td class="num">${fmtNum(e.val_bpb)}</td><td class="num" style="color:${delta < 0 ? "var(--keep)" : delta > 0 ? "var(--crash)" : "inherit"}">${fmtDelta(delta)}</td>
              <td class="num">${typeof e.memory_gb === "number" ? e.memory_gb.toFixed(1) : "—"}</td><td>${badge(e.status)}</td><td class="num muted">${e.duration_seconds != null ? `${Math.round(e.duration_seconds)}s` : duration(e.started_at, null)}</td></tr>`;
          }).join("")}</tbody></table></div>`}
      </div>
      <div>
        <h2>Mission</h2>
        <div class="card">
          <dl class="kv">
            <dt>objective</dt><dd>${esc(m.objective)}</dd>
            <dt>strategy</dt><dd>${esc(m.strategy.type)}${m.strategy.type === "sweep" ? ` (${m.strategy.experiments.length} planned)` : ` · ${esc(m.strategy.command.join(" "))}`}</dd>
            <dt>base ref</dt><dd>${esc(m.base_ref)}</dd>
            <dt>keep policy</dt><dd>${esc(m.keep_policy.direction)} ${esc(m.keep_policy.metric)}, min Δ ${m.keep_policy.min_improvement}${m.keep_policy.max_memory_gb ? `, ≤ ${m.keep_policy.max_memory_gb} GB` : ""}</dd>
            <dt>budget</dt><dd>${m.budget.max_experiments} experiments${m.budget.max_duration_minutes ? `, ${m.budget.max_duration_minutes} min` : ""}, ${m.budget.experiment_timeout_minutes} min/run</dd>
            <dt>requested by</dt><dd>${esc(m.requested_by || "—")}</dd>
            <dt>host</dt><dd>${esc(record.host || "—")}</dd>
            <dt>worktree</dt><dd>${esc(record.worktree || "—")}</dd>
          </dl>
          <details style="margin-top:10px"><summary>Mission JSON</summary><pre class="log">${esc(JSON.stringify(m, null, 2))}</pre></details>
        </div>
        <h2 style="margin-top:22px">Events</h2>
        <div class="card"><ul class="events">${(record.events || []).slice().reverse().map((ev) => `<li><time>${esc(fmtTime(ev.at))}</time><span class="lvl-${esc(ev.level)}">${esc(ev.message)}</span></li>`).join("") || '<li class="muted">none</li>'}</ul></div>
      </div>
    </div>`;

  renderProgressChart(app.querySelector("#chart"), exps, { direction });
  app.querySelectorAll("button[data-cmd]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const cmd = btn.dataset.cmd;
      if (cmd === "cancel_mission" && !confirm(`Cancel mission "${m.name}"? The running experiment will be killed.`)) return;
      btn.disabled = true;
      try {
        await sendCommand({ command: cmd, mission_id: m.mission_id }, cmd.replace("_", " "));
      } finally {
        setTimeout(() => route(), 1500);
      }
    }),
  );
  app.querySelector("#clone-btn").addEventListener("click", () => {
    const clone = { ...m };
    delete clone.mission_id;
    delete clone.requested_by;
    clone.tag = `${m.tag}-v2`.slice(0, 41);
    clone.name = `${m.name} (clone)`;
    sessionStorage.setItem("autoresearch.draft", JSON.stringify(clone, null, 2));
    location.hash = "#/new";
  });
}

async function viewNew() {
  setActiveNav("new");
  const schema = await ensureSchema();
  const example = (schema.examples && schema.examples[0]) || {};
  const draft = sessionStorage.getItem("autoresearch.draft");
  const starter = draft || JSON.stringify({ ...example, mission_id: undefined, tag: `run-${new Date().toISOString().slice(5, 10).replace("-", "")}`, requested_by: undefined }, null, 2);
  const overridable = schema["x-overridable-hyperparameters"] || [];

  app.innerHTML = `
    <div class="page-head"><h1>New mission</h1><span class="muted">Validated against <a href="#/schema">the mission schema</a>, then published as a <code>start_mission</code> command.</span></div>
    <div class="grid two">
      <div>
        <div class="field"><label for="editor">Mission JSON</label><textarea id="editor" class="editor" spellcheck="false">${esc(starter)}</textarea></div>
        <div class="btn-group">
          <button class="btn btn-primary" id="submit">Start mission</button>
          <button class="btn" id="validate">Validate</button>
          <button class="btn" id="load-example">Load example</button>
          <button class="btn" id="load-agent">Agent template</button>
          <button class="btn" id="format">Format</button>
        </div>
        <div id="result" class="section"></div>
      </div>
      <div>
        <div class="card">
          <div class="label">Quick reference</div>
          <p class="hint">Work happens on <code>autoresearch/&lt;tag&gt;</code>, so the tag must be new for this repo. <code>mission_id</code> and <code>requested_by</code> are filled in automatically when omitted.</p>
          <p class="hint"><strong>sweep</strong> runs the planned experiments in order; kept changes accumulate. <strong>agent</strong> invokes a coding-agent CLI per iteration to propose a change to <code>train.py</code>.</p>
          <div class="label" style="margin-top:12px">Overridable hyperparameters</div>
          <div class="chips" style="margin-top:6px">${overridable.map((h) => `<span class="chip">${esc(h)}</span>`).join("")}</div>
          <div class="label" style="margin-top:12px">Signed in as</div>
          <div class="mono">${esc((state.me && state.me.user) || "unknown")}</div>
        </div>
      </div>
    </div>`;

  const editor = app.querySelector("#editor");
  const result = app.querySelector("#result");
  const parse = () => {
    try {
      return [JSON.parse(editor.value), null];
    } catch (err) {
      return [null, `Invalid JSON: ${err.message}`];
    }
  };
  const showErrors = (errors) => {
    result.innerHTML = `<div class="error-box"><strong>${errors.length} problem${errors.length === 1 ? "" : "s"}</strong><ul>${errors.map((e) => `<li>${esc(e)}</li>`).join("")}</ul></div>`;
  };
  const doValidate = () => {
    const [mission, err] = parse();
    if (err) return showErrors([err]), null;
    const errors = validate(schema, mission);
    if (errors.length) return showErrors(errors), null;
    result.innerHTML = '<div class="ok-box">Mission is valid.</div>';
    return mission;
  };

  app.querySelector("#validate").addEventListener("click", doValidate);
  app.querySelector("#format").addEventListener("click", () => { const [m, err] = parse(); if (err) showErrors([err]); else editor.value = JSON.stringify(m, null, 2); });
  app.querySelector("#load-example").addEventListener("click", () => { editor.value = JSON.stringify({ ...example, mission_id: undefined, requested_by: undefined }, null, 2); result.innerHTML = ""; });
  app.querySelector("#load-agent").addEventListener("click", () => {
    editor.value = JSON.stringify({
      name: "Overnight agent run",
      tag: `agent-${new Date().toISOString().slice(5, 10).replace("-", "")}`,
      objective: "Minimise val_bpb within the fixed 5-minute training budget.",
      strategy: { type: "agent", command: ["claude", "-p", "Read the file {prompt_file} and follow its instructions.", "--dangerously-skip-permissions"], instructions: "Focus on optimizer and learning-rate schedule ideas first.", timeout_minutes: 20 },
      budget: { max_experiments: 100, max_duration_minutes: 480, experiment_timeout_minutes: 10 },
      tags: ["agent", "overnight"],
    }, null, 2);
    result.innerHTML = "";
  });
  app.querySelector("#submit").addEventListener("click", async () => {
    const mission = doValidate();
    if (!mission) return;
    const btn = app.querySelector("#submit");
    btn.disabled = true;
    try {
      const res = await sendCommand({ command: "start_mission", mission }, "start mission");
      sessionStorage.removeItem("autoresearch.draft");
      result.innerHTML = `<div class="ok-box">Command accepted (request <code>${esc(res.request_id || "")}</code>). The mission will appear on the <a href="#/">overview</a> once the service picks it up.</div>`;
    } catch {
      /* toast already shown */
    } finally {
      btn.disabled = false;
    }
  });
  if (draft) sessionStorage.removeItem("autoresearch.draft");
}

async function viewSchema() {
  setActiveNav("schema");
  const [mission, command] = await Promise.all([ensureSchema(), state.commandSchema || api.commandSchema().then((s) => (state.commandSchema = s))]);
  const typeOf = (p, root) => {
    if (!p) return "";
    if (p.$ref) return p.$ref.split("/").pop();
    if (p.anyOf) return p.anyOf.map((x) => typeOf(x, root)).join(" | ");
    if (p.oneOf) return p.oneOf.map((x) => typeOf(x, root)).join(" | ");
    if (p.const !== undefined) return `const ${JSON.stringify(p.const)}`;
    if (p.enum) return p.enum.map((e) => JSON.stringify(e)).join(" | ");
    if (p.type === "array") return `array<${typeOf(p.items, root) || "any"}>`;
    if (p.type === "object" && p.additionalProperties && typeof p.additionalProperties === "object") return `map<string, ${typeOf(p.additionalProperties, root)}>`;
    return Array.isArray(p.type) ? p.type.join(" | ") : p.type || "any";
  };
  const constraints = (p) => Object.entries(p).filter(([k]) => ["minimum", "maximum", "exclusiveMinimum", "minLength", "maxLength", "pattern", "minItems", "maxItems", "default"].includes(k)).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(", ");
  const table = (obj) => `<div class="table-wrap"><table class="schema-table"><thead><tr><th>Property</th><th>Type</th><th>Description</th><th>Constraints</th></tr></thead><tbody>${Object.entries(obj.properties || {}).map(([name, p]) => `<tr><td>${esc(name)}${(obj.required || []).includes(name) ? '<span class="req">required</span>' : ""}</td><td class="type">${esc(typeOf(p, mission))}</td><td>${esc(p.description || "")}</td><td class="muted mono">${esc(constraints(p))}</td></tr>`).join("")}</tbody></table></div>`;
  const defs = (schema) => Object.entries(schema.$defs || {}).map(([name, d]) => `<div class="schema-def"><h3>${esc(name)}</h3>${d.description ? `<p class="hint">${esc(d.description.split("\n")[0])}</p>` : ""}${d.properties ? table(d) : `<pre class="log">${esc(JSON.stringify(d, null, 2))}</pre>`}</div>`).join("");
  const dl = (name, obj) => `<a class="btn btn-sm" download="${name}" href="data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(obj, null, 2))}">Download ${name}</a>`;

  app.innerHTML = `
    <div class="page-head"><h1>Schema</h1><span class="muted">What this service accepts. Generated from the service's Pydantic models and published to the result store on start-up.</span></div>
    <div class="section"><h2>${esc(mission.title)} <span class="muted mono" style="text-transform:none;letter-spacing:0">${esc(mission.$id || "")}</span></h2>
      <p class="hint">${esc(mission.description || "")}</p>
      <div class="btn-group" style="margin-bottom:10px">${dl("mission.schema.json", mission)}<a class="btn btn-sm" href="${esc(cfg.dataBaseUrl)}/schema/mission.schema.json" target="_blank" rel="noopener">Raw JSON</a></div>
      ${table(mission)}
      ${defs(mission)}
    </div>
    <div class="section"><h2>${esc(command.title)}</h2>
      <p class="hint">${esc(command.description || "")} Any of the following, discriminated by <code>command</code>: ${(command.oneOf || []).map((o) => `<code>${esc(o.$ref.split("/").pop())}</code>`).join(", ")}.</p>
      <div class="btn-group" style="margin-bottom:10px">${dl("command.schema.json", command)}<a class="btn btn-sm" href="${esc(cfg.dataBaseUrl)}/schema/command.schema.json" target="_blank" rel="noopener">Raw JSON</a></div>
      ${defs(command)}
    </div>
    <div class="section"><h2>Example mission</h2><pre class="log">${esc(JSON.stringify((mission.examples || [])[0] || {}, null, 2))}</pre></div>`;
}

// ---------------------------------------------------------------------------
// router + refresh
// ---------------------------------------------------------------------------

async function route() {
  const hash = location.hash || "#/";
  const match = hash.match(/^#\/missions\/([^/?]+)/);
  try {
    if (match) await viewMission(decodeURIComponent(match[1]));
    else if (hash.startsWith("#/new")) await viewNew();
    else if (hash.startsWith("#/schema")) await viewSchema();
    else viewOverview();
  } catch (err) {
    console.error(err);
    app.innerHTML = `<div class="error-box">Failed to render view: ${esc(err.message)}</div>`;
  }
}

async function refresh() {
  await loadIndex();
  const hash = location.hash || "#/";
  if (hash === "#/" || hash === "") return route();
  const match = hash.match(/^#\/missions\/([^/?]+)/);
  if (match) {
    // Finished missions never change; avoid re-rendering (and collapsing open details) for them.
    const summary = state.index && (state.index.missions || []).find((m) => m.mission_id === decodeURIComponent(match[1]));
    if (!summary || !TERMINAL.has(summary.state)) await route();
  }
}

async function init() {
  state.me = await api.me();
  const userPill = document.getElementById("user-pill");
  if (state.me && state.me.user) {
    userPill.textContent = state.me.user;
    if (cfg.showSignOut !== false && state.me.auth !== "devserver") document.getElementById("logout-link").hidden = false;
  } else {
    userPill.hidden = true;
  }
  await loadIndex();
  await route();
  window.addEventListener("hashchange", route);
  const every = Math.max(3, Number(cfg.refreshSeconds) || 10) * 1000;
  state.timer = setInterval(() => { if (!document.hidden) refresh(); }, every);
}

init();
