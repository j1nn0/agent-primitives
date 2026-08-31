import { isJsonValue, type JsonValue } from './json.js';
import { isSupervisorFeatureId } from './ids.js';
import { hasOnlyAllowedKeys, hasOwn, isPlainObject } from './internal.js';
import type { SupervisorFeatureMode, SupervisorMode } from './feature.js';

export interface SupervisorFeatureConfigEntry {
  readonly mode?: SupervisorFeatureMode;
  readonly settings?: JsonValue;
}

export interface SupervisorConfigV1 {
  readonly schemaVersion: 1;
  readonly mode: SupervisorMode;
  readonly features: Readonly<Record<string, SupervisorFeatureConfigEntry>>;
}

const EMPTY_FEATURE_CONFIG: Readonly<Record<string, SupervisorFeatureConfigEntry>> = Object.freeze({});

export const DEFAULT_SUPERVISOR_CONFIG: SupervisorConfigV1 = Object.freeze({
  schemaVersion: 1,
  mode: 'autonomous',
  features: EMPTY_FEATURE_CONFIG,
});

export type SupervisorConfigDiagnosticCode =
  | 'invalid-top-level'
  | 'invalid-schema-version'
  | 'invalid-mode'
  | 'invalid-features'
  | 'invalid-feature-entry';

export interface SupervisorConfigDiagnostic {
  readonly code: SupervisorConfigDiagnosticCode;
}

export interface SupervisorConfigFeatureDiagnostic extends SupervisorConfigDiagnostic {
  readonly featureId: string;
}

export type SupervisorConfigParseResult =
  | {
      readonly status: 'valid';
      readonly config: SupervisorConfigV1;
      readonly featureDiagnostics: readonly SupervisorConfigFeatureDiagnostic[];
    }
  | {
      readonly status: 'invalid';
      readonly diagnostics: readonly SupervisorConfigDiagnostic[];
    };

const ALLOWED_CONFIG_KEYS = new Set(['schemaVersion', 'mode', 'features']);
const ALLOWED_FEATURE_ENTRY_KEYS = new Set(['mode', 'settings']);

function isSupervisorMode(value: unknown): value is SupervisorMode {
  return value === 'autonomous' || value === 'observe' || value === 'off';
}

function invalidTopLevel(): SupervisorConfigParseResult {
  return { status: 'invalid', diagnostics: [{ code: 'invalid-top-level' }] };
}

function parseFeatureEntry(value: unknown): SupervisorFeatureConfigEntry | null {
  if (!isPlainObject(value)) {
    return null;
  }

  try {
    if (!hasOnlyAllowedKeys(value, ALLOWED_FEATURE_ENTRY_KEYS)) {
      return null;
    }

    const hasMode = hasOwn(value, 'mode');
    const hasSettings = hasOwn(value, 'settings');
    const mode = value.mode;
    const settings = value.settings;

    if (hasMode) {
      if (!isFeatureMode(mode)) {
        return null;
      }
      // The kernel checks JSON safety only; a registered feature owns semantic settings validation.
      if (hasSettings) {
        if (!isJsonValue(settings)) {
          return null;
        }
        return { mode, settings };
      }
      return { mode };
    }
    if (hasSettings) {
      if (!isJsonValue(settings)) {
        return null;
      }
      return { settings };
    }
    return {};
  } catch {
    return null;
  }
}

function isFeatureMode(value: unknown): value is SupervisorFeatureMode {
  return value === 'autonomous' || value === 'observe' || value === 'off';
}

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

export function parseSupervisorConfig(value: unknown): SupervisorConfigParseResult {
  try {
    if (!isPlainObject(value)) {
      return invalidTopLevel();
    }

    const diagnostics: SupervisorConfigDiagnostic[] = [];
    if (!hasOnlyAllowedKeys(value, ALLOWED_CONFIG_KEYS)) {
      diagnostics.push({ code: 'invalid-top-level' });
    }

    const hasSchemaVersion = hasOwn(value, 'schemaVersion');
    const hasMode = hasOwn(value, 'mode');
    const hasFeatures = hasOwn(value, 'features');
    const schemaVersion = value.schemaVersion;
    const modeValue = value.mode;
    const featuresValue = value.features;
    if (!hasSchemaVersion || schemaVersion !== 1) {
      diagnostics.push({ code: 'invalid-schema-version' });
    }
    if (!hasMode || !isSupervisorMode(modeValue)) {
      diagnostics.push({ code: 'invalid-mode' });
    }
    if (!hasFeatures || !isPlainObject(featuresValue)) {
      diagnostics.push({ code: 'invalid-features' });
    }

    if (diagnostics.length > 0) {
      return { status: 'invalid', diagnostics };
    }
    if (schemaVersion !== 1 || !isSupervisorMode(modeValue) || !isPlainObject(featuresValue)) {
      return invalidTopLevel();
    }

    const mode = modeValue;
    const featureValues = featuresValue;
    const featureIds: string[] = [];
    const featureDiagnostics: SupervisorConfigFeatureDiagnostic[] = [];

    for (const key of Reflect.ownKeys(featureValues)) {
      if (typeof key === 'symbol') {
        return { status: 'invalid', diagnostics: [{ code: 'invalid-features' }] };
      }
      featureIds.push(key);
    }
    featureIds.sort(compareStrings);

    const features: Record<string, SupervisorFeatureConfigEntry> = {};
    for (const featureId of featureIds) {
      let entry: SupervisorFeatureConfigEntry | null = null;
      try {
        entry = parseFeatureEntry(featureValues[featureId]);
      } catch {
        entry = null;
      }
      if (!isSupervisorFeatureId(featureId) || entry === null) {
        featureDiagnostics.push({ code: 'invalid-feature-entry', featureId });
        continue;
      }
      features[featureId] = entry;
    }

    featureDiagnostics.sort((left, right) => compareStrings(left.featureId, right.featureId));
    return {
      status: 'valid',
      config: { schemaVersion: 1, mode, features },
      featureDiagnostics,
    };
  } catch {
    return invalidTopLevel();
  }
}

