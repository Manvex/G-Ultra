// Visual check: runs the real app and photographs the screens. Not included in the package.
// Steps are separated by @@, and each step is "route~~capture name~~js to run first~~wait in ms".
const fs = require('node:fs');
const path = require('node:path');

module.exports = async function runShots(win, app) {
  const dir = process.env.GULTRA_SHOT_DIR;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const js = (code) => win.webContents.executeJavaScript(code);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'run.log'), '');
  const log = (...a) => fs.appendFileSync(path.join(dir, 'run.log'), a.join(' ') + '\n');
  win.webContents.on('render-process-gone', (_e, d) => log('RENDERER GONE', JSON.stringify(d)));
  win.webContents.on('console-message', (e) => {
    if (e.level === 'error' || e.level === 'warning') log('CONSOLE', e.level, e.message);
  });
  win.on('close', () => log('WINDOW CLOSE EVENT'));
  process.on('unhandledRejection', (e) => log('REJECTION', e && e.stack));

  await new Promise((r) => win.webContents.once('did-finish-load', r));
  const [w, h] = (process.env.GULTRA_SHOT_SIZE || '1240x820').split('x').map(Number);
  win.setContentSize(w, h);
  await wait(3000);

  const steps = (process.env.GULTRA_SHOT_STEPS || 'home@@memory@@thermal@@gpu@@storage@@clean@@health').split('@@');
  for (const step of steps) {
    const [route, name, code, ms] = step.split('~~');
    await js(`location.hash = '#/${route}'`);
    await wait(Number(process.env.GULTRA_SHOT_WAIT || 2600));
    if (code) log('result', name, await js(code));
    if (ms) await wait(Number(ms));
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(dir, `${name || route}.png`), img.toPNG());
  }

  if (process.env.GULTRA_SHOT_REPORT) {
    // percentCPUUsage measures from the previous call, so the first call only primes it.
    await js(`window.__gultraForceFocus = true; location.hash = '#/home'`);
    await wait(4000);
    app.getAppMetrics();
    await wait(10000);
    const perf = app.getAppMetrics();
    fs.writeFileSync(path.join(dir, 'metrics.json'), JSON.stringify(perf.map((m) => ({ type: m.type, cpu: +m.cpu.percentCPUUsage.toFixed(2), memMB: Math.round(m.memory.workingSetSize / 1024), privateMB: Math.round((m.memory.privateBytes || 0) / 1024) })), null, 1));
  }
  app.quit();
};
