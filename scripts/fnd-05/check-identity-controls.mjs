import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

const publicMembers = ['allUsers', 'allAuthenticatedUsers'];
const invokerRoles = new Set(['roles/run.invoker', 'roles/cloudfunctions.invoker']);
const textExtensions = /\.(tf|tfvars|json|ya?ml|hcl|env|txt|md|mjs|ts|sh)$/;
const skippedDirectories = new Set(['.git', 'node_modules', '.terraform']);
const maxBytes = 2_000_000;

const keyPatterns = [
  ['service-account key JSON field', new RegExp(`"${'private'}_key"\\s*:`)],
  ['PEM private key', new RegExp(`-----BEGIN (?:[A-Z]+ )?${'PRIVATE'} KEY-----`)],
  ['service-account key file type', /"type"\s*:\s*"service_account"/],
  ['Terraform plan service-account key resource', /"type"\s*:\s*"google_service_account_key"/],
  ['Terraform service-account key resource', /^\s*resource\s+"google_service_account_key"/m],
];

function stripHclComment(line) {
  return line.replace(/^\s*(#|\/\/).*$/, '').replace(/\s#.*$/, '');
}

export function scanCredentialText(path, text) {
  const findings = [];
  for (const [label, pattern] of keyPatterns) {
    if (pattern.test(text)) findings.push({ path, rule: 'static-key', detail: label });
  }
  return findings;
}

function walk(value, visit) {
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit);
  } else if (value !== null && typeof value === 'object') {
    visit(value);
    for (const child of Object.values(value)) walk(child, visit);
  }
}

function publicInvokerInJson(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  let found = false;
  walk(parsed, (node) => {
    if (!invokerRoles.has(node.role)) return;
    const members = [node.member, ...(Array.isArray(node.members) ? node.members : [])];
    if (members.some((member) => publicMembers.includes(member))) found = true;
  });
  return found;
}

export function scanPublicInvocationText(path, text) {
  const findings = [];
  if (path.endsWith('.json')) {
    if (publicInvokerInJson(text)) {
      findings.push({
        path,
        rule: 'public-invoker',
        detail: 'plan binds a public principal to an invoker role',
      });
    }
    return findings;
  }
  if (!/\.(tf|tfvars)$/.test(path)) return findings;
  const lines = text.split('\n');
  lines.forEach((raw, index) => {
    const line = stripHclComment(raw);
    if (publicMembers.some((member) => line.includes(member))) {
      findings.push({
        path,
        rule: 'public-invoker',
        detail: `line ${index + 1} names a public principal`,
      });
    }
  });
  return findings;
}

export function scanFiles(files, approvedPublic = new Set()) {
  const findings = [];
  for (const { path, text } of files) {
    findings.push(...scanCredentialText(path, text));
    findings.push(
      ...scanPublicInvocationText(path, text).filter((finding) => !approvedPublic.has(path)),
    );
  }
  return findings;
}

function readCandidate(root, path) {
  const absolute = join(root, path);
  const stats = statSync(absolute);
  if (!stats.isFile() || stats.size > maxBytes) return undefined;
  if (!textExtensions.test(path)) return undefined;
  return { path, text: readFileSync(absolute, 'utf8') };
}

function listTrackedFiles(root) {
  const output = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' });
  return output.split('\0').filter((path) => path.length > 0);
}

function listDirectoryFiles(root) {
  const paths = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (skippedDirectories.has(entry.name)) continue;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else paths.push(relative(root, absolute));
    }
  };
  visit(root);
  return paths;
}

const ownDirectory = 'scripts/fnd-05/';

export function checkIdentityControls({ repoRoot, planDirs = [], approvedPublic = new Set() }) {
  const files = [];
  for (const path of listTrackedFiles(repoRoot)) {
    if (path.startsWith(ownDirectory)) continue;
    const candidate = readCandidate(repoRoot, path);
    if (candidate) files.push(candidate);
  }
  for (const planDir of planDirs) {
    for (const path of listDirectoryFiles(planDir)) {
      const candidate = readCandidate(planDir, path);
      if (candidate) files.push({ ...candidate, path: join('plan', candidate.path) });
    }
  }
  return scanFiles(files, approvedPublic);
}

function main(argv) {
  const planDirs = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--plan-dir' && argv[index + 1]) planDirs.push(argv[(index += 1)]);
  }
  const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
  }).trim();
  const findings = checkIdentityControls({ repoRoot, planDirs });
  for (const finding of findings)
    console.error(`${finding.rule}: ${finding.path}: ${finding.detail}`);
  if (findings.length > 0) process.exitCode = 1;
  else console.log('identity controls: no static keys or public invocation found');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main(process.argv.slice(2));
