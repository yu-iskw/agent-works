import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { join, sep } from 'node:path';

import type { Stats } from 'node:fs';

declare const contained: unique symbol;
/** An absolute path that `realpath` resolved (symlinks followed) to a location inside the root. */
type ContainedPath = string & { readonly [contained]: true };

/**
 * The loader's only filesystem access. Every read takes a `ContainedPath`, and only `resolve`
 * (or `base`) produces one, so a path from package contents cannot reach the filesystem without
 * passing the containment check. That is why the fs-filename rule is satisfied here, once.
 */
export type PackageRoot = {
  readonly base: ContainedPath;
  /** Resolves a root-relative path; null when it does not exist or resolves outside the root. */
  resolve(relativePath: string): Promise<ContainedPath | null>;
  stat(path: ContainedPath): Promise<Stats>;
  readdir(path: ContainedPath): Promise<string[]>;
  readFile(path: ContainedPath): Promise<Buffer>;
};

const inside = (root: string, target: string): boolean =>
  target === root || target.startsWith(`${root}${sep}`);

/** Null when the root itself cannot be resolved. */
export async function openPackageRoot(root: string): Promise<PackageRoot | null> {
  let base: ContainedPath;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the configured package root, not package content
    base = (await realpath(root)) as ContainedPath;
  } catch {
    return null;
  }
  return {
    base,
    async resolve(relativePath) {
      try {
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- the result is checked against the root before use
        const resolved = await realpath(join(base, relativePath));
        return inside(base, resolved) ? (resolved as ContainedPath) : null;
      } catch {
        return null;
      }
    },
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- ContainedPath only comes from resolve
    stat: (path) => stat(path),
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- ContainedPath only comes from resolve
    readdir: (path) => readdir(path),
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- ContainedPath only comes from resolve
    readFile: (path) => readFile(path),
  };
}
