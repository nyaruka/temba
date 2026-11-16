#!/usr/bin/env node

// Regenerates the XLIFF and locale files, then fails if they changed or any
// string lacks a translation. There's no translation service, so a string that
// isn't extracted and translated here silently shows in English.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const config = require('./localize.config.json');
const XLIFF_DIR = path.join(__dirname, config.interchange.xliffDir);
const LOCALES_DIR = path.join(__dirname, config.output.outputDir);

function snapshot() {
  const files = {};
  for (const dir of [XLIFF_DIR, LOCALES_DIR]) {
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name);
      files[file] = fs.readFileSync(file, 'utf8');
    }
  }
  return files;
}

const before = snapshot();
// locale:build logs into dist/
fs.mkdirSync(path.join(__dirname, 'dist'), { recursive: true });
try {
  execSync('bun run locale:extract && bun run locale:build', {
    cwd: __dirname,
    stdio: 'pipe'
  });
} catch (error) {
  console.error(error.stdout.toString(), error.stderr.toString());
  const buildLog = path.join(__dirname, 'dist', 'locale.out');
  if (fs.existsSync(buildLog)) {
    console.error(fs.readFileSync(buildLog, 'utf8'));
  }
  process.exit(1);
}
const after = snapshot();

const changed = Object.keys({ ...before, ...after })
  .filter((file) => before[file] !== after[file])
  .map((file) => path.relative(__dirname, file));

const untranslated = [];
for (const locale of config.targetLocales) {
  const xliff = after[path.join(XLIFF_DIR, `${locale}.xlf`)];
  for (const unit of xliff.match(/<trans-unit[\s\S]*?<\/trans-unit>/g) || []) {
    if (!/<target(\s[^>]*)?>\s*\S[\s\S]*?<\/target>/.test(unit)) {
      const source = unit.match(/<source>([\s\S]*?)<\/source>/)[1];
      untranslated.push(`${locale}: ${source}`);
    }
  }
}

if (changed.length) {
  console.error('❌ Locale files were out of date and have been regenerated:');
  changed.forEach((file) => console.error(`   ${file}`));
}
if (untranslated.length) {
  console.error(
    `❌ ${untranslated.length} strings have no translation, add a <target> in the XLIFF file and run this again:`
  );
  untranslated.forEach((line) => console.error(`   ${line}`));
}
if (changed.length || untranslated.length) {
  process.exit(1);
}
console.log('✅ Locale files are up to date and fully translated');
