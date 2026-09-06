/**
 * Pure merge-decision rules. No network, no side effects -> easy to unit test.
 *
 * Every rule resolves to one of four states. The distinction matters for security:
 * a rule we could not evaluate must never look like a rule that passed.
 *
 *   VERIFIED               checked and satisfied
 *   BLOCKED                checked and violated -> blocks the merge
 *   SKIPPED_WITH_WARNING   intentionally not enforced by configuration
 *   UNKNOWN                could not be evaluated (e.g. API 403) -> never auto-merge
 *
 * `pass` means "nothing is BLOCKED" (safe to merge by hand).
 * `autoMergeSafe` additionally requires that every rule is VERIFIED, so an
 * unverifiable security rule can never silently authorize an automated merge.
 */

export const VERIFIED = 'VERIFIED';
export const BLOCKED = 'BLOCKED';
export const SKIPPED_WITH_WARNING = 'SKIPPED_WITH_WARNING';
export const UNKNOWN = 'UNKNOWN';

/** Rules that must be VERIFIED before any automated merge, no matter the config. */
export const SECURITY_CRITICAL = new Set(['branch-protected']);

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

  /** @param {string} id @param {string} status @param {string} label @param {string} detail */
  const push = (id, status, label, detail) =>
    rules.push({ id, status, ok: status === VERIFIED, label, detail });

  /** Boolean shorthand: true -> VERIFIED, false -> BLOCKED. */
  const add = (id, ok, label, detail) =>
    push(id, ok ? VERIFIED : BLOCKED, label, detail);

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

  // Security-critical, and deliberately tri-state: `null` means we were not allowed
  // to read the protection API, which is NOT the same as "protected".
  {
    const label = `Base branch \`${pr.base}\` is protected`;
    if (branchProtected === null || branchProtected === undefined) {
      push(
        'branch-protected',
        UNKNOWN,
        label,
        'could not read branch protection (insufficient token permissions) - auto-merge withheld'
      );
    } else if (!requireBranchProtection) {
      push(
        'branch-protected',
        SKIPPED_WITH_WARNING,
        label,
        branchProtected
          ? 'protection rules active (enforcement disabled by configuration)'
          : 'NOT protected, but enforcement is disabled by configuration - auto-merge withheld'
      );
    } else {
      push(
        'branch-protected',
        branchProtected ? VERIFIED : BLOCKED,
        label,
        branchProtected ? 'protection rules active' : 'NO branch protection configured'
      );
    }
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

  const blocked = rules.filter((r) => r.status === BLOCKED);
  const unverified = rules.filter(
    (r) => r.status === UNKNOWN || r.status === SKIPPED_WITH_WARNING
  );
  const criticalUnverified = unverified.filter((r) => SECURITY_CRITICAL.has(r.id));

  const pass = blocked.length === 0;

  return {
    pass,
    // An unverifiable rule must never authorize an automated merge.
    autoMergeSafe: pass && unverified.length === 0,
    blocked,
    unverified,
    criticalUnverified,
    rules,
    checks: ck,
    reviews: rv,
  };
}
