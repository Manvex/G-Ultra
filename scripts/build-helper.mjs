// Compiles the C# helper with csc.exe from .NET Framework (present on every Windows 10/11).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, copyFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const helper = join(root, 'electron', 'helper');
const src = join(helper, 'src');
const lib = join(helper, 'lib');
const selftest = process.argv.includes('--selftest');
const out = selftest ? process.argv[process.argv.indexOf('--selftest') + 1] : join(helper, 'bin');

const fw = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319';
const csc = join(fw, 'csc.exe');
if (!existsSync(csc)) throw new Error('csc.exe is missing: ' + csc);
if (!existsSync(join(lib, 'LibreHardwareMonitorLib.dll'))) throw new Error('run this first: node scripts/fetch-lhm.mjs');

if (!selftest) rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'lib'), { recursive: true });

const args = [
  '/nologo', '/optimize+', '/platform:x64', selftest ? '/target:exe' : '/target:winexe', '/nowarn:1701,1702,0436',
  `/out:${join(out, selftest ? 'GUltraSelfTest.exe' : 'GUltraHelper.exe')}`,
  '/r:System.dll', '/r:System.Core.dll', '/r:System.Management.dll', '/r:System.Web.Extensions.dll',
  '/r:System.Numerics.dll', '/r:Microsoft.CSharp.dll', '/r:System.Xml.dll', '/r:System.Xml.Linq.dll', '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll',
  `/r:${join(fw, 'netstandard.dll')}`,
  `/r:${join(lib, 'LibreHardwareMonitorLib.dll')}`,
];
if (selftest) args.push('/define:SELFTEST');
for (const f of readdirSync(src)) if (f.endsWith('.cs')) args.push(join(src, f));

try {
  const output = execFileSync(csc, args, { encoding: 'utf8' });
  if (output.trim()) console.log(output.trim());
} catch (e) {
  console.error(e.stdout || e.message);
  process.exit(1);
}

for (const f of readdirSync(lib)) if (f.endsWith('.dll')) copyFileSync(join(lib, f), join(out, 'lib', f));
if (!selftest) {
  // The tray icon, and a garbage collector setting that keeps the background monitor small.
  copyFileSync(join(root, 'build', 'icon.ico'), join(out, 'icon.ico'));
  writeFileSync(join(out, 'GUltraHelper.exe.config'), '<?xml version="1.0"?>\n<configuration><runtime><gcConcurrent enabled="false"/></runtime></configuration>\n');
}
console.log('helper compiled:', out);
