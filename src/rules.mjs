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
 *
 * SEMANTICS: `autoMergeSafe` states that *this bot's policy* is satisfied. It does
 * NOT promise GitHub will accept the merge - branch protection may additionally
 * require approving reviews, and a bot cannot approve its own pull request. That
 * case is surfaced separately as `githubWillRefuse` (from `mergeable_state`) so a
 * protection-level refusal is never mistaken for a gatekeeper bug.
 */

export const VERIFIED = 'VERIFIED';
export const BLOCKED = 'BLOCKED';
export const SKIPPED_WITH_WARNING = 'SKIPPED_WITH_WARNING';
export const UNKNOWN = 'UNKNOWN';

/** Per-source protection readings. An error must never collapse into "no". */
export const PROTECTED = 'PROTECTED';
export const NOT_PROTECTED = 'NOT_PROTECTED';
export const ERR = 'ERR';

/**
 * Interprets `GET /repos/{o}/{r}/branches/{b}` -> classic branch protection.
 * @param {{status:number, body?:{protected?:boolean}}} res
 */
export function readClassicProtection(res) {
  if (!res || res.status !== 200) return ERR;
  return res.body?.protected ? PROTECTED : NOT_PROTECTED;
}

/**
 * Interprets `GET /repos/{o}/{r}/rules/branches/{b}` -> rulesets.
 *
 * A non-empty list is NOT sufficient: a ruleset may be `disabled`, or in `evaluate`
 * (dry-run) mode, in which case it constrains nothing. Only `active` counts, otherwise
 * we would confidently report a branch as protected when it is not - the same silent
 * failure as before, merely inverted.
 *
 * Note the endpoint already returns only rules whose conditions match this branch,
 * so no further condition matching is needed here.
 *
 * @param {{status:number, body?:Array}} res
 */
export function readRulesetProtection(res) {
  if (!res || res.status !== 200) return ERR;
  if (!Array.isArray(res.body)) return ERR;
  return res.body.some(isActive) ? PROTECTED : NOT_PROTECTED;
}

function isActive(rule) {
  // The rules-for-branch endpoint reports enforcement on each entry; older payloads
  // nest it. Absent enforcement info we refuse to assume "active".
  const enforcement = rule?.enforcement ?? rule?.ruleset?.enforcement;
  return enforcement === 'active';
}

/**
 * Combines per-source readings into a single verdict.
 *
 * Rules:
 *   - any source says PROTECTED            -> PROTECTED   (mechanisms are independent, so OR)
 *   - no source could be read              -> UNKNOWN
 *   - a source errored and none said yes   -> UNKNOWN     (a half-read is a doubt, not a "no")
 *   - all sources read and all say no      -> NOT_PROTECTED
 *
 * The third case is the important one: an org policy or fine-grained token can 403 the
 * rulesets endpoint, and treating that as "no rulesets" would yield a confident verdict
 * from half the evidence.
 *
 * @param {{classic?:string, rulesets?:string}} readings
 * @returns {{protected: boolean|null, source: string, detail: string}}
 */
export function resolveProtection({ classic = ERR, rulesets = ERR } = {}) {
  const sources = [
    ['classic protection', classic],
    ['rulesets', rulesets],
  ];

  const describe = (name, state) =>
    state === PROTECTED
      ? `${name}: active`
      : state === NOT_PROTECTED
        ? `${name}: none`
        : `${name}: UNREADABLE`;
  const detail = sources.map(([n, v]) => describe(n, v)).join(', ');

  const readable = sources.filter(([, v]) => v !== ERR);
  const errored = sources.filter(([, v]) => v === ERR);

  if (readable.some(([, v]) => v === PROTECTED)) {
    return {
      protected: true,
      source: readable
        .filter(([, v]) => v === PROTECTED)
        .map(([n]) => n)
        .join('+'),
      detail,
    };
  }

  if (readable.length === 0) {
    return { protected: null, source: 'none', detail };
  }

  if (errored.length > 0) {
    // Partial evidence, all of it negative: not enough to declare "unprotected".
    return { protected: null, source: 'partial', detail };
  }

  return { protected: false, source: 'branch+rulesets', detail };
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

  // GitHub's own view of the merge, independent of our rules. `blocked` here means
  // protection requirements are unmet (typically a missing required review) - which a
  // bot cannot resolve for its own PR.
  const mergeableState = pr.mergeable_state;
  const githubWillRefuse =
    mergeableState === 'blocked' || mergeableState === 'behind' ? mergeableState : null;

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
    githubWillRefuse,
    blocked,
    unverified,
    criticalUnverified,
    rules,
    checks: ck,
    reviews: rv,
  };
}
