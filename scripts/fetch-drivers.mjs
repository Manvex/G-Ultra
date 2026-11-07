// Downloads the setup files the installer bundles and checks them against known hashes.
// They aren't kept in git. Run this once before `npm run dist:win`.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'build', 'drivers');
const FILES = [
  {
    name: 'PawnIO_setup.exe',
    url: 'https://github.com/namazso/PawnIO.Setup/releases/download/2.2.0/PawnIO_setup.exe',
    sha256: '1f519a22e47187f70a1379a48ca604981c4fcf694f4e65b734aaa74a9fba3032',
  },
  {
    name: 'ndp48-web.exe',
    url: 'https://go.microsoft.com/fwlink/?LinkId=2085155',
    sha256: '0bba3094588c4bfec301939985222a20b340bf03431563dec8b2b4478b06fffa',
  },
];

const hash = (data) => createHash('sha256').update(data).digest('hex');
mkdirSync(out, { recursive: true });

for (const f of FILES) {
  const path = join(out, f.name);
  if (existsSync(path) && hash(readFileSync(path)) === f.sha256) {
    console.log(`${f.name}: already here`);
    continue;
  }
  const res = await fetch(f.url);
  if (!res.ok) throw new Error(`${f.name}: download failed (${res.status})`);
  const data = Buffer.from(await res.arrayBuffer());
  if (hash(data) !== f.sha256) throw new Error(`${f.name}: the hash doesn't match, so the file was not saved`);
  writeFileSync(path, data);
  console.log(`${f.name}: downloaded and verified`);
}
