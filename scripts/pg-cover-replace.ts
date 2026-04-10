import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { uploadCover } from './lib/r2-client';
import { workerClient } from './lib/worker-client';

const args = process.argv.slice(2);
const getArg = (name: string, def: string) => {
  const arg = args.find((a) => a.startsWith(`--${name}=`));
  return arg ? arg.split('=')[1] : def;
};

const COVER_DIR = getArg('dir', './covers');
const DRY_RUN = args.includes('--dry-run');

const SUPPORTED_EXT = ['.jpg', '.jpeg', '.png', '.webp'];

function getMimeType(ext: string): string {
  switch (ext.toLowerCase()) {
    case '.png': return 'image/png';
    case '.webp': return 'image/webp';
    default: return 'image/jpeg';
  }
}

async function main() {
  console.log('='.repeat(60));
  console.log('PG Cover Replace - Batch upload cover images');
  console.log(`  Directory: ${path.resolve(COVER_DIR)}`);
  console.log(`  Dry run: ${DRY_RUN}`);
  console.log('='.repeat(60));

  const dirPath = path.resolve(COVER_DIR);
  if (!fs.existsSync(dirPath)) {
    console.error(`Directory not found: ${dirPath}`);
    process.exit(1);
  }

  const files = fs.readdirSync(dirPath);
  const coverFiles: Array<{ gutenbergId: number; filePath: string; ext: string }> = [];

  for (const file of files) {
    const ext = path.extname(file).toLowerCase();
    if (!SUPPORTED_EXT.includes(ext)) continue;

    const basename = path.basename(file, ext);
    const gutenbergId = parseInt(basename, 10);
    if (isNaN(gutenbergId)) {
      console.warn(`  Skipping ${file} (filename is not a gutenberg ID)`);
      continue;
    }

    coverFiles.push({ gutenbergId, filePath: path.join(dirPath, file), ext });
  }

  if (coverFiles.length === 0) {
    console.log('\nNo cover files found. Name files as {gutenbergId}.jpg/png');
    return;
  }

  console.log(`\nFound ${coverFiles.length} cover file(s).\n`);

  let replaced = 0;
  let skipped = 0;
  let failed = 0;

  for (const cover of coverFiles) {
    // Look up book in DB
    let book: any;
    try {
      book = await workerClient.getBookByGutenbergId(cover.gutenbergId);
    } catch {
      console.log(`  [skip] PG#${cover.gutenbergId} — not in database`);
      skipped++;
      continue;
    }

    const mimeType = getMimeType(cover.ext);
    console.log(`  PG#${cover.gutenbergId} "${book.title}" ← ${path.basename(cover.filePath)}`);

    if (DRY_RUN) {
      replaced++;
      continue;
    }

    try {
      const buffer = fs.readFileSync(cover.filePath);
      const coverUrl = await uploadCover(cover.gutenbergId, buffer, mimeType);

      // Store relative key (strip public URL prefix)
      const relativeKey = coverUrl.startsWith('http')
        ? coverUrl.replace(/^https?:\/\/[^/]+\//, '')
        : coverUrl;

      await workerClient.updateBook(book.id, {
        coverUrl: relativeKey,
        coverSource: 'manual',
      });

      console.log(`    → uploaded & updated`);
      replaced++;
    } catch (err) {
      console.error(`    FAILED:`, err instanceof Error ? err.message : err);
      failed++;
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log(`Replaced: ${replaced} | Skipped: ${skipped} | Failed: ${failed}`);
  console.log('='.repeat(60));
}

main().catch((err) => {
  console.error('Cover replace failed:', err);
  process.exit(1);
});
