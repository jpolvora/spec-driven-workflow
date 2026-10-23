#!/usr/bin/env node
'use strict';

// Spec 00056 AC10-AC12: deterministic host-capability detection for advisory
// per-role model hints. Nothing here invokes a model, contacts a provider, or
// stores credentials: hints stay opaque strings and detection only reads and
// writes local JSON files.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const DETECTION_DEFAULTS = Object.freeze({ enabled: false, command: null, timeoutMs: 30000 });
const CACHE_FILE_REL = '.sdw/host-capabilities.json';
const MODEL_HINT_KEYS = ['model', 'provider', 'effort', 'apiEndpoint'];
const MODEL_ROLES = ['orchestrator', 'worker', 'reviewer', 'fixer', 'judge', 'ship', 'retro'];

function normalizePath(value) {
  return String(value).replace(/\\/g, '/');
}

function normalizeHint(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const hint = {};
  for (const key of MODEL_HINT_KEYS) {
    hint[key] = typeof entry[key] === 'string' && entry[key].trim() ? entry[key].trim() : null;
  }
  return MODEL_HINT_KEYS.some(key => hint[key] !== null) ? hint : null;
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

// Spec 00056 AC9: the detection block defaults to disabled, null command, and a
// 30 second timeout. SDW_MODELS_DETECT_COMMAND mirrors the judge env fallback.
function resolveDetection(models) {
  const raw = models && models.detection && typeof models.detection === 'object' && !Array.isArray(models.detection)
    ? models.detection
    : {};
  const envCommand = nonEmptyString(process.env && process.env.SDW_MODELS_DETECT_COMMAND);
  return {
    enabled: raw.enabled === true,
    command: nonEmptyString(raw.command) || envCommand,
    timeoutMs: Number.isInteger(raw.timeoutMs) && raw.timeoutMs > 0 ? raw.timeoutMs : DETECTION_DEFAULTS.timeoutMs
  };
}

// Spec 00056 AC10: the cache maps one key per session model. The host may pass
// a neutral host id plus session model, or the full key through the environment.
function resolveSessionKey(options = {}) {
  const explicit = nonEmptyString(options.modelsSessionKey) || nonEmptyString(options.sessionKey);
  if (explicit) return explicit;
  const envKey = nonEmptyString(process.env && process.env.SDW_MODELS_SESSION_KEY);
  if (envKey) return envKey;
  const hostId = nonEmptyString(options.hostId) || nonEmptyString(process.env && process.env.SDW_HOST_ID) || 'host';
  const sessionModel = nonEmptyString(options.sessionModel) || nonEmptyString(process.env && process.env.SDW_SESSION_MODEL) || 'current';
  return `${hostId}::${sessionModel}`;
}

function quoteToken(value) {
  const str = String(value);
  if (process.platform === 'win32') {
    if (/["\r\n]/.test(str)) throw new Error(`Unsafe path for detection command substitution: ${str}`);
    return `"${str}"`;
  }
  return `'${str.replace(/'/g, "'\\''")}'`;
}

function substituteCommand(command, tokens) {
  return String(command)
    .replace(/\{capabilitiesFile\}/g, () => quoteToken(tokens.capabilitiesFile))
    .replace(/\{targetRoot\}/g, () => quoteToken(tokens.targetRoot))
    // Function replacers: `$` sequences in a value must never be expanded, and
    // the slug/runId come from file names, so they are quoted like paths.
    .replace(/\{slug\}/g, () => quoteToken(tokens.slug || ''))
    .replace(/\{runId\}/g, () => quoteToken(tokens.runId || ''));
}

// Spec 00056 AC12: shape validation only. The helper never checks reachability
// and never treats an unknown model id as an error of the detection file.
function validateCapabilities(raw) {
  const errors = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { valid: false, errors: ['capabilities must be a JSON object'] };
  }
  if (typeof raw.harness !== 'string') errors.push('capabilities.harness must be a string');
  if (!Array.isArray(raw.models)) {
    errors.push('capabilities.models must be an array');
  } else {
    raw.models.forEach((entry, index) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        errors.push(`capabilities.models[${index}] must be an object`);
        return;
      }
      if (typeof entry.model !== 'string' || !entry.model.trim()) {
        errors.push(`capabilities.models[${index}].model must be a non-empty string`);
      }
      for (const key of ['provider', 'effort']) {
        if (entry[key] !== undefined && entry[key] !== null && typeof entry[key] !== 'string') {
          errors.push(`capabilities.models[${index}].${key} must be a string or null`);
        }
      }
      if (typeof entry.available !== 'boolean') {
        errors.push(`capabilities.models[${index}].available must be a boolean`);
      }
    });
  }
  let supportedModels = null;
  if ('supportedModels' in raw) {
    if (!Array.isArray(raw.supportedModels) || raw.supportedModels.some(model => typeof model !== 'string' || !model.trim())) {
      errors.push('capabilities.supportedModels must be an array of non-empty strings');
    } else {
      supportedModels = raw.supportedModels.map(model => model.trim());
    }
  }
  if (errors.length > 0) return { valid: false, errors };
  const capabilities = {
    harness: raw.harness,
    models: raw.models.map(entry => ({
      model: entry.model.trim(),
      provider: nonEmptyString(entry.provider),
      effort: nonEmptyString(entry.effort),
      available: entry.available
    }))
  };
  if (supportedModels === null) {
    supportedModels = capabilities.models.filter(entry => entry.available).map(entry => entry.model);
  }
  return { valid: true, errors: [], capabilities, supportedModels };
}

function isModelAvailable(model, capabilities, supportedModels) {
  if (!model) return true;
  if (capabilities && Array.isArray(capabilities.models)) {
    const entries = capabilities.models.filter(entry => entry.model === model);
    if (entries.length > 0) return entries.some(entry => entry.available);
  }
  if (Array.isArray(supportedModels)) return supportedModels.includes(model);
  return true;
}

// Spec 00056 AC11: when a statically resolved hint names a model flagged
// unavailable in supportedModels or the capabilities list, walk the role chain
// to the first available entry, then models.default, then null. Every adaptation
// records requested, resolved, and the reason.
function adaptModelHints(options = {}) {
  const staticHints = options.staticHints || {};
  const chains = options.chains || {};
  const capabilities = options.capabilities || null;
  const supportedModels = Array.isArray(options.supportedModels) ? options.supportedModels : null;
  const resolved = {};
  const adaptations = [];

  for (const role of MODEL_ROLES) {
    const staticHint = staticHints[role] || null;
    if (!staticHint || !staticHint.model) {
      resolved[role] = staticHint;
      continue;
    }
    if (!capabilities || isModelAvailable(staticHint.model, capabilities, supportedModels)) {
      resolved[role] = staticHint;
      continue;
    }

    const chain = Array.isArray(chains[role]) && chains[role].length > 0 ? chains[role] : [staticHint];
    let replacement = null;
    for (const candidate of chain) {
      if (!candidate) continue;
      if (!candidate.model) {
        replacement = null;
        break;
      }
      if (isModelAvailable(candidate.model, capabilities, supportedModels)) {
        replacement = candidate;
        break;
      }
    }

    const requested = staticHint.model;
    const resolvedModel = replacement ? replacement.model : null;
    resolved[role] = replacement ? { ...replacement, configuredModel: requested } : null;
    adaptations.push({
      role,
      requested,
      resolved: resolvedModel,
      reason: `requested model "${requested}" is unavailable in the captured capabilities; resolved ${resolvedModel ? `"${resolvedModel}"` : 'the session model'}`
    });
  }

  return { resolved, adaptations };
}

function readCapabilitiesCache(cacheFile) {
  try {
    const parsed = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (e) {
    return null;
  }
}

function writeCapabilitiesCache(cacheFile, key, entry) {
  const cache = readCapabilitiesCache(cacheFile) || {};
  cache[key] = entry;
  try {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2) + '\n', 'utf8');
    return true;
  } catch (e) {
    return false;
  }
}

function runProbe(options) {
  const { targetRoot, detection, capabilitiesFile, slug, runId } = options;
  if (detection.command) {
    let substituted;
    try {
      substituted = substituteCommand(detection.command, {
        capabilitiesFile,
        targetRoot,
        slug,
        runId
      });
    } catch (err) {
      return { ok: false, error: err.message };
    }
    try { fs.rmSync(capabilitiesFile, { force: true }); } catch (e) { /* best effort */ }
    try { fs.mkdirSync(path.dirname(capabilitiesFile), { recursive: true }); } catch (e) { /* best effort */ }
    const proc = spawnSync(substituted, {
      cwd: targetRoot,
      shell: true,
      timeout: detection.timeoutMs,
      encoding: 'utf8'
    });
    if (proc.error && proc.error.code === 'ETIMEDOUT') {
      return { ok: false, error: `detection command timed out after ${detection.timeoutMs}ms` };
    }
    if (proc.error) {
      return { ok: false, error: `detection command failed: ${proc.error.message}` };
    }
    if (proc.status !== 0) {
      const stderr = proc.stderr ? String(proc.stderr).trim() : '';
      return { ok: false, error: stderr || `detection command exited with status ${proc.status}` };
    }
  }

  if (!fs.existsSync(capabilitiesFile)) {
    return { ok: false, error: `capabilities file not found: ${normalizePath(capabilitiesFile)}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(capabilitiesFile, 'utf8'));
  } catch (err) {
    return { ok: false, error: `capabilities file is not valid JSON: ${err.message}` };
  }
  const validation = validateCapabilities(parsed);
  if (!validation.valid) {
    return { ok: false, error: `capabilities file shape is invalid: ${validation.errors.join('; ')}` };
  }
  return { ok: true, capabilities: validation.capabilities, supportedModels: validation.supportedModels };
}

/**
 * Binds host capabilities once at run start (Spec 00056 AC10).
 *
 * @param {object} options
 * @param {string} options.targetRoot Project root.
 * @param {object} options.config Resolved project configuration.
 * @param {string} options.runId Run identifier used by the probe tokens.
 * @param {string} options.slug Specification slug used by the probe tokens.
 * @param {object} [options.options] CLI/runtime options: noModelDetect, refreshModels,
 *   modelsSessionKey, capabilitiesFile, capabilitiesCacheFile, now.
 * @returns {{detection: object, capabilities: object|null, supportedModels: string[]|null, warning: string|null}}
 */
function bindModelCapabilities(options = {}) {
  const targetRoot = options.targetRoot;
  const config = options.config || {};
  const runtime = options.options || {};
  const detection = resolveDetection(config.models);
  const key = resolveSessionKey(runtime);

  if (runtime.noModelDetect || !detection.enabled) {
    return { detection: { status: 'skipped' }, capabilities: null, supportedModels: null, warning: null };
  }

  const cacheFile = nonEmptyString(runtime.capabilitiesCacheFile)
    ? path.resolve(runtime.capabilitiesCacheFile)
    : path.join(targetRoot, CACHE_FILE_REL);

  if (!runtime.refreshModels) {
    const cache = readCapabilitiesCache(cacheFile);
    const entry = cache && cache[key];
    if (entry && entry.capabilities) {
      const validation = validateCapabilities(entry.capabilities);
      if (validation.valid) {
        return {
          detection: {
            enabled: true,
            status: 'hit',
            source: 'hit',
            transport: 'cache',
            key,
            command: detection.command,
            probedAt: typeof entry.probedAt === 'string' ? entry.probedAt : null
          },
          capabilities: validation.capabilities,
          supportedModels: Array.isArray(entry.supportedModels) ? entry.supportedModels : validation.supportedModels,
          warning: null
        };
      }
    }
  }

  const configuredStateDir = nonEmptyString(config.stateDir);
  const stateDir = configuredStateDir
    ? path.resolve(targetRoot, configuredStateDir)
    : path.join(targetRoot, '.sdw', 'state');
  const capabilitiesFile = nonEmptyString(runtime.capabilitiesFile)
    ? path.resolve(runtime.capabilitiesFile)
    : path.join(stateDir, options.runId || 'run', 'model-capabilities.probe.json');

  const probe = runProbe({
    targetRoot,
    detection,
    capabilitiesFile,
    slug: options.slug,
    runId: options.runId
  });
  const probedAt = typeof runtime.now === 'function' ? String(runtime.now()) : new Date().toISOString();

  if (!probe.ok) {
    return {
      detection: {
        enabled: true,
        status: 'failed-open',
        source: 'failed-open',
        transport: detection.command ? 'command' : 'host',
        key,
        command: detection.command,
        probedAt: null,
        error: probe.error
      },
      capabilities: null,
      supportedModels: null,
      warning: `Model detection failed open: ${probe.error}`
    };
  }

  const transport = detection.command ? 'command' : 'host';
  writeCapabilitiesCache(cacheFile, key, {
    capabilities: probe.capabilities,
    supportedModels: probe.supportedModels,
    probedAt,
    source: transport
  });
  return {
    detection: {
      enabled: true,
      status: 'probe',
      source: 'probe',
      transport,
      key,
      command: detection.command,
      probedAt
    },
    capabilities: probe.capabilities,
    supportedModels: probe.supportedModels,
    warning: null
  };
}

module.exports = {
  substituteCommand,
  DETECTION_DEFAULTS,
  CACHE_FILE_REL,
  MODEL_ROLES,
  normalizeHint,
  resolveDetection,
  resolveSessionKey,
  validateCapabilities,
  isModelAvailable,
  adaptModelHints,
  readCapabilitiesCache,
  writeCapabilitiesCache,
  bindModelCapabilities
};
