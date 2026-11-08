// Signs one file during the Windows build. dist-signed.mjs passes the certificate through the environment.
const { execFileSync } = require('node:child_process');
const { existsSync, readdirSync } = require('node:fs');
const { basename, join } = require('node:path');

function signtool() {
  const kits = 'C:\\Program Files (x86)\\Windows Kits\\10\\bin';
  const versions = existsSync(kits) ? readdirSync(kits).filter((d) => /^10\./.test(d)).sort().reverse() : [];
  for (const v of versions) {
    const exe = join(kits, v, 'x64', 'signtool.exe');
    if (existsSync(exe)) return exe;
  }
  throw new Error('signtool.exe was not found. Install the Windows SDK.');
}

module.exports = async function sign(config) {
  const file = config.path;
  // These installers come from Microsoft and PawnIO and keep their makers' own signatures.
  if (/[\\/]resources[\\/]drivers[\\/]/i.test(file)) {
    console.log(`  keeping the original signature: ${basename(file)}`);
    return;
  }
  const { GULTRA_SIGN_THUMBPRINT: thumbprint, GULTRA_SIGN_TIMESTAMP: timestamp } = process.env;
  if (!thumbprint) throw new Error('Build with: npm run dist:win:signed');

  const args = ['sign', '/sha1', thumbprint, '/fd', 'sha256', '/tr', timestamp, '/td', 'sha256', '/d', 'G Ultra', '/du', 'https://github.com/Manvex/G-Ultra', file];
  // Timestamp servers fail now and then, and a retry is usually enough.
  for (let attempt = 1; ; attempt++) {
    try {
      execFileSync(signtool(), args, { stdio: 'pipe' });
      console.log(`  signed: ${basename(file)}`);
      return;
    } catch (e) {
      if (attempt >= 4) throw new Error(`Signing ${basename(file)} failed: ${e.stderr || e.message}`);
      await new Promise((r) => setTimeout(r, 4000 * attempt));
    }
  }
};
