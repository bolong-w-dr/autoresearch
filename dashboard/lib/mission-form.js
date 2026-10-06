// Pure helpers for the New mission form: a prefilled, placeholder-driven editor
// that round-trips to the mission JSON the service validates.

export const DEFAULT_OBJECTIVE = "Minimise val_bpb within the fixed 5-minute training budget.";

export const HYPER_PLACEHOLDERS = {
  ASPECT_RATIO: "64",
  HEAD_DIM: "128",
  WINDOW_PATTERN: "SSSL",
  TOTAL_BATCH_SIZE: "524288",
  EMBEDDING_LR: "0.6",
  UNEMBEDDING_LR: "0.004",
  MATRIX_LR: "0.04",
  SCALAR_LR: "0.5",
  WEIGHT_DECAY: "0.2",
  ADAM_BETAS: "0.8, 0.95",
  WARMUP_RATIO: "0.0",
  WARMDOWN_RATIO: "0.5",
  FINAL_LR_FRAC: "0.0",
  DEPTH: "8",
  DEVICE_BATCH_SIZE: "128",
};

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

export function suggestedTag(date = new Date()) {
  return `${MONTHS[date.getMonth()]}${date.getDate()}`;
}

export function blankExperiment() {
  return { description: "", overrides: [{ key: "MATRIX_LR", value: "" }] };
}

export function blankForm(date = new Date()) {
  const tag = suggestedTag(date);
  return {
    name: `${tag} sweep`,
    tag,
    objective: DEFAULT_OBJECTIVE,
    baseRef: "master",
    strategy: "sweep",
    experiments: [{ description: "increase MATRIX_LR to 0.05", overrides: [{ key: "MATRIX_LR", value: "0.05" }] }],
    command: "claude\n-p\nRead the file {prompt_file} and follow its instructions.",
    instructions: "",
    agentTimeout: "20",
    direction: "min",
    minImprovement: "0",
    maxMemoryGb: "",
    maxExperiments: "12",
    maxDuration: "",
    experimentTimeout: "10",
    tags: "",
  };
}

export function agentTemplate(date = new Date()) {
  const form = blankForm(date);
  form.name = `${form.tag} agent run`;
  form.tag = `${form.tag}-agent`;
  form.strategy = "agent";
  form.instructions = "";
  form.maxExperiments = "100";
  form.maxDuration = "480";
  form.tags = "agent, overnight";
  return form;
}

function formatOverride(value) {
  if (Array.isArray(value)) return value.join(", ");
  if (value === null || value === undefined) return "";
  return String(value);
}

export function formFromMission(mission, date = new Date()) {
  const form = blankForm(date);
  if (!mission || typeof mission !== "object") return form;
  form.name = mission.name || "";
  form.tag = mission.tag || form.tag;
  form.objective = mission.objective || form.objective;
  form.baseRef = mission.base_ref || "master";
  const strategy = mission.strategy || {};
  if (strategy.type === "agent") {
    form.strategy = "agent";
    form.command = (strategy.command || []).join("\n");
    form.instructions = strategy.instructions || "";
    form.agentTimeout = String(strategy.timeout_minutes ?? 20);
  } else if (strategy.type === "sweep" && Array.isArray(strategy.experiments) && strategy.experiments.length) {
    form.strategy = "sweep";
    form.experiments = strategy.experiments.map((exp) => ({
      description: exp.description || "",
      overrides: Object.keys(exp.overrides || {}).length
        ? Object.entries(exp.overrides).map(([key, value]) => ({ key, value: formatOverride(value) }))
        : [{ key: "MATRIX_LR", value: "" }],
    }));
  }
  const keep = mission.keep_policy || {};
  form.direction = keep.direction || "min";
  form.minImprovement = keep.min_improvement != null ? String(keep.min_improvement) : "0";
  form.maxMemoryGb = keep.max_memory_gb != null ? String(keep.max_memory_gb) : "";
  const budget = mission.budget || {};
  form.maxExperiments = budget.max_experiments != null ? String(budget.max_experiments) : "12";
  form.maxDuration = budget.max_duration_minutes != null ? String(budget.max_duration_minutes) : "";
  form.experimentTimeout = budget.experiment_timeout_minutes != null ? String(budget.experiment_timeout_minutes) : "10";
  form.tags = Array.isArray(mission.tags) ? mission.tags.join(", ") : "";
  return form;
}

export function parseOverrideValue(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return { error: "enter a value (see the placeholder for the baseline)" };
  if (text === "true" || text === "false") return { value: text === "true" };
  if (text.includes(",")) {
    const parts = text.split(",").map((p) => p.trim()).filter(Boolean);
    const nums = parts.map(Number);
    if (!parts.length || nums.some((n) => Number.isNaN(n))) return { error: "use comma-separated numbers, e.g. 0.8, 0.95" };
    return { value: nums };
  }
  if (/^-?\d+$/.test(text)) return { value: Number(text) };
  if (/^-?\d+\.\d+$/.test(text) || /^\.\d+$/.test(text)) return { value: Number(text) };
  if (/\s/.test(text)) return { error: "a single token, or comma-separated numbers" };
  return { value: text };
}

function parseNumber(raw, { integer = false, min, max, allowEmpty = false, label }) {
  const text = String(raw ?? "").trim();
  if (!text) return allowEmpty ? { value: undefined } : { error: `${label} is required` };
  const value = Number(text);
  if (!Number.isFinite(value) || (integer && !Number.isInteger(value))) {
    return { error: `${label} must be ${integer ? "a whole number" : "a number"}` };
  }
  if (min !== undefined && value < min) return { error: `${label} must be at least ${min}` };
  if (max !== undefined && value > max) return { error: `${label} must be at most ${max}` };
  return { value };
}

export function missionFromForm(form) {
  const errors = {};
  const mission = { schema_version: "1" };

  const name = (form.name || "").trim();
  if (!name) errors.name = "Give the mission a name.";
  else if (name.length > 120) errors.name = "Name must be at most 120 characters.";
  else mission.name = name;

  const tag = (form.tag || "").trim();
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(tag)) {
    errors.tag = "Lowercase letters, digits and hyphens, starting with a letter or digit (max 41).";
  } else mission.tag = tag;

  const objective = (form.objective || "").trim();
  if (!objective) errors.objective = "Describe the objective.";
  else if (objective.length > 2000) errors.objective = "Objective must be at most 2000 characters.";
  else mission.objective = objective;

  const baseRef = (form.baseRef || "").trim();
  if (!baseRef) errors.baseRef = "Name the git ref to branch from.";
  else mission.base_ref = baseRef;

  if (form.strategy === "agent") {
    const command = String(form.command || "")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    if (!command.length) errors.command = "One argument per line, e.g. claude / -p / Read {prompt_file}.";
    const timeout = parseNumber(form.agentTimeout, { integer: true, min: 1, max: 240, label: "Agent timeout" });
    if (timeout.error) errors.agentTimeout = timeout.error;
    if (!errors.command && !timeout.error) {
      mission.strategy = { type: "agent", command, timeout_minutes: timeout.value };
      const instructions = (form.instructions || "").trim();
      if (instructions) mission.strategy.instructions = instructions;
    }
  } else {
    const experiments = [];
    (form.experiments || []).forEach((exp, i) => {
      const description = (exp.description || "").trim();
      if (!description) errors[`exp-${i}-description`] = "Describe what this experiment changes.";
      else if (description.length > 200) errors[`exp-${i}-description`] = "Keep the description under 200 characters.";
      const overrides = {};
      const seen = new Set();
      (exp.overrides || []).forEach((ov, j) => {
        if (!ov.key) {
          errors[`exp-${i}-ov-${j}`] = "Pick a hyperparameter.";
          return;
        }
        if (seen.has(ov.key)) errors[`exp-${i}-ov-${j}`] = `${ov.key} is already set on this experiment.`;
        seen.add(ov.key);
        const parsed = parseOverrideValue(ov.value);
        if (parsed.error) errors[`exp-${i}-ov-${j}`] = parsed.error;
        else overrides[ov.key] = parsed.value;
      });
      if (description) experiments.push({ description, overrides });
    });
    if (!experiments.length && !Object.keys(errors).some((k) => k.startsWith("exp-"))) {
      errors.experiments = "Add at least one experiment.";
    }
    if (!Object.keys(errors).some((k) => k.startsWith("exp-") || k === "experiments")) {
      mission.strategy = { type: "sweep", experiments };
    }
  }

  const minImprovement = parseNumber(form.minImprovement, { min: 0, label: "Minimum improvement" });
  if (minImprovement.error) errors.minImprovement = minImprovement.error;
  const maxMemory = parseNumber(form.maxMemoryGb, { min: 0.1, allowEmpty: true, label: "Memory cap" });
  if (maxMemory.error) errors.maxMemoryGb = maxMemory.error;
  if (!minImprovement.error && !maxMemory.error) {
    mission.keep_policy = { metric: "val_bpb", direction: form.direction === "max" ? "max" : "min", min_improvement: minImprovement.value };
    if (maxMemory.value !== undefined) mission.keep_policy.max_memory_gb = maxMemory.value;
  }

  const maxExperiments = parseNumber(form.maxExperiments, { integer: true, min: 1, max: 10000, label: "Max experiments" });
  if (maxExperiments.error) errors.maxExperiments = maxExperiments.error;
  const maxDuration = parseNumber(form.maxDuration, { integer: true, min: 5, allowEmpty: true, label: "Max duration" });
  if (maxDuration.error) errors.maxDuration = maxDuration.error;
  const experimentTimeout = parseNumber(form.experimentTimeout, { integer: true, min: 1, max: 120, label: "Per-run timeout" });
  if (experimentTimeout.error) errors.experimentTimeout = experimentTimeout.error;
  if (!maxExperiments.error && !maxDuration.error && !experimentTimeout.error) {
    mission.budget = {
      max_experiments: maxExperiments.value,
      experiment_timeout_minutes: experimentTimeout.value,
    };
    if (maxDuration.value !== undefined) mission.budget.max_duration_minutes = maxDuration.value;
  }

  const tags = String(form.tags || "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  if (tags.length > 20) errors.tags = "At most 20 tags.";
  else if (tags.some((t) => t.length > 40)) errors.tags = "Each tag must be at most 40 characters.";
  else if (tags.length) mission.tags = tags;

  return { mission, errors };
}

export function hyperPlaceholders(schema) {
  return { ...HYPER_PLACEHOLDERS, ...((schema && schema["x-hyperparameter-placeholders"]) || {}) };
}
