#!/usr/bin/env node
/**
 * Rebuild a finished video from its scene manifest, outside the pipeline.
 *
 *   node scripts/rebuild-video.js <productionId> [output.mp4]
 *
 * Scene repair is locked once content is approved or scheduled, by design, so
 * this is the way to correct a video that has already gone out: it reads the
 * scenes straight from the API, re-times every scene to the narration that
 * actually exists on disk, levels the takes against each other, and reassembles.
 *
 * Two things it fixes that the pipeline does not:
 *   - Scene durations come from a word-count estimate, so a scene whose take
 *     runs short holds a still image over silence. Here each scene is timed to
 *     its own audio.
 *   - Text-to-speech drifts in level between takes, badly enough that some
 *     scenes are hard to hear next to their neighbours. Each take is normalised
 *     to a common loudness before the scenes are joined.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { AIVideoGenerator } = require(path.join(ROOT, 'utils/ai-video-generator'));
const { runFFmpeg } = require(path.join(ROOT, 'utils/ffmpeg'));

// Each scene is levelled here; the finished mix is normalised again for YouTube.
const SCENE_TARGET_LUFS = -16;
const TAIL_PADDING_SECONDS = 0.6;

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
for (const key of ['BACKGROUND_MUSIC_PATH', 'BACKGROUND_MUSIC_GAIN_DB', 'PORT']) {
  if (!process.env[key] && fileEnv[key]) process.env[key] = fileEnv[key];
}

async function probeDuration(file) {
  const { stderr } = await runFFmpeg(['-hide_banner', '-i', file]).catch(error => ({ stderr: String(error.stderr || error.message || '') }));
  const match = String(stderr || '').match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
  if (!match) return null;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + parseFloat(match[3]);
}

function latestTake(dir, position) {
  const prefix = String(position).padStart(3, '0') + '_r';
  if (!fs.existsSync(dir)) return null;
  const takes = fs.readdirSync(dir)
    .filter(name => name.startsWith(prefix))
    .sort((a, b) => Number((a.match(/_r(\d+)/) || [])[1] || 0) - Number((b.match(/_r(\d+)/) || [])[1] || 0));
  return takes.length ? path.join(dir, takes[takes.length - 1]) : null;
}

(async () => {
  const productionId = process.argv[2];
  if (!productionId) {
    console.log('Usage: node scripts/rebuild-video.js <productionId> [output.mp4]');
    process.exit(1);
  }
  const port = process.env.PORT || 3456;
  const bundle = await (await fetch(`http://localhost:${port}/api/content/${productionId}`)).json();
  if (!bundle || !bundle.scenes || !bundle.scenes.length) {
    console.error(`\nNo scenes found for ${productionId}. Is the agent running on port ${port}?`);
    process.exit(1);
  }
  const scenes = bundle.scenes.slice().sort((a, b) => a.position - b.position);
  const audioDir = path.join(ROOT, 'data/audio/scenes', productionId);
  const work = fs.mkdtempSync(path.join(require('os').tmpdir(), 'rebuild-'));
  const output = process.argv[3] || path.join(ROOT, 'data/videos', `${productionId}_manual_${Date.now()}.mp4`);

  try {
    console.log(`${scenes.length} scenes\n`);
    const segments = [];
    const levelled = [];

    for (const scene of scenes) {
      const take = latestTake(audioDir, scene.position);
      if (!take) throw new Error(`Scene ${scene.position + 1} has no narration on disk`);
      if (!scene.assetPath || !fs.existsSync(scene.assetPath)) {
        throw new Error(`Scene ${scene.position + 1} has no image on disk`);
      }
      const spoken = await probeDuration(take);
      if (!spoken) throw new Error(`Could not read the duration of ${path.basename(take)}`);
      const duration = Number((spoken + TAIL_PADDING_SECONDS).toFixed(2));

      // Level this take against its neighbours before anything is joined.
      const evened = path.join(work, `${String(scene.position).padStart(3, '0')}.wav`);
      await runFFmpeg([
        '-y', '-loglevel', 'error', '-i', take,
        '-af', `loudnorm=I=${SCENE_TARGET_LUFS}:TP=-2:LRA=11,apad=pad_dur=${TAIL_PADDING_SECONDS},atrim=duration=${duration},aformat=sample_fmts=s16:sample_rates=48000:channel_layouts=mono`,
        evened
      ]);

      segments.push({ type: 'image', path: scene.assetPath, duration });
      levelled.push(evened);
      console.log(`  ${String(scene.position + 1).padStart(2)}. ${String(scene.label || '').slice(0, 38).padEnd(40)} ${String(scene.duration).padStart(6)}s -> ${String(duration).padStart(6)}s  (${path.basename(take)})`);
    }

    const total = segments.reduce((sum, segment) => sum + segment.duration, 0);
    console.log(`\nTotal ${Math.floor(total / 60)}:${String(Math.round(total % 60)).padStart(2, '0')}\n`);

    const narration = path.join(work, 'narration.wav');
    const concatArgs = ['-y', '-loglevel', 'error'];
    levelled.forEach(file => concatArgs.push('-i', file));
    concatArgs.push('-filter_complex', `${levelled.map((_, index) => `[${index}:a]`).join('')}concat=n=${levelled.length}:v=0:a=1[out]`, '-map', '[out]', narration);
    await runFFmpeg(concatArgs);

    const generator = new AIVideoGenerator({});
    generator.logger.warn = () => {};
    generator.logger.info = message => console.log(`  ${message}`);

    const visual = path.join(work, 'visual.mp4');
    console.log('Rendering the picture...');
    await generator.renderMediaTimeline(segments, visual);
    console.log('Mixing audio...');
    await generator.addAudioToVideo(visual, narration, output);

    const { stderr } = await runFFmpeg(['-hide_banner', '-i', output, '-af', 'loudnorm=I=-14:print_format=summary', '-f', 'null', '-']);
    const text = String(stderr || '');
    console.log('');
    console.log(`Wrote ${output}`);
    console.log(`  ${(text.match(/Input Integrated:\s*-?[\d.]+ LUFS/) || [''])[0]}`);
    console.log(`  ${(text.match(/Input True Peak:\s*-?[\d.]+ dBTP/) || [''])[0]}`);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(`\n${error.message}`);
  process.exit(1);
});
