// Builds the Windows installer signed with the code signing certificate on this PC, then checks the result.
// Needs a certificate from a trusted authority. With a cloud certificate, connect its desktop app first.
// More than one certificate? Set GULTRA_SIGN_THUMBPRINT to choose. GULTRA_SIGN_TIMESTAMP sets the timestamp server.
import { execFileSync, execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

function powershell(script) {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' }).trim();
}

function findCertificate() {
  const out = powershell(`@(Get-ChildItem Cert:\\CurrentUser\\My,Cert:\\LocalMachine\\My -CodeSigningCert -ErrorAction SilentlyContinue |
    Where-Object { $_.HasPrivateKey -and $_.NotAfter -gt (Get-Date) } |
    ForEach-Object { [pscustomobject]@{ thumbprint = $_.Thumbprint; name = $_.GetNameInfo('SimpleName', $false); issuer = $_.GetNameInfo('SimpleName', $true); subject = $_.Subject } }) | ConvertTo-Json -Compress`);
  const list = out ? [].concat(JSON.parse(out)) : [];
  const wanted = process.env.GULTRA_SIGN_THUMBPRINT;
  const usable = wanted ? list.filter((c) => c.thumbprint.toLowerCase() === wanted.toLowerCase()) : list;
  if (usable.length === 0) {
    throw new Error('No usable code signing certificate on this PC. Connect your certificate (for example SimplySign Desktop) and try again.');
  }
  if (usable.length > 1) {
    throw new Error(`Several certificates found. Set GULTRA_SIGN_THUMBPRINT to one of:\n${usable.map((c) => `  ${c.thumbprint}  ${c.name}`).join('\n')}`);
  }
  return usable[0];
}

function signature(file) {
  const out = powershell(`Get-AuthenticodeSignature -LiteralPath '${file.replace(/'/g, "''")}' | ForEach-Object { [pscustomobject]@{ status = [string]$_.Status; subject = $_.SignerCertificate.Subject; timestamped = ($null -ne $_.TimeStamperCertificate) } } | ConvertTo-Json -Compress`);
  return JSON.parse(out);
}

const cert = findCertificate();
const timestamp = process.env.GULTRA_SIGN_TIMESTAMP || 'http://time.certum.pl';
process.env.GULTRA_SIGN_THUMBPRINT = cert.thumbprint;
process.env.GULTRA_SIGN_TIMESTAMP = timestamp;
console.log(`Signing as: ${cert.name}\nIssued by:  ${cert.issuer}\nTimestamp:  ${timestamp}\n`);

execSync('npm run build:helper && npm run build:web', { cwd: root, stdio: 'inherit' });

const { build, Platform, Arch } = require('electron-builder');
await build({
  targets: Platform.WINDOWS.createTarget(undefined, Arch.x64),
  config: {
    win: {
      signtoolOptions: {
        sign: join(root, 'scripts', 'sign-win.cjs'),
        signingHashAlgorithms: ['sha256'],
        // Installed apps then accept updates only from this publisher.
        publisherName: cert.name,
      },
    },
  },
});

// A build that didn't really get signed must not look like one that did.
const unpacked = join(root, 'release', 'win-unpacked');
const mine = ['G Ultra.exe', 'resources\\helper\\GUltraHelper.exe'].map((f) => join(unpacked, f));
mine.push(join(root, 'release', 'G-Ultra-Setup.exe'));
const problems = [];
for (const file of mine) {
  const s = signature(file);
  console.log(`${s.status.padEnd(10)} ${s.timestamped ? 'timestamped' : 'NO TIMESTAMP'}  ${file.replace(root, '')}`);
  if (s.status !== 'Valid') problems.push(`${file}: ${s.status}`);
  else if (!s.timestamped) problems.push(`${file}: no timestamp, so the signature would stop working when the certificate expires`);
}
for (const f of ['PawnIO_setup.exe', 'ndp48-web.exe']) {
  const s = signature(join(unpacked, 'resources', 'drivers', f));
  console.log(`${s.status.padEnd(10)} kept: ${s.subject}`);
  if (s.status !== 'Valid' || (s.subject || '').includes(cert.subject)) problems.push(`${f}: should keep its maker's signature`);
}
const updateConfig = join(unpacked, 'resources', 'app-update.yml');
if (!existsSync(updateConfig) || !readFileSync(updateConfig, 'utf8').includes('publisherName')) {
  problems.push('app-update.yml has no publisherName, so the updater would not check signatures');
}
if (problems.length) {
  console.error(`\nThe build is NOT ready to publish:\n${problems.map((p) => `  ${p}`).join('\n')}`);
  process.exit(1);
}
console.log(`\nSigned and verified. Windows will show the publisher as: ${cert.name}`);
