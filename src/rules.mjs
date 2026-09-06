/**
 * Pure merge-decision rules. No network, no side effects -> easy to unit test.
 */

/** Conclusions that do not block a merge. */
const OK_CONCLUSIONS = new Set(['success', 'neutral', 'skipped']);

export function summarizeChecks(checks = []) {
  const pending = [];
  const failing = [];
  const passing = [];
  for (const c of checks) {
    if (c.status !== 'completed' || c.conclusion == null) pending.push(c);
    else if (OK_CONCLUSIONS.has(c.conclusion)) passing.push(c);
    else failing.push(c);
  }
  return { pending, failing, passing, total: checks.length };
}

export function summarizeReviews(reviews = []) {
  // Latest review per user wins.
  const latest = new Map();
  for (const r of reviews) {
    if (!r.user) continue;
    if (r.state === 'COMMENTED') continue;
    latest.set(r.user, r.state);
  }
  const states = [...latest.values()];
  return {
    approvals: states.filter((s) => s === 'APPROVED').length,
    changesRequested: states.filter((s) => s === 'CHANGES_REQUESTED').length,
  };
}

/**
 * @returns {{pass:boolean, rules:Array<{id:string,ok:boolean,label:string,detail:string}>, checks:object, reviews:object}}
 */
export function evaluate({
  pr,
  checks = [],
  branchProtected = false,
  reviews = [],
  options = {},
} = {}) {
  const { requireBranchProtection = true, minApprovals = 0 } = options;

  const ck = summarizeChecks(checks);
  const rv = summarizeReviews(reviews);
  const rules = [];

  const add = (id, ok, label, detail) => rules.push({ id, ok, label, detail });

  add(
    'open',
    pr.state === 'open',
    'PR is open',
    pr.state === 'open' ? 'open' : `state = ${pr.state}`
  );

  add(
    'not-draft',
    pr.draft !== true,
    'Not a draft',
    pr.draft ? 'PR is still a draft' : 'ready for review'
  );

  add(
    'no-conflicts',
    pr.mergeable !== false && pr.mergeable_state !== 'dirty',
    'No merge conflicts',
    pr.mergeable === false || pr.mergeable_state === 'dirty'
      ? 'branch has conflicts with the base'
      : pr.mergeable === null
        ? 'mergeability still being computed (treated as OK)'
        : 'clean'
  );

  add(
    'checks-complete',
    ck.pending.length === 0,
    'All checks finished',
    ck.pending.length
      ? `${ck.pending.length} still running: ${ck.pending.map((c) => c.name).join(', ')}`
      : `${ck.total} check(s) finished`
  );

  add(
    'checks-green',
    ck.failing.length === 0,
    'No failing checks',
    ck.failing.length
      ? `failing: ${ck.failing.map((c) => `${c.name} (${c.conclusion})`).join(', ')}`
      : `${ck.passing.length} passing`
  );

  add(
    'has-checks',
    ck.total > 0,
    'At least one check ran',
    ck.total > 0 ? `${ck.total} check(s)` : 'no CI reported for this commit'
  );

  if (requireBranchProtection) {
    add(
      'branch-protected',
      branchProtected,
      `Base branch \`${pr.base}\` is protected`,
      branchProtected ? 'protection rules active' : 'NO branch protection configured'
    );
  }

  add(
    'no-changes-requested',
    rv.changesRequested === 0,
    'No changes requested',
    rv.changesRequested ? `${rv.changesRequested} reviewer(s) requested changes` : 'none'
  );

  if (minApprovals > 0) {
    add(
      'approvals',
      rv.approvals >= minApprovals,
      `At least ${minApprovals} approval(s)`,
      `${rv.approvals} approval(s)`
    );
  }

  add(
    'no-blocking-label',
    !(pr.labels || []).some((l) => /^(do-not-merge|wip|blocked)$/i.test(l)),
    'No blocking label',
    (pr.labels || []).join(', ') || 'no labels'
  );

  return { pass: rules.every((r) => r.ok), rules, checks: ck, reviews: rv };
}
