#!/usr/bin/env node
/**
 * Re-mux a finished video's audio: normalise the narration to broadcast
 * loudness and lay the configured music bed underneath it.
 *
 *   node scripts/remix-audio.js <input.mp4> [output.mp4]
 *
 * Use this for a production whose scene repair is already locked — approved or
 * scheduled content cannot be rebuilt through the pipeline, by design. For any
 * new video the same treatment is applied automatically during assembly, so
 * this script is only needed to correct something already published.
 *
 * Reads BACKGROUND_MUSIC_PATH and BACKGROUND_MUSIC_GAIN_DB from .env. With no
 * music configured it still normalises the narration.
 */

const fs = require('fs');
const path = require('path');

try {
  require('dotenv').config();
} catch {
  // Optional; the manual parse below covers a bare checkout.
}

const ROOT = path.join(__dirname, '..');

function readEnvFile() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (match) out[match[1]] = match[2].trim();
  }
  return out;
}

const fileEnv = readEnvFile();
for (const key of ['BACKGROUND_MUSIC_PATH', 'BACKGROUND_MUSIC_GAIN_DB']) {
  if (!process.env[key] && fileEnv[key]) process.env[key] = fileEnv[key];
}

const { AIVideoGenerator } = require(path.join(ROOT, 'utils/ai-video-generator'));
const { runFFmpeg, getFFmpegPath } = require(path.join(ROOT, 'utils/ffmpeg'));

async function measure(file) {
  const { stderr } = await runFFmpeg(['-hide_banner', '-i', file, '-af', 'loudnorm=I=-14:print_format=summary', '-f', 'null', '-']);
  const text = String(stderr || '');
  const lufs = (text.match(/Input Integrated:\s*(-?[\d.]+)/) || [])[1];
  const peak = (text.match(/Input True Peak:\s*(-?[\d.]+)/) || [])[1];
  return { lufs, peak };
}

(async () => {
  const input = process.argv[2];
  if (!input) {
    console.log('Usage: node scripts/remix-audio.js <input.mp4> [output.mp4]');
    process.exit(1);
  }
  if (!fs.existsSync(input)) {
    console.error(`\n${input} does not exist.`);
    process.exit(1);
  }
  const output = process.argv[3] || input.replace(/\.mp4$/i, '_remixed.mp4');

  const generator = new AIVideoGenerator({});
  generator.logger.warn = () => {};
  generator.logger.info = message => console.log(`  ${message}`);

  const music = await generator.resolveBackgroundMusic();
  console.log(`Input : ${path.basename(input)}`);
  console.log(`Music : ${music || 'none configured — narration will only be normalised'}`);
  if (music) console.log(`Gain  : ${process.env.BACKGROUND_MUSIC_GAIN_DB || -22} dB`);
  console.log('');

  const before = await measure(input);
  console.log(`Before: ${before.lufs} LUFS, true peak ${before.peak} dBTP`);

  // FFmpeg cannot read and write the same file, so the narration is extracted
  // first and then remixed against the untouched video stream.
  const temp = output.replace(/\.mp4$/i, '.narration.m4a');
  await runFFmpeg(['-y', '-loglevel', 'error', '-i', input, '-vn', '-c:a', 'aac', '-b:a', '192k', temp]);
  try {
    await generator.addAudioToVideo(input, temp, output);
  } finally {
    fs.rmSync(temp, { force: true });
  }

  const after = await measure(output);
  console.log(`After : ${after.lufs} LUFS, true peak ${after.peak} dBTP`);
  console.log('');
  console.log(`Wrote ${output}`);
  console.log('Target is -14 LUFS with the true peak below -1 dBTP. A peak above 0 means the audio clips.');
  console.log(`FFmpeg: ${getFFmpegPath()}`);
})().catch(error => {
  console.error(`\n${error.message}`);
  process.exit(1);
});
