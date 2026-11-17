import { execSync } from 'node:child_process';
import fs from 'node:fs';

// What differs between where the app runs, as a Vite plugin. This edition: no dev server routes;
// the build keeps the licence notices of what it bundles.
export function editionPlugin() {
  return { name: 'edition', config: () => ({ esbuild: { legalComments: 'eof' } }) };
}

// Which code a build is: the commit in a git checkout that has one, else the package version
// (a download has no history).
export function buildStamp(here) {
  const time = new Date().toISOString();
  const git = (cmd) => execSync(`git ${cmd}`, { cwd: here('.'), encoding: 'utf8' }).trim();
  if (fs.existsSync(here('./.git')) && git('rev-parse --verify -q HEAD || true') !== '') {
    return { sha: git('rev-parse --short HEAD'), dirty: git('status --porcelain') !== '', time };
  }
  const { version } = JSON.parse(fs.readFileSync(here('./package.json'), 'utf8'));
  return { sha: `v${version}`, dirty: false, time };
}
