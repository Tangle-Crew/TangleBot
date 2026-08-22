const { SlashCommandBuilder, EmbedBuilder, AttachmentBuilder, MessageFlags } = require('discord.js');
const { createCanvas } = require('@napi-rs/canvas');
const GIFEncoder = require('gif-encoder-2');

const COORDINATOR_ROLE_ID = process.env.COORDINATOR_ROLE_ID;

const DISCORD_GREEN  = 0x1a5c2e;
const DISCORD_PURPLE = 0x4a235a;

// GIF timing constants (must match createSpinGif frame counts / delays)
const SPIN_FRAMES    = 72;
const SPIN_MS        = 50;
const FLASH_FRAMES   = 10;
const FLASH_MS       = 100;
const HOLD_FRAMES    = 5;
const HOLD_MS        = 500;
// Total GIF play time + buffer for Discord upload latency
const GIF_TOTAL_MS   = SPIN_FRAMES * SPIN_MS + FLASH_FRAMES * FLASH_MS + HOLD_FRAMES * HOLD_MS + 800;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Alternating dark purple / dark green for every slice pair
const SLICE_COLORS = ['#3a0e54', '#0d3320'];
const WINNER_COLOR  = '#c8960c';  // dark gold for winner highlight
const SILVER_RING   = '#b0b0bc';
const SILVER_SPOKE  = '#c8c8d4';
const SILVER_HUB    = '#d0d0dc';

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Expand entries, supporting numeric ranges like "1-10" mixed with plain tokens
function parseEntries(raw) {
  const out = [];
  for (const token of raw.split(',').map(s => s.trim()).filter(Boolean)) {
    const m = token.match(/^(\d+)-(\d+)$/);
    if (m) {
      const a = parseInt(m[1], 10), b = parseInt(m[2], 10);
      const step = a <= b ? 1 : -1;
      for (let n = a; step > 0 ? n <= b : n >= b; n += step) out.push(String(n));
    } else {
      out.push(token);
    }
  }
  return out;
}

// ── Wheel frame renderer ───────────────────────────────────────────────────────
// rotationAngle: float radians — slice i midpoint is at (i * sliceAngle - rotationAngle)
// flash: highlight whichever slice is currently at the pointer (angle 0, right side)
function drawWheelFrame(ctx, SIZE, entries, rotationAngle, flash) {
  const N          = entries.length;
  const sliceAngle = (2 * Math.PI) / N;
  const cx         = SIZE / 2;
  const cy         = SIZE / 2;
  const outerR     = Math.round(SIZE * 0.415);
  const innerR     = Math.round(SIZE * 0.11);

  // Background
  ctx.fillStyle = '#12121e';
  ctx.fillRect(0, 0, SIZE, SIZE);

  // Metallic border ring (layered circles for bevel effect)
  for (const [r, c] of [[outerR + 7, '#7a7a88'], [outerR + 5, '#d4d4e0'], [outerR + 2, '#5a5a68']]) {
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, 2 * Math.PI);
    ctx.fillStyle = c;
    ctx.fill();
  }

  // Which slice is at the pointer when flashing
  let winnerSlice = -1;
  if (flash) {
    winnerSlice = ((Math.round(rotationAngle / sliceAngle) % N) + N) % N;
  }

  // Slices
  for (let i = 0; i < N; i++) {
    const mid   = i * sliceAngle - rotationAngle;
    const start = mid - sliceAngle / 2;
    const end   = mid + sliceAngle / 2;

    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, outerR, start, end);
    ctx.closePath();
    ctx.fillStyle = (flash && i === winnerSlice) ? WINNER_COLOR : SLICE_COLORS[i % 2];
    ctx.fill();
  }

  // Metallic spoke lines (at each slice boundary)
  ctx.lineCap = 'round';
  for (let i = 0; i < N; i++) {
    const angle = (i + 0.5) * sliceAngle - rotationAngle;
    const x2    = cx + outerR * Math.cos(angle);
    const y2    = cy + outerR * Math.sin(angle);

    // Shadow spoke
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(x2, y2);
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.lineWidth = 3.5;
    ctx.stroke();

    // Silver spoke
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(x2, y2);
    ctx.strokeStyle = SILVER_SPOKE;
    ctx.lineWidth = 2;
    ctx.stroke();

    // Bright centre highlight on spoke
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(x2, y2);
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 0.6;
    ctx.stroke();
  }
  ctx.lineCap = 'butt';

  // Text labels — dynamic size: fills the arc height, scales down if too wide for the spoke
  const textR      = Math.round((innerR + outerR) / 2);
  const radialMax  = (outerR - innerR) * 0.80;
  const arcHeight  = 2 * textR * Math.sin(sliceAngle / 2);
  const maxSize    = Math.min(Math.floor(arcHeight * 0.72), Math.round(SIZE * 0.09));

  for (let i = 0; i < N; i++) {
    const mid   = i * sliceAngle - rotationAngle;
    const label = entries[i].trim().slice(0, 16);
    const left  = Math.cos(mid) < 0;

    // Shrink font until the label fits along the radial axis
    let fs = Math.max(maxSize, 7);
    ctx.font = `bold ${fs}px sans-serif`;
    while (fs > 7 && ctx.measureText(label).width > radialMax) {
      fs--;
      ctx.font = `bold ${fs}px sans-serif`;
    }

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(mid);
    if (left) ctx.rotate(Math.PI);
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor  = 'rgba(0,0,0,0.95)';
    ctx.shadowBlur   = 4;
    ctx.fillStyle    = 'white';
    ctx.fillText(label, left ? -textR : textR, 0);
    ctx.restore();
  }

  // Hub shadow
  ctx.beginPath();
  ctx.arc(cx, cy, innerR + 4, 0, 2 * Math.PI);
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fill();

  // Hub — metallic silver
  ctx.beginPath();
  ctx.arc(cx, cy, innerR, 0, 2 * Math.PI);
  ctx.fillStyle = SILVER_HUB;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(cx, cy, innerR, 0, 2 * Math.PI);
  ctx.strokeStyle = '#888898';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Hub centre pin
  ctx.beginPath();
  ctx.arc(cx, cy, 5, 0, 2 * Math.PI);
  ctx.fillStyle = '#555560';
  ctx.fill();

  // Pointer triangle (right side, tip touching border ring)
  const tipX = cx + outerR + 7;
  ctx.beginPath();
  ctx.moveTo(tipX,      cy);
  ctx.lineTo(tipX + 22, cy - 13);
  ctx.lineTo(tipX + 22, cy + 13);
  ctx.closePath();
  ctx.fillStyle   = flash ? '#ffd700' : SILVER_RING;
  ctx.fill();
  ctx.strokeStyle = '#333340';
  ctx.lineWidth   = 1;
  ctx.stroke();
}

// ── GIF generator ──────────────────────────────────────────────────────────────
function createSpinGif(entries, winnerIdx) {
  const SIZE       = 400;
  const N          = entries.length;
  const sliceAngle = (2 * Math.PI) / N;

  const theta0      = Math.random() * 2 * Math.PI;
  const winnerAngle = winnerIdx * sliceAngle;

  // 8 full rotations + land exactly on winner
  let thetaFinal = theta0 + 8 * 2 * Math.PI;
  thetaFinal += ((winnerAngle - thetaFinal) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);

  const easeOut = t => 1 - Math.pow(1 - t, 5);

  const canvas  = createCanvas(SIZE, SIZE);
  const ctx     = canvas.getContext('2d');
  const encoder = new GIFEncoder(SIZE, SIZE, 'neuquant', true);
  encoder.setRepeat(-1); // play once
  encoder.start();

  // Spin phase
  encoder.setDelay(SPIN_MS);
  for (let f = 0; f < SPIN_FRAMES; f++) {
    const t     = f / (SPIN_FRAMES - 1);
    const theta = theta0 + (thetaFinal - theta0) * easeOut(t);
    drawWheelFrame(ctx, SIZE, entries, theta, false);
    encoder.addFrame(ctx.getImageData(0, 0, SIZE, SIZE).data);
  }

  // Flash phase — alternating highlight on/off
  for (let b = 0; b < FLASH_FRAMES; b++) {
    encoder.setDelay(FLASH_MS);
    drawWheelFrame(ctx, SIZE, entries, thetaFinal, b % 2 === 0);
    encoder.addFrame(ctx.getImageData(0, 0, SIZE, SIZE).data);
  }

  // Hold phase — winner visible, GIF pauses here since it plays once
  encoder.setDelay(HOLD_MS);
  drawWheelFrame(ctx, SIZE, entries, thetaFinal, true);
  for (let h = 0; h < HOLD_FRAMES; h++) {
    encoder.addFrame(ctx.getImageData(0, 0, SIZE, SIZE).data);
  }

  encoder.finish();
  return encoder.out.getData();
}

// ── Discord command ─────────────────────────────────────────────────────────────
module.exports = {
  data: new SlashCommandBuilder()
    .setName('spinwheel')
    .setDescription('Spin a prize wheel and pick a random winner')
    .addStringOption(o =>
      o.setName('entries')
        .setDescription('Comma-separated entries or ranges, e.g. Alice,Bob,1-10')
        .setRequired(true)
    )
    .addStringOption(o =>
      o.setName('title')
        .setDescription('Label for the wheel (default: "Wheel Spin")')
    )
    .addIntegerOption(o =>
      o.setName('winners')
        .setDescription('How many winners to pick (default: 1)')
        .setMinValue(1)
        .setMaxValue(10)
    )
    .addStringOption(o =>
      o.setName('message')
        .setDescription('Win message — use {winner} as placeholder (default: "Winner is {winner}")')
    )
    .addBooleanOption(o =>
      o.setName('shuffle')
        .setDescription('Shuffle the entry order before spinning (default: false)')
    )
    .addStringOption(o =>
      o.setName('ping')
        .setDescription('Ping included with the winner announcement (optional)')
        .addChoices(
          { name: '@here',     value: '@here'     },
          { name: '@everyone', value: '@everyone' },
        )
    ),

  async execute(interaction) {
    if (!interaction.member.roles.cache.has(COORDINATOR_ROLE_ID)) {
      return interaction.reply({ content: 'You need the Coordinator role to use this command.', flags: MessageFlags.Ephemeral });
    }

    await interaction.deferReply();

    console.log(`[spinwheel] Started by ${interaction.user.tag}`);

    const raw       = interaction.options.getString('entries');
    const title     = interaction.options.getString('title') ?? 'Wheel Spin';
    const numWin    = interaction.options.getInteger('winners') ?? 1;
    const msgTpl    = interaction.options.getString('message') ?? 'Winner is {winner}';
    const doShuffle = interaction.options.getBoolean('shuffle') ?? false;
    const ping      = interaction.options.getString('ping') ?? '';

    let entries = parseEntries(raw);

    if (entries.length < 2) {
      return interaction.editReply({ content: 'You need at least 2 entries to spin the wheel.' });
    }

    if (entries.length > 50) {
      return interaction.editReply({ content: `Too many entries (${entries.length}). Maximum is 50.` });
    }

    if (numWin >= entries.length) {
      return interaction.editReply({
        content: `You asked for ${numWin} winner(s) but only provided ${entries.length} entries.`,
      });
    }

    if (doShuffle) entries = shuffle(entries);

    // Pre-pick winner(s)
    const pool    = [...entries];
    const winners = [];
    for (let i = 0; i < numWin; i++) {
      const idx = Math.floor(Math.random() * pool.length);
      winners.push(pool.splice(idx, 1)[0]);
    }
    console.log(`[spinwheel] ${entries.length} entries → Winner(s): ${winners.join(', ')}`);

    const winnerIdx = entries.indexOf(winners[0]);
    const gifBuf    = createSpinGif(entries, winnerIdx);
    const file      = new AttachmentBuilder(gifBuf, { name: 'wheel.gif' });

    // Step 1 — send the spinning wheel GIF (no result yet)
    const spinEmbed = new EmbedBuilder()
      .setColor(DISCORD_PURPLE)
      .setTitle(`🎡 ${title}`)
      .setImage('attachment://wheel.gif');

    await interaction.editReply({ embeds: [spinEmbed], files: [file] });

    // Step 2 — wait for the GIF to finish playing
    await sleep(GIF_TOTAL_MS);

    // Step 3 — edit the same message to reveal the winner
    // (Discord keeps the existing attachment when no files are included in the edit)
    const isSingle = winners.length === 1;
    const winText  = winners
      .map((w, i) => {
        const msg = msgTpl.replace(/\{winner\}/gi, `**${w}**`);
        return `🏆 ${isSingle ? '' : `#${i + 1}: `}${msg}`;
      })
      .join('\n');

    const resultEmbed = new EmbedBuilder()
      .setColor(DISCORD_GREEN)
      .setTitle(`🎡 ${title} — Result`)
      .setImage('attachment://wheel.gif')
      .setDescription(winText)
      .addFields({
        name:  `All ${entries.length} entries`,
        value: entries.map(e => winners.includes(e) ? `**${e}**` : e).join(', '),
      })
      .setFooter({ text: `Spun by ${interaction.user.username}` })
      .setTimestamp();

    await interaction.editReply({ embeds: [resultEmbed] });

    // Step 4 — Discord only sends @here / @everyone notifications on NEW messages, not edits.
    // Send a minimal follow-up that contains only the ping so notifications fire.
    if (ping) {
      await interaction.followUp({
        content:         ping,
        allowedMentions: { parse: ['everyone'] },
      });
    }
  },
};
