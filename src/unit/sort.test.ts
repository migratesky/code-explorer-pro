import { strict as assert } from 'assert';
import { sortGroupsByActive, FileGroupLike } from '../core/sort';

describe('sortGroupsByActive', () => {
  it('sorts with active file first, then same directory, then alphabetical', () => {
    const active = '/repo/src/dir/file.ts';
    const groups: FileGroupLike[] = [
      { fsPath: '/repo/src/aaa.ts', label: 'aaa.ts' },           // same dir as /repo/src
      { fsPath: '/repo/src/dir/bbb.ts', label: 'bbb.ts' },        // same dir as active
      { fsPath: '/repo/src/dir/file.ts', label: 'file.ts' },      // active file
      { fsPath: '/repo/zzz.ts', label: 'zzz.ts' },                // other
      { fsPath: '/repo/src/ccc.ts', label: 'ccc.ts' },            // same dir as /repo/src
    ];

    const sorted = sortGroupsByActive(groups, active);

    // active first
    assert.equal(sorted[0].fsPath, '/repo/src/dir/file.ts');
    // then files in same dir as active, sorted by label
    const sameDir = sorted.filter(g => g.fsPath.startsWith('/repo/src/dir/')).map(g => g.label);
    assert.deepEqual(sameDir, ['file.ts', 'bbb.ts']);
    // then remaining by label
    const rest = sorted.slice(2).filter(g => !g.fsPath.startsWith('/repo/src/dir/')).map(g => g.label);
    assert.deepEqual(rest, ['aaa.ts', 'ccc.ts', 'zzz.ts']);
  });

  it('falls back to alphabetical when no active file', () => {
    const groups: FileGroupLike[] = [
      { fsPath: '/a/z.ts', label: 'z.ts' },
      { fsPath: '/a/a.ts', label: 'a.ts' },
      { fsPath: '/a/m.ts', label: 'm.ts' },
    ];

    const sorted = sortGroupsByActive(groups, undefined);
    assert.deepEqual(sorted.map(g => g.label), ['a.ts', 'm.ts', 'z.ts']);
  });
});
