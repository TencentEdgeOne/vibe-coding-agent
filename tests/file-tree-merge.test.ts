import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeFileTreeWrites } from '../app/lib/file-tree.ts';
import type { FileTree } from '../shared/protocol.ts';

test('a written file is added to an empty tree so the Code tab is not blank', () => {
  const tree = mergeFileTreeWrites(null, [{ path: 'src/app.tsx', size: 42 }]);

  assert.deepEqual(tree, {
    root: '',
    items: [
      { path: 'src', name: 'src', type: 'directory', depth: 0 },
      { path: 'src/app.tsx', name: 'app.tsx', type: 'file', depth: 1, size: 42 },
    ],
  });
});

test('merging a write keeps the existing tree and its metadata', () => {
  const current: FileTree = {
    root: 'projects/cid/app',
    items: [
      { path: 'src', name: 'src', type: 'directory', depth: 0 },
      { path: 'src/main.ts', name: 'main.ts', type: 'file', depth: 1, mtime: 10, size: 4 },
    ],
  };

  const tree = mergeFileTreeWrites(current, [{ path: 'src/main.ts', size: 8 }]);

  assert.equal(tree?.root, current.root);
  assert.deepEqual(tree?.items, [
    { path: 'src', name: 'src', type: 'directory', depth: 0 },
    { path: 'src/main.ts', name: 'main.ts', type: 'file', depth: 1, mtime: 10, size: 8 },
  ]);
});

test('paths are deduplicated and sorted for a stable sidebar', () => {
  const tree = mergeFileTreeWrites(null, [
    { path: 'b.txt' },
    { path: 'a/nested/c.txt' },
    { path: 'b.txt' },
  ]);

  assert.deepEqual(
    tree?.items.map((item) => item.path),
    ['a', 'a/nested', 'a/nested/c.txt', 'b.txt'],
  );
});
