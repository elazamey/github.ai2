/** Renders the gatekeeper verdict as a Markdown PR comment. */

import { VERIFIED, BLOCKED, SKIPPED_WITH_WARNING, UNKNOWN } from './rules.mjs';

const ICON = {
  [VERIFIED]: '✅',
  [BLOCKED]: '❌',
  [SKIPPED_WITH_WARNING]: '⚠️',
  [UNKNOWN]: '❔',
};

const STATUS_LABEL = {
  [VERIFIED]: 'verified',
  [BLOCKED]: 'blocked',
  [SKIPPED_WITH_WARNING]: 'skipped',
  [UNKNOWN]: 'unknown',
};

export function renderComment(verdict, ctx = {}) {
  const { repo = '', prNumber = '', autoMerge = false, dryRun = false } = ctx;

  const head = verdict.pass
    ? verdict.autoMergeSafe
      ? '## ✅ PR Gatekeeper — ready to merge'
      : '## ⚠️ PR Gatekeeper — no blockers, but not fully verified'
    : '## ⛔ PR Gatekeeper — merge blocked';

  const rows = verdict.rules
    .map(
      (r) =>
        `| ${ICON[r.status] || '•'} | ${r.label} | \`${STATUS_LABEL[r.status] || r.status}\` | ${r.detail} |`
    )
    .join('\n');

  const lines = [
    head,
    '',
    `**Repository:** \`${repo}\` · **PR:** #${prNumber}`,
    '',
    '| | Rule | Status | Detail |',
    '| :-: | --- | --- | --- |',
    rows,
    '',
  ];

  if (verdict.blocked.length) {
    lines.push(
      `### ❌ Blockers (${verdict.blocked.length})`,
      ...verdict.blocked.map((b) => `- **${b.label}** — ${b.detail}`),
      ''
    );
  }

  if (verdict.unverified.length) {
    lines.push(
      `### ❔ Unverified rules (${verdict.unverified.length})`,
      ...verdict.unverified.map(
        (u) => `- **${u.label}** — \`${STATUS_LABEL[u.status]}\` — ${u.detail}`
      ),
      '',
      '> These rules could not be confirmed. They do **not** block a manual merge, but',
      '> they do prevent automated merging — an unverified security rule must never',
      '> be treated as a pass.',
      ''
    );
  }

  if (verdict.githubWillRefuse) {
    const why =
      verdict.githubWillRefuse === 'behind'
        ? 'the branch is behind its base and protection requires it to be up to date'
        : 'branch protection requirements are not met (most often a missing required review)';
    lines.push(
      '### ⛔ GitHub will refuse this merge',
      '',
      `\`mergeable_state: ${verdict.githubWillRefuse}\` — ${why}.`,
      '',
      '> This is enforced by GitHub, not by the gatekeeper. Every rule above may pass',
      '> and the merge will still be rejected. A bot cannot approve its own pull',
      '> request, so a PR authored by this bot needs a human approval.',
      ''
    );
  }

  const { pending, failing, passing, total } = verdict.checks;
  lines.push(
    `**Checks:** ${passing.length} passing · ${failing.length} failing · ${pending.length} pending · ${total} total`,
    ''
  );

  if (!verdict.pass) {
    lines.push('_Resolve the blockers above; this comment updates automatically._');
  } else if (!autoMerge) {
    lines.push('_Auto-merge is disabled — merge manually when ready._');
  } else if (!verdict.autoMergeSafe) {
    const names = verdict.criticalUnverified.length
      ? verdict.criticalUnverified.map((r) => `\`${r.id}\``).join(', ')
      : verdict.unverified.map((r) => `\`${r.id}\``).join(', ');
    lines.push(
      `_Auto-merge is enabled but **withheld**: ${names} could not be verified._`
    );
  } else if (dryRun) {
    lines.push('_Auto-merge is enabled, but this was a dry run — nothing was merged._');
  } else {
    lines.push('_Auto-merge is enabled and every rule is verified — merging now._');
  }

  if (dryRun) lines.push('', '> 🧪 dry-run mode: no comment or merge was performed.');

  return lines.join('\n');
}
