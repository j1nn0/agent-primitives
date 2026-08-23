export type DiscoveryAnchorCategory = 'path' | 'opaque-id' | 'versioned-subject';

export interface DiscoveryAnchor {
  readonly category: DiscoveryAnchorCategory;
  /** Normalized value used for matching. */
  readonly value: string;
}

export interface CandidateItem {
  readonly id: string;
  readonly content: string;
}

export interface SupersessionCandidate {
  /** Sorted ids of the active discoveries sharing these anchors. */
  readonly itemIds: readonly string[];
  /** Sorted anchors this group shares. */
  readonly anchors: readonly DiscoveryAnchor[];
}

const ANCHOR_CATEGORIES: readonly DiscoveryAnchorCategory[] = [
  'path',
  'opaque-id',
  'versioned-subject',
];

const CATEGORY_ORDER: Readonly<Record<DiscoveryAnchorCategory, number>> = {
  path: 0,
  'opaque-id': 1,
  'versioned-subject': 2,
};

const VERSIONED_SUBJECT_STOPLIST = new Set([
  'version',
  'release',
  'build',
  'number',
  'the',
  'this',
  'that',
  'current',
  'latest',
  'file',
  'path',
  'name',
  'type',
  'value',
  'status',
  'error',
  'code',
  'data',
  'result',
  'size',
  'count',
]);

const PATH_TOKEN_REGEX =
  /(?<![A-Za-z0-9._@:/-])(?:\/[A-Za-z0-9._@-]+(?:\/[A-Za-z0-9._@-]+)*|[A-Za-z0-9._@-]+(?:\/[A-Za-z0-9._@-]+)+)(?![A-Za-z0-9._@:/-])/g;
const OPAQUE_ID_REGEX =
  /(?<![A-Za-z0-9._-])[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+(?![A-Za-z0-9_-])/g;
const OPAQUE_ID_FULL_REGEX = /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+$/;
const DOTTED_VERSION_REGEX =
  /(?<![A-Za-z0-9._-])v?\d+\.\d+(?:\.\d+)*(?![A-Za-z0-9_-]|\.[A-Za-z])/g;
const PATH_SEGMENT_REGEX = /^[A-Za-z0-9._@-]+$/;
const RELATIVE_PATH_EXTENSION_REGEX = /\.[A-Za-z0-9]+$/;
const SUBJECT_TOKEN_REGEX = /[A-Za-z][A-Za-z0-9_-]*$/;
const VERSION_MARKER_REGEX = /(?:^|[^A-Za-z0-9._@/-])(version|v)$/i;
const TRAILING_TOKEN_DECORATION_REGEX = /[.`'"\])}>,;:!?]+$/;
const TRAILING_SEPARATOR_REGEX = /[\s`.,;:!?()[\]{}'"、。！？]+$/u;

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function compareAnchors(left: DiscoveryAnchor, right: DiscoveryAnchor): number {
  const categoryComparison =
    CATEGORY_ORDER[left.category] - CATEGORY_ORDER[right.category];
  return categoryComparison === 0
    ? compareStrings(left.value, right.value)
    : categoryComparison;
}

function sortAnchors(anchors: readonly DiscoveryAnchor[]): DiscoveryAnchor[] {
  return [...anchors].sort(compareAnchors);
}

function requestedCategories(
  categories: readonly DiscoveryAnchorCategory[],
): readonly DiscoveryAnchorCategory[] {
  return ANCHOR_CATEGORIES.filter((category) => categories.includes(category));
}

function stripCandidateDecorations(token: string): string {
  let normalized = token;
  while (normalized.startsWith('`') || normalized.endsWith('`')) {
    if (normalized.startsWith('`')) {
      normalized = normalized.slice(1);
    }
    if (normalized.endsWith('`')) {
      normalized = normalized.slice(0, -1);
    }
  }
  return normalized.replace(TRAILING_TOKEN_DECORATION_REGEX, '');
}

function isPathAnchor(token: string): boolean {
  const normalized = stripCandidateDecorations(token);
  const segments = normalized.split('/');
  if (segments.length < 2) {
    return false;
  }

  if (segments[0] === '') {
    return segments
      .slice(1)
      .every(
        (segment) =>
          segment.length > 0 && PATH_SEGMENT_REGEX.test(segment),
      );
  }

  if (segments.some((segment) => !PATH_SEGMENT_REGEX.test(segment))) {
    return false;
  }

  const lastSegment = segments[segments.length - 1];
  return (
    lastSegment !== undefined &&
    RELATIVE_PATH_EXTENSION_REGEX.test(lastSegment)
  );
}

function collectPathAnchors(content: string): DiscoveryAnchor[] {
  const anchors: DiscoveryAnchor[] = [];
  for (const match of content.matchAll(PATH_TOKEN_REGEX)) {
    const token = stripCandidateDecorations(match[0]);
    if (isPathAnchor(token)) {
      anchors.push({ category: 'path', value: token });
    }
  }
  return anchors;
}

function collectOpaqueIdAnchors(content: string): DiscoveryAnchor[] {
  const anchors: DiscoveryAnchor[] = [];
  for (const match of content.matchAll(OPAQUE_ID_REGEX)) {
    const token = stripCandidateDecorations(match[0]);
    if (
      token.length >= 6 &&
      /\d/.test(token) &&
      OPAQUE_ID_FULL_REGEX.test(token)
    ) {
      anchors.push({ category: 'opaque-id', value: token });
    }
  }
  return anchors;
}

function stripTrailingSeparators(value: string): string {
  return value.replace(TRAILING_SEPARATOR_REGEX, '');
}

function subjectBeforeVersion(prefix: string): string | undefined {
  let candidatePrefix = stripTrailingSeparators(prefix);
  const marker = VERSION_MARKER_REGEX.exec(candidatePrefix);
  if (marker !== null) {
    candidatePrefix = stripTrailingSeparators(
      candidatePrefix.slice(0, marker.index),
    );
  }

  const subjectMatch = SUBJECT_TOKEN_REGEX.exec(candidatePrefix);
  if (subjectMatch === null) {
    return undefined;
  }

  const subjectStart = subjectMatch.index;
  const precedingCharacter = candidatePrefix[subjectStart - 1];
  if (
    precedingCharacter !== undefined &&
    /[A-Za-z0-9._@/-]/.test(precedingCharacter)
  ) {
    return undefined;
  }

  const subject = stripCandidateDecorations(subjectMatch[0]).toLowerCase();
  if (
    subject.length < 3 ||
    VERSIONED_SUBJECT_STOPLIST.has(subject)
  ) {
    return undefined;
  }
  return subject;
}

function collectVersionedSubjectAnchors(content: string): DiscoveryAnchor[] {
  const anchors: DiscoveryAnchor[] = [];
  for (const match of content.matchAll(DOTTED_VERSION_REGEX)) {
    const version = match[0].replace(/^v/, '');
    if (!/^\d+\.\d+(?:\.\d+)*$/.test(version)) {
      continue;
    }

    const subject = subjectBeforeVersion(content.slice(0, match.index));
    if (subject !== undefined) {
      anchors.push({ category: 'versioned-subject', value: subject });
    }
  }
  return anchors;
}

function deduplicateAnchors(anchors: readonly DiscoveryAnchor[]): DiscoveryAnchor[] {
  const seen = new Set<string>();
  const unique: DiscoveryAnchor[] = [];
  for (const anchor of anchors) {
    const key = `${anchor.category}\u0000${anchor.value}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(anchor);
  }
  return sortAnchors(unique);
}

export function collectDiscoveryAnchors(
  content: string,
  categories: readonly DiscoveryAnchorCategory[],
): readonly DiscoveryAnchor[] {
  const anchors: DiscoveryAnchor[] = [];
  for (const category of requestedCategories(categories)) {
    switch (category) {
      case 'path':
        anchors.push(...collectPathAnchors(content));
        break;
      case 'opaque-id':
        anchors.push(...collectOpaqueIdAnchors(content));
        break;
      case 'versioned-subject':
        anchors.push(...collectVersionedSubjectAnchors(content));
        break;
    }
  }
  return deduplicateAnchors(anchors);
}

function itemSetKey(itemIds: readonly string[]): string {
  return JSON.stringify(itemIds);
}

function candidateSortKey(candidate: SupersessionCandidate): string {
  const firstId = candidate.itemIds[0] ?? '';
  const firstAnchor = candidate.anchors[0];
  const firstAnchorKey = firstAnchor === undefined
    ? ''
    : `${CATEGORY_ORDER[firstAnchor.category]}\u0000${firstAnchor.value}`;
  return `${firstId}\u0000${firstAnchorKey}`;
}

function compareCandidates(
  left: SupersessionCandidate,
  right: SupersessionCandidate,
): number {
  const keyComparison = compareStrings(candidateSortKey(left), candidateSortKey(right));
  if (keyComparison !== 0) {
    return keyComparison;
  }

  const idsComparison = compareStrings(
    itemSetKey(left.itemIds),
    itemSetKey(right.itemIds),
  );
  if (idsComparison !== 0) {
    return idsComparison;
  }
  return compareStrings(
    JSON.stringify(left.anchors),
    JSON.stringify(right.anchors),
  );
}

export function findSupersessionCandidates(
  items: readonly CandidateItem[],
  categories: readonly DiscoveryAnchorCategory[],
): readonly SupersessionCandidate[] {
  const idsByAnchor = new Map<string, Set<string>>();
  const anchorByKey = new Map<string, DiscoveryAnchor>();

  for (const item of items) {
    for (const anchor of collectDiscoveryAnchors(item.content, categories)) {
      const key = `${anchor.category}\u0000${anchor.value}`;
      let itemIds = idsByAnchor.get(key);
      if (itemIds === undefined) {
        itemIds = new Set<string>();
        idsByAnchor.set(key, itemIds);
        anchorByKey.set(key, anchor);
      }
      itemIds.add(item.id);
    }
  }

  const anchorsByItemSet = new Map<string, DiscoveryAnchor[]>();
  for (const [key, itemIds] of idsByAnchor) {
    if (itemIds.size < 2) {
      continue;
    }

    const sortedItemIds = [...itemIds].sort(compareStrings);
    const itemSet = itemSetKey(sortedItemIds);
    const anchors = anchorsByItemSet.get(itemSet);
    const anchor = anchorByKey.get(key);
    if (anchor === undefined) {
      continue;
    }
    if (anchors === undefined) {
      anchorsByItemSet.set(itemSet, [anchor]);
    } else {
      anchors.push(anchor);
    }
  }

  return [...anchorsByItemSet.entries()]
    .map(([itemSet, anchors]) => ({
      itemIds: JSON.parse(itemSet) as readonly string[],
      anchors: sortAnchors(anchors),
    }))
    .sort(compareCandidates);
}
