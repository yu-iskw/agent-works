/**
 * Gate membership from MILESTONE.md (four exit gates) and the live proof each gate still needs.
 * Live items are operator work; nothing here marks one done.
 */
export const gateTasks = {
  G1: [
    'BASE-00',
    'FND-01',
    'FND-02',
    'FND-03',
    'FND-04',
    'FND-05',
    'FND-06',
    'AUTH-01',
    'TASK-01',
    'DEP-01',
    'ACL-01',
    'OPS-01',
  ],
  G2: ['SCH-00', 'SCH-01', 'SCH-02', 'SCH-03', 'SCH-04', 'SCH-05', 'SCH-06', 'AGT-03'],
  G3: ['AGT-00', 'AGT-01', 'AGT-02', 'AGT-03', 'AGT-04', 'AGT-05', 'AGT-06', 'AGT-07'],
  G4: ['OPS-02', 'OPS-03', 'OPS-04', 'OPS-05'],
};

export const gateTitles = {
  G1: 'Secure controlled pilot',
  G2: 'Durable automation',
  G3: 'Governed teamwork',
  G4: 'Enterprise production',
};

export const gateApprovalRoles = {
  G1: 'Security, platform, product',
  G2: 'Platform, security, product',
  G3: 'Product, security, privacy',
  G4: 'SRE, security, product, finance',
};

/** Optional capabilities: DEFER with proof they are disabled. */
export const optionalCapabilities = [
  {
    task: 'AGT-05',
    capability: 'sandboxExecution',
    record: 'docs/plans/enterprise-production-v1/agt-05/gate-decision-record.md',
    tests: ['apps/api/src/capabilities/gate.test.ts', 'apps/api/src/capabilities/sandbox.test.ts'],
  },
  {
    task: 'AGT-06',
    capability: 'managedMemory',
    record: 'docs/plans/enterprise-production-v1/agt-06/gate-decision-record.md',
    tests: [
      'apps/api/src/capabilities/gate.test.ts',
      'apps/api/src/capabilities/memory-port.test.ts',
    ],
  },
];

const dir = 'docs/plans/enterprise-production-v1';

/** Gate-level live proof from MILESTONE.md "Required proof". All UNTESTED until an operator attaches it. */
export const gateLiveRequirements = {
  G1: [
    [
      'two-user-identity-and-source',
      'Real two-user IAP identity and source ACL tests (SEC-01, SEC-02)',
      `${dir}/dep-01/operator-approval.md`,
    ],
    [
      'broker-negatives-live',
      'Broker negatives against the deployed stack (SEC-03)',
      `${dir}/dep-01/operator-approval.md`,
    ],
    [
      'private-ingress',
      'Private ingress: direct URL bypass, wrong issuer/audience (SEC-04)',
      `${dir}/dep-01/operator-approval.md`,
    ],
    [
      'real-persistence',
      'Real Cloud SQL persistence and migrations 0001..0030 applied',
      `${dir}/fnd-03/README.md`,
    ],
    ['stop-and-restore', 'Operator stop and restore drill', 'docs/runbooks/dr-restore.md'],
  ],
  G2: [
    [
      'duplicate-fault-recovery',
      'Duplicate and fault recovery matrix on real queue and Postgres (DUR-01..03)',
      `${dir}/sch-03/operator-real-queue-test.md`,
    ],
    [
      'authority-revocation',
      'Authority revocation observed before enqueue, start and effect (SEC-03)',
      `${dir}/agt-03/README.md`,
    ],
    [
      'concurrency-benchmark',
      'Concurrency benchmark and P01 to P04 measurements',
      `${dir}/ops-04/README.md`,
    ],
  ],
  G3: [
    ['dag-recovery', 'Versioned DAG recovery on the deployed stack', `${dir}/agt-01/evidence.md`],
    [
      'bounded-delegation-live',
      'Bounded delegation and widened-grant denial live',
      `${dir}/agt-02/evidence.md`,
    ],
    [
      'private-shared-isolation',
      'Private versus shared bot isolation live',
      `${dir}/agt-04/evidence.md`,
    ],
    [
      'status-ui-live',
      'Dependency and execution status UI on the deployed web app',
      `${dir}/agt-07/evidence.md`,
    ],
  ],
  G4: [
    [
      'approved-slo-budget',
      'Approved SLO, RTO/RPO and budget ceiling (O05)',
      `${dir}/fnd-01/readiness-matrix.md`,
    ],
    [
      'load-fault-recovery',
      'Capacity, fault and restore campaign P01 to P08',
      `${dir}/ops-04/README.md`,
    ],
    [
      'quality-security-eval-live',
      'Live security and quality evaluation with approved thresholds',
      `${dir}/ops-03/evidence.md`,
    ],
    [
      'rollout-rollback-rehearsal',
      'Cohort rollout and rollback rehearsal',
      `${dir}/ops-05/rollout-rollback.md`,
    ],
    [
      'release-sbom-image-scan',
      'Release SBOM and image vulnerability scan bound to the image digest',
      `${dir}/fnd-06/release-evidence-policy.md`,
    ],
    [
      'immutable-release-record',
      'Tagged commit, image digests, signed go/no-go record (issue 175)',
      `${dir}/ops-05/go-no-go-form.md`,
    ],
  ],
};
