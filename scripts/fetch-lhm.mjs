// Downloads LibreHardwareMonitorLib (MPL-2.0) and its .NET Framework 4.8 dependencies
// into electron/helper/lib. Run it once; the DLLs stay in the project.
import { mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, copyFileSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'electron', 'helper', 'lib');
const work = mkdtempSync(join(process.env.GULTRA_TMP || tmpdir(), 'gultra-nuget-'));
const PREFERRED = ['net48', 'net472', 'net471', 'net47', 'net462', 'net461', 'net46', 'net452', 'net45', 'netstandard2.0'];
const GROUPS = ['.NETFramework4.8', '.NETFramework4.7.2', '.NETFramework4.6.2', '.NETFramework4.6.1', '.NETFramework4.6', '.NETFramework4.5', '.NETStandard2.0'];
const api = 'https://api.nuget.org/v3-flatcontainer';
const seen = new Map();

async function text(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.text();
}

function parseDeps(nuspec) {
  const groups = [...nuspec.matchAll(/<group\s+targetFramework="([^"]+)"\s*(?:\/>|>([\s\S]*?)<\/group>)/g)];
  for (const wanted of GROUPS) {
    const g = groups.find((m) => m[1].toLowerCase() === wanted.toLowerCase());
    if (g) return [...(g[2] || '').matchAll(/<dependency\s+id="([^"]+)"\s+version="([^"]+)"/g)].map((m) => [m[1], m[2]]);
  }
  return [];
}

async function fetchPkg(id, version) {
  const key = id.toLowerCase();
  const ver = version.replace(/[\[\]()\s]/g, '').split(',')[0];
  if (seen.has(key)) return;
  seen.set(key, ver);
  const nuspec = await text(`${api}/${key}/${ver}/${key}.nuspec`);
  const zipPath = join(work, `${key}.zip`);
  const res = await fetch(`${api}/${key}/${ver}/${key}.${ver}.nupkg`);
  writeFileSync(zipPath, Buffer.from(await res.arrayBuffer()));
  const dest = join(work, key);
  mkdirSync(dest, { recursive: true });
  execFileSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${dest}' -Force`]);
  // Some packages keep their architecture-specific DLL in runtimes/ rather than lib/.
  const runtimeDir = join(dest, 'runtimes', 'win-x64', 'lib');
  const libDir = existsSync(runtimeDir) ? runtimeDir : join(dest, 'lib');
  if (existsSync(libDir)) {
    const tfms = readdirSync(libDir);
    const tfm = PREFERRED.find((t) => tfms.includes(t));
    if (tfm) {
      for (const f of readdirSync(join(libDir, tfm))) {
        if (f.endsWith('.dll')) {
          copyFileSync(join(libDir, tfm, f), join(out, f));
          console.log(`  ${id} ${ver} [${tfm}] → ${f}`);
        }
      }
    } else {
      console.log(`  ${id} ${ver}: no DLL for .NET Framework (${tfms.join(', ')})`);
    }
  }
  for (const [depId, depVer] of parseDeps(nuspec)) await fetchPkg(depId, depVer);
}

mkdirSync(out, { recursive: true });
await fetchPkg('LibreHardwareMonitorLib', process.argv[2] || '0.9.6');
rmSync(work, { recursive: true, force: true });
console.log(`done: ${seen.size} packages`);
