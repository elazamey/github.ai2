import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, summarizeChecks, summarizeReviews } from '../src/rules.mjs';
import { renderComment } from '../src/report.mjs';

const basePR = {
  draft: false,
  state: 'open',
  mergeable: true,
  mergeable_state: 'clean',
  title: 'feat: something',
  base: 'main',
  head: 'feature',
  sha: 'abc123',
  labels: [],
};

const green = [{ name: 'e2e', status: 'completed', conclusion: 'success' }];
const red = [{ name: 'e2e', status: 'completed', conclusion: 'failure' }];
const running = [{ name: 'e2e', status: 'in_progress', conclusion: null }];

const ruleOf = (v, id) => v.rules.find((r) => r.id === id);

test('fixture #1 positive case: green CI + protected branch => pass', () => {
  const v = evaluate({ pr: basePR, checks: green, branchProtected: true });
  assert.equal(v.pass, true);
  assert.equal(v.checks.passing.length, 1);
});

test('fixture #2 failing CI => blocked on checks-green', () => {
  const v = evaluate({ pr: basePR, checks: red, branchProtected: true });
  assert.equal(v.pass, false);
  assert.equal(ruleOf(v, 'checks-green').ok, false);
  assert.match(ruleOf(v, 'checks-green').detail, /failure/);
});

test('fixture #3 unprotected branch => blocked on branch-protected', () => {
  const v = evaluate({ pr: basePR, checks: green, branchProtected: false });
  assert.equal(v.pass, false);
  assert.equal(ruleOf(v, 'branch-protected').ok, false);
});

test('branch protection rule can be disabled', () => {
  const v = evaluate({
    pr: basePR,
    checks: green,
    branchProtected: false,
    options: { requireBranchProtection: false },
  });
  assert.equal(v.pass, true);
  assert.equal(ruleOf(v, 'branch-protected'), undefined);
});

test('pending checks block the merge', () => {
  const v = evaluate({ pr: basePR, checks: running, branchProtected: true });
  assert.equal(ruleOf(v, 'checks-complete').ok, false);
  assert.equal(v.pass, false);
});

test('draft PRs are blocked', () => {
  const v = evaluate({
    pr: { ...basePR, draft: true },
    checks: green,
    branchProtected: true,
  });
  assert.equal(ruleOf(v, 'not-draft').ok, false);
});

test('merge conflicts are blocked', () => {
  const v = evaluate({
    pr: { ...basePR, mergeable: false, mergeable_state: 'dirty' },
    checks: green,
    branchProtected: true,
  });
  assert.equal(ruleOf(v, 'no-conflicts').ok, false);
});

test('null mergeability is treated as OK', () => {
  const v = evaluate({
    pr: { ...basePR, mergeable: null, mergeable_state: 'unknown' },
    checks: green,
    branchProtected: true,
  });
  assert.equal(ruleOf(v, 'no-conflicts').ok, true);
});

test('no checks at all is blocked', () => {
  const v = evaluate({ pr: basePR, checks: [], branchProtected: true });
  assert.equal(ruleOf(v, 'has-checks').ok, false);
});

test('blocking labels stop the merge', () => {
  for (const label of ['do-not-merge', 'WIP', 'blocked']) {
    const v = evaluate({
      pr: { ...basePR, labels: [label] },
      checks: green,
      branchProtected: true,
    });
    assert.equal(ruleOf(v, 'no-blocking-label').ok, false, label);
  }
});

test('CHANGES_REQUESTED blocks, later APPROVED by same user unblocks', () => {
  const blocked = evaluate({
    pr: basePR,
    checks: green,
    branchProtected: true,
    reviews: [{ state: 'CHANGES_REQUESTED', user: 'ana' }],
  });
  assert.equal(ruleOf(blocked, 'no-changes-requested').ok, false);

  const ok = evaluate({
    pr: basePR,
    checks: green,
    branchProtected: true,
    reviews: [
      { state: 'CHANGES_REQUESTED', user: 'ana' },
      { state: 'APPROVED', user: 'ana' },
    ],
  });
  assert.equal(ok.pass, true);
});

test('minApprovals is enforced when configured', () => {
  const v = evaluate({
    pr: basePR,
    checks: green,
    branchProtected: true,
    options: { minApprovals: 2 },
    reviews: [{ state: 'APPROVED', user: 'ana' }],
  });
  assert.equal(ruleOf(v, 'approvals').ok, false);
});

test('neutral and skipped conclusions do not block', () => {
  const { passing, failing } = summarizeChecks([
    { name: 'a', status: 'completed', conclusion: 'neutral' },
    { name: 'b', status: 'completed', conclusion: 'skipped' },
  ]);
  assert.equal(passing.length, 2);
  assert.equal(failing.length, 0);
});

test('summarizeReviews ignores COMMENTED', () => {
  const r = summarizeReviews([
    { state: 'COMMENTED', user: 'ana' },
    { state: 'APPROVED', user: 'bob' },
  ]);
  assert.deepEqual(r, { approvals: 1, changesRequested: 0 });
});

test('report renders pass and blocked states', () => {
  const pass = renderComment(
    evaluate({ pr: basePR, checks: green, branchProtected: true }),
    { repo: 'o/r', prNumber: 1, autoMerge: true }
  );
  assert.match(pass, /ready to merge/);
  assert.match(pass, /merging now/);

  const blocked = renderComment(
    evaluate({ pr: basePR, checks: red, branchProtected: false }),
    { repo: 'o/r', prNumber: 2 }
  );
  assert.match(blocked, /merge blocked/);
  assert.match(blocked, /Blockers \(2\)/);
});
