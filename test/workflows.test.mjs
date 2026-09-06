/**
 * Guards against workflow *startup* failures.
 *
 * A workflow with an invalid `permissions:` key does not fail loudly — GitHub
 * refuses to parse the file, the run reports 0 jobs, and the workflow silently
 * never executes. That happened with `administration: read`, which is not a
 * grantable GITHUB_TOKEN permission, so this is a regression test.
 *
 * Deliberately dependency-free: a tiny targeted parse, not a general YAML parser.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const DIR = '.github/workflows';

// https://docs.github.com/actions/security-for-github-actions/security-guides/automatic-token-authentication
const VALID_PERMISSIONS = new Set([
  'actions',
  'attestations',
  'checks',
  'contents',
  'deployments',
  'discussions',
  'id-token',
  'issues',
  'models',
  'packages',
  'pages',
  'pull-requests',
  'repository-projects',
  'security-events',
  'statuses',
]);

const VALID_VALUES = new Set(['read', 'write', 'none']);

const files = readdirSync(DIR).filter((f) => /\.ya?ml$/.test(f));

test('workflow directory is not empty', () => {
  assert.ok(files.length > 0);
});

for (const file of files) {
  test(`${file} declares only valid GITHUB_TOKEN permissions`, () => {
    const lines = readFileSync(`${DIR}/${file}`, 'utf8').split('\n');

    let indent = null;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim().startsWith('#')) continue;

      const start = line.match(/^(\s*)permissions:\s*(\S.*)?$/);
      if (start) {
        // `permissions: read-all` / `write-all` on one line is also valid.
        if (start[2]) {
          assert.match(
            start[2].trim(),
            /^(read-all|write-all|\{\})$/,
            `${file}:${i + 1} invalid inline permissions`
          );
          continue;
        }
        indent = start[1].length;
        continue;
      }

      if (indent === null) continue;

      if (line.trim() === '') continue;
      const currentIndent = line.match(/^\s*/)[0].length;
      if (currentIndent <= indent) {
        indent = null; // block ended
        continue;
      }

      const entry = line.match(/^\s*([a-z-]+):\s*([a-z-]+)\s*$/);
      assert.ok(entry, `${file}:${i + 1} unparseable permission line: ${line}`);
      assert.ok(
        VALID_PERMISSIONS.has(entry[1]),
        `${file}:${i + 1} "${entry[1]}" is not a valid GITHUB_TOKEN permission ` +
          `(this makes the whole workflow fail to start)`
      );
      assert.ok(
        VALID_VALUES.has(entry[2]),
        `${file}:${i + 1} "${entry[2]}" is not a valid permission value`
      );
    }
  });

  test(`${file} has no tab indentation`, () => {
    const content = readFileSync(`${DIR}/${file}`, 'utf8');
    assert.doesNotMatch(content, /^\t/m, 'YAML forbids tabs for indentation');
  });
}

test('gatekeeper workflow does not request `administration` (regression)', () => {
  const content = readFileSync(`${DIR}/gatekeeper.yml`, 'utf8');
  const permsBlock = content.split(/^permissions:/m)[1]?.split(/^\S/m)[0] ?? '';
  assert.doesNotMatch(
    permsBlock,
    /administration/,
    'administration is not grantable to GITHUB_TOKEN; it breaks workflow startup'
  );
});
