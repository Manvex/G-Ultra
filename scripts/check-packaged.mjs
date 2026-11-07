// Checks the packaged app: starts it, reads what each screen shows, measures its footprint, closes it.
// It never presses an action button, so nothing gets cleaned or closed.
// __COMPAT_LAYER=RunAsInvoker skips the UAC prompt, so this runs the app in limited mode.
import { spawn, execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const exe = process.argv[2] || join(root, 'release', 'win-unpacked', 'G Ultra.exe');
const port = 9333;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const child = spawn(exe, [`--remote-debugging-port=${port}`], { stdio: 'ignore', env: { ...process.env, __COMPAT_LAYER: 'RunAsInvoker' } });
let page = null;
for (let i = 0; i < 40 && !page; i++) {
  await sleep(500);
  try {
    const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    page = list.find((t) => t.type === 'page');
  } catch {}
}
if (!page) {
  console.log('ERROR: the window did not start');
  child.kill();
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
};
const evalJs = (expression) =>
  new Promise((res) => {
    const i = ++id;
    pending.set(i, (m) => res(m.result?.result?.value ?? m.result?.exceptionDetails?.text));
    ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
  });

const footprint = (seconds) => {
  const script = `
$names = 'G Ultra','GUltraHelper'
function snap { Get-Process $names -ErrorAction SilentlyContinue | Select-Object Id,ProcessName,CPU,PrivateMemorySize64 }
$a = snap; Start-Sleep ${seconds}; $b = snap
$rows = foreach ($p in $b) { $q = $a | Where-Object Id -eq $p.Id; if ($q) { [pscustomobject]@{ Name=$p.ProcessName; CpuPct=[math]::Round(($p.CPU-$q.CPU)/${seconds}/[Environment]::ProcessorCount*100,2); PrivateMB=[math]::Round($p.PrivateMemorySize64/1MB) } } }
$rows | Sort-Object CpuPct -Descending | Format-Table -AutoSize | Out-String
'TOTAL CPU: ' + [math]::Round(($rows | Measure-Object CpuPct -Sum).Sum,2) + '% | PRIVATE: ' + ($rows | Measure-Object PrivateMB -Sum).Sum + ' MB'
`;
  return execSync(`powershell -NoProfile -EncodedCommand ${Buffer.from(script, 'utf16le').toString('base64')}`, { encoding: 'utf8' }).trim();
};

// Idle first, before anything has been scanned.
await sleep(12000);
console.log('--- idle on Home ---');
console.log(footprint(15));

const errors = [];
for (const route of ['memory', 'thermal', 'gpu', 'storage', 'clean', 'health', 'home']) {
  await evalJs(`location.hash = '#/${route}'`);
  await sleep(1800);
  const text = await evalJs(`document.querySelector('.page')?.innerText.replace(/\\s+/g,' ').slice(0, 170)`);
  console.log(`[${route}] ${text}`);
  if (!text) errors.push(route);
}

const helperPath = execSync(`powershell -NoProfile -Command "(Get-Process GUltraHelper -ErrorAction SilentlyContinue | Select-Object -First 1).Path"`, { encoding: 'utf8' }).trim();
console.log('helper:', helperPath);

ws.close();
child.kill();
await sleep(4000);
const left = execSync(`powershell -NoProfile -Command "@(Get-Process GUltraHelper -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*win-unpacked*' }).Count"`, { encoding: 'utf8' }).trim();
console.log('helpers left after closing the app:', left);
try {
  execSync(`powershell -NoProfile -Command "Get-Process 'G Ultra' -ErrorAction SilentlyContinue | Stop-Process -Force"`, { stdio: 'ignore' });
} catch {}
console.log(errors.length ? `EMPTY SCREENS: ${errors.join(', ')}` : 'ALL SCREENS HAVE DATA');
