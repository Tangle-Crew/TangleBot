const { createCanvas } = require('@napi-rs/canvas');
const { metricUnit, formatAmount } = require('./womMetrics');

const WIDTH = 1000;
const HEIGHT = 560;
const PADDING = { top: 70, right: 40, bottom: 60, left: 80 };
const BACKGROUND = '#1e1f22';
const PLOT_BACKGROUND = '#2b2d31';
const GRID = 'rgba(255,255,255,0.08)';
const AXIS_TEXT = '#b5bac1';
const TITLE_TEXT = '#f2f3f5';
const TOTAL_COLOR = 'rgba(255,255,255,0.85)';
// One per top-5 player, in rank order.
const PLAYER_COLORS = ['#f0b232', '#5865f2', '#3ba55d', '#eb459e', '#00b0f4'];
const TICKS = 5;
// The title's and value axis's label for each metricUnit.
const AXIS_LABELS = { kc: 'KC gained', xp: 'XP gained', score: 'Score gained' };

// Axis labels: "250k", "1.2m".
function shortNumber(value) {
  const units = [[1e9, 'b'], [1e6, 'm'], [1e3, 'k']];
  for (const [size, suffix] of units) {
    if (Math.abs(value) >= size) return `${(value / size).toLocaleString('en-US', { maximumFractionDigits: 1 })}${suffix}`;
  }
  return value.toLocaleString('en-US', { maximumFractionDigits: 1 });
}

// A round axis maximum at or above max, split into TICKS steps (1, 2, 2.5 or 5 times a power of 10).
function niceMax(max) {
  if (max <= 0) return TICKS;
  const rough = max / TICKS;
  const power = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map(f => f * power).find(s => s >= rough);
  return step * TICKS;
}

// "Oct 10" in Eastern Time, as the competition times are set.
const dateLabel = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric' });

function drawLine(ctx, points, color, { width = 3, dashed = false } = {}) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineJoin = 'round';
  if (dashed) ctx.setLineDash([10, 7]);
  ctx.beginPath();
  points.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
  ctx.stroke();
  ctx.restore();
  if (dashed) return;
  ctx.fillStyle = color;
  for (const [x, y] of points) {
    ctx.beginPath();
    ctx.arc(x, y, 3.5, 0, 2 * Math.PI);
    ctx.fill();
  }
}

// data from loadChartData in weeklyAnnounce.js. Returns a PNG buffer.
function renderProgressChart(data) {
  const { title, metric, marks, players, total } = data;
  // Values are gains since the start, not lifetime totals, and the labels say so.
  const label = AXIS_LABELS[metricUnit(metric)] ?? 'Gains';
  const gained = amount => `+${formatAmount(amount, metric)}`;
  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext('2d');

  const plot = {
    left: PADDING.left,
    top: PADDING.top,
    width: WIDTH - PADDING.left - PADDING.right,
    height: HEIGHT - PADDING.top - PADDING.bottom,
  };
  // One scale for the players and the clan total, so the total (everyone's gains added up) is
  // always the highest line.
  const max = niceMax(Math.max(...total, ...players.flatMap(p => p.values)));
  const span = Math.max(marks[marks.length - 1] - marks[0], 1);
  const x = t => plot.left + ((t - marks[0]) / span) * plot.width;
  const y = v => plot.top + plot.height - (v / max) * plot.height;

  ctx.fillStyle = BACKGROUND;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  ctx.fillStyle = PLOT_BACKGROUND;
  ctx.fillRect(plot.left, plot.top, plot.width, plot.height);

  ctx.fillStyle = TITLE_TEXT;
  ctx.font = 'bold 24px sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(`${title} — ${label}`, PADDING.left, 32);

  ctx.font = '14px sans-serif';
  for (let i = 0; i <= TICKS; i++) {
    const tickY = plot.top + plot.height - (i / TICKS) * plot.height;
    ctx.strokeStyle = GRID;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(plot.left, tickY);
    ctx.lineTo(plot.left + plot.width, tickY);
    ctx.stroke();
    ctx.fillStyle = AXIS_TEXT;
    ctx.textAlign = 'right';
    ctx.fillText(shortNumber((max / TICKS) * i), plot.left - 10, tickY);
  }

  ctx.save();
  ctx.fillStyle = AXIS_TEXT;
  ctx.textAlign = 'center';
  ctx.translate(22, plot.top + plot.height / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText(label, 0, 0);
  ctx.restore();

  ctx.fillStyle = AXIS_TEXT;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (const t of marks) ctx.fillText(dateLabel.format(new Date(t)), x(t), plot.top + plot.height + 10);

  drawLine(ctx, marks.map((t, i) => [x(t), y(total[i])]), TOTAL_COLOR, { width: 2, dashed: true });
  // Drawn lowest rank first, so 1st place ends up on top.
  [...players].reverse().forEach((player, r) => {
    const color = PLAYER_COLORS[players.length - 1 - r];
    drawLine(ctx, marks.map((t, i) => [x(t), y(player.values[i])]), color);
  });

  // Legend, top left inside the plot.
  const entries = [
    ...players.map((p, i) => ({ label: `${p.name} — ${gained(p.final)}`, color: PLAYER_COLORS[i] })),
    { label: `Clan total — ${gained(total[total.length - 1])}`, color: TOTAL_COLOR, dashed: true },
  ];
  ctx.font = '15px sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const legendWidth = Math.max(...entries.map(e => ctx.measureText(e.label).width)) + 52;
  const legendHeight = entries.length * 24 + 12;
  ctx.fillStyle = 'rgba(30,31,34,0.85)';
  ctx.fillRect(plot.left + 12, plot.top + 12, legendWidth, legendHeight);
  entries.forEach((entry, i) => {
    const rowY = plot.top + 30 + i * 24;
    drawLine(ctx, [[plot.left + 24, rowY], [plot.left + 48, rowY]], entry.color, { width: 3, dashed: entry.dashed });
    ctx.fillStyle = TITLE_TEXT;
    ctx.fillText(entry.label, plot.left + 58, rowY);
  });

  return canvas.toBuffer('image/png');
}

// "<metric>-progress.png", e.g. "amoxliatl-progress.png".
function chartFileName(metric) {
  return `${String(metric).replace(/[^a-z0-9_-]/gi, '_')}-progress.png`;
}

module.exports = { renderProgressChart, chartFileName };
