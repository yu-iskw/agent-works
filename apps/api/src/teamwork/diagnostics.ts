import { SOURCE_CAPABILITY, SOURCE_KINDS } from '@agent-works/domain/teamwork';

import { memberCapabilities } from './catalog.js';
import { oncePerProvider, tokenSource } from './connections.js';
import { audit } from './context.js';
import { SourceError, sourceRemediation } from './sources/port.js';

import type { Deps, Member } from './context.js';
import type { SourceResult, TokenSource } from './sources/port.js';
import type { SourceCheck, SourceKind } from '@agent-works/domain/teamwork';

/**
 * Reads every source this member may use in this segment once, with the member's own connections,
 * so a member can confirm the setup before starting work. Read-only, no model calls, audited.
 */
export async function checkSources(deps: Deps, member: Member): Promise<readonly SourceCheck[]> {
  const token = oncePerProvider(tokenSource(deps, member.sub));
  const allowed = memberCapabilities(deps, member);
  // Member files are not a provider: there is nothing to reach before a member attaches one.
  const checks = await Promise.all(
    SOURCE_KINDS.filter((source) => source !== 'member_file').map((source) =>
      // eslint-disable-next-line security/detect-object-injection
      allowed.has(SOURCE_CAPABILITY[source])
        ? checkOne(deps, token, source)
        : Promise.resolve<SourceCheck>({
            source,
            status: 'not_allowed',
            detail: 'This segment does not use this source for you.',
          }),
    ),
  );
  await audit(deps, deps.sql, {
    ownerSub: member.sub,
    action: 'sources.check',
    outcome: checks.every((check) => check.status !== 'unreachable') ? 'ok' : 'problems',
    detail: { failed: checks.filter((check) => check.status === 'unreachable').length },
  });
  return checks;
}

async function checkOne(deps: Deps, token: TokenSource, source: SourceKind): Promise<SourceCheck> {
  const { sources } = deps.config;
  try {
    const result = await deps.sources.read({
      kind: source,
      token,
      query: 'setup check workbench task report',
      metrics:
        source === 'bigquery_metrics'
          ? { baseline: '2026-09', current: '2026-10', groupBy: 'region' }
          : null,
      repository: sources.githubRepositories.at(0) ?? null,
      issueNumber: sources.githubIssue ?? null,
    });
    return { source, status: 'reachable', detail: describe(result) };
  } catch (error) {
    if (error instanceof SourceError && error.code === 'empty')
      return {
        source,
        status: 'no_data',
        detail: 'The source answered, but nothing matched the sample this check reads.',
      };
    // Any other failure, including a timeout or a malformed provider reply, is reported for this
    // source alone so the remaining checks still run.
    const detail =
      error instanceof SourceError ? sourceRemediation[error.code] : sourceRemediation.unavailable;
    return { source, status: 'unreachable', detail };
  }
}

function describe(result: SourceResult): string {
  if (result.metrics !== null) {
    const { freshness } = result.metrics;
    const fresh =
      freshness === null ? 'freshness not reported by this source' : `data modified ${freshness}`;
    return `${result.metrics.calculations.length} comparisons computed; ${fresh}`;
  }
  const count = `${result.items.length} item${result.items.length === 1 ? '' : 's'} readable`;
  const revision =
    result.repositoryRevision === null ? '' : ` at ${result.repositoryRevision.slice(0, 12)}`;
  return `${count}${revision}: ${result.items
    .slice(0, 6)
    .map((item) => item.title)
    .join(', ')}`;
}
