import { api, newRequestId } from "./lib/api.js";
import { renderProgressChart } from "./lib/chart.js";
import { agentTemplate, blankForm, formFromMission, hyperPlaceholders, missionFromForm } from "./lib/mission-form.js";
import { collectHints, commandDocHtml, missionDocHtml } from "./lib/schema-doc.js";
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

function fieldError(key) {
  return `<p class="field-error" data-error-for="${esc(key)}" hidden></p>`;
}

function inputField({ id, label, hintKey, value, placeholder, required = false, wide = false }) {
  return `<div class="field ${wide ? "field-wide" : ""}">
    <label for="${id}">${esc(label)} ${required ? '<span class="req-mark">required</span>' : '<span class="opt-mark">optional</span>'}</label>
    <input id="${id}" data-hint="${esc(hintKey)}" value="${esc(value)}" placeholder="${esc(placeholder)}" autocomplete="off" />
    ${fieldError(id)}
  </div>`;
}

async function viewNew() {
  setActiveNav("new");
  const schema = await ensureSchema();
  const hints = collectHints(schema);
  const placeholders = hyperPlaceholders(schema);
  const hyperKeys = schema["x-overridable-hyperparameters"] || Object.keys(placeholders);
  let form;
  const draft = sessionStorage.getItem("autoresearch.draft");
  if (draft) {
    try {
      form = formFromMission(JSON.parse(draft));
    } catch {
      form = blankForm();
    }
    sessionStorage.removeItem("autoresearch.draft");
  } else {
    form = blankForm();
  }
  let showErrors = false;

  const paint = () => {
    app.innerHTML = `
      <div class="page-head">
        <h1>New mission</h1>
        <span class="muted">Prefilled with a working sweep. Grey text is a placeholder. The panel shows the exact JSON sent to the service, checked against <a href="#/schema">the schema</a>.</span>
      </div>
      <form id="mission-form" class="grid two" autocomplete="off">
        <div>
          <section class="card form-section">
            <h2>Mission</h2>
            <div class="field-row">
              ${inputField({ id: "name", label: "Name", hintKey: "name", value: form.name, placeholder: "LR and batch-size sweep", required: true })}
              ${inputField({ id: "tag", label: "Tag", hintKey: "tag", value: form.tag, placeholder: "oct6-lr", required: true })}
            </div>
            <div class="field field-wide">
              <label for="objective">Objective <span class="opt-mark">prefilled</span></label>
              <textarea id="objective" data-hint="objective" rows="2" placeholder="Minimise val_bpb within the fixed 5-minute training budget.">${esc(form.objective)}</textarea>
              ${fieldError("objective")}
            </div>
            <div class="field-row">
              ${inputField({ id: "baseRef", label: "Branch from", hintKey: "base_ref", value: form.baseRef, placeholder: "master", required: true })}
              ${inputField({ id: "tags", label: "Tags", hintKey: "tags", value: form.tags, placeholder: "sweep, overnight" })}
            </div>
          </section>

          <section class="card form-section">
            <h2>How experiments are proposed</h2>
            <div class="segmented" role="radiogroup" aria-label="Strategy">
              <label class="${form.strategy === "sweep" ? "on" : ""}"><input type="radio" name="strategy" value="sweep" ${form.strategy === "sweep" ? "checked" : ""} /> Sweep</label>
              <label class="${form.strategy === "agent" ? "on" : ""}"><input type="radio" name="strategy" value="agent" ${form.strategy === "agent" ? "checked" : ""} /> Coding agent</label>
            </div>
            <p class="hint" id="strategy-hint"></p>
            <div id="sweep-fields" ${form.strategy === "agent" ? "hidden" : ""}>
              <div id="experiments"></div>
              <button type="button" class="btn btn-sm" id="add-exp">Add experiment</button>
              ${fieldError("experiments")}
            </div>
            <div id="agent-fields" ${form.strategy === "agent" ? "" : "hidden"}>
              <div class="field">
                <label for="command">Command <span class="req-mark">required</span></label>
                <textarea id="command" data-hint="AgentStrategy.command" rows="4" placeholder="claude&#10;-p&#10;Read the file {prompt_file} and follow its instructions.">${esc(form.command)}</textarea>
                <p class="hint">One argument per line. <code>{prompt_file}</code>, <code>{description_file}</code> and <code>{worktree}</code> are filled in by the service.</p>
                ${fieldError("command")}
              </div>
              <div class="field">
                <label for="instructions">Extra instructions <span class="opt-mark">optional</span></label>
                <textarea id="instructions" data-hint="AgentStrategy.instructions" rows="3" placeholder="Focus on the learning-rate schedule before changing the architecture.">${esc(form.instructions)}</textarea>
                ${fieldError("instructions")}
              </div>
              ${inputField({ id: "agentTimeout", label: "Agent timeout (minutes)", hintKey: "AgentStrategy.timeout_minutes", value: form.agentTimeout, placeholder: "20" })}
            </div>
          </section>

          <section class="card form-section">
            <h2>When to keep a result</h2>
            <div class="field-row">
              <div class="field">
                <label for="direction">Direction</label>
                <select id="direction" data-hint="KeepPolicy.direction">
                  <option value="min" ${form.direction === "min" ? "selected" : ""}>min — lower val_bpb is better</option>
                  <option value="max" ${form.direction === "max" ? "selected" : ""}>max — higher is better</option>
                </select>
              </div>
              ${inputField({ id: "minImprovement", label: "Minimum improvement", hintKey: "KeepPolicy.min_improvement", value: form.minImprovement, placeholder: "0" })}
              ${inputField({ id: "maxMemoryGb", label: "VRAM cap (GB)", hintKey: "KeepPolicy.max_memory_gb", value: form.maxMemoryGb, placeholder: "48" })}
            </div>
          </section>

          <section class="card form-section">
            <h2>When to stop</h2>
            <div class="field-row">
              ${inputField({ id: "maxExperiments", label: "Max experiments", hintKey: "Budget.max_experiments", value: form.maxExperiments, placeholder: "12", required: true })}
              ${inputField({ id: "maxDuration", label: "Max duration (minutes)", hintKey: "Budget.max_duration_minutes", value: form.maxDuration, placeholder: "480" })}
              ${inputField({ id: "experimentTimeout", label: "Per-run timeout (minutes)", hintKey: "Budget.experiment_timeout_minutes", value: form.experimentTimeout, placeholder: "10", required: true })}
            </div>
          </section>

          <div class="btn-group">
            <button type="submit" class="btn btn-primary" id="submit">Start mission</button>
            <button type="button" class="btn" id="use-example">Load schema example</button>
            <button type="button" class="btn" id="use-agent">Agent template</button>
            <button type="button" class="btn" id="use-blank">Reset defaults</button>
          </div>
          <div id="result" class="section"></div>
        </div>
        <aside class="form-side">
          <div class="card">
            <div class="label">Schema for this field</div>
            <div id="field-doc" class="field-doc"><p class="hint">Click a field. This shows its type, whether it is required, and an example from the published schema.</p></div>
          </div>
          <div class="card">
            <div class="label">Command payload <button type="button" class="btn btn-sm" id="copy-payload">Copy</button></div>
            <p id="payload-status" class="hint"></p>
            <pre id="payload" class="log payload"></pre>
          </div>
          <p class="hint">Signed in as <span class="mono">${esc((state.me && state.me.user) || "unknown")}</span>. <code>requested_by</code> and <code>mission_id</code> are added when the command is sent.</p>
        </aside>
      </form>`;
    renderExperiments();
    bind();
    refreshPayload();
  };

  function renderExperiments() {
    const host = app.querySelector("#experiments");
    if (!host) return;
    host.innerHTML = form.experiments
      .map((exp, i) => {
        const rows = exp.overrides
          .map((ov, j) => {
            const opts = hyperKeys.map((h) => `<option value="${esc(h)}" ${h === ov.key ? "selected" : ""}>${esc(h)}</option>`).join("");
            return `<div class="override-row">
              <select data-ov="key" data-i="${i}" data-j="${j}" data-hint="overrides" aria-label="Hyperparameter">${opts}</select>
              <input data-ov="value" data-i="${i}" data-j="${j}" data-hint="overrides" value="${esc(ov.value)}" placeholder="baseline ${esc(placeholders[ov.key] || "")}" aria-label="New value" />
              <button type="button" class="btn btn-sm" data-remove-ov="${i}:${j}" ${exp.overrides.length === 1 ? "disabled" : ""} aria-label="Remove override">×</button>
              ${fieldError(`exp-${i}-ov-${j}`)}
            </div>`;
          })
          .join("");
        return `<div class="exp-card" data-exp="${i}">
          <div class="exp-head"><span>Experiment ${i + 1} <span class="muted">runs after the baseline</span></span>
            <button type="button" class="btn btn-sm" data-remove-exp="${i}" ${form.experiments.length === 1 ? "disabled" : ""}>Remove</button></div>
          <div class="field">
            <label>Description <span class="req-mark">required</span></label>
            <input data-exp-field="description" data-i="${i}" data-hint="SweepStrategy.experiments" value="${esc(exp.description)}" placeholder="increase MATRIX_LR to 0.05" />
            ${fieldError(`exp-${i}-description`)}
          </div>
          <p class="hint">Overrides. The grey placeholder is the current <code>train.py</code> baseline.</p>
          ${rows}
          <button type="button" class="btn btn-sm" data-add-ov="${i}">Add override</button>
        </div>`;
      })
      .join("");
  }

  function readForm() {
    const val = (id) => (app.querySelector("#" + id) || {}).value ?? "";
    const strategy = (app.querySelector('input[name="strategy"]:checked') || {}).value || form.strategy;
    const experiments = [...app.querySelectorAll(".exp-card")].map((card) => ({
      description: card.querySelector("[data-exp-field=description]").value,
      overrides: [...card.querySelectorAll(".override-row")].map((row) => ({
        key: row.querySelector("[data-ov=key]").value,
        value: row.querySelector("[data-ov=value]").value,
      })),
    }));
    return {
      ...form,
      name: val("name"),
      tag: val("tag"),
      objective: val("objective"),
      baseRef: val("baseRef"),
      tags: val("tags"),
      strategy,
      experiments: experiments.length ? experiments : form.experiments,
      command: val("command"),
      instructions: val("instructions"),
      agentTimeout: val("agentTimeout"),
      direction: val("direction"),
      minImprovement: val("minImprovement"),
      maxMemoryGb: val("maxMemoryGb"),
      maxExperiments: val("maxExperiments"),
      maxDuration: val("maxDuration"),
      experimentTimeout: val("experimentTimeout"),
    };
  }

  function applyErrors(errors) {
    app.querySelectorAll("[data-error-for]").forEach((el) => {
      const msg = showErrors ? errors[el.dataset.errorFor] : "";
      el.hidden = !msg;
      el.textContent = msg || "";
    });
  }

  function refreshPayload() {
    form = readForm();
    const built = missionFromForm(form);
    const schemaErrors = Object.keys(built.errors).length ? [] : validate(schema, built.mission);
    const problems = Object.values(built.errors).concat(schemaErrors);
    applyErrors(built.errors);
    const pre = app.querySelector("#payload");
    const status = app.querySelector("#payload-status");
    if (pre) pre.textContent = JSON.stringify(built.mission, null, 2);
    if (status) {
      status.textContent = problems.length ? `${problems.length} to fix before this can start` : "Valid against the mission schema";
      status.className = problems.length ? "hint bad-hint" : "hint good-hint";
    }
    const hint = app.querySelector("#strategy-hint");
    if (hint) {
      hint.textContent = form.strategy === "agent"
        ? "Each iteration runs this command inside the mission worktree. The agent edits train.py; the service trains and keeps or discards."
        : "Each experiment rewrites the constants you list, then trains for the fixed 5-minute budget. Kept changes carry into the next experiment.";
    }
    return problems.length ? null : built.mission;
  }

  function showFieldDoc(key) {
    const doc = app.querySelector("#field-doc");
    const hint = hints[key];
    if (!doc) return;
    if (!hint) {
      doc.innerHTML = `<p class="hint">Pick a hyperparameter. Placeholder values are the current <code>train.py</code> baselines, so you can see what you are changing.</p><div class="chips">${hyperKeys.map((h) => `<span class="chip">${esc(h)} = ${esc(placeholders[h] || "")}</span>`).join("")}</div>`;
      return;
    }
    doc.innerHTML = `<header><code>${esc(hint.name)}</code> ${hint.required ? '<span class="badge badge-paused">required</span>' : '<span class="badge badge-skipped">optional</span>'} <span class="type">${esc(hint.type)}</span></header>
      <p>${esc(hint.description || "See the schema page for the full description.")}</p>
      ${hint.example ? `<div class="doc-example"><span>example</span><code>${esc(hint.example)}</code></div>` : ""}`;
  }

  function bind() {
    const formEl = app.querySelector("#mission-form");
    formEl.addEventListener("input", (ev) => {
      if (ev.target.matches("[data-ov=key]")) {
        const row = ev.target.closest(".override-row");
        const value = row.querySelector("[data-ov=value]");
        value.placeholder = `baseline ${placeholders[ev.target.value] || ""}`;
      }
      refreshPayload();
    });
    formEl.addEventListener("focusin", (ev) => {
      const key = ev.target.getAttribute && ev.target.getAttribute("data-hint");
      if (key) showFieldDoc(key);
    });
    formEl.addEventListener("click", (ev) => {
      const t = ev.target;
      if (t.id === "add-exp") {
        form = readForm();
        form.experiments.push({ description: "", overrides: [{ key: "DEPTH", value: "" }] });
        renderExperiments();
        refreshPayload();
      } else if (t.dataset.removeExp != null) {
        form = readForm();
        form.experiments.splice(Number(t.dataset.removeExp), 1);
        renderExperiments();
        refreshPayload();
      } else if (t.dataset.addOv != null) {
        form = readForm();
        form.experiments[Number(t.dataset.addOv)].overrides.push({ key: "DEPTH", value: "" });
        renderExperiments();
        refreshPayload();
      } else if (t.dataset.removeOv != null) {
        form = readForm();
        const [i, j] = t.dataset.removeOv.split(":").map(Number);
        form.experiments[i].overrides.splice(j, 1);
        renderExperiments();
        refreshPayload();
      }
    });
    formEl.addEventListener("change", (ev) => {
      if (ev.target.matches("[data-ov=key]")) {
        const row = ev.target.closest(".override-row");
        row.querySelector("[data-ov=value]").placeholder = `baseline ${placeholders[ev.target.value] || ""}`;
      }
      if (ev.target.name === "strategy") {
        form = readForm();
        app.querySelector("#sweep-fields").hidden = form.strategy !== "sweep";
        app.querySelector("#agent-fields").hidden = form.strategy !== "agent";
        app.querySelectorAll(".segmented label").forEach((label) => {
          label.classList.toggle("on", label.querySelector("input").checked);
        });
        refreshPayload();
      }
    });
    formEl.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      showErrors = true;
      const mission = refreshPayload();
      const result = app.querySelector("#result");
      if (!mission) {
        const built = missionFromForm(readForm());
        const extra = Object.keys(built.errors).length ? [] : validate(schema, built.mission);
        const all = Object.values(built.errors).concat(extra);
        result.innerHTML = `<div class="error-box"><strong>Fix ${all.length} item${all.length === 1 ? "" : "s"}</strong><ul>${all.map((e) => `<li>${esc(e)}</li>`).join("")}</ul></div>`;
        return;
      }
      const btn = app.querySelector("#submit");
      btn.disabled = true;
      try {
        const res = await sendCommand({ command: "start_mission", mission }, "start mission");
        result.innerHTML = `<div class="ok-box">Command accepted (request <code>${esc(res.request_id || "")}</code>). It will show on the <a href="#/">overview</a> once the service picks it up.</div>`;
      } catch {
        /* toast already shown */
      } finally {
        btn.disabled = false;
      }
    });
    app.querySelector("#copy-payload").addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(app.querySelector("#payload").textContent);
        toast("Payload copied", "ok");
      } catch {
        toast("Copy failed; select the JSON and copy it manually", "bad");
      }
    });
    const swap = (next) => {
      form = next;
      showErrors = false;
      paint();
    };
    app.querySelector("#use-blank").addEventListener("click", () => swap(blankForm()));
    app.querySelector("#use-agent").addEventListener("click", () => swap(agentTemplate()));
    app.querySelector("#use-example").addEventListener("click", () => {
      const example = (schema.examples || [])[0];
      if (!example) return;
      const next = formFromMission(example);
      delete next.mission_id;
      swap(next);
    });
  }

  paint();
}

async function viewSchema() {
  setActiveNav("schema");
  const [mission, command] = await Promise.all([ensureSchema(), state.commandSchema || api.commandSchema().then((s) => (state.commandSchema = s))]);
  const dl = (name, obj) => `<a class="btn btn-sm" download="${name}" href="data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(obj, null, 2))}">Download ${name}</a>`;
  app.innerHTML = `
    <div class="page-head">
      <h1>Schema</h1>
      <span class="muted">The contract this service accepts. Each field shows its type, whether you must set it, and an example you can copy into <a href="#/new">New mission</a>.</span>
    </div>
    <div class="section">
      <h2>${esc(mission.title || "Mission")} <span class="muted mono" style="text-transform:none;letter-spacing:0">${esc(mission.$id || "")}</span></h2>
      <div class="btn-group" style="margin-bottom:12px">${dl("mission.schema.json", mission)}<a class="btn btn-sm" href="${esc(cfg.dataBaseUrl)}/schema/mission.schema.json" target="_blank" rel="noopener">Raw JSON</a><a class="btn btn-sm" href="#/new">Open the form</a></div>
      ${missionDocHtml(mission, esc)}
    </div>
    <div class="section">
      <h2>${esc(command.title || "Command")}</h2>
      <div class="btn-group" style="margin-bottom:12px">${dl("command.schema.json", command)}<a class="btn btn-sm" href="${esc(cfg.dataBaseUrl)}/schema/command.schema.json" target="_blank" rel="noopener">Raw JSON</a></div>
      ${commandDocHtml(command, esc)}
    </div>`;
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
