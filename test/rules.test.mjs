import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluate,
  summarizeChecks,
  normalizeChecks,
  resolveProtection,
  summarizeReviews,
  VERIFIED,
  BLOCKED,
  SKIPPED_WITH_WARNING,
  UNKNOWN,
} from '../src/rules.mjs';
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

test('disabling enforcement downgrades the rule but withholds auto-merge', () => {
  const v = evaluate({
    pr: basePR,
    checks: green,
    branchProtected: false,
    options: { requireBranchProtection: false },
  });
  // No blocker: a human may still merge.
  assert.equal(v.pass, true);
  assert.equal(ruleOf(v, 'branch-protected').status, SKIPPED_WITH_WARNING);
  // But an unenforced security rule must never authorize an automated merge.
  assert.equal(v.autoMergeSafe, false);
  assert.equal(v.criticalUnverified.length, 1);
});

test('403 on branch protection => UNKNOWN, never a silent pass', () => {
  const v = evaluate({ pr: basePR, checks: green, branchProtected: null });
  const rule = ruleOf(v, 'branch-protected');
  assert.equal(rule.status, UNKNOWN);
  assert.equal(rule.ok, false);
  // Not a blocker...
  assert.equal(v.pass, true);
  // ...but categorically not auto-mergeable.
  assert.equal(v.autoMergeSafe, false);
  assert.deepEqual(v.criticalUnverified.map((r) => r.id), ['branch-protected']);
  assert.match(rule.detail, /auto-merge withheld/);
});

test('UNKNOWN is distinct from VERIFIED and from BLOCKED', () => {
  const unknown = evaluate({ pr: basePR, checks: green, branchProtected: null });
  const verified = evaluate({ pr: basePR, checks: green, branchProtected: true });
  const blocked = evaluate({ pr: basePR, checks: green, branchProtected: false });

  assert.equal(ruleOf(unknown, 'branch-protected').status, UNKNOWN);
  assert.equal(ruleOf(verified, 'branch-protected').status, VERIFIED);
  assert.equal(ruleOf(blocked, 'branch-protected').status, BLOCKED);

  assert.equal(unknown.autoMergeSafe, false);
  assert.equal(verified.autoMergeSafe, true);
  assert.equal(blocked.pass, false);
});

test('fully verified green PR is the only auto-merge-safe state', () => {
  const v = evaluate({ pr: basePR, checks: green, branchProtected: true });
  assert.equal(v.autoMergeSafe, true);
  assert.equal(v.unverified.length, 0);
  assert.ok(v.rules.every((r) => r.status === VERIFIED));
});

test('a blocker keeps autoMergeSafe false even when everything else is verified', () => {
  const v = evaluate({ pr: basePR, checks: red, branchProtected: true });
  assert.equal(v.pass, false);
  assert.equal(v.autoMergeSafe, false);
  assert.deepEqual(v.blocked.map((r) => r.id), ['checks-green']);
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

test('report distinguishes unverified from passing and withholds auto-merge', () => {
  const out = renderComment(
    evaluate({ pr: basePR, checks: green, branchProtected: null }),
    { repo: 'o/r', prNumber: 3, autoMerge: true }
  );
  assert.match(out, /not fully verified/);
  assert.match(out, /Unverified rules \(1\)/);
  assert.match(out, /withheld/);
  assert.doesNotMatch(out, /merging now/);
});


// --- normalizeChecks: observed in the real Actions run on PR #4 ---

test('the gatekeeper does not count itself as a pending check', () => {
  // Observed live: "4 still running: gatekeeper, e2e, unit, unit" - the bot runs as
  // a check, so it saw its own in-progress run and could never settle.
  const raw = [
    { name: 'gatekeeper', status: 'in_progress', conclusion: null },
    { name: 'e2e', status: 'completed', conclusion: 'success' },
  ];
  const out = normalizeChecks(raw);
  assert.deepEqual(out.map((c) => c.name), ['e2e']);

  const v = evaluate({ pr: basePR, checks: out, branchProtected: true });
  assert.equal(ruleOf(v, 'checks-complete').ok, true);
  assert.equal(v.autoMergeSafe, true);
});

test('self-check name is configurable', () => {
  const raw = [{ name: 'my-bot', status: 'in_progress', conclusion: null }];
  assert.equal(normalizeChecks(raw, { selfCheckName: 'my-bot' }).length, 0);
  assert.equal(normalizeChecks(raw).length, 1);
});

test('duplicate check names collapse to the newest run', () => {
  // Observed live: "unit, unit" - push and pull_request runs of the same workflow.
  const raw = [
    {
      name: 'unit',
      status: 'completed',
      conclusion: 'failure',
      startedAt: '2026-09-06T10:00:00Z',
    },
    {
      name: 'unit',
      status: 'completed',
      conclusion: 'success',
      startedAt: '2026-09-06T10:05:00Z',
    },
  ];
  const out = normalizeChecks(raw);
  assert.equal(out.length, 1);
  assert.equal(out[0].conclusion, 'success');
});

test('a newer pending run supersedes an older success', () => {
  const out = normalizeChecks([
    {
      name: 'unit',
      status: 'completed',
      conclusion: 'success',
      startedAt: '2026-09-06T10:00:00Z',
    },
    {
      name: 'unit',
      status: 'in_progress',
      conclusion: null,
      startedAt: '2026-09-06T10:05:00Z',
    },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].status, 'in_progress');
  const v = evaluate({ pr: basePR, checks: out, branchProtected: true });
  assert.equal(ruleOf(v, 'checks-complete').ok, false);
});

test('normalizeChecks handles missing timestamps and empty input', () => {
  assert.deepEqual(normalizeChecks([]), []);
  assert.deepEqual(normalizeChecks(), []);
  const out = normalizeChecks([
    { name: 'a', status: 'completed', conclusion: 'success' },
    { name: 'a', status: 'completed', conclusion: 'failure' },
  ]);
  assert.equal(out.length, 1);
});


// --- resolveProtection: no admin rights required ---

test('classic protection alone marks the branch protected', () => {
  const r = resolveProtection({ classicProtected: true, rules: [] });
  assert.equal(r.protected, true);
});

test('a ruleset alone marks the branch protected', () => {
  // Classic protection and rulesets are independent mechanisms.
  const r = resolveProtection({ classicProtected: false, rules: [{ type: 'pull_request' }] });
  assert.equal(r.protected, true);
});

test('both sources empty means genuinely unprotected, not unknown', () => {
  const r = resolveProtection({ classicProtected: false, rules: [] });
  assert.equal(r.protected, false);
  assert.equal(r.source, 'branch+rulesets');
});

test('only UNKNOWN when every source is unreadable', () => {
  assert.equal(resolveProtection({}).protected, null);
  assert.equal(resolveProtection({ classicProtected: null, rules: null }).protected, null);
  // A single readable source is still enough to decide.
  assert.equal(resolveProtection({ classicProtected: true, rules: null }).protected, true);
  assert.equal(resolveProtection({ classicProtected: null, rules: [] }).protected, false);
});

test('resolveProtection feeds the rule engine end to end', () => {
  const unprotected = resolveProtection({ classicProtected: false, rules: [] });
  const v = evaluate({
    pr: basePR,
    checks: green,
    branchProtected: unprotected.protected,
    options: { protectionDetail: unprotected.detail },
  });
  assert.equal(ruleOf(v, 'branch-protected').status, BLOCKED);
  assert.equal(v.pass, false);
  assert.match(ruleOf(v, 'branch-protected').detail, /no classic protection/);

  const unreadable = resolveProtection({});
  const v2 = evaluate({ pr: basePR, checks: green, branchProtected: unreadable.protected });
  assert.equal(ruleOf(v2, 'branch-protected').status, UNKNOWN);
});
