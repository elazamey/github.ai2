/**
 * End-to-end coverage of scripts/gatekeeper.mjs against a recorded GitHub API.
 *
 * Why this exists: the VERIFIED path was previously provable only by manually
 * configuring branch protection on a live repository. That makes the happy path
 * hostage to repo configuration and untested in CI. Here a local mock server plays
 * the GitHub API, so both VERIFIED and BLOCKED are exercised on every run, including
 * the auto-merge decision itself.
 *
 * The live repository then serves as a smoke test, not as the only source of truth.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Minimal GitHub API stand-in. `routes` maps "METHOD /path" -> {status, body}. */
async function withApi(routes, fn) {
  const calls = [];
  const server = createServer((req, res) => {
    const path = req.url.split('?')[0];
    const key = `${req.method} ${path}`;
    calls.push(key);
    let chunks = '';
    req.on('data', (d) => (chunks += d));
    req.on('end', () => {
      const route = routes[key];
      if (!route) {
        res.writeHead(404, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ message: `no stub for ${key}` }));
      }
      if (route.capture) route.capture(chunks ? JSON.parse(chunks) : null);
      res.writeHead(route.status ?? 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(route.body ?? {}));
    });
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    return await fn(`http://127.0.0.1:${port}`, calls);
  } finally {
    server.close();
  }
}

const PR = {
  number: 7,
  state: 'open',
  draft: false,
  mergeable: true,
  mergeable_state: 'clean',
  title: 'feat: x',
  labels: [],
  base: { ref: 'main' },
  head: { sha: 'deadbeef', ref: 'topic' },
};

const CHECKS = {
  check_runs: [
    { name: 'unit', status: 'completed', conclusion: 'success', started_at: '2026-09-06T10:00:00Z' },
    { name: 'gatekeeper', status: 'in_progress', conclusion: null, started_at: '2026-09-06T10:01:00Z' },
  ],
};

function baseRoutes(overrides = {}) {
  return {
    'GET /repos/o/r/pulls/7': { body: PR },
    'GET /repos/o/r/commits/deadbeef/check-runs': { body: CHECKS },
    'GET /repos/o/r/commits/deadbeef/status': { body: { statuses: [] } },
    'GET /repos/o/r/pulls/7/reviews': { body: [] },
    'GET /repos/o/r/issues/7/comments': { body: [] },
    'POST /repos/o/r/issues/7/comments': { status: 201, body: { id: 1 } },
    'GET /repos/o/r/branches/main': { body: { protected: true } },
    'GET /repos/o/r/rules/branches/main': { body: [{ enforcement: 'active' }] },
    ...overrides,
  };
}

async function gatekeeper(apiUrl, env = {}) {
  return run(process.execPath, ['scripts/gatekeeper.mjs'], {
    env: {
      ...process.env,
      GITHUB_API_URL: apiUrl,
      GITHUB_TOKEN: 'test-token',
      GITHUB_REPOSITORY: 'o/r',
      PR_NUMBER: '7',
      GITHUB_STEP_SUMMARY: '',
      ...env,
    },
  });
}

test('E2E: protected branch + green checks => VERIFIED and auto-merge fires', async () => {
  let merged = null;
  const routes = baseRoutes({
    'PUT /repos/o/r/pulls/7/merge': {
      body: { merged: true },
      capture: (b) => (merged = b),
    },
  });

  await withApi(routes, async (url, calls) => {
    const { stdout } = await gatekeeper(url, { AUTO_MERGE: 'true' });
    assert.match(stdout, /ready to merge/);
    assert.match(stdout, /`verified` \| protection active/);
    assert.doesNotMatch(stdout, /unknown/);
    // The auto-merge actually happened, with the configured method.
    assert.ok(calls.includes('PUT /repos/o/r/pulls/7/merge'), 'merge was not called');
    assert.equal(merged.merge_method, 'squash');
  });
});

test('E2E: unprotected branch => BLOCKED and merge is never called', async () => {
  const routes = baseRoutes({
    'GET /repos/o/r/branches/main': { body: { protected: false } },
    'GET /repos/o/r/rules/branches/main': { body: [] },
  });

  await withApi(routes, async (url, calls) => {
    const { stdout } = await gatekeeper(url, { AUTO_MERGE: 'true' });
    assert.match(stdout, /merge blocked/);
    assert.match(stdout, /NO branch protection configured/);
    assert.ok(!calls.includes('PUT /repos/o/r/pulls/7/merge'), 'merge must not be called');
  });
});

test('E2E: rulesets 403 => UNKNOWN, auto-merge withheld, merge never called', async () => {
  // The org-policy scenario: half the evidence is unreadable.
  const routes = baseRoutes({
    'GET /repos/o/r/branches/main': { body: { protected: false } },
    'GET /repos/o/r/rules/branches/main': { status: 403, body: { message: 'nope' } },
  });

  await withApi(routes, async (url, calls) => {
    const { stdout } = await gatekeeper(url, { AUTO_MERGE: 'true' });
    assert.match(stdout, /not fully verified/);
    assert.match(stdout, /UNREADABLE/);
    assert.match(stdout, /withheld/);
    assert.ok(!calls.includes('PUT /repos/o/r/pulls/7/merge'), 'merge must not be called');
  });
});

test('E2E: an active ruleset alone is enough to reach VERIFIED', async () => {
  const routes = baseRoutes({
    'GET /repos/o/r/branches/main': { body: { protected: false } },
    'GET /repos/o/r/rules/branches/main': { body: [{ enforcement: 'active' }] },
  });

  await withApi(routes, async (url) => {
    const { stdout } = await gatekeeper(url);
    assert.match(stdout, /ready to merge/);
  });
});

test('E2E: a disabled ruleset does not fake protection', async () => {
  const routes = baseRoutes({
    'GET /repos/o/r/branches/main': { body: { protected: false } },
    'GET /repos/o/r/rules/branches/main': { body: [{ enforcement: 'disabled' }] },
  });

  await withApi(routes, async (url) => {
    const { stdout } = await gatekeeper(url);
    assert.match(stdout, /merge blocked/);
  });
});

test('E2E: the comment is updated in place, not duplicated', async () => {
  let patched = false;
  const routes = baseRoutes({
    'GET /repos/o/r/issues/7/comments': {
      body: [{ id: 42, body: '<!-- pr-gatekeeper-bot -->\nold report' }],
    },
    'PATCH /repos/o/r/issues/comments/42': {
      body: { id: 42 },
      capture: () => (patched = true),
    },
  });

  await withApi(routes, async (url, calls) => {
    await gatekeeper(url);
    assert.ok(patched, 'existing comment should be edited');
    assert.ok(!calls.includes('POST /repos/o/r/issues/7/comments'), 'must not post a second comment');
  });
});

test('E2E: DRY_RUN never writes', async () => {
  await withApi(baseRoutes(), async (url, calls) => {
    const { stdout } = await gatekeeper(url, { DRY_RUN: 'true', AUTO_MERGE: 'true' });
    assert.match(stdout, /dry-run/);
    assert.ok(!calls.some((c) => c.startsWith('POST') || c.startsWith('PUT') || c.startsWith('PATCH')));
  });
});

test('E2E: the gatekeeper ignores its own in-progress check', async () => {
  // CHECKS contains a running "gatekeeper" run; a settled verdict proves it is excluded.
  await withApi(baseRoutes(), async (url) => {
    const { stdout } = await gatekeeper(url);
    assert.match(stdout, /0 pending/);
    assert.match(stdout, /ready to merge/);
  });
});

test('E2E: policy satisfied but mergeable_state=blocked => merge is not attempted', async () => {
  const routes = baseRoutes({
    'GET /repos/o/r/pulls/7': { body: { ...PR, mergeable_state: 'blocked' } },
  });

  await withApi(routes, async (url, calls) => {
    const { stdout } = await gatekeeper(url, { AUTO_MERGE: 'true' });
    assert.match(stdout, /GitHub will refuse this merge/);
    assert.ok(
      !calls.includes('PUT /repos/o/r/pulls/7/merge'),
      'must not fire a merge GitHub would reject'
    );
  });
});

test('E2E: the comment carries a per-sha marker while keeping one stable identity', async () => {
  let posted = null;
  const routes = baseRoutes({
    'POST /repos/o/r/issues/7/comments': {
      status: 201,
      body: { id: 1 },
      capture: (b) => (posted = b),
    },
  });

  await withApi(routes, async (url) => {
    await gatekeeper(url);
    assert.match(posted.body, /<!-- pr-gatekeeper-bot -->/, 'stable identity marker');
    assert.match(posted.body, /<!-- gk:deadbeef -->/, 'per-sha marker');
  });
});
