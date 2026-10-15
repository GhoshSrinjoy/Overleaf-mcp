import DiffMatchPatch from 'diff-match-patch';

export interface MergeResult {
  merged: string;
  /** False when some of our changes could not be placed into their version. */
  clean: boolean;
  failedHunks: number;
}

/**
 * Rebases our edits (base → ours) onto their version of the same text. Used when a document
 * changed remotely between loading and saving it, so collaborators' edits survive the save.
 */
export function threeWayMerge(base: string, ours: string, theirs: string): MergeResult {
  if (ours === base || ours === theirs) return { merged: theirs, clean: true, failedHunks: 0 };
  if (theirs === base) return { merged: ours, clean: true, failedHunks: 0 };
  const dmp = new DiffMatchPatch();
  // Stricter than the defaults: refuse to apply a hunk where the context has changed a lot.
  dmp.Match_Threshold = 0.25;
  dmp.Patch_DeleteThreshold = 0.25;
  const patches = dmp.patch_make(base, ours);
  const [merged, applied] = dmp.patch_apply(patches, theirs) as [string, boolean[]];
  const failedHunks = applied.filter((ok) => !ok).length;
  return { merged, clean: failedHunks === 0, failedHunks };
}
