import { describe, expect, it, vi } from 'vitest';
import {
  ContextGuardError,
  createContextGuard,
  createLiteralVerifier,
  verifyContext,
} from '../src/index.js';
import type { ContextVerifier, ContextSnapshot } from '../src/index.js';

describe('privacy and side effects', () => {
  it('does not include candidate context or thrown verifier errors in reports', async () => {
    const sentinel = 'SENTINEL-9f3a-CONFIDENTIAL';
    const guard = createContextGuard([
      {
        id: 'secret-item',
        kind: 'constraint',
        content: 'Keep this constraint private.',
        critical: true,
      },
    ]);
    const report = await verifyContext({
      snapshot: guard.snapshot(),
      context: `candidate context contains ${sentinel}`,
      verifier: {
        verify() {
          throw new Error(`verifier error contains ${sentinel}`);
        },
      },
    });

    expect(JSON.stringify(report)).not.toContain(sentinel);
  });

  it('does not include context or item content in invalid-input errors', async () => {
    const sentinel = 'SENTINEL-9f3a-CONFIDENTIAL';
    const content = 'ITEM-CONTENT-4c12-PRIVATE';
    const snapshot: ContextSnapshot = {
      schemaVersion: 1,
      items: [
        {
          id: 'sensitive-item',
          kind: 'fact',
          content,
          critical: true,
        },
      ],
    };
    let thrown: unknown;

    try {
      await verifyContext({
        snapshot,
        context: sentinel,
        verifier: null as unknown as ContextVerifier,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ContextGuardError);
    expect((thrown as ContextGuardError).code).toBe('invalid_input');
    expect((thrown as ContextGuardError).message).not.toContain(sentinel);
    expect((thrown as ContextGuardError).message).not.toContain(content);
  });

  it('does not write to console during a full verification cycle', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined);

    try {
      const guard = createContextGuard([
        {
          id: 'goal',
          kind: 'goal',
          content: 'Keep the goal.',
        },
      ]);
      const report = await guard.verify('Keep the goal.', {
        verifier: createLiteralVerifier(),
      });

      expect(report.ok).toBe(true);
      expect(log).not.toHaveBeenCalled();
      expect(info).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
      expect(debug).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      info.mockRestore();
      warn.mockRestore();
      error.mockRestore();
      debug.mockRestore();
    }
  });
});
