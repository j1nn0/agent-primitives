import { SUPERVISOR_KERNEL_ASSESSMENT_CAPABILITY } from '../feature.js';
import type { ResolvedSupervisorFeature, SupervisorPlan } from '../registry.js';
import type { SupervisorVerificationKind } from './verification.js';

/** Maximum UTF-16 code units retained from a Root Request task, from its beginning. */
export const SUPERVISOR_ASSESSMENT_TASK_TEXT_MAX_UTF16_CODE_UNITS = 8_000;

/** Maximum UTF-16 code units retained from the latest assistant response, from its end. */
export const SUPERVISOR_ASSESSMENT_FINAL_ASSISTANT_TEXT_MAX_UTF16_CODE_UNITS = 12_000;

/** Maximum number of most-recent tool-result records retained for assessment. */
export const SUPERVISOR_ASSESSMENT_MAX_EVIDENCE_RECORDS = 8;

/** Maximum UTF-16 code units retained in one tool-result record, from its end. */
export const SUPERVISOR_ASSESSMENT_EVIDENCE_RECORD_MAX_UTF16_CODE_UNITS = 4_000;

/** Maximum UTF-16 code units retained across all retained tool-result records. */
export const SUPERVISOR_ASSESSMENT_EVIDENCE_TOTAL_MAX_UTF16_CODE_UNITS = 24_000;

/** One bounded, digest-only observation of an executed tool result. */
export interface SupervisorAssessmentEvidence {
  readonly id: string;
  readonly toolName: string;
  readonly toolCallId: string;
  readonly isError: boolean;
  readonly inputDigest: string | null;
  readonly resultDigest: string | null;
  readonly mutationEpoch: number;
  readonly verificationKind: SupervisorVerificationKind | null;
  readonly text: string;
}

/** Ephemeral input assembled for a future Kernel-owned assessment request. */
export interface SupervisorAssessmentInput {
  readonly taskText?: string;
  readonly finalAssistantText?: string;
  readonly evidence: readonly SupervisorAssessmentEvidence[];
}

/**
 * Extracts only text content blocks. Images, tool calls, thinking, and other blocks are ignored;
 * adjacent text blocks are concatenated without adding or removing any content of their own.
 */
export function extractSupervisorAssessmentText(content: unknown): string {
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .filter(isTextContentBlock)
    .map((block) => block.text)
    .join('');
}

function isTextContentBlock(value: unknown): value is { readonly type: 'text'; readonly text: string } {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const block = value as { readonly type?: unknown; readonly text?: unknown };
  return block.type === 'text' && typeof block.text === 'string';
}

type AssessmentPlanSource = SupervisorPlan | readonly ResolvedSupervisorFeature[] | undefined;

/**
 * Returns true only when a resolved autonomous or observe feature explicitly consumes the Kernel's
 * assessment capability. Off and unavailable plan entries never activate assessment.
 *
 * The overload accepts either the complete resolved plan or its resolved feature list because the
 * Kernel keeps the latter at `runtimeManager.getPlan()?.features`.
 */
export function isSupervisorAssessmentEnabled(
  planOrFeatures: AssessmentPlanSource,
): boolean {
  if (planOrFeatures === undefined) {
    return false;
  }
  const features = 'features' in planOrFeatures ? planOrFeatures.features : planOrFeatures;

  return features.some((feature) => {
    if (feature.effectiveMode !== 'autonomous' && feature.effectiveMode !== 'observe') {
      return false;
    }
    return feature.descriptor?.requires.includes(SUPERVISOR_KERNEL_ASSESSMENT_CAPABILITY) ?? false;
  });
}
