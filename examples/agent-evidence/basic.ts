import { judgeEvidence } from '@j1nn0/agent-evidence';

const verdict = judgeEvidence({
  claims: [
    {
      id: 'tests-pass',
      requires: [{ evidenceId: 'current-tests' }],
    },
    {
      id: 'bug-fixed',
      requires: [{ evidenceId: 'bug-proof' }],
    },
    {
      id: 'current-proof',
      requires: [{ evidenceId: 'old-proof', subject: 'current-revision' }],
    },
    {
      id: 'release-ready',
      requires: [{ evidenceId: 'missing-proof' }],
    },
  ],
  evidence: [
    { id: 'current-tests', outcome: 'confirmed' },
    { id: 'bug-proof', outcome: 'refuted' },
    { id: 'old-proof', outcome: 'refuted', subject: 'old-revision' },
  ],
});

for (const claimVerdict of verdict.claims) {
  console.log(claimVerdict);
}
