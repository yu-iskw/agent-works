// Metric comparisons drawn from the revision's own calculation rows. Bars are proportional to
// the larger absolute value of each pair; every number shown is the stored value.

import type { Calculation } from '@agent-works/domain/teamwork';
import type { JSX } from 'preact';

const format = (value: number, unit: string): string => {
  const text = Number.isInteger(value)
    ? value.toLocaleString()
    : value.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return unit === '%' ? `${text}%` : unit === '' ? text : `${text} ${unit}`;
};

const signed = (value: number, digits = 1): string =>
  `${value > 0 ? '+' : ''}${value.toLocaleString(undefined, { maximumFractionDigits: digits })}`;

function Bar(props: { readonly label: string; readonly value: number; readonly scale: number }) {
  const width = props.scale === 0 ? 0 : Math.round((Math.abs(props.value) / props.scale) * 100);
  return (
    <div class="calc-bar">
      <span class="calc-bar-label">{props.label}</span>
      <span class="calc-bar-track" aria-hidden="true">
        <span class="calc-bar-fill" style={{ width: `${width}%` }} />
      </span>
    </div>
  );
}

function Comparison(props: { readonly calc: Calculation }): JSX.Element {
  const { calc } = props;
  const scale = Math.max(Math.abs(calc.baselineValue), Math.abs(calc.currentValue));
  const change =
    calc.changePct === null
      ? signed(calc.change, 2)
      : `${signed(calc.change, 2)} (${signed(calc.changePct)}%)`;
  const tone = calc.change > 0 ? 'ok' : calc.change < 0 ? 'error' : 'muted';
  return (
    <li class="calc">
      <div
        role="img"
        aria-label={`${calc.metric}, ${calc.group}: ${calc.baseline} ${format(calc.baselineValue, calc.unit)}, ${calc.current} ${format(calc.currentValue, calc.unit)}, change ${change}`}
      >
        <div class="calc-head">
          <span class="calc-metric">{calc.metric}</span>
          <span class="muted">
            {calc.groupBy}: {calc.group}
          </span>
          <span class="calc-id">{calc.id}</span>
        </div>
        <div class="calc-values">
          <span>
            <span class="muted">{calc.baseline}</span> {format(calc.baselineValue, calc.unit)}
          </span>
          <span>
            <span class="muted">{calc.current}</span> {format(calc.currentValue, calc.unit)}
          </span>
          <span class="calc-change" data-tone={tone}>
            {change}
          </span>
        </div>
        <Bar label={calc.baseline} value={calc.baselineValue} scale={scale} />
        <Bar label={calc.current} value={calc.currentValue} scale={scale} />
      </div>
    </li>
  );
}

export function Calculations(props: {
  readonly calculations: readonly Calculation[];
}): JSX.Element | null {
  if (props.calculations.length === 0) return null;
  return (
    <section class="calcs" aria-labelledby="calcs-title">
      <h4 id="calcs-title">Calculations</h4>
      <ul class="calc-list">
        {props.calculations.map((calc) => (
          <Comparison key={calc.id} calc={calc} />
        ))}
      </ul>
    </section>
  );
}
