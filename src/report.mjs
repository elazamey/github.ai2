/** Renders the gatekeeper verdict as a Markdown PR comment. */

export function renderComment(verdict, ctx = {}) {
  const { repo = '', prNumber = '', autoMerge = false, dryRun = false } = ctx;

  const head = verdict.pass
    ? '## ✅ PR Gatekeeper — ready to merge'
    : '## ⛔ PR Gatekeeper — merge blocked';

  const rows = verdict.rules
    .map((r) => `| ${r.ok ? '✅' : '❌'} | ${r.label} | ${r.detail} |`)
    .join('\n');

  const blockers = verdict.rules.filter((r) => !r.ok);

  const lines = [
    head,
    '',
    `**Repository:** \`${repo}\` · **PR:** #${prNumber}`,
    '',
    '| | Rule | Detail |',
    '| :-: | --- | --- |',
    rows,
    '',
  ];

  if (blockers.length) {
    lines.push(
      `### Blockers (${blockers.length})`,
      ...blockers.map((b) => `- **${b.label}** — ${b.detail}`),
      ''
    );
  }

  const { pending, failing, passing, total } = verdict.checks;
  lines.push(
    `**Checks:** ${passing.length} passing · ${failing.length} failing · ${pending.length} pending · ${total} total`,
    ''
  );

  if (verdict.pass) {
    lines.push(
      autoMerge
        ? dryRun
          ? '_Auto-merge is enabled, but this was a dry run — nothing was merged._'
          : '_Auto-merge is enabled — merging now._'
        : '_Auto-merge is disabled — merge manually when ready._'
    );
  } else {
    lines.push('_Resolve the blockers above; this comment updates automatically._');
  }

  if (dryRun) lines.push('', '> 🧪 dry-run mode: no comment or merge was performed.');

  return lines.join('\n');
}
