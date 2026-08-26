import type {
  ClaimResult,
  EvidenceVerdict,
} from '@j1nn0/agent-evidence';
import type { EvidenceState } from './state.js';

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return count === 1 ? singular : plural;
}

function formatRequirement(
  evidenceId: string,
  subject: string | undefined,
): string {
  return subject === undefined
    ? evidenceId
    : `${evidenceId} (subject=${subject})`;
}

export function formatEvidenceState(state: EvidenceState): string {
  const claimCount = state.claims.length;
  const evidenceCount = state.evidence.length;
  const lines = [
    `Agent Evidence: ${claimCount} ${pluralize(claimCount, 'claim')} and ${evidenceCount} ${pluralize(evidenceCount, 'evidence record')} in the current session.`,
  ];

  if (claimCount === 0) {
    lines.push('Claims: none.');
  } else {
    lines.push('Claims:');
    for (const claim of state.claims) {
      const requirements = claim.requires
        .map((requirement) =>
          formatRequirement(requirement.evidenceId, requirement.subject),
        )
        .join(', ');
      lines.push(`- ${claim.id}: requires ${requirements}`);
    }
  }

  if (evidenceCount === 0) {
    lines.push('Evidence: none.');
  } else {
    lines.push('Evidence:');
    for (const record of state.evidence) {
      const subject =
        record.subject === undefined ? '' : `; subject=${record.subject}`;
      lines.push(`- ${record.id}: outcome=${record.outcome}${subject}`);
    }
  }

  lines.push(
    'Policy: explicit judgment only; each requirement needs an existing evidence record with outcome=confirmed and, when supplied, the exact subject.',
  );
  return lines.join('\n');
}

function formatClaimResult(result: ClaimResult): string {
  switch (result.outcome) {
    case 'supported':
      return `[ok] ${result.claimId}`;
    case 'contradicted':
      return `[!!] ${result.claimId} contradicted by ${result.evidenceId}`;
    case 'unsupported':
      return `[..] ${result.claimId} unsupported (${result.reason}: ${result.evidenceId})`;
  }
}

export function formatEvidenceVerdict(verdict: EvidenceVerdict): string {
  return [
    'Agent Evidence verdict:',
    ...verdict.claims.map(formatClaimResult),
    JSON.stringify(verdict),
  ].join('\n');
}
