// Publishes the built files as a GitHub release, which is what the apps' update check looks for.
// First: raise the version in package.json, run dist:win and dist:android, commit and push.
// Then: npm run release -- "What changed in this version"
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const notes = process.argv[2];
if (!notes) throw new Error('Describe the release: npm run release -- "What changed"');

const installed = 'C:\\Program Files\\GitHub CLI\\gh.exe';
const gh = existsSync(installed) ? installed : 'gh';
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();

if (git('status', '--porcelain')) throw new Error('Commit your changes first.');
git('fetch', 'origin', 'main');
if (git('rev-parse', 'HEAD') !== git('rev-parse', 'origin/main')) throw new Error('Push your commits first.');

// The apps can't update without all of these. latest.yml describes the Windows installer to them.
const files = ['G-Ultra-Setup.exe', 'G-Ultra-Setup.exe.blockmap', 'latest.yml', 'G-Ultra.apk'].map((f) => join(root, 'release', f));
for (const f of files) if (!existsSync(f)) throw new Error('Missing file, build it first: ' + f);
if (!readFileSync(join(root, 'release', 'latest.yml'), 'utf8').includes(`version: ${version}`)) {
  throw new Error(`release/latest.yml isn't version ${version}. Run dist:win again.`);
}

const installer = join(root, 'release', 'G-Ultra-Setup.exe').replace(/'/g, "''");
const status = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `[string](Get-AuthenticodeSignature -LiteralPath '${installer}').Status`], { encoding: 'utf8' }).trim();
console.log(`Installer signature: ${status}`);
if (status !== 'Valid' && process.env.GULTRA_ALLOW_UNSIGNED !== '1') {
  throw new Error('The installer is not validly signed. Build with: npm run dist:win:signed');
}

execFileSync(gh, ['release', 'create', `v${version}`, ...files, '--title', `G Ultra ${version}`, '--notes', notes, '--latest'], { cwd: root, stdio: 'inherit' });
