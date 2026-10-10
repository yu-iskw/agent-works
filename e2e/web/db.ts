import { execFileSync } from 'node:child_process';

export function psql(sql: string): string {
  return execFileSync(
    'docker',
    [
      'compose',
      '-f',
      'compose.dev.yml',
      'exec',
      '-T',
      'postgres',
      'psql',
      '-U',
      'postgres',
      '-At',
      '-c',
      sql,
    ],
    { encoding: 'utf8', cwd: process.cwd() },
  ).trim();
}
