import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ARCHIVE_EXCLUDED_DIRECTORIES,
  ARCHIVE_EXCLUDED_FILENAMES,
  FILE_TREE_IGNORED_DIRECTORIES,
  FILE_TREE_IGNORED_FILENAMES,
  isIgnoredFileTreePath,
} from '../agents/_lib/constants.ts';

test('file tree hides .edgeone created by makers deploy', () => {
  assert.ok(FILE_TREE_IGNORED_DIRECTORIES.includes('.edgeone'));
  assert.equal(isIgnoredFileTreePath('.edgeone'), true);
  assert.equal(isIgnoredFileTreePath('.edgeone'), true);
  assert.equal(isIgnoredFileTreePath('.edgeone/project.json'), true);
  assert.equal(isIgnoredFileTreePath('.edgeone/logs/deploy.log'), true);
  assert.equal(isIgnoredFileTreePath('edgeone.json'), false);
  assert.equal(isIgnoredFileTreePath('src/app.ts'), false);
});

test('source archive also excludes .edgeone', () => {
  assert.ok(ARCHIVE_EXCLUDED_DIRECTORIES.includes('.edgeone'));
});

test('.env is listed in the file tree and still left out of the download', () => {
  assert.equal(FILE_TREE_IGNORED_FILENAMES.has('.env'), false);
  assert.equal(isIgnoredFileTreePath('.env'), false);
  assert.equal(isIgnoredFileTreePath('.env'), false);
  assert.ok(ARCHIVE_EXCLUDED_FILENAMES.includes('.env'));
});
