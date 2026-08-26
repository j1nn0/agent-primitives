import { judgeRetry } from '@j1nn0/agent-retry-guard';

const policy = { maxAttempts: 6, maxStrategyAttempts: 3 };
const sameStrategyRun = [
  { outcome: 'failure', strategyId: 'alpha' },
  { outcome: 'no_progress', strategyId: 'alpha' },
  { outcome: 'failure', strategyId: 'alpha' },
] as const;

console.log('same strategy reaches its policy:', judgeRetry({ attempts: sameStrategyRun, policy }));

const switchedStrategy = judgeRetry({
  attempts: [...sameStrategyRun, { outcome: 'failure', strategyId: 'beta' }],
  policy,
});
console.log('switching strategy resets the repeated run:', switchedStrategy);

const successfulEpisode = judgeRetry({
  attempts: [...sameStrategyRun, { outcome: 'success', strategyId: 'beta' }],
  policy,
});
console.log('success ends the episode:', successfulEpisode);

const freshEpisode = judgeRetry({
  attempts: [{ outcome: 'failure', strategyId: 'alpha' }],
  policy,
});
console.log('a fresh array starts a fresh episode:', freshEpisode);
