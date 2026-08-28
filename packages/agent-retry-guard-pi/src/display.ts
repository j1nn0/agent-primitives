import type { RetryPolicy, RetryVerdict } from '@j1nn0/agent-retry-guard';
import type { RetryState } from './state.js';

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return count === 1 ? singular : plural;
}

export function formatRetryPolicy(policy: RetryPolicy): string {
  const limits: string[] = [];
  if (policy.maxAttempts !== undefined) {
    limits.push(`maxAttempts=${policy.maxAttempts}`);
  }
  if (policy.maxStrategyAttempts !== undefined) {
    limits.push(`maxStrategyAttempts=${policy.maxStrategyAttempts}`);
  }

  return limits.length === 0
    ? 'Policy: no policy set.'
    : `Policy: ${limits.join(', ')}.`;
}

export function formatRetryState(state: RetryState): string {
  const count = state.attempts.length;
  const lines = [
    `Agent Retry Guard: ${count} ${pluralize(count, 'attempt')} recorded in the current episode.`,
  ];

  if (count === 0) {
    lines.push('Attempts: none.');
  } else {
    lines.push(
      ...state.attempts.map(
        (attempt, index) =>
          `Attempt ${index + 1}: outcome=${attempt.outcome}; strategyId=${attempt.strategyId ?? 'no-id'}`,
      ),
    );
  }

  lines.push(formatRetryPolicy(state.policy));
  return lines.join('\n');
}

function retryReading(verdict: RetryVerdict): string {
  return verdict.retryAllowed
    ? 'retryAllowed is true: another attempt is permitted by the declared policy.'
    : 'retryAllowed is false: this episode is not permitted another attempt.';
}

export function formatRetryVerdict(verdict: RetryVerdict): string {
  return [
    'Agent Retry Guard verdict:',
    JSON.stringify(verdict, null, 2),
    `Reading: ${retryReading(verdict)}`,
    ...(verdict.retryAllowed ? [] : ['Start a new episode with agent_retry_start_episode.']),
  ].join('\n');
}
