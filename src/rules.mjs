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

/**
 * Resolves branch protection from several sources of differing trust.
 *
 * The admin-only `/protection` endpoint is not the only source of truth, and relying
 * on it alone is fragile: it 403s without admin rights, and its documented codes are
 * only 200/404 - so a fine-grained token can answer 404, which is indistinguishable
 * from "no protection configured". Two endpoints readable with plain `contents: read`
 * are more reliable here:
 *
 *   GET /repos/{o}/{r}/branches/{b}        -> .protected  (classic protection)
 *   GET /repos/{o}/{r}/rules/branches/{b}  -> []          (rulesets)
 *
 * Classic branch protection and rulesets are independent; a branch may be governed by
 * either, so protection is the OR of both. Only when every source is unreadable do we
 * report `null` (UNKNOWN).
 *
 * @param {{classicProtected?:boolean|null, rules?:Array|null}} sources
 * @returns {{protected: boolean|null, source: string, detail: string}}
 */
export function resolveProtection({ classicProtected = null, rules = null } = {}) {
  const haveClassic = typeof classicProtected === 'boolean';
  const haveRules = Array.isArray(rules);

  if (!haveClassic && !haveRules) {
    return {
      protected: null,
      source: 'none',
      detail: 'no protection source was readable',
    };
  }

  const ruleCount = haveRules ? rules.length : 0;
  const parts = [];
  if (haveClassic) {
    parts.push(classicProtected ? 'classic protection on' : 'no classic protection');
  }
  if (haveRules) {
    parts.push(ruleCount ? `${ruleCount} ruleset rule(s)` : 'no ruleset rules');
  }

  return {
    protected: Boolean(classicProtected) || ruleCount > 0,
    source: haveClassic && haveRules ? 'branch+rulesets' : haveClassic ? 'branch' : 'rulesets',
    detail: parts.join(', '),
  };
}

/** Rules that must be VERIFIED before any automated merge, no matter the config. */
export const SECURITY_CRITICAL = new Set(['branch-protected']);

/** Conclusions that do not block a merge. */
const OK_CONCLUSIONS = new Set(['success', 'neutral', 'skipped']);

/**
 * Normalizes raw check-runs before evaluation.
 *
 * - Drops the gatekeeper's own check: it runs as a check itself, so it would always
 *   observe itself as in-progress and could never reach a settled verdict.
 * - Deduplicates by name, keeping the newest: the same workflow can report twice on
 *   one sha (a `push` run and a `pull_request` run), or be re-run.
 *
 * @param {Array<{name:string,startedAt?:string}>} runs
 * @param {{selfCheckName?:string}} opts
 */
export function normalizeChecks(runs = [], { selfCheckName = 'gatekeeper' } = {}) {
  const byName = new Map();
  for (const r of runs) {
    if (r.name === selfCheckName) continue;
    const ts = Date.parse(r.startedAt || 0) || 0;
    const prev = byName.get(r.name);
    if (!prev || ts >= prev.__ts) byName.set(r.name, { ...r, __ts: ts });
  }
  return [...byName.values()].map(({ __ts, ...c }) => c);
}

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
    const note = options.protectionDetail ? ` (${options.protectionDetail})` : '';
    if (branchProtected === null || branchProtected === undefined) {
      push(
        'branch-protected',
        UNKNOWN,
        label,
        'could not read branch protection from any source - auto-merge withheld'
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
        (branchProtected ? 'protection active' : 'NO branch protection configured') + note
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
