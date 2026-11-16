import { css, html, svg, TemplateResult } from 'lit';

/** Width and height of a list sparkline, in pixels */
const WIDTH = 90;
const HEIGHT = 22;

/**
 * Renders a tiny line+area sparkline of a numeric series, for a list's
 * activity column. An optional second series is drawn as a plain line on
 * the same scale. Values are normalized to the sparkline's height, so
 * absolute magnitude isn't preserved - the point is shape, not scale.
 */
export const renderSparkline = (
  values: number[],
  secondary: number[] = null
): TemplateResult => {
  if (!values || values.length < 2) return html``;

  const max = Math.max(...values, ...(secondary || []), 1);
  const step = WIDTH / (values.length - 1);
  const points = (series: number[]) =>
    series.map((v, i) => {
      const x = i * step;
      const y = HEIGHT - (v / max) * (HEIGHT - 2) - 1;
      return [x.toFixed(1), y.toFixed(1)] as const;
    });

  const pts = points(values);
  const line = pts.map(([x, y]) => `${x},${y}`).join(' ');
  const areaCmds = pts
    .map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x},${y}`)
    .join(' ');
  const area = `${areaCmds} L${WIDTH},${HEIGHT} L0,${HEIGHT} Z`;
  const second =
    secondary && secondary.length === values.length
      ? points(secondary)
          .map(([x, y]) => `${x},${y}`)
          .join(' ')
      : null;

  return html`
    <svg
      class="sparkline"
      width=${WIDTH}
      height=${HEIGHT}
      viewBox="0 0 ${WIDTH} ${HEIGHT}"
      preserveAspectRatio="none"
    >
      <path class="area" d=${area}></path>
      <polyline class="line" points=${line}></polyline>
      ${second
        ? svg`<polyline class="line secondary" points=${second}></polyline>`
        : null}
    </svg>
  `;
};

/** Styles for {@link renderSparkline} */
export const sparklineStyles = css`
  .sparkline {
    display: inline-block;
    vertical-align: middle;
  }
  .sparkline .line {
    fill: none;
    stroke: var(--accent-600);
    stroke-width: 1.25;
    stroke-linejoin: round;
    stroke-linecap: round;
  }
  .sparkline .line.secondary {
    stroke: var(--success);
    stroke-width: 1.1;
  }
  .sparkline .area {
    fill: var(--accent-100);
    opacity: 0.7;
  }
`;
