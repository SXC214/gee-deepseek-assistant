import { sanitizeChatText } from "./chat.js";

const PLAN_SCHEMA_VERSION = 3;
const STABLE_STATES = new Set(["idle", "clarifying", "ready"]);
const TRANSIENT_STATES = new Set(["researching", "generating"]);
const PLAN_STATUSES = new Set(["needs_clarification", "ready"]);
const PLAN_WORKFLOWS = new Set(["standard", "todo_v1"]);
const PLAN_PHASES = new Set(["decomposing", "researching", "clarifying", "reviewing"]);
const TODO_STATUSES = new Set(["pending", "in_progress", "completed"]);
const REQUIRED_READY_REQUIREMENTS = [
  "area",
  "timeRange",
  "temporalAggregation",
  "spatialStatistic",
  "qualityControl"
];

/**
 * Creates the small, serializable state object used by Plan Mode.
 * All exported state transitions return a new session; callers can safely keep
 * the previous revision while an asynchronous search/model request is running.
 */
export function createPlanSession(originalRequest, { workflow = "standard" } = {}) {
  const request = cleanText(originalRequest);
  if (!request) throw new TypeError("Plan Mode requires a non-empty original request.");
  const normalizedWorkflow = PLAN_WORKFLOWS.has(workflow) ? workflow : "standard";

  return {
    schemaVersion: PLAN_SCHEMA_VERSION,
    workflow: normalizedWorkflow,
    originalRequest: request,
    userTurns: [],
    sources: [],
    plan: null,
    state: "idle",
    stableState: "idle",
    revision: 0,
    planRevision: 0,
    planStale: false
  };
}

/**
 * Merges official-search snapshots while preserving their first-seen order.
 * A shared canonical URL OR Earth Engine dataset id identifies a duplicate.
 */
export function mergeSources(existing = [], incoming = []) {
  const merged = [];
  for (const source of [...asArray(existing), ...asArray(incoming)]) {
    const normalized = normalizeSource(source);
    if (!normalized) continue;
    const duplicateIndex = merged.findIndex((current) => sameSource(current, normalized));
    if (duplicateIndex < 0) merged.push(normalized);
    else merged[duplicateIndex] = mergeSource(merged[duplicateIndex], normalized);
  }
  return merged;
}

/** Parses a raw JSON response or the JSON inside a Markdown code fence. */
export function parsePlanResponse(content) {
  const text = String(content ?? "").trim();
  if (!text) throw new SyntaxError("Plan response is empty.");

  const candidates = [];
  for (const match of text.matchAll(/```(?:json|JSON)?\s*\r?\n([\s\S]*?)```/g)) {
    candidates.push(match[1].trim());
  }
  candidates.push(text);

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (isPlainObject(parsed)) return parsed;
    } catch {
      // A model may wrap the raw JSON in a short explanation. Try extracting
      // the first complete object before reporting the parsing error below.
      const objectText = extractJsonObject(candidate);
      if (!objectText) continue;
      try {
        const parsed = JSON.parse(objectText);
        if (isPlainObject(parsed)) return parsed;
      } catch {
        // Continue with the next candidate.
      }
    }
  }
  throw new SyntaxError("Plan response must contain a JSON object.");
}

/**
 * Validates a model plan against the official source snapshot. It never throws
 * for ordinary model mistakes so the UI can render all actionable errors.
 */
export function validatePlanResponse(plan, sources = [], context = {}) {
  const errors = [];
  if (!isPlainObject(plan)) {
    return { valid: false, errors: ["Plan response must be an object."], plan: null };
  }

  const normalized = normalizePlan(plan);
  if (!PLAN_STATUSES.has(normalized.status)) {
    errors.push("status must be needs_clarification or ready.");
  }
  if (containsExecutableCode(normalized)) {
    errors.push("planning response must not contain executable JavaScript.");
  }
  if (normalized.status === "needs_clarification" && normalized.questions.length === 0) {
    errors.push("needs_clarification plan requires at least one question.");
  }
  if (context?.requireTodoWorkflow) {
    validateTodoWorkflow(normalized, errors, plan);
  }

  if (normalized.status === "ready") {
    if (!normalized.goal) errors.push("ready plan requires goal.");
    if (normalized.datasets.length === 0) errors.push("ready plan requires datasets.");
    for (const key of REQUIRED_READY_REQUIREMENTS) {
      if (!hasMeaningfulValue(normalized.requirements[key])) {
        errors.push(`ready plan requires requirements.${key}.`);
      }
    }
    if (!hasMeaningfulValue(normalized.method)) errors.push("ready plan requires method.");
    if (!hasMeaningfulValue(normalized.outputs)) errors.push("ready plan requires outputs.");
    if (normalized.questions.length > 0) errors.push("ready plan must not have unanswered questions.");
    if (context?.requireUserDiscussion && asArray(context.userTurns).length === 0) {
      errors.push("ready plan requires at least one user clarification before confirmation.");
    }

    const officialSources = mergeSources([], sources);
    const matchedDatasets = [];
    for (const dataset of normalized.datasets) {
      const datasetId = dataset.datasetId;
      const datasetUrl = canonicalUrl(dataset.url);
      if (!datasetId) {
        errors.push(`dataset ${datasetLabel(dataset)} requires datasetId.`);
      }
      if (!datasetUrl) {
        errors.push(`dataset ${datasetLabel(dataset)} requires url.`);
      }
      for (const key of ["name", "coverage", "spatialResolution", "advantages", "limitations", "recommendation"]) {
        if (!hasMeaningfulValue(dataset[key])) {
          errors.push(`dataset ${datasetLabel(dataset)} requires ${key}.`);
        }
      }
      if (!datasetId || !datasetUrl) {
        continue;
      }
      const matched = officialSources.find((source) => {
        if (source.type !== "dataset" || !hasCoherentCatalogIdentity(source)) return false;
        const idMatches = !datasetId
          || Boolean(source.datasetId && sameDatasetId(datasetId, source.datasetId));
        const urlMatches = !datasetUrl
          || Boolean(source.url && datasetUrl === canonicalUrl(source.url));
        return idMatches && urlMatches;
      });
      if (!matched) {
        errors.push(`dataset ${datasetLabel(dataset)} is not present in the official source snapshot.`);
      } else {
        matchedDatasets.push({ dataset, source: matched });
      }
    }
    validateTemporalCoverage(normalized, matchedDatasets, context, errors);
  }

  return { valid: errors.length === 0, errors, plan: normalized };
}

/** Applies a valid research/clarification result and creates a new revision. */
export function applyPlanResponse(session, response) {
  const current = sanitizePlanSession(session);
  if (!current) throw new TypeError("A valid plan session is required.");
  const parsed = typeof response === "string" ? parsePlanResponse(response) : response;
  const validation = validatePlanResponse(parsed, current.sources, {
    originalRequest: current.originalRequest,
    userTurns: current.userTurns,
    requireUserDiscussion: true,
    requireTodoWorkflow: current.workflow === "todo_v1"
  });
  if (!validation.valid) {
    const error = new TypeError(`Invalid plan response: ${validation.errors.join(" ")}`);
    error.validation = validation;
    throw error;
  }

  const state = validation.plan.status === "ready" ? "ready" : "clarifying";
  return {
    ...current,
    plan: validation.plan,
    state,
    stableState: state,
    revision: current.revision + 1,
    planRevision: current.planRevision + 1,
    planStale: false
  };
}

/**
 * Adds a user clarification. A previously ready plan is deliberately made
 * non-confirmable until a new research/clarification response is applied.
 */
export function addPlanAnswer(session, text) {
  const current = sanitizePlanSession(session);
  if (!current) throw new TypeError("A valid plan session is required.");
  const answer = cleanText(text);
  if (!answer) throw new TypeError("Plan answer must be non-empty.");

  return {
    ...current,
    userTurns: [...current.userTurns, answer],
    state: "clarifying",
    stableState: "clarifying",
    revision: current.revision + 1,
    planStale: true
  };
}

/** Sets an ephemeral state while retaining the last stable state for recovery. */
export function setPlanState(session, state) {
  const current = sanitizePlanSession(session);
  if (!current) throw new TypeError("A valid plan session is required.");
  if (!STABLE_STATES.has(state) && !TRANSIENT_STATES.has(state)) {
    throw new TypeError(`Unknown plan state: ${state}`);
  }
  return {
    ...current,
    state,
    stableState: STABLE_STATES.has(state) ? state : current.stableState
  };
}

/** Returns the only fields permitted in chrome.storage.local.activePlanV1. */
export function sanitizePlanSession(value) {
  if (!isPlainObject(value)) return null;
  const originalRequest = cleanText(value.originalRequest);
  if (!originalRequest) return null;
  const workflow = PLAN_WORKFLOWS.has(value.workflow) ? value.workflow : "standard";

  const candidatePlan = isPlainObject(value.plan) ? normalizePlan(value.plan) : null;
  const userTurns = asArray(value.userTurns).map(cleanText).filter(Boolean).slice(-100);
  const sources = mergeSources([], value.sources).slice(0, 80);
  const preferredStable = STABLE_STATES.has(value.stableState) ? value.stableState : null;
  const suppliedState = String(value.state || "");
  let state;
  let stableState;

  if (TRANSIENT_STATES.has(suppliedState)) {
    // A stopped/restarted fetch cannot be resumed, so return to a safe UI state.
    state = preferredStable || fallbackStableState(candidatePlan, Boolean(value.planStale));
    stableState = state;
  } else if (STABLE_STATES.has(suppliedState)) {
    state = suppliedState;
    stableState = preferredStable || state;
  } else {
    state = fallbackStableState(candidatePlan, Boolean(value.planStale));
    stableState = state;
  }

  let planStale = Boolean(value.planStale);
  const readyValidation = candidatePlan?.status === "ready"
    ? validatePlanResponse(candidatePlan, sources, {
      originalRequest,
      userTurns,
      requireUserDiscussion: true,
      requireTodoWorkflow: workflow === "todo_v1"
    })
    : null;
  const canConfirm = Boolean(readyValidation?.valid) && !planStale;

  // Stored state is untrusted. Revalidate a ready plan against its persisted
  // official-source snapshot before restoring a confirmation button.
  if ((state === "ready" || stableState === "ready") && !canConfirm) {
    state = "clarifying";
    stableState = "clarifying";
    planStale = true;
  }

  return {
    schemaVersion: PLAN_SCHEMA_VERSION,
    workflow,
    originalRequest,
    userTurns,
    sources,
    plan: candidatePlan,
    state,
    stableState,
    revision: nonNegativeInteger(value.revision),
    planRevision: nonNegativeInteger(value.planRevision),
    planStale
  };
}

/** JSON form is convenient for tests and for storage adapters that use strings. */
export function serializePlanSession(session) {
  const sanitized = sanitizePlanSession(session);
  if (!sanitized) throw new TypeError("A valid plan session is required.");
  return JSON.stringify(sanitized);
}

/** Restores either a JSON string or a chrome.storage plain object. */
export function restorePlanSession(stored) {
  if (typeof stored === "string") {
    try {
      return sanitizePlanSession(JSON.parse(stored));
    } catch {
      return null;
    }
  }
  return sanitizePlanSession(stored);
}

function normalizePlan(plan) {
  const requirements = isPlainObject(plan.requirements) ? plan.requirements : {};
  return {
    status: cleanText(plan.status),
    phase: cleanText(plan.phase),
    todoList: asArray(plan.todoList || plan.todo_list)
      .map(normalizeTodo)
      .filter((todo) => todo.id || todo.title),
    completedThisTurn: asArray(plan.completedThisTurn || plan.completed_this_turn)
      .map(cleanText)
      .filter(Boolean),
    currentTodoId: cleanText(plan.currentTodoId || plan.current_todo_id),
    nextTodoId: cleanText(plan.nextTodoId || plan.next_todo_id),
    goal: cleanText(plan.goal),
    researchSummary: cleanText(plan.researchSummary || plan.research_summary),
    datasets: asArray(plan.datasets).filter(isPlainObject).map(normalizeDataset),
    requirements: {
      area: cleanValue(requirements.area),
      timeRange: cleanValue(requirements.timeRange),
      temporalAggregation: cleanValue(requirements.temporalAggregation),
      spatialStatistic: cleanValue(requirements.spatialStatistic),
      qualityControl: cleanValue(requirements.qualityControl)
    },
    method: cleanValue(plan.method),
    outputs: cleanValue(plan.outputs),
    assumptions: asArray(plan.assumptions).map(cleanText).filter(Boolean),
    risks: asArray(plan.risks).map(cleanText).filter(Boolean),
    revisionSummary: cleanValue(plan.revisionSummary || plan.revision_summary),
    questions: asArray(plan.questions)
      .map(normalizeQuestion)
      .filter((question) => question.prompt)
      .slice(0, 3)
  };
}

function normalizeTodo(todo, index) {
  if (!isPlainObject(todo)) {
    return {
      id: `todo_${index + 1}`,
      title: "",
      objective: "",
      evidenceNeeded: [],
      status: "",
      result: ""
    };
  }
  return {
    id: cleanText(todo.id) || `todo_${index + 1}`,
    title: cleanText(todo.title),
    objective: cleanText(todo.objective),
    evidenceNeeded: asArray(todo.evidenceNeeded || todo.evidence_needed)
      .map(cleanText)
      .filter(Boolean),
    status: cleanText(todo.status),
    result: cleanText(todo.result)
  };
}

function validateTodoWorkflow(plan, errors, rawPlan) {
  for (const field of [
    "status",
    "phase",
    "todoList",
    "completedThisTurn",
    "currentTodoId",
    "nextTodoId",
    "goal",
    "researchSummary",
    "datasets",
    "requirements",
    "method",
    "outputs",
    "assumptions",
    "risks",
    "revisionSummary",
    "questions"
  ]) {
    if (!Object.hasOwn(rawPlan, field)) errors.push(`TODO workflow requires field ${field}.`);
  }
  if (!PLAN_PHASES.has(plan.phase)) {
    errors.push("TODO workflow phase must be decomposing, researching, clarifying, or reviewing.");
  }
  if (plan.todoList.length < 4 || plan.todoList.length > 8) {
    errors.push("TODO workflow requires 4-8 tasks.");
  }

  const ids = new Set();
  let inProgressCount = 0;
  for (const todo of plan.todoList) {
    const label = todo.id || todo.title || "task";
    if (!todo.id) errors.push("each TODO task requires id.");
    else if (ids.has(todo.id)) errors.push(`TODO task id ${todo.id} must be unique.`);
    else ids.add(todo.id);
    if (!todo.title) errors.push(`TODO task ${label} requires title.`);
    if (!todo.objective) errors.push(`TODO task ${label} requires objective.`);
    if (todo.evidenceNeeded.length === 0) errors.push(`TODO task ${label} requires evidenceNeeded.`);
    if (!TODO_STATUSES.has(todo.status)) errors.push(`TODO task ${label} has invalid status.`);
    if (todo.status === "in_progress") inProgressCount += 1;
    if (todo.status === "completed" && !todo.result) {
      errors.push(`completed TODO task ${label} requires result.`);
    }
  }
  if (inProgressCount > 1) errors.push("TODO workflow allows at most one in_progress task.");

  const completedIds = new Set(plan.todoList
    .filter((todo) => todo.status === "completed")
    .map((todo) => todo.id));
  for (const id of plan.completedThisTurn) {
    if (!ids.has(id)) errors.push(`completedThisTurn references unknown TODO task ${id}.`);
    else if (!completedIds.has(id)) errors.push(`completedThisTurn task ${id} must be completed.`);
  }

  const current = plan.todoList.find((todo) => todo.id === plan.currentTodoId);
  const next = plan.todoList.find((todo) => todo.id === plan.nextTodoId);
  if (plan.currentTodoId && !current) errors.push("currentTodoId must reference a TODO task.");
  if (current && current.status !== "in_progress") errors.push("currentTodoId must reference the in_progress task.");
  if (inProgressCount === 1 && !plan.currentTodoId) errors.push("an in_progress task requires currentTodoId.");
  if (plan.nextTodoId && !next) errors.push("nextTodoId must reference a TODO task.");
  if (next && next.status !== "pending") errors.push("nextTodoId must reference a pending task.");

  if (plan.phase === "decomposing" && inProgressCount !== 1) {
    errors.push("decomposing phase requires exactly one in_progress task.");
  }
  if (plan.phase === "researching" && plan.status === "ready") {
    errors.push("researching phase cannot be ready.");
  }
  if (plan.phase === "clarifying" && plan.status !== "needs_clarification") {
    errors.push("clarifying phase requires needs_clarification status.");
  }
  for (const question of plan.questions) {
    if (question.options.length < 2 || question.options.length > 3) {
      errors.push(`TODO workflow question ${question.id} requires 2-3 options.`);
    }
    if (!question.options.some((option) => option.recommended)) {
      errors.push(`TODO workflow question ${question.id} requires a recommended option.`);
    }
    const optionIds = question.options.map((option) => option.id);
    if (new Set(optionIds).size !== optionIds.length) {
      errors.push(`TODO workflow question ${question.id} option ids must be unique.`);
    }
  }
  if (plan.status === "ready") {
    if (plan.phase !== "reviewing") errors.push("ready TODO workflow requires reviewing phase.");
    if (plan.todoList.some((todo) => todo.status !== "completed")) {
      errors.push("ready TODO workflow requires all tasks completed.");
    }
    if (plan.currentTodoId || plan.nextTodoId) {
      errors.push("ready TODO workflow requires empty currentTodoId and nextTodoId.");
    }
  }
}

function normalizeQuestion(question, index) {
  if (typeof question === "string") {
    return {
      id: `question_${index + 1}`,
      prompt: cleanText(question),
      options: [],
      allowFreeText: true
    };
  }
  if (!isPlainObject(question)) {
    return { id: `question_${index + 1}`, prompt: "", options: [], allowFreeText: true };
  }
  const options = asArray(question.options).map((option, optionIndex) => {
    if (typeof option === "string") {
      return { id: `option_${optionIndex + 1}`, label: cleanText(option), description: "", recommended: false };
    }
    if (!isPlainObject(option)) return null;
    return {
      id: cleanText(option.id) || `option_${optionIndex + 1}`,
      label: cleanText(option.label || option.value),
      description: cleanText(option.description),
      recommended: Boolean(option.recommended)
    };
  }).filter((option) => option?.label).slice(0, 3);
  return {
    id: cleanText(question.id) || `question_${index + 1}`,
    prompt: cleanText(question.prompt || question.question),
    options,
    allowFreeText: question.allowFreeText !== false
  };
}

function normalizeDataset(dataset) {
  return {
    datasetId: cleanText(dataset.datasetId || dataset.id || dataset.catalogId),
    url: canonicalUrl(dataset.url || dataset.sourceUrl),
    name: cleanText(dataset.name || dataset.title),
    coverage: cleanValue(dataset.coverage),
    spatialResolution: cleanValue(dataset.spatialResolution || dataset.resolution),
    advantages: cleanValue(dataset.advantages),
    limitations: cleanValue(dataset.limitations),
    recommendation: cleanValue(dataset.recommendation)
  };
}

function normalizeSource(source) {
  if (!isPlainObject(source)) return null;
  const canonical = canonicalUrl(source.url);
  const url = isOfficialEarthEngineUrl(canonical) ? canonical : "";
  const datasetId = cleanText(source.datasetId || source.id);
  if (!url && !datasetId) return null;
  return {
    type: cleanText(source.type || source.kind) || (datasetId ? "dataset" : "docs"),
    title: cleanText(source.title),
    url,
    datasetId,
    summary: cleanText(source.summary || source.description),
    snippet: cleanText(source.snippet)
  };
}

function mergeSource(existing, incoming) {
  return {
    type: incoming.type || existing.type,
    title: incoming.title || existing.title,
    url: existing.url || incoming.url,
    datasetId: existing.datasetId || incoming.datasetId,
    summary: incoming.summary || existing.summary,
    snippet: incoming.snippet || existing.snippet
  };
}

function sameSource(left, right) {
  return Boolean(
    (left.url && right.url && canonicalUrl(left.url) === canonicalUrl(right.url))
    || (left.datasetId && right.datasetId && sameDatasetId(left.datasetId, right.datasetId))
  );
}

function sameDatasetId(left, right) {
  return cleanText(left).toLowerCase() === cleanText(right).toLowerCase();
}

function fallbackStableState(plan, planStale) {
  if (planStale) return "clarifying";
  return plan?.status === "ready" ? "ready" : plan ? "clarifying" : "idle";
}

function datasetLabel(dataset) {
  return dataset.name || dataset.datasetId || dataset.url || "entry";
}

function cleanText(value) {
  return typeof value === "string" ? sanitizeChatText(value) : "";
}

function cleanValue(value) {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value.map(cleanValue).filter(hasMeaningfulValue);
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cleanValue(item)]));
  }
  return "";
}

function hasMeaningfulValue(value) {
  if (typeof value === "string") return Boolean(value.trim());
  if (Array.isArray(value)) return value.length > 0;
  return isPlainObject(value) && Object.values(value).some(hasMeaningfulValue);
}

function containsExecutableCode(value) {
  const text = JSON.stringify(value);
  return /```\s*(?:javascript|js)\b/i.test(text)
    || /(?:^|\\n)\s*(?:var|let|const)\s+[A-Za-z_$][\w$]*\s*=/m.test(text)
    || /\b(?:Map\.addLayer|Export\.(?:image|table)|ee\.(?:Image|ImageCollection|FeatureCollection))\s*\(/.test(text);
}

function canonicalUrl(value) {
  const text = cleanText(value);
  if (!text) return "";
  try {
    const url = new URL(text);
    url.search = "";
    url.hash = "";
    return url.href.replace(/\/$/, "");
  } catch {
    return "";
  }
}

function isOfficialEarthEngineUrl(value) {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && url.hostname.toLowerCase() === "developers.google.com"
      && (url.pathname === "/earth-engine" || url.pathname.startsWith("/earth-engine/"));
  } catch {
    return false;
  }
}

function hasCoherentCatalogIdentity(source) {
  if (!source?.datasetId || !source?.url) return false;
  try {
    const url = new URL(source.url);
    const prefix = "/earth-engine/datasets/catalog/";
    if (!url.pathname.startsWith(prefix)) return false;
    const slug = decodeURIComponent(url.pathname.slice(prefix.length)).replace(/\/$/, "");
    return slug.toLowerCase() === source.datasetId.replaceAll("/", "_").toLowerCase();
  } catch {
    return false;
  }
}

function validateTemporalCoverage(plan, matchedDatasets, context, errors) {
  const originalRequest = typeof context === "string"
    ? context
    : cleanText(context?.originalRequest);
  const requested = extractYearRange(`${originalRequest}\n${JSON.stringify(plan.requirements.timeRange)}`);
  if (!requested) return;

  let fullCoverageCount = 0;
  const resolved = [];
  for (const match of matchedDatasets) {
    const availability = extractOfficialAvailability(match.source.summary);
    if (!availability) {
      errors.push(`dataset ${datasetLabel(match.dataset)} has no verifiable Dataset Availability in its official snapshot.`);
      continue;
    }
    resolved.push({ ...match, availability });

    const claimedYears = extractYears(JSON.stringify(match.dataset.coverage));
    if (!claimedYears.length) {
      errors.push(`dataset ${datasetLabel(match.dataset)} coverage must state a year from the official snapshot.`);
    } else if (claimedYears.some((year) => year < availability.start || year > availability.end)) {
      errors.push(`dataset ${datasetLabel(match.dataset)} coverage conflicts with the official Dataset Availability.`);
    }

    const coversRequest = availability.start <= requested.start && availability.end >= requested.end;
    if (coversRequest) fullCoverageCount += 1;
    else {
      if (marksPrimaryDataset(match.dataset)) {
        errors.push(`dataset ${datasetLabel(match.dataset)} cannot be a primary dataset because it does not cover the full requested period.`);
      }
      if (!marksPartialOrExcluded(match.dataset)) {
        errors.push(`dataset ${datasetLabel(match.dataset)} does not cover the full requested period and must be marked supplemental or excluded.`);
      }
    }
  }

  if (matchedDatasets.length && fullCoverageCount === 0) {
    errors.push("ready plan requires at least one officially verified dataset covering the requested period.");
  }

  const ndviLongSeries = /\bndvi\b|归一化植被指数/i.test(originalRequest)
    && requested.start <= 2000
    && requested.end >= 2020;
  if (!ndviLongSeries) return;

  const families = new Map();
  for (const entry of resolved) {
    const identity = `${entry.source.title} ${entry.source.datasetId}`.toLowerCase();
    if (identity.includes("landsat") && !families.has("Landsat")) families.set("Landsat", entry);
    if ((identity.includes("modis") || /\/mod13/i.test(entry.source.datasetId)) && !families.has("MODIS")) {
      families.set("MODIS", entry);
    }
    if ((identity.includes("sentinel-2") || /copernicus\/s2|\/hlss30/i.test(entry.source.datasetId))
      && !families.has("Sentinel-2")) {
      families.set("Sentinel-2", entry);
    }
  }
  for (const family of ["Landsat", "MODIS", "Sentinel-2"]) {
    if (!families.has(family)) {
      errors.push(`${requested.start}-${requested.end} NDVI plan must compare an official ${family} candidate.`);
    }
  }
  const sentinel = families.get("Sentinel-2");
  if (sentinel && sentinel.availability.start > requested.start && !marksPartialOrExcluded(sentinel.dataset)) {
    errors.push(`Sentinel-2 does not cover the full ${requested.start}-${requested.end} period and must be identified as supplemental or excluded.`);
  }
}

function extractYearRange(value) {
  const text = String(value || "");
  const match = text.match(/\b((?:19|20)\d{2})\s*(?:-|–|—|至|到)\s*((?:19|20)\d{2})\b/);
  const years = match ? [Number(match[1]), Number(match[2])] : extractYears(text).slice(0, 2);
  if (years.length < 2) return null;
  const [first, second] = years;
  return { start: Math.min(first, second), end: Math.max(first, second) };
}

function extractYears(value) {
  return [...String(value || "").matchAll(/\b((?:19|20)\d{2})\b/g)].map((match) => Number(match[1]));
}

function extractOfficialAvailability(summary) {
  const text = cleanText(summary);
  const marker = text.toLowerCase().indexOf("dataset availability");
  if (marker < 0) return null;
  const years = [...text.slice(marker, marker + 180).matchAll(/\b((?:19|20)\d{2})-\d{2}-\d{2}/g)]
    .map((match) => Number(match[1]));
  if (years.length < 2) return null;
  return { start: years[0], end: years[1] };
}

function marksPartialOrExcluded(dataset) {
  const role = JSON.stringify({
    coverage: dataset.coverage,
    limitations: dataset.limitations,
    recommendation: dataset.recommendation
  });
  return /补充|辅助|对照|不覆盖|覆盖不完整|不足|排除|不采用|不推荐|supplement|comparison|reference|exclude|not cover|incomplete|limited|partial/i.test(role);
}

function marksPrimaryDataset(dataset) {
  const recommendation = JSON.stringify(dataset.recommendation);
  if (/不作为[^"。；]*(?:主数据|主要数据)|not[^".]{0,40}(?:primary|main)/i.test(recommendation)) return false;
  return /唯一[^"。；]*(?:主数据|数据源)|作为[^"。；]*(?:主数据|主要数据)|primary dataset|main dataset|sole source/i.test(recommendation);
}

function extractJsonObject(text) {
  const start = text.indexOf("{");
  if (start < 0) return "";
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === "{") depth += 1;
    else if (char === "}" && --depth === 0) return text.slice(start, index + 1);
  }
  return "";
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonNegativeInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}
