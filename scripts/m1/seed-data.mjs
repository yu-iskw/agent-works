#!/usr/bin/env node
// Generates the synthetic BigQuery seed rows and the expected-answer manifest for both M1
// segments. Deterministic: rerunning produces the same rows and expected values. Run
// `pnpm format` afterwards so the files match the repository's Trunk formatting.
//   node scripts/m1/seed-data.mjs
// Output: fixtures/m1/bigquery/<segment>/{daily_kpis,metric_definitions}.csv and
// fixtures/m1/expected/<segment>-metrics.json. The manifest never depends on model output.
import { mkdirSync, writeFileSync } from 'node:fs';

const segments = {
  alpha: {
    regions: ['EU', 'NA', 'APAC'],
    channels: ['web', 'partner'],
    metrics: {
      signups: { unit: 'accounts', base: { web: 420, partner: 130 }, decimals: 0 },
      active_users: { unit: 'accounts', base: { web: 5200, partner: 1600 }, decimals: 0 },
      revenue_usd: { unit: 'USD', base: { web: 9100, partner: 2800 }, decimals: 2 },
    },
    regionScale: { EU: 0.9, NA: 1.2, APAC: 0.7 },
    effects: [
      {
        metric: 'signups',
        region: 'EU',
        channel: 'web',
        from: '2026-10-03',
        to: '2026-10-31',
        factor: 0.78,
      },
      {
        metric: 'revenue_usd',
        region: 'EU',
        channel: 'web',
        from: '2026-10-03',
        to: '2026-10-31',
        factor: 0.93,
      },
      {
        metric: 'signups',
        region: 'APAC',
        channel: 'partner',
        from: '2026-10-01',
        to: '2026-10-31',
        factor: 1.18,
      },
    ],
    definitions: [
      [
        'signups',
        'Accounts that completed email verification on the day (UTC).',
        'accounts',
        'Analytics',
      ],
      [
        'active_users',
        'Distinct accounts with at least one session on the day (UTC).',
        'accounts',
        'Analytics',
      ],
      [
        'revenue_usd',
        'Recognised subscription revenue on the day, excluding tax.',
        'USD',
        'Finance',
      ],
    ],
  },
  beta: {
    regions: ['NA', 'EMEA', 'APAC'],
    channels: ['web', 'phone'],
    metrics: {
      bookings: { unit: 'appointments', base: { web: 610, phone: 340 }, decimals: 0 },
      completed_visits: { unit: 'appointments', base: { web: 520, phone: 290 }, decimals: 0 },
      no_shows: { unit: 'appointments', base: { web: 48, phone: 31 }, decimals: 0 },
    },
    regionScale: { NA: 1.3, EMEA: 1.0, APAC: 0.6 },
    effects: [
      {
        metric: 'no_shows',
        region: 'NA',
        channel: 'web',
        from: '2026-10-06',
        to: '2026-10-31',
        factor: 0.7,
      },
      {
        metric: 'no_shows',
        region: 'NA',
        channel: 'phone',
        from: '2026-10-06',
        to: '2026-10-31',
        factor: 0.7,
      },
      {
        metric: 'bookings',
        region: 'EMEA',
        channel: 'phone',
        from: '2026-10-13',
        to: '2026-10-24',
        factor: 0.55,
      },
      {
        metric: 'completed_visits',
        region: 'EMEA',
        channel: 'phone',
        from: '2026-10-13',
        to: '2026-10-24',
        factor: 0.55,
      },
      {
        metric: 'bookings',
        region: 'EMEA',
        channel: 'web',
        from: '2026-10-13',
        to: '2026-10-24',
        factor: 1.2,
      },
    ],
    definitions: [
      ['bookings', 'Appointments booked on the day (UTC).', 'appointments', 'Clinic operations'],
      [
        'completed_visits',
        'Appointments attended on the day (UTC).',
        'appointments',
        'Clinic operations',
      ],
      [
        'no_shows',
        'Booked appointments neither attended nor cancelled, by appointment day (UTC).',
        'appointments',
        'Clinic operations',
      ],
    ],
  },
};

const periods = {
  '2026-08': ['2026-08-01', '2026-08-31'],
  '2026-09': ['2026-09-01', '2026-09-30'],
  '2026-10': ['2026-10-01', '2026-10-31'],
};

function rng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
}

function days(from, to) {
  const out = [];
  for (
    let d = new Date(`${from}T00:00:00Z`);
    d <= new Date(`${to}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1)
  )
    out.push(d.toISOString().slice(0, 10));
  return out;
}

const round = (value, decimals) => Number(value.toFixed(decimals));

function generate(name, spec) {
  const random = rng([...name].reduce((sum, c) => sum * 31 + c.charCodeAt(0), 7));
  const rows = [];
  for (const day of days('2026-08-01', '2026-10-31')) {
    const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
    const weekly = weekday === 0 || weekday === 6 ? 0.85 : 1.05;
    for (const region of spec.regions)
      for (const channel of spec.channels)
        for (const [metric, m] of Object.entries(spec.metrics)) {
          const effect = spec.effects
            .filter(
              (e) =>
                e.metric === metric &&
                e.region === region &&
                e.channel === channel &&
                day >= e.from &&
                day <= e.to,
            )
            .reduce((f, e) => f * e.factor, 1);
          const noise = 0.96 + random() * 0.08;
          const value = round(
            m.base[channel] * spec.regionScale[region] * weekly * noise * effect,
            m.decimals,
          );
          rows.push({ day, region, channel, metric, value });
        }
  }
  return rows;
}

function totals(rows, spec, groupBy) {
  const out = {};
  for (const [period, [from, to]] of Object.entries(periods))
    for (const metric of Object.keys(spec.metrics)) {
      const decimals = spec.metrics[metric].decimals;
      for (const row of rows) {
        if (row.metric !== metric || row.day < from || row.day > to) continue;
        const key = `${metric}|${row[groupBy]}|${period}`;
        out[key] = round((out[key] ?? 0) + row.value, decimals);
      }
    }
  return out;
}

function comparisons(rows, spec, groupBy, baseline, current) {
  const sums = totals(rows, spec, groupBy);
  const groups = groupBy === 'region' ? spec.regions : spec.channels;
  return Object.keys(spec.metrics).flatMap((metric) =>
    groups.map((group) => {
      const before = sums[`${metric}|${group}|${baseline}`];
      const after = sums[`${metric}|${group}|${current}`];
      return {
        metric,
        [groupBy]: group,
        baseline,
        current,
        baselineValue: before,
        currentValue: after,
        changePct: round(((after - before) / before) * 100, 1),
      };
    }),
  );
}

for (const [name, spec] of Object.entries(segments)) {
  const rows = generate(name, spec);
  mkdirSync(`fixtures/m1/bigquery/${name}`, { recursive: true });
  writeFileSync(
    `fixtures/m1/bigquery/${name}/daily_kpis.csv`,
    [
      'day,region,channel,metric,value',
      ...rows.map((r) => `${r.day},${r.region},${r.channel},${r.metric},${r.value}`),
    ].join('\n') + '\n',
  );
  writeFileSync(
    `fixtures/m1/bigquery/${name}/metric_definitions.csv`,
    [
      'metric,definition,unit,owner,updated_at',
      ...spec.definitions.map(
        ([metric, definition, unit, owner]) =>
          `${metric},"${definition}",${unit},${owner},2026-09-30T00:00:00Z`,
      ),
    ].join('\n') + '\n',
  );
  const manifest = {
    segment: name,
    dataset: `aw_m1_${name}`,
    rowCount: rows.length,
    dateRange: ['2026-08-01', '2026-10-31'],
    units: Object.fromEntries(Object.entries(spec.metrics).map(([k, m]) => [k, m.unit])),
    tolerance: { absolute: 0.01, percentPoints: 0.1 },
    injectedEffects: spec.effects,
    emptyPeriod: '2025-01',
    expected: {
      'region:2026-09->2026-10': comparisons(rows, spec, 'region', '2026-09', '2026-10'),
      'channel:2026-09->2026-10': comparisons(rows, spec, 'channel', '2026-09', '2026-10'),
      'region:2026-08->2026-10': comparisons(rows, spec, 'region', '2026-08', '2026-10'),
    },
  };
  mkdirSync('fixtures/m1/expected', { recursive: true });
  writeFileSync(
    `fixtures/m1/expected/${name}-metrics.json`,
    JSON.stringify(manifest, null, 2) + '\n',
  );
  process.stdout.write(`${name}: ${rows.length} rows\n`);
}
