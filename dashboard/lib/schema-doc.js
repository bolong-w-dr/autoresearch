// Renders a JSON Schema (as published by the service) as readable documentation:
// each field with its description, whether it is required, an example value to
// copy, and the constraints. Used by the Schema page.

function resolve(schema, node, root) {
  let current = node;
  const seen = new Set();
  while (current && current.$ref && !seen.has(current.$ref)) {
    seen.add(current.$ref);
    if (!current.$ref.startsWith("#/")) break;
    const next = current.$ref
      .slice(2)
      .split("/")
      .reduce((n, part) => (n ? n[part.replace(/~1/g, "/").replace(/~0/g, "~")] : null), root || schema);
    if (!next) break;
    current = next;
  }
  return current || {};
}

function typeLabel(node, root) {
  const n = resolve(root, node, root);
  if (n.const !== undefined) return JSON.stringify(n.const);
  if (n.enum) return n.enum.map((e) => JSON.stringify(e)).join(" | ");
  if (n.anyOf) return n.anyOf.map((x) => typeLabel(x, root)).join(" | ");
  if (n.oneOf) return n.oneOf.map((x) => (x.$ref ? x.$ref.split("/").pop() : typeLabel(x, root))).join(" | ");
  if (n.$ref) return n.$ref.split("/").pop();
  if (n.type === "array") return `array of ${typeLabel(n.items || {}, root)}`;
  if (n.type === "object" && n.additionalProperties && typeof n.additionalProperties === "object") {
    return `object of ${typeLabel(n.additionalProperties, root)}`;
  }
  return n.type || "object";
}

function constraints(node) {
  const keys = ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "minLength", "maxLength", "minItems", "maxItems", "pattern", "default"];
  return keys.filter((k) => node[k] !== undefined).map((k) => [k, node[k]]);
}

function exampleText(node) {
  const value = (node.examples && node.examples[0]) ?? node.example ?? (node.default !== undefined ? node.default : undefined);
  if (value === undefined) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

function fieldArticles(schema, obj, root, esc, depth) {
  const resolved = resolve(root, obj, root);
  const required = new Set(resolved.required || []);
  return Object.entries(resolved.properties || {})
    .map(([name, raw]) => {
      const prop = resolve(root, raw, root);
      const example = exampleText(prop.examples ? prop : raw);
      const cons = constraints({ ...raw, ...prop });
      const refName = raw.$ref ? raw.$ref.split("/").pop() : "";
      const oneOf = raw.oneOf || prop.oneOf || [];
      const nested = !oneOf.length && prop.properties && depth < 2 && !prop.const && prop.type !== "array" ? prop : null;
      const variants = oneOf.length && depth < 2
        ? oneOf.map((alt) => {
            const title = (alt.$ref || alt.title || "option").split("/").pop();
            return `<div class="doc-nested"><h4>${esc(title)}</h4>${fieldArticles(schema, alt, root, esc, depth + 1)}</div>`;
          }).join("")
        : "";
      return `<article class="doc-field" id="field-${esc(name)}">
        <header>
          <code>${esc(name)}</code>
          ${required.has(name) ? '<span class="badge badge-paused">required</span>' : '<span class="badge badge-skipped">optional</span>'}
          <span class="type">${esc(typeLabel(raw, root))}</span>
        </header>
        ${prop.description ? `<p>${esc(prop.description)}</p>` : ""}
        ${example ? `<div class="doc-example"><span>example</span><code>${esc(example)}</code></div>` : ""}
        ${cons.length ? `<ul class="doc-constraints">${cons.map(([k, v]) => `<li><code>${esc(k)}</code> ${esc(typeof v === "string" ? v : JSON.stringify(v))}</li>`).join("")}</ul>` : ""}
        ${nested && nested.properties ? `<div class="doc-nested"><h4>${esc(refName || name)}</h4>${fieldArticles(schema, nested, root, esc, depth + 1)}</div>` : ""}
        ${variants}
      </article>`;
    })
    .join("");
}

const COMMAND_BLURBS = {
  start_mission: "Queue a new mission. mission_id, request_id and issued_by are filled in for you.",
  pause_mission: "Pause after the experiment that is currently training finishes.",
  resume_mission: "Continue a paused mission.",
  stop_mission: "Finish the current experiment, record it, then end the mission.",
  cancel_mission: "Kill the running experiment immediately, or drop a mission that has not started.",
  ping: "Health check. The service records it and replies pong.",
  publish_schema: "Rewrite schema/mission.schema.json and schema/command.schema.json in the result store.",
};

export function missionDocHtml(schema, esc) {
  const placeholders = schema["x-hyperparameter-placeholders"] || {};
  const chips = Object.entries(placeholders)
    .map(([k, v]) => `<span class="chip" title="baseline in train.py">${esc(k)} = ${esc(v)}</span>`)
    .join("");
  return `
    <p class="doc-lead">${esc(schema.description || "")} Optional fields can be left blank in <a href="#/new">New mission</a>; the service uses its default. The example under each field is a value you can copy.</p>
    ${fieldArticles(schema, schema, schema, esc, 0)}
    <div class="schema-def">
      <h3>Overridable hyperparameters</h3>
      <p class="hint">A sweep experiment may only rewrite these constants in <code>train.py</code>. The value after <code>=</code> is the baseline the form shows as a placeholder.</p>
      <div class="chips">${chips}</div>
    </div>`;
}

export function commandDocHtml(schema, esc) {
  const examples = schema.examples || [];
  const blocks = examples
    .map((ex) => {
      const name = ex.command;
      return `<div class="schema-def" id="cmd-${esc(name)}">
        <h3><code>${esc(name)}</code></h3>
        <p class="hint">${esc(COMMAND_BLURBS[name] || "")}</p>
        <pre class="log doc-payload">${esc(JSON.stringify(ex, null, 2))}</pre>
      </div>`;
    })
    .join("");
  return `<p class="doc-lead">${esc(schema.description || "")} Every command accepts <code>request_id</code> (generated if omitted; duplicates are ignored), <code>issued_at</code> and <code>issued_by</code> (set from your SSO session).</p>${blocks}`;
}

export function collectHints(schema) {
  const hints = {};
  function add(key, raw, required) {
    const prop = resolve(schema, raw, schema);
    hints[key] = {
      name: key.split(".").pop(),
      required: !!required,
      type: typeLabel(raw, schema),
      description: prop.description || raw.description || "",
      example: exampleText(prop.examples ? prop : raw),
    };
    const kids = prop.properties ? prop : null;
    if (kids && kids.properties && key.split(".").length < 3) {
      const req = new Set(kids.required || []);
      for (const [name, child] of Object.entries(kids.properties)) {
        if (name === "type") continue;
        add(`${key}.${name}`, child, req.has(name));
      }
    }
    for (const alt of raw.oneOf || prop.oneOf || []) {
      const title = (alt.$ref || "").split("/").pop();
      if (title) add(title, alt, false);
    }
  }
  const req = new Set(schema.required || []);
  for (const [name, prop] of Object.entries(schema.properties || {})) add(name, prop, req.has(name));
  return hints;
}

export function fieldHint(schema, key) {
  const prop = (schema.properties || {})[key];
  if (!prop) return null;
  const resolved = resolve(schema, prop, schema);
  return {
    name: key,
    required: (schema.required || []).includes(key),
    type: typeLabel(prop, schema),
    description: resolved.description || prop.description || "",
    example: exampleText(resolved.examples ? resolved : prop),
  };
}
