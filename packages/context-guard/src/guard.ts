import { copyItem, duplicateItem, invalidContextItem, validateContextItem } from './item.js';
import type { ContextGuard, ContextItem, ContextItemInput } from './types.js';
import { verifyContext } from './verify.js';

export function createContextGuard(
  items: readonly ContextItemInput[] = [],
): ContextGuard {
  const registry = new Map<string, ContextItem>();

  const guard: ContextGuard = {
    add(item): ContextItem {
      const validated = validateContextItem(item);
      if (registry.has(validated.id)) {
        return duplicateItem(validated.id);
      }
      registry.set(validated.id, validated);
      return copyItem(validated);
    },

    addAll(input): readonly ContextItem[] {
      if (!Array.isArray(input)) {
        return invalidContextItem();
      }

      const pending: ContextItem[] = [];
      const ids = new Set<string>();
      for (const candidate of input) {
        const item = validateContextItem(candidate);
        if (registry.has(item.id) || ids.has(item.id)) {
          return duplicateItem(item.id);
        }
        ids.add(item.id);
        pending.push(item);
      }

      for (const item of pending) {
        registry.set(item.id, item);
      }

      return pending.map(copyItem);
    },

    get(id): ContextItem | undefined {
      const item = registry.get(id);
      return item === undefined ? undefined : copyItem(item);
    },

    list(): readonly ContextItem[] {
      return Array.from(registry.values(), copyItem);
    },

    has(id): boolean {
      return registry.has(id);
    },

    remove(id): boolean {
      return registry.delete(id);
    },

    clear(): void {
      registry.clear();
    },

    size(): number {
      return registry.size;
    },

    snapshot() {
      return {
        schemaVersion: 1 as const,
        items: Array.from(registry.values(), copyItem),
      };
    },

    verify(context, options) {
      return verifyContext({
        snapshot: guard.snapshot(),
        context,
        verifier: options.verifier,
      });
    },
  };

  guard.addAll(items);
  return guard;
}
