import { ContextGuardError } from './errors.js';
import {
  copyItem,
  duplicateItem,
  hasOwn,
  isPlainObject,
  validateContextItem,
} from './item.js';
import type {
  ContextItem,
  ContextSnapshot,
  ContextVerifier,
  ContextVerifierInput,
  LiteralVerifierOptions,
  VerificationFinding,
  VerificationReport,
  VerificationStatus,
  VerifyContextInput,
} from './types.js';

const VERIFIER_FAILED_REASON =
  'The verifier failed, so this item could not be evaluated.';
const MISSING_FINDING_REASON = 'The verifier returned no finding for this item.';
const CONFLICTING_FINDING_REASON =
  'The verifier returned conflicting findings for this item.';
const INVALID_FINDING_REASON =
  'The verifier returned a structurally invalid finding for this item.';
const LITERAL_PRESERVED_REASON =
  'The item content appears in the candidate context after the configured normalization.';
const LITERAL_LOST_REASON =
  'The item content does not appear in the candidate context after the configured normalization.';

interface NormalizedFinding {
  readonly itemId: string;
  readonly status: VerificationStatus;
  readonly reason?: string;
}

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}

function isVerificationStatus(value: unknown): value is VerificationStatus {
  return (
    value === 'preserved' ||
    value === 'changed' ||
    value === 'lost' ||
    value === 'unknown'
  );
}

function invalidInput(message: string): never {
  throw new ContextGuardError('invalid_input', message);
}

function validateSnapshot(value: unknown): ContextSnapshot {
  if (!isPlainObject(value) || value.schemaVersion !== 1) {
    return invalidInput('Invalid context snapshot.');
  }

  const rawItems = value.items;
  if (!Array.isArray(rawItems)) {
    return invalidInput('Invalid context snapshot.');
  }

  const items: ContextItem[] = [];
  const ids = new Set<string>();
  for (const rawItem of rawItems) {
    const item = validateContextItem(rawItem);
    if (ids.has(item.id)) {
      return duplicateItem(item.id);
    }
    ids.add(item.id);
    items.push(item);
  }

  return { schemaVersion: 1, items };
}

interface ValidatedInput {
  readonly snapshot: ContextSnapshot;
  readonly context: string;
  readonly verifier: ContextVerifier;
}

function validateVerifyContextInput(input: unknown): ValidatedInput {
  if (!isObject(input)) {
    return invalidInput('Invalid verification input.');
  }

  const candidate = input as Record<string, unknown>;
  const snapshot = validateSnapshot(candidate.snapshot);
  const context = candidate.context;
  if (typeof context !== 'string') {
    return invalidInput('Invalid verification input.');
  }

  const verifierValue = candidate.verifier;
  if (!isObject(verifierValue)) {
    return invalidInput('Invalid verification input.');
  }

  let verify: unknown;
  try {
    verify = (verifierValue as Record<string, unknown>).verify;
  } catch {
    return invalidInput('Invalid verification input.');
  }
  if (typeof verify !== 'function') {
    return invalidInput('Invalid verification input.');
  }

  return {
    snapshot,
    context,
    verifier: verifierValue as ContextVerifier,
  };
}

function finding(
  itemId: string,
  status: VerificationStatus,
  reason?: string,
): VerificationFinding {
  if (reason === undefined) {
    return { itemId, status };
  }
  return { itemId, status, reason };
}

function unknownFindings(
  items: readonly ContextItem[],
  reason: string,
): VerificationFinding[] {
  return items.map((item) => finding(item.id, 'unknown', reason));
}

function buildReport(
  items: readonly ContextItem[],
  inputFindings: readonly VerificationFinding[],
  inputIssues: readonly string[],
): VerificationReport {
  const findings = inputFindings.map((item) =>
    finding(item.itemId, item.status, item.reason),
  );
  const preserved: string[] = [];
  const changed: string[] = [];
  const lost: string[] = [];
  const unknown: string[] = [];
  const criticalFailures: string[] = [];

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const itemFinding = findings[index];
    if (item === undefined || itemFinding === undefined) {
      continue;
    }

    switch (itemFinding.status) {
      case 'preserved':
        preserved.push(item.id);
        break;
      case 'changed':
        changed.push(item.id);
        break;
      case 'lost':
        lost.push(item.id);
        break;
      case 'unknown':
        unknown.push(item.id);
        break;
    }

    if (item.critical && itemFinding.status !== 'preserved') {
      criticalFailures.push(item.id);
    }
  }

  const issues = [...inputIssues];
  return {
    schemaVersion: 1,
    ok:
      changed.length === 0 &&
      lost.length === 0 &&
      unknown.length === 0 &&
      issues.length === 0,
    findings,
    preserved,
    changed,
    lost,
    unknown,
    criticalFailures,
    issues,
  };
}

function normalizeResult(
  items: readonly ContextItem[],
  result: unknown,
): VerificationReport {
  if (!Array.isArray(result)) {
    return buildReport(
      items,
      unknownFindings(items, VERIFIER_FAILED_REASON),
      ['verifier returned a non-array result'],
    );
  }

  const snapshotIds = new Set(items.map((item) => item.id));
  const findingsByItemId = new Map<string, NormalizedFinding[]>();
  const taintedItemIds = new Set<string>();
  const issues: string[] = [];
  const entries = result as readonly unknown[];

  for (let index = 0; index < entries.length; index += 1) {
    let knownItemId: string | undefined;

    try {
      const entry = entries[index];
      if (!isObject(entry)) {
        issues.push(`malformed finding at index ${index}`);
        continue;
      }

      const candidate = entry as Record<string, unknown>;
      const itemId = candidate.itemId;
      if (typeof itemId !== 'string') {
        issues.push(`malformed finding at index ${index}`);
        continue;
      }

      if (!snapshotIds.has(itemId)) {
        issues.push(`finding for unknown item id "${itemId}"`);
        continue;
      }

      knownItemId = itemId;

      const status = candidate.status;
      if (!isVerificationStatus(status)) {
        issues.push(`unsupported status for item "${itemId}"`);
        taintedItemIds.add(itemId);
        continue;
      }

      let reason: string | undefined;
      if (hasOwn(entry, 'reason')) {
        const reasonValue = candidate.reason;
        if (typeof reasonValue === 'string') {
          reason = reasonValue;
        } else {
          issues.push(`non-string reason for item "${itemId}"`);
        }
      }

      const normalized: NormalizedFinding =
        reason === undefined ? { itemId, status } : { itemId, status, reason };
      const existing = findingsByItemId.get(itemId);
      if (existing === undefined) {
        findingsByItemId.set(itemId, [normalized]);
      } else {
        existing.push(normalized);
      }
    } catch {
      issues.push(`malformed finding at index ${index}`);
      if (knownItemId !== undefined) {
        taintedItemIds.add(knownItemId);
      }
    }
  }

  const findings: VerificationFinding[] = [];
  for (const item of items) {
    // A structurally invalid finding for a known item taints that item, even
    // when another finding for it looked valid: the verifier's output cannot be
    // trusted per item, so the item must not stay preserved.
    if (taintedItemIds.has(item.id)) {
      findings.push(finding(item.id, 'unknown', INVALID_FINDING_REASON));
      continue;
    }

    const matches = findingsByItemId.get(item.id);
    if (matches === undefined || matches.length === 0) {
      issues.push(`missing finding for item "${item.id}"`);
      findings.push(finding(item.id, 'unknown', MISSING_FINDING_REASON));
      continue;
    }

    if (matches.length >= 2) {
      issues.push(`duplicate findings for item "${item.id}"`);
      findings.push(finding(item.id, 'unknown', CONFLICTING_FINDING_REASON));
      continue;
    }

    const [match] = matches;
    if (match === undefined) {
      issues.push(`missing finding for item "${item.id}"`);
      findings.push(finding(item.id, 'unknown', MISSING_FINDING_REASON));
      continue;
    }
    findings.push(finding(match.itemId, match.status, match.reason));
  }

  return buildReport(items, findings, issues);
}

export async function verifyContext(
  input: VerifyContextInput,
): Promise<VerificationReport> {
  const validated = validateVerifyContextInput(input);
  let result: unknown;

  try {
    result = await validated.verifier.verify({
      items: validated.snapshot.items.map(copyItem),
      context: validated.context,
    });
  } catch {
    return buildReport(
      validated.snapshot.items,
      unknownFindings(validated.snapshot.items, VERIFIER_FAILED_REASON),
      ['verifier threw an error'],
    );
  }

  return normalizeResult(validated.snapshot.items, result);
}

function normalize(value: string, whitespace: boolean, caseSensitive: boolean): string {
  let normalized = value;
  if (whitespace) {
    normalized = normalized.replace(/\s+/gu, ' ').trim();
  }
  if (!caseSensitive) {
    normalized = normalized.toLowerCase();
  }
  return normalized;
}

export function createLiteralVerifier(
  options: LiteralVerifierOptions = {},
): ContextVerifier {
  const caseSensitive = options.caseSensitive ?? false;
  const normalizeWhitespace = options.normalizeWhitespace ?? true;

  return {
    verify(input: ContextVerifierInput): VerificationFinding[] {
      const context = normalize(
        input.context,
        normalizeWhitespace,
        caseSensitive,
      );
      return input.items.map((item) => {
        const content = normalize(
          item.content,
          normalizeWhitespace,
          caseSensitive,
        );
        return context.includes(content)
          ? finding(item.id, 'preserved', LITERAL_PRESERVED_REASON)
          : finding(item.id, 'lost', LITERAL_LOST_REASON);
      });
    },
  };
}
