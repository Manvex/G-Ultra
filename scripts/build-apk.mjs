// Builds the signed APK, using Android Studio's JDK and the local SDK.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const android = join(root, 'android');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const debug = process.argv.includes('--debug');

const javaHome = process.env.JAVA_HOME && existsSync(join(process.env.JAVA_HOME, 'bin', 'javac.exe')) ? process.env.JAVA_HOME : 'C:\\Program Files\\Android\\Android Studio\\jbr';
const sdk = process.env.ANDROID_HOME || join(process.env.LOCALAPPDATA, 'Android', 'Sdk');
const env = { ...process.env, JAVA_HOME: javaHome, ANDROID_HOME: sdk };

writeFileSync(join(android, 'local.properties'), `sdk.dir=${sdk.replace(/\\/g, '\\\\').replace(/:/g, '\\:')}\n`);

// The signing key is generated once and stays on this PC.
// Future updates of the app must be signed with the same key.
const keyProps = join(android, 'keystore.properties');
const keyFile = join(android, 'g-ultra-release.jks');
if (!existsSync(keyFile)) {
  const password = randomBytes(18).toString('base64url');
  execFileSync(join(javaHome, 'bin', 'keytool.exe'), [
    '-genkeypair', '-v', '-keystore', keyFile, '-storepass', password, '-keypass', password,
    '-alias', 'gultra', '-keyalg', 'RSA', '-keysize', '2048', '-validity', '10000',
    '-dname', 'CN=G Ultra, O=G Ultra, C=RO',
  ], { stdio: 'ignore', env });
  writeFileSync(keyProps, `storeFile=g-ultra-release.jks\nstorePassword=${password}\nkeyAlias=gultra\nkeyPassword=${password}\n`);
  console.log('signing key created:', keyFile);
}

const task = debug ? 'assembleDebug' : 'assembleRelease';
execFileSync('cmd.exe', ['/c', '.\\gradlew.bat', task, '--no-daemon', '--console=plain'], { cwd: android, stdio: 'inherit', env });

const built = debug
  ? join(android, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk')
  : join(android, 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk');
mkdirSync(join(root, 'release'), { recursive: true });
const dest = join(root, 'release', debug ? `G-Ultra-${version}-debug.apk` : `G-Ultra-${version}.apk`);
copyFileSync(built, dest);
console.log('APK:', dest);
