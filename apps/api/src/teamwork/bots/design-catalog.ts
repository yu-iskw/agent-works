import type { BotDesignCatalog } from './design.js';
import type { AgentRegistry } from '../mcp-task/index.js';
import type postgres from 'postgres';

type ActivatedSkill = {
  package_id: string;
  version: string;
  digest: string;
  name: string;
  description: string;
};

/**
 * What the design conversation may offer the model: approved agents by id and data classification,
 * and only activated skills pinned to their package digest. Endpoints and credentials stay out.
 */
export function createBotDesignCatalog(
  sql: postgres.Sql,
  registry: AgentRegistry,
): BotDesignCatalog {
  return {
    agents: () =>
      registry.list().map(({ agentId, displayName, dataClassification }) => ({
        agentId,
        displayName,
        dataClassification,
      })),
    async skills() {
      const rows = await sql<ActivatedSkill[]>`
        select p.package_id, p.version, p.digest, s.name, s.description
        from tw_skill_packages p
        join tw_skill_package_skills s on s.package_id = p.package_id and s.version = p.version
        where p.state = 'activated'
        order by p.package_id, p.version, s.name
      `;
      return rows.map((row) => ({
        packageId: row.package_id,
        version: row.version,
        digest: row.digest,
        name: row.name,
        description: row.description,
      }));
    },
  };
}
