#!/usr/bin/env node
/**
 * Scene image helper.
 *
 * Prints the prompts the pipeline already wrote for each scene, and uploads
 * hand-made images back into those scenes. Use it when you generate visuals
 * yourself (Gemini app, Midjourney, museum scans) instead of paying for the
 * image provider.
 *
 *   node scripts/scenes.js list
 *   node scripts/scenes.js prompts <productionId> [--out prompts.txt]
 *   node scripts/scenes.js upload  <productionId> <imageDir> [--real] [--no-rebuild]
 *
 * Images are matched to scenes by filename order, so name them 01.png, 02.png,
 * and so on. Run `prompts` first to see how many scenes need a picture.
 */

const fs = require('fs');
const path = require('path');

try {
  require('dotenv').config();
} catch {
  // dotenv is optional here; fall back to the manual parse below.
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
const API_KEY = process.env.API_KEY || fileEnv.API_KEY || '';
const PORT = process.env.PORT || fileEnv.PORT || 3456;
const BASE = `http://localhost:${PORT}`;

const CONTENT_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp'
};

function headers(extra = {}) {
  return API_KEY ? { 'x-api-key': API_KEY, ...extra } : { ...extra };
}

async function request(url, options = {}) {
  let response;
  try {
    response = await fetch(url, options);
  } catch (error) {
    throw new Error(
      `Could not reach the agent at ${BASE}. Start it with "npm start" in another terminal, then run this command again. (${error.message})`
    );
  }
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  if (!response.ok) {
    const detail = body.error || body.raw || response.statusText;
    throw new Error(`${url} returned ${response.status}: ${detail}`);
  }
  return body;
}

async function fetchBundle(productionId) {
  const bundle = await request(`${BASE}/api/content/${encodeURIComponent(productionId)}`);
  const scenes = bundle.scenes || [];
  if (!scenes.length) {
    throw new Error(
      `Production ${productionId} has no scenes yet. Let the generation job finish the production stage, then run this command again.`
    );
  }
  scenes.sort((a, b) => Number(a.position) - Number(b.position));
  return { bundle, scenes };
}

async function commandList() {
  const dashboard = await request(`${BASE}/api/dashboard`);
  const rows = dashboard.pipeline || dashboard.result?.pipeline || [];
  if (!rows.length) {
    console.log('No productions yet. Create one from the dashboard or with POST /generate, then run this again.');
    return;
  }
  console.log(`Recent productions (${rows.length}):\n`);
  for (const row of rows.slice(0, 25)) {
    const id = row.id || row.productionId || row.production_id || '(no id)';
    const title = row.title || row.topic || '(untitled)';
    const status = row.status || row.reviewStatus || row.review_status || '-';
    console.log(`  ${String(id).padEnd(28)} ${String(status).padEnd(16)} ${String(title).slice(0, 70)}`);
  }
  console.log('\nUse: node scripts/scenes.js prompts <productionId>');
}

async function commandPrompts(productionId, options) {
  const { bundle, scenes } = await fetchBundle(productionId);
  const lines = [];
  lines.push(`# ${bundle.title || bundle.topic || productionId}`);
  lines.push(`# ${scenes.length} scenes — save your images as 01, 02, ... in one folder, in this order.`);
  lines.push('');

  scenes.forEach((scene, index) => {
    const number = String(index + 1).padStart(2, '0');
    const seconds = Number(scene.duration || 0).toFixed(1);
    lines.push(`## ${number} — ${scene.label || 'Scene'}  (${seconds}s, status: ${scene.status})`);
    lines.push(scene.prompt || '(this scene has no prompt; write one from the script text)');
    lines.push('');
  });

  const text = lines.join('\n');
  if (options.out) {
    fs.writeFileSync(options.out, text, 'utf8');
    console.log(`Wrote ${scenes.length} prompts to ${options.out}.`);
  } else {
    console.log(text);
  }
  console.log(`Next: node scripts/scenes.js upload ${productionId} <imageDir>`);
}

async function commandUpload(productionId, imageDir, options) {
  if (!fs.existsSync(imageDir) || !fs.statSync(imageDir).isDirectory()) {
    throw new Error(`${imageDir} is not a folder. Point this at the directory holding your images.`);
  }

  const files = fs
    .readdirSync(imageDir)
    .filter(name => CONTENT_TYPES[path.extname(name).toLowerCase()])
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));

  if (!files.length) {
    throw new Error(`No .png, .jpg or .webp files found in ${imageDir}.`);
  }

  const { scenes } = await fetchBundle(productionId);

  console.log(`${scenes.length} scenes, ${files.length} images.`);
  if (files.length !== scenes.length) {
    console.log(
      files.length < scenes.length
        ? `Only the first ${files.length} scenes will be replaced; the rest keep what they have.`
        : `Only the first ${scenes.length} images will be used; the extras are ignored.`
    );
  }
  console.log(
    options.real
      ? 'Marking these as real footage (x-synthetic-media: false). Record the source in provenance before approval.'
      : 'Marking these as AI-generated (x-synthetic-media: true).'
  );
  console.log('');

  const count = Math.min(files.length, scenes.length);
  let uploaded = 0;

  for (let index = 0; index < count; index += 1) {
    const scene = scenes[index];
    const file = files[index];
    const full = path.join(imageDir, file);
    const contentType = CONTENT_TYPES[path.extname(file).toLowerCase()];
    const buffer = fs.readFileSync(full);
    const label = `${String(index + 1).padStart(2, '0')} ${String(scene.label || 'Scene').slice(0, 28).padEnd(28)}`;

    try {
      await request(`${BASE}/api/content/${encodeURIComponent(productionId)}/scenes/${encodeURIComponent(scene.id)}/asset`, {
        method: 'PUT',
        headers: headers({
          'content-type': contentType,
          'x-file-name': file,
          'x-rights-confirmed': 'true',
          'x-synthetic-media': options.real ? 'false' : 'true'
        }),
        body: buffer
      });
      uploaded += 1;
      console.log(`  ok   ${label} <- ${file} (${(buffer.length / 1024).toFixed(0)} KB)`);
    } catch (error) {
      console.log(`  FAIL ${label} <- ${file}`);
      console.log(`       ${error.message}`);
    }
  }

  console.log(`\nUploaded ${uploaded} of ${count} images.`);

  if (uploaded && options.rebuild) {
    console.log('Rebuilding scenes...');
    await request(`${BASE}/api/content/${encodeURIComponent(productionId)}/scenes/rebuild`, {
      method: 'POST',
      headers: headers({ 'content-type': 'application/json' }),
      body: '{}'
    });
    console.log('Rebuild finished.');
  }

  console.log('\nReplacing scene assets cleared the factual-review and media-rights ticks for this production.');
  console.log('Re-confirm both in the dashboard before approving, or the approve call will fail with 409.');
}

function parseFlags(argv) {
  const options = { rebuild: true, real: false, out: null };
  const rest = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--no-rebuild') options.rebuild = false;
    else if (arg === '--real') options.real = true;
    else if (arg === '--out') options.out = argv[++index];
    else rest.push(arg);
  }
  return { options, rest };
}

function usage() {
  console.log(`Scene image helper

  node scripts/scenes.js list
  node scripts/scenes.js prompts <productionId> [--out prompts.txt]
  node scripts/scenes.js upload  <productionId> <imageDir> [--real] [--no-rebuild]

Images are matched to scenes by filename order, so name them 01.png, 02.png, ...
Use --real for footage you did not generate with AI, such as museum scans or
public-domain artwork; record its source in provenance before you approve.`);
}

(async () => {
  const [command, ...argv] = process.argv.slice(2);
  const { options, rest } = parseFlags(argv);

  try {
    if (command === 'list') {
      await commandList();
    } else if (command === 'prompts') {
      if (!rest[0]) throw new Error('Pass a production id: node scripts/scenes.js prompts <productionId>');
      await commandPrompts(rest[0], options);
    } else if (command === 'upload') {
      if (!rest[0] || !rest[1]) throw new Error('Pass a production id and an image folder: node scripts/scenes.js upload <productionId> <imageDir>');
      await commandUpload(rest[0], rest[1], options);
    } else {
      usage();
      process.exit(command ? 1 : 0);
    }
  } catch (error) {
    console.error(`\n${error.message}`);
    process.exit(1);
  }
})();
