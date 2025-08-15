import * as path from 'path';

export type FileGroupLike = { fsPath: string; label: string };

/**
 * Sorts file groups prioritizing:
 *  1) current file
 *  2) files in the same directory as current file
 *  3) remaining files alphabetically by label
 */
export function sortGroupsByActive<T extends FileGroupLike>(groups: T[], activeFsPath?: string): T[] {
  const arr = [...groups];
  if (!activeFsPath) {
    return arr.sort((a, b) => String(a.label).localeCompare(String(b.label)));
  }
  const activeDir = path.dirname(activeFsPath);
  const isSameDir = (p: string) => p.startsWith(activeDir + '/') || p.startsWith(activeDir + '\\');
  const score = (g: FileGroupLike) => (g.fsPath === activeFsPath ? 2 : isSameDir(g.fsPath) ? 1 : 0);
  return arr.sort((a, b) => {
    const sa = score(a);
    const sb = score(b);
    if (sa !== sb) return sb - sa;
    return String(a.label).localeCompare(String(b.label));
  });
}
