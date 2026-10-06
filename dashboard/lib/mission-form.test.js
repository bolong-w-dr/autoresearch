import assert from "node:assert/strict";
import test from "node:test";
import { agentTemplate, blankForm, formFromMission, missionFromForm, parseOverrideValue } from "./mission-form.js";
import { collectHints, missionDocHtml } from "./schema-doc.js";

const day = new Date("2026-10-06T12:00:00Z");

test("a fresh form is prefilled and produces a sweep mission", () => {
  const form = blankForm(day);
  assert.equal(form.tag, "oct6");
  assert.equal(form.name, "oct6 sweep");
  assert.equal(form.experiments[0].overrides[0].value, "0.05");
  assert.equal(form.experiments[0].description.length > 0, true);
  const { mission, errors } = missionFromForm(form);
  assert.deepEqual(errors, {});
  assert.equal(mission.strategy.type, "sweep");
  assert.equal(mission.strategy.experiments[0].overrides.MATRIX_LR, 0.05);
  assert.equal(mission.budget.max_experiments, 12);
  assert.equal(mission.budget.max_duration_minutes, undefined);
  assert.equal(mission.keep_policy.max_memory_gb, undefined);
  assert.equal(mission.mission_id, undefined);
});

test("placeholders and blanks are rejected with field errors", () => {
  const form = blankForm(day);
  form.name = "";
  form.tag = "Has Spaces";
  form.experiments[0].overrides[0].value = "";
  form.experiments[0].description = "";
  const { errors } = missionFromForm(form);
  assert.match(errors.name, /name/);
  assert.match(errors.tag, /Lowercase/);
  assert.ok(errors["exp-0-description"]);
  assert.match(errors["exp-0-ov-0"], /placeholder|value/);
});

test("comma-separated overrides become number lists", () => {
  assert.deepEqual(parseOverrideValue("0.8, 0.95"), { value: [0.8, 0.95] });
  assert.deepEqual(parseOverrideValue("SSSL"), { value: "SSSL" });
  assert.ok(parseOverrideValue("").error);
  const form = blankForm(day);
  form.experiments[0].overrides = [{ key: "ADAM_BETAS", value: "0.9, 0.95" }];
  const { mission, errors } = missionFromForm(form);
  assert.deepEqual(errors, {});
  assert.deepEqual(mission.strategy.experiments[0].overrides.ADAM_BETAS, [0.9, 0.95]);
});

test("agent template and round-trip through a mission", () => {
  const agent = agentTemplate(day);
  const built = missionFromForm(agent);
  assert.deepEqual(built.errors, {});
  assert.deepEqual(built.mission.strategy.command[0], "claude");
  assert.ok(built.mission.strategy.command.some((p) => p.includes("{prompt_file}")));
  assert.equal(built.mission.budget.max_duration_minutes, 480);
  assert.deepEqual(built.mission.tags, ["agent", "overnight"]);
  const again = missionFromForm(formFromMission(built.mission, day));
  assert.deepEqual(again.mission.strategy, built.mission.strategy);
});

test("schema doc renders examples and field hints", () => {
  const schema = {
    description: "A mission.",
    required: ["name"],
    properties: {
      name: { type: "string", description: "Display name.", examples: ["LR sweep"] },
      strategy: { oneOf: [{ $ref: "#/$defs/SweepStrategy" }] },
    },
    $defs: {
      SweepStrategy: {
        properties: { experiments: { type: "array", description: "Planned experiments.", examples: [[{ description: "deeper" }]] } },
      },
    },
    "x-hyperparameter-placeholders": { MATRIX_LR: "0.04" },
  };
  const html = missionDocHtml(schema, (s) => String(s));
  assert.match(html, /LR sweep/);
  assert.match(html, /MATRIX_LR = 0.04/);
  assert.match(html, /Planned experiments/);
  const hints = collectHints(schema);
  assert.equal(hints.name.example, "LR sweep");
  assert.equal(hints.name.required, true);
  assert.match(hints["SweepStrategy.experiments"].description, /Planned/);
});
