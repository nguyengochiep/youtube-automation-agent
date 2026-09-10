#!/usr/bin/env node
/**
 * Build a YouTube description from what the production actually contains.
 *
 *   node scripts/description.js <productionId> [--out description.txt]
 *                               [--max-chapters 8] [--include-pending]
 *
 * The SEO agent writes chapter timestamps on a fixed grid before any narration
 * exists, so they do not line up with the finished video — on the first
 * published video the last chapter sat 29 seconds past the end of the file.
 * Timestamps here are accumulated from the durations on the scene manifest,
 * which the pipeline fits to the narration that actually got recorded, so they
 * match what a viewer hears.
 *
 * It also assembles the parts that were being pasted in by hand every time:
 * the sources block from provenance (verified sources only, unless you pass
 * --include-pending), the music credit, the AI-narration disclosure, and
 * hashtags cleaned up from the SEO tags.
 *
 * Nothing is written back to the production. Read the output, edit the lead
 * line if it needs it, then paste it into YouTube Studio.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// Edit these once for the channel; they are the same on every video.
const CHANNEL_PROMISE = 'Southeast Asian history and mythology, sourced from Vietnamese-language records most English channels cannot read. Every claim links to where it came from.';
const AI_DISCLOSURE = 'Narration in this video is AI-generated. Research, scripting, sourcing and editorial decisions are human.';
const SOURCES_NOTE = 'Every date and quotation above can be checked against these.';

// YouTube ignores a chapter list unless the first one is at 0:00, there are at
// least three of them, and each runs 10 seconds or longer.
const MIN_CHAPTERS = 3;
const MIN_CHAPTER_SECONDS = 10;
const DEFAULT_MAX_CHAPTERS = 8;

// The first ~150 characters are all a viewer sees before "Show more".
const LEAD_LIMIT = 150;
const DESCRIPTION_LIMIT = 5000;
const MAX_HASHTAGS = 3;

// Scene labels the pipeline writes for structure, not for viewers.
const MERGE_FORWARD = new Set(['hook']);
const MERGE_BACKWARD = new Set(['call to action', 'call-to-action', 'outro']);

// Tags that say nothing about the video.
const JUNK_TAGS = new Set([
  'youtube', 'youtuber', 'subscribe', 'video', 'videos', 'shorts', 'viral',
  'trending', 'explained', 'story', 'guide', 'tutorial', 'documentary'
]);

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
const MUSIC_PATH = process.env.BACKGROUND_MUSIC_PATH || fileEnv.BACKGROUND_MUSIC_PATH || '';
const BASE = `http://localhost:${PORT}`;

async function request(url) {
  let response;
  try {
    response = await fetch(url, { headers: API_KEY ? { 'x-api-key': API_KEY } : {} });
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
    throw new Error(`${url} returned ${response.status}: ${body.error || body.raw || response.statusText}`);
  }
  return body;
}

function timecode(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const mm = hours ? String(minutes).padStart(2, '0') : String(minutes);
  return `${hours ? `${hours}:` : ''}${mm}:${String(secs).padStart(2, '0')}`;
}

/**
 * Accumulate chapter start times from the scene manifest.
 *
 * Scene durations are the timings the pipeline fitted to the recorded
 * narration, so summing them tracks the finished file. Structural scenes are
 * folded into their neighbours, then the shortest chapters are merged until the
 * list fits the requested maximum and every entry clears the 10-second floor.
 */
function buildChapters(scenes, maxChapters) {
  const ordered = [...scenes].sort((a, b) => Number(a.position) - Number(b.position));

  let elapsed = 0;
  const segments = ordered.map(scene => {
    const start = elapsed;
    const duration = Number(scene.duration) || 0;
    elapsed += duration;
    return { start, duration, title: String(scene.label || 'Chapter').trim() };
  });

  const chapters = [];
  let pendingTitle = null;
  for (const segment of segments) {
    const key = segment.title.toLowerCase();

    if (MERGE_FORWARD.has(key)) {
      // Keep the start time, take the next scene's title.
      if (!chapters.length) pendingTitle = segment;
      else chapters[chapters.length - 1].duration += segment.duration;
      continue;
    }

    if (MERGE_BACKWARD.has(key) && chapters.length) {
      chapters[chapters.length - 1].duration += segment.duration;
      continue;
    }

    if (pendingTitle) {
      chapters.push({ start: pendingTitle.start, duration: pendingTitle.duration + segment.duration, title: segment.title });
      pendingTitle = null;
      continue;
    }

    chapters.push({ ...segment });
  }

  if (pendingTitle) chapters.push({ ...pendingTitle });

  // Fold anything under the floor into the chapter before it.
  for (let index = chapters.length - 1; index > 0; index -= 1) {
    if (chapters[index].duration < MIN_CHAPTER_SECONDS) {
      chapters[index - 1].duration += chapters[index].duration;
      chapters.splice(index, 1);
    }
  }

  // Then merge the shortest neighbours until the list fits.
  while (chapters.length > maxChapters && chapters.length > MIN_CHAPTERS) {
    let shortest = 1;
    for (let index = 2; index < chapters.length; index += 1) {
      if (chapters[index].duration < chapters[shortest].duration) shortest = index;
    }
    chapters[shortest - 1].duration += chapters[shortest].duration;
    chapters.splice(shortest, 1);
  }

  // Re-derive starts so they stay contiguous after the merges.
  let cursor = 0;
  for (const chapter of chapters) {
    chapter.start = cursor;
    cursor += chapter.duration;
  }
  if (chapters.length) chapters[0].start = 0;

  return chapters;
}

/**
 * The SEO agent appends its own timestamp, keyword and tag lists to the body of
 * the description, and those timestamps are on the same fixed grid as the
 * chapter array — on the first published video they ran to 14:50 on a file that
 * ends at 5:51. Cut everything from the first such label onwards.
 */
const AGENT_TAIL = /(^|\s)(timestamps?|chapters?|keywords?|tags|hashtags|sources)\s*:/i;

function cleanAgentDescription(value) {
  const raw = String(value || '');
  const match = AGENT_TAIL.exec(raw);
  return {
    text: (match ? raw.slice(0, match.index) : raw).replace(/\s+/g, ' ').trim(),
    strippedLabel: match ? match[2].toLowerCase() : null
  };
}

function buildLead(seo, script) {
  const candidates = [cleanAgentDescription(seo?.description).text, script?.hook, script?.introduction]
    .map(value => String(value || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  if (!candidates.length) return '';

  const text = candidates[0];
  if (text.length <= LEAD_LIMIT) return text;

  // Cut on the last sentence end that still fits, else the last whole word.
  const window = text.slice(0, LEAD_LIMIT + 1);
  const sentenceEnd = Math.max(window.lastIndexOf('. '), window.lastIndexOf('! '), window.lastIndexOf('? '));
  if (sentenceEnd > 60) return window.slice(0, sentenceEnd + 1).trim();
  const wordEnd = window.lastIndexOf(' ');
  return `${window.slice(0, wordEnd > 60 ? wordEnd : LEAD_LIMIT).trim()}…`;
}

function buildBody(seo, lead) {
  const full = cleanAgentDescription(seo?.description).text;
  if (!full) return '';
  const remainder = full.startsWith(lead.replace(/…$/, '')) ? full.slice(lead.replace(/…$/, '').length) : full;
  return remainder.trim();
}

function toHashtag(tag) {
  const cleaned = String(tag || '')
    .split(/[\s\-_/]+/)
    .map(word => word.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter(Boolean)
    .map(word => word[0].toUpperCase() + word.slice(1))
    .join('');
  if (cleaned.length < 3 || cleaned.length > 30) return null;
  if (/^\d+$/.test(cleaned)) return null;
  return `#${cleaned}`;
}

function buildHashtags(seo) {
  const out = [];
  const seen = new Set();
  for (const tag of seo?.tags || []) {
    const key = String(tag || '').toLowerCase().trim();
    if (!key || JUNK_TAGS.has(key)) continue;
    const hashtag = toHashtag(tag);
    if (!hashtag || seen.has(hashtag.toLowerCase())) continue;
    seen.add(hashtag.toLowerCase());
    out.push(hashtag);
    if (out.length >= MAX_HASHTAGS) break;
  }
  return out;
}

function formatSource(source) {
  const year = source.publishedAt ? new Date(source.publishedAt).getUTCFullYear() : null;
  const parts = [source.title || source.url];
  if (source.publisher) parts.push(source.publisher);
  if (year && Number.isFinite(year)) parts.push(String(year));
  return `${parts.join(', ')} — ${source.url}`;
}

function musicCredit() {
  if (!MUSIC_PATH) return null;
  const name = path
    .basename(MUSIC_PATH, path.extname(MUSIC_PATH))
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, letter => letter.toUpperCase());
  return `${name} — YouTube Audio Library`;
}

function buildDescription(bundle, chapters, options) {
  const seo = bundle.seo || {};
  const script = bundle.script || {};
  const sources = (bundle.provenance?.sources || [])
    .filter(source => options.includePending || source.status === 'verified');

  const lead = buildLead(seo, script);
  const body = buildBody(seo, lead);
  const blocks = [];

  if (lead) blocks.push(lead);
  if (body && body !== lead) blocks.push(body);

  if (chapters.length >= MIN_CHAPTERS) {
    blocks.push(['Chapters', ...chapters.map(chapter => `${timecode(chapter.start)} ${chapter.title}`)].join('\n'));
  }

  if (sources.length) {
    blocks.push(['Sources', ...sources.map(formatSource), '', SOURCES_NOTE].join('\n'));
  }

  const music = musicCredit();
  if (music) blocks.push(`Music: ${music}`);

  blocks.push(AI_DISCLOSURE);
  blocks.push(CHANNEL_PROMISE);

  const hashtags = buildHashtags(seo);
  if (hashtags.length) blocks.push(hashtags.join(' '));

  return blocks.join('\n\n');
}

function report(bundle, chapters, description, options) {
  const warnings = [];
  const notes = [];

  const seo = bundle.seo || {};
  const videoDuration = Number(bundle.assets?.finalVideo?.duration) || 0;
  const sceneTotal = (bundle.scenes || []).reduce((sum, scene) => sum + (Number(scene.duration) || 0), 0);

  const lead = description.split('\n\n')[0] || '';
  if (lead.length > LEAD_LIMIT) {
    warnings.push(`The lead paragraph is ${lead.length} characters. Only about ${LEAD_LIMIT} show before "Show more" — trim it by hand.`);
  } else {
    notes.push(`Lead paragraph is ${lead.length} characters, inside the ${LEAD_LIMIT}-character fold.`);
  }

  if (description.length > DESCRIPTION_LIMIT) {
    warnings.push(`The description is ${description.length} characters; YouTube accepts ${DESCRIPTION_LIMIT}. Shorten the sources block.`);
  }

  if (chapters.length < MIN_CHAPTERS) {
    warnings.push(`Only ${chapters.length} chapters survived the 10-second floor, so the chapter block was left out. YouTube needs at least ${MIN_CHAPTERS}.`);
  } else {
    notes.push(`${chapters.length} chapters, first at 0:00, shortest ${Math.round(Math.min(...chapters.map(c => c.duration)))}s.`);
  }

  if (videoDuration) {
    const last = chapters[chapters.length - 1];
    if (last && last.start >= videoDuration) {
      warnings.push(`The last chapter starts at ${timecode(last.start)} but the video ends at ${timecode(videoDuration)}. The scene manifest and the rendered file disagree — rebuild before publishing.`);
    }
    if (Math.abs(sceneTotal - videoDuration) > 2) {
      warnings.push(`Scene durations add up to ${timecode(sceneTotal)} but the file is ${timecode(videoDuration)}. Timestamps may drift; run scripts/rebuild-video.js.`);
    } else {
      notes.push(`Scene manifest (${timecode(sceneTotal)}) matches the rendered file (${timecode(videoDuration)}).`);
    }
  } else {
    warnings.push('This production has no rendered video yet, so the timestamps could not be checked against a file.');
  }

  const { strippedLabel } = cleanAgentDescription(seo.description);
  if (strippedLabel) {
    notes.push(`Dropped the agent's own "${strippedLabel}" list from the body; its timings are estimates, not the recorded ones.`);
  }

  // The whole reason this script exists: show what the SEO agent had.
  const agentChapters = Array.isArray(seo.chapters) ? seo.chapters : [];
  if (agentChapters.length) {
    const beyond = videoDuration
      ? agentChapters.filter(chapter => Number(chapter.seconds) >= videoDuration)
      : [];
    if (beyond.length) {
      warnings.push(
        `The SEO agent's own chapters put ${beyond.length} entr${beyond.length === 1 ? 'y' : 'ies'} past the end of the video ` +
        `(last one at ${beyond[beyond.length - 1].time}). Do not paste the description from the dashboard.`
      );
    } else {
      notes.push(`The SEO agent's chapters differ from these; the ones above come from the scene manifest.`);
    }
  }

  const pending = (bundle.provenance?.sources || []).filter(source => source.status !== 'verified');
  if (pending.length) {
    const action = options.includePending
      ? 'They are in the description because you passed --include-pending. Open each one and verify it, or take it out.'
      : 'They were left out. Open each one, set it to verified, then run this again.';
    warnings.push(`${pending.length} source${pending.length === 1 ? ' is' : 's are'} not verified. ${action}`);
    for (const source of pending) warnings.push(`    ${source.status}: ${source.title || source.url}`);
  }

  const staleNarration = (bundle.scenes || []).filter(
    scene => !['current', 'intentional_silence'].includes(scene.narrationStatus)
  );
  if (staleNarration.length) {
    warnings.push(`${staleNarration.length} scene(s) have narration that is not current, so their timings cannot be trusted.`);
  }

  return { warnings, notes };
}

function parseArgs(argv) {
  const options = { out: null, maxChapters: DEFAULT_MAX_CHAPTERS, includePending: false };
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--out') options.out = argv[++index];
    else if (arg === '--max-chapters') options.maxChapters = Math.max(MIN_CHAPTERS, Number(argv[++index]) || DEFAULT_MAX_CHAPTERS);
    else if (arg === '--include-pending') options.includePending = true;
    else positional.push(arg);
  }
  return { options, positional };
}

async function main() {
  const { options, positional } = parseArgs(process.argv.slice(2));
  const productionId = positional[0];

  if (!productionId) {
    console.log('Usage: node scripts/description.js <productionId> [--out file.txt] [--max-chapters 8] [--include-pending]');
    console.log('Run "node scripts/scenes.js list" to see production ids.');
    process.exitCode = 1;
    return;
  }

  const bundle = await request(`${BASE}/api/content/${encodeURIComponent(productionId)}`);
  const scenes = bundle.scenes || [];
  if (!scenes.length) {
    throw new Error(
      `Production ${productionId} has no scenes yet, so there are no real timings to build chapters from. Let the production stage finish first.`
    );
  }

  const chapters = buildChapters(scenes, options.maxChapters);
  const description = buildDescription(bundle, chapters, options);
  const { warnings, notes } = report(bundle, chapters, description, options);

  if (options.out) {
    fs.writeFileSync(options.out, `${description}\n`, 'utf8');
    console.log(`Wrote the description to ${options.out} (${description.length} characters).\n`);
  } else {
    console.log('─'.repeat(70));
    console.log(description);
    console.log('─'.repeat(70));
    console.log('');
  }

  for (const note of notes) console.log(`  ok   ${note}`);
  for (const warning of warnings) console.log(`  WARN ${warning}`);
  console.log('');
  console.log('Read it once before pasting. The lead line is the only part most viewers see.');
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  buildChapters,
  buildDescription,
  buildLead,
  buildHashtags,
  cleanAgentDescription,
  report,
  timecode,
  MIN_CHAPTERS,
  MIN_CHAPTER_SECONDS,
  LEAD_LIMIT
};
