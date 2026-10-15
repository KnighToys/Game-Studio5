// Run with Node 24+ and Chromium: node scripts/smoke-gameplay.mjs
// Optional overrides: CHROMIUM_PATH, GAME_RUNTIME_DIR (a checkout with Linux dependencies).
// Test hooks are injected into the browser response; production files stay unchanged.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, access } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = fileURLToPath(new URL('../', import.meta.url));
const runtime = process.env.GAME_RUNTIME_DIR || await access('/workspace/game-studio5-runtime/server.js')
  .then(() => '/workspace/game-studio5-runtime', () => root);
const profile = await mkdtemp(path.join(tmpdir(), 'gameplay-smoke-'));
let server, browser, cdp;
let serverOutput = '', browserOutput = '';
const exceptions = [], consoleErrors = [], failedResponses = [];

async function until(check, label, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function freePort() {
  const reservation = createServer();
  await new Promise((resolve, reject) => {
    reservation.once('error', reject);
    reservation.listen(0, '127.0.0.1', resolve);
  });
  const { port } = reservation.address();
  await new Promise(resolve => reservation.close(resolve));
  return port;
}

async function connect(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let sequence = 0;
  const pending = new Map(), handlers = new Map();
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) request.reject(new Error(JSON.stringify(message.error)));
      else request.resolve(message.result);
    } else {
      for (const handler of handlers.get(message.method) || []) handler(message.params);
    }
  });
  socket.addEventListener('close', () => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error('Chromium connection closed'));
    }
    pending.clear();
  });
  return {
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }, 20_000);
        pending.set(id, { resolve, reject, timer });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    on(method, handler) {
      handlers.set(method, [...handlers.get(method) || [], handler]);
    },
    close() { socket.close(); },
  };
}

async function evaluate(expression) {
  const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
}

async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.kill('SIGTERM');
  await Promise.race([exited, delay(2_000)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await exited;
  }
}

try {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['--preserve-symlinks', '--preserve-symlinks-main', path.join(runtime, 'server.js')], {
    cwd: runtime, env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', data => { serverOutput += data; });
  server.stderr.on('data', data => { serverOutput += data; });
  server.on('error', error => { serverOutput += error.message; });
  await until(async () => {
    if (server.exitCode !== null) throw new Error(`Game server exited: ${serverOutput}`);
    return fetch(`${origin}/fps-prototypes`, { signal: AbortSignal.timeout(1_000) })
      .then(response => response.ok, () => false);
  }, 'game server');

  const source = await readFile(path.join(root, 'templates/fps_prototypes.html'), 'utf8');
  const hook = `globalThis.__gameTest={THREE,P,W,keys,cam,S,collisionWorld,shoot,update,enemies,tracers,waves,
    orb,nearOrb,interact,swingSword,fireWave,obsM,
    get locked(){return locked},set locked(value){locked=value}};`;
  assert.match(source, /<\/script>\s*<\/body>/i, 'Expected the gameplay module at the end of the document');
  const instrumented = source.replace(/<\/script>\s*<\/body>/i, `${hook}</script></body>`);

  browser = spawn(process.env.CHROMIUM_PATH || '/usr/bin/chromium', [
    '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--use-gl=angle',
    '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--remote-debugging-port=0',
    `--user-data-dir=${profile}`, '--window-size=960,720', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  browser.stderr.on('data', data => { browserOutput = (browserOutput + data).slice(-20_000); });
  browser.on('error', error => { browserOutput += error.message; });
  let debuggerUrl;
  await until(() => {
    if (browser.exitCode !== null) throw new Error(`Chromium exited: ${browserOutput}`);
    debuggerUrl = browserOutput.match(/DevTools listening on (ws:\/\/\S+)/)?.[1];
    return debuggerUrl;
  }, 'Chromium debugger');
  const debuggerOrigin = debuggerUrl.replace(/^ws:/, 'http:').replace(/\/devtools\/.*$/, '');
  const pages = await fetch(`${debuggerOrigin}/json/list`).then(response => response.json());
  cdp = await connect(pages.find(page => page.type === 'page').webSocketDebuggerUrl);
  cdp.on('Runtime.exceptionThrown', event => exceptions.push(event.exceptionDetails.exception?.description || event.exceptionDetails.text));
  cdp.on('Runtime.consoleAPICalled', event => {
    if (event.type === 'error') consoleErrors.push(event.args.map(arg => arg.description || arg.value).join(' '));
  });
  cdp.on('Network.responseReceived', event => {
    if (event.response.status >= 400 && !event.response.url.endsWith('/favicon.ico')) failedResponses.push(`${event.response.status} ${event.response.url}`);
  });
  cdp.on('Fetch.requestPaused', event => {
    cdp.send('Fetch.fulfillRequest', {
      requestId: event.requestId, responseCode: 200,
      responseHeaders: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }],
      body: Buffer.from(instrumented).toString('base64'),
    }).catch(error => exceptions.push(error.message));
  });
  await Promise.all([
    cdp.send('Runtime.enable'), cdp.send('Page.enable'), cdp.send('Network.enable'),
    cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*fps-prototypes', resourceType: 'Document', requestStage: 'Request' }] }),
  ]);
  await cdp.send('Page.navigate', { url: `${origin}/fps-prototypes` });
  await until(() => evaluate(`Boolean(globalThis.__gameTest && document.querySelector('canvas') &&
    document.getElementById('play-status').textContent === 'Click to play' && __gameTest.collisionWorld.entries.size)`), 'loaded and rendered game', 60_000);
  assert.deepEqual(exceptions, [], 'Runtime exceptions during scene loading');
  assert.deepEqual(consoleErrors, [], 'Console errors during scene loading');
  assert.deepEqual(failedResponses, [], 'Failed game assets');
  console.log('PASS: real scene loads and renders Click to play without JavaScript or asset errors');

  const results = await evaluate(`(() => {
    const t=__gameTest,{THREE,P,W,keys,cam,S,collisionWorld,shoot,update,enemies,tracers,waves}=t;
    const checks=[];
    function check(condition,label){if(!condition)throw new Error(label);checks.push(label)}
    const close=(a,b,epsilon=1e-4)=>Math.abs(a-b)<epsilon;
    t.locked=false;
    check(t.obsM.every(mesh=>collisionWorld.entries.has(mesh)),'arena box colliders are registered');
    // Replace loaded-model collisions with controlled real triangle geometry only inside this test page.
    for(const root of [...collisionWorld.entries.keys()])collisionWorld.removeModel(root);
    for(const enemy of enemies){enemy.alive=false;enemy.rt=Infinity;enemy.g.visible=false}
    const enemy=enemies[0];enemy.alive=true;enemy.g.visible=true;enemy.hp=100;
    enemy.g.position.set(0,0,0);enemy.m.rotation.set(0,0,0);
    cam.position.set(0,1.2,8);cam.rotation.set(0,0,0);cam.fov=75;cam.updateProjectionMatrix();
    function model(w,h,d,x,y,z){
      const mesh=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),new THREE.MeshBasicMaterial());
      mesh.position.set(x,y,z);S.add(mesh);collisionWorld.addModel(mesh);return mesh;
    }
    function remove(mesh){collisionWorld.removeModel(mesh);S.remove(mesh);mesh.geometry.dispose();mesh.material.dispose()}
    function tracerTip(){S.updateMatrixWorld(true);return new THREE.Vector3(0,.5,0).applyMatrix4(tracers.at(-1).m.matrixWorld)}
    const wall=model(4,3,.5,0,1.5,4);S.updateMatrixWorld(true);shoot(0);
    check(enemy.hp===100,'model wall blocks enemy damage');
    check(tracerTip().distanceTo(new THREE.Vector3(0,1.2,4.25))<1e-4,'tracer ends at nearest model wall');
    remove(wall);S.updateMatrixWorld(true);shoot(0);
    check(enemy.hp===85,'unobstructed shot damages enemy');
    enemy.hp=100;const farWall=model(4,3,.5,0,1.5,-4);S.updateMatrixWorld(true);shoot(0);
    check(enemy.hp===85,'model wall behind enemy does not block nearer target');remove(farWall);
    enemy.alive=false;enemy.rt=Infinity;

    function primeInput(){
      t.locked=true;keys.KeyW=true;keys.ShiftLeft=true;
      Object.assign(W,{cur:1,wave:true,down:true,charging:true,chargeT:3.1,holdT:3.25,cc:true,blocking:true,scope:true,scopeCharge:2});
      P.dashT=.08;P.dashFx=1;
    }
    function assertReset(label){
      check(!Object.values(keys).some(Boolean)&&!W.down&&!W.charging&&!W.blocking&&!W.cc&&
        W.holdT===0&&W.chargeT===0&&!W.scope&&W.scopeCharge===0&&P.dashT===0&&P.dashFx===0,label+' clears held input');
      const count=waves.length;t.locked=true;
      window.dispatchEvent(new MouseEvent('mouseup',{button:0}));
      check(waves.length===count,label+' prevents a stored charged wave after resume');t.locked=false;
    }
    primeInput();window.dispatchEvent(new Event('blur'));assertReset('window blur');
    primeInput();document.dispatchEvent(new Event('pointerlockchange'));assertReset('pointer unlock');
    primeInput();Object.defineProperty(document,'hidden',{configurable:true,value:true});
    try{document.dispatchEvent(new Event('visibilitychange'));assertReset('hidden tab')}
    finally{delete document.hidden}
    window.dispatchEvent(new KeyboardEvent('keydown',{code:'KeyW'}));
    check(!keys.KeyW,'unlocked keyboard cannot pre-arm movement');

    Object.assign(W,{cur:0,wave:false,swap:0,down:false,charging:false,blocking:false,scope:false});
    P.dead=false;P.hp=200;P.eyeY=1.7;P.pitch=0;P.yaw=0;P.roll=0;P.velocityY=0;
    const platform=model(6,2,6,0,1,0);P.pos.set(0,2,0);
    for(let i=0;i<60;i++)update(1/60);
    check(close(P.pos.y,2)&&P.grounded&&P.velocityY===0,'player stays grounded on elevated model');
    check(close(cam.position.y,P.pos.y+P.eyeY),'camera follows elevated feet plus eye height');
    P.pos.x=5;
    for(let i=0;i<6;i++)update(1/60);
    check(P.pos.y>0&&P.pos.y<2&&P.velocityY<0&&!P.grounded,'leaving model ledge starts a fall');
    check(close(cam.position.y,P.pos.y+P.eyeY),'camera follows airborne player');
    for(let i=0;i<180;i++)update(1/60);
    check(P.pos.y===0&&P.velocityY===0&&P.grounded,'fall lands on arena floor without sinking');
    check(close(cam.position.y,P.eyeY),'camera returns to standing floor height');
    remove(platform);

    const arenaBox=t.obsM[4];collisionWorld.addModel(arenaBox);P.pos.set(6,5,-8);P.velocityY=0;
    for(let i=0;i<60;i++)update(1/60);
    check(close(P.pos.y,3)&&close(P.pos.x,6)&&close(P.pos.z,-8)&&P.grounded,'fall lands on top of an existing arena box');
    P.pos.set(6,0,-3);P.velocityY=0;P.dashDir.set(0,0,-1);P.dashT=.12;
    for(let i=0;i<3;i++)update(.05);
    check(P.pos.z>=-6.101&&P.pos.z<-5.9,'dash cannot tunnel through an arena box');
    collisionWorld.removeModel(arenaBox);P.dashT=0;

    // Vertical separation must apply to gameplay interactions as well as the camera.
    enemy.alive=true;enemy.hp=100;enemy.cd=0;enemy.g.position.set(0,0,-2);
    P.pos.set(0,8,0);P.velocityY=0;P.hp=200;W.cur=1;W.cdT=0;t.swingSword();
    check(enemy.hp===100,'elevated sword cannot hit an enemy far below');
    W.chargeT=3.1;t.fireWave();
    check(close(waves.at(-1).g.position.y,P.pos.y+1.1),'sword wave spawns at player elevation');
    update(0);
    check(enemy.hp===100,'elevated sword wave cannot hit an enemy far below');
    check(P.hp===200,'enemy melee cannot hit an elevated player far above');
    P.pos.set(t.orb.position.x,8,t.orb.position.z);P.hp=100;t.orb.visible=true;t.interact();
    check(!t.nearOrb()&&P.hp===100&&t.orb.visible,'elevated player cannot absorb orb far below');
    P.pos.y=0;t.interact();
    check(P.hp===150&&!t.orb.visible,'orb absorption still works at ground height');
    P.pos.set(0,0,0);W.cdT=0;t.swingSword();
    check(enemy.hp===80,'sword still damages a nearby enemy at the same height');
    enemy.hp=100;P.hp=200;enemy.cd=0;W.chargeT=3.1;t.fireWave();update(0);
    check(enemy.hp===58,'charged sword wave still damages enemy at the same height');
    check(P.hp===180,'enemy melee still damages player at the same height');
    t.locked=false;
    return checks;
  })()`);
  for (const result of results) console.log(`PASS: ${result}`);
  assert.deepEqual(exceptions, [], 'Runtime exceptions during gameplay checks');
  assert.deepEqual(consoleErrors, [], 'Console errors during gameplay checks');
  console.log(`Gameplay smoke test passed (${results.length + 1} checks).`);
} catch (error) {
  console.error(error.stack || error);
  if (consoleErrors.length) console.error('Browser console:', consoleErrors.join('\n'));
  process.exitCode = 1;
} finally {
  cdp?.close();
  await Promise.all([stop(browser), stop(server)]);
  await rm(profile, { recursive: true, force: true });
}
