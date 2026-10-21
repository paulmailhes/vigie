import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { createGateway, memoryKeychain, parseAuthenticate } from '../lib/gateway.mjs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'vigie-passerelle-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

// Faux service : MCP protégé + serveur d'autorisation (découverte, inscription, code + PKCE, rafraîchissement).
function fakeService({ secret = false, oneGrantPerClient = false } = {}) {
  const state = { codes: new Map(), tokens: new Map(), clientOf: new Map(), refreshes: 0, seen: [], lastChallenge: null, registered: 0 };
  const srv = http.createServer(async (req, res) => {
    const base = `http://127.0.0.1:${srv.address().port}`;
    const url = new URL(req.url, base);
    let body = '';
    for await (const c of req) body += c;
    const json = (code, obj, headers = {}) => { res.writeHead(code, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(obj)); };
    if (url.pathname === '/.well-known/oauth-protected-resource/mcp') return json(200, { resource: `${base}/mcp`, authorization_servers: [base], scopes_supported: ['mcp:connect'] });
    if (url.pathname === '/.well-known/oauth-authorization-server') {
      return json(200, { issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register`,
        token_endpoint_auth_methods_supported: secret ? ['client_secret_post'] : ['none'] });
    }
    if (url.pathname === '/register') {
      state.registered++;
      const r = JSON.parse(body);
      assert.deepEqual(r.redirect_uris, ['http://localhost:4777/oauth/callback']);
      return json(201, { client_id: `vigie-client-${state.registered}`, ...(secret ? { client_secret: 'chut' } : {}), token_endpoint_auth_method: r.token_endpoint_auth_method });
    }
    if (url.pathname === '/token') {
      const f = new URLSearchParams(body);
      if (secret && f.get('client_secret') !== 'chut') return json(401, { error: 'invalid_client' });
      if (f.get('grant_type') === 'authorization_code') {
        const c = state.codes.get(f.get('code'));
        const ok = c && crypto.createHash('sha256').update(f.get('code_verifier')).digest('base64url') === c.challenge && f.get('redirect_uri') === 'http://localhost:4777/oauth/callback';
        if (!ok) return json(400, { error: 'invalid_grant' });
        const t = `jeton-${c.space}-1`;
        // comme Webflow : une nouvelle autorisation pour la même application annule les jetons d'avant
        if (oneGrantPerClient) for (const [k, v] of state.tokens) if (state.clientOf.get(k) === f.get('client_id')) state.tokens.delete(k);
        state.tokens.set(t, c.space);
        state.clientOf.set(t, f.get('client_id'));
        return json(200, { access_token: t, refresh_token: `refresh-${c.space}`, expires_in: c.expiresIn ?? 3600 });
      }
      if (f.get('grant_type') === 'refresh_token') {
        if (state.revoked) return json(400, { error: 'invalid_grant' }); // autorisation annulée (comme Webflow)
        state.refreshes++;
        const space = f.get('refresh_token').replace('refresh-', '');
        const t = `jeton-${space}-${state.refreshes + 1}`;
        state.tokens.set(t, space);
        return json(200, { access_token: t, expires_in: 3600 });
      }
    }
    if (url.pathname.startsWith('/mcp')) {
      const auth = String(req.headers.authorization || '').replace(/^Bearer /, '');
      state.seen.push({ path: url.pathname + url.search, auth, method: req.method, key: req.headers['x-vigie-key'], session: req.headers['mcp-session-id'] });
      if (!state.tokens.has(auth)) {
        res.writeHead(401, { 'WWW-Authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp", scope="mcp:connect"` });
        return res.end();
      }
      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('event: message\ndata: {"un":1}\n\n');
        setTimeout(() => { res.write('event: message\ndata: {"deux":2}\n\n'); res.end(); }, 50);
        return;
      }
      return json(200, { jsonrpc: '2.0', id: JSON.parse(body).id, result: { space: state.tokens.get(auth), method: JSON.parse(body).method } }, { 'Mcp-Session-Id': 'session-1' });
    }
    res.writeHead(404); res.end();
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, state, base: `http://127.0.0.1:${srv.address().port}` })));
}

// Le « navigateur » : lit l'adresse d'autorisation, choisit l'espace, renvoie le code à Vigie.
function approveIn(svc, url, space, expiresIn) {
  const u = new URL(url);
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(u.searchParams.get('resource'), `${svc.base}/mcp`);
  assert.equal(u.searchParams.get('scope'), 'mcp:connect');
  const code = `code-${space}`;
  svc.state.codes.set(code, { challenge: u.searchParams.get('code_challenge'), space, expiresIn });
  return new URLSearchParams({ state: u.searchParams.get('state'), code });
}

// Un moteur minimal qui relaie /mcp/<nom> par la passerelle.
function engine(gw) {
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost');
    const m = /^\/mcp\/([^/]+)(?:\/(.*))?$/.exec(u.pathname);
    gw.proxy(req, res, m[1], m[2] || '', u.search);
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, base: `http://127.0.0.1:${srv.address().port}` })));
}

test('WWW-Authenticate lu', () => {
  assert.deepEqual(parseAuthenticate('Bearer resource_metadata="https://x/.well-known/a",scope="mcp:connect"'), { resource_metadata: 'https://x/.well-known/a', scope: 'mcp:connect' });
});

test('passerelle : autorisée une fois, relaie JSON et flux SSE avec le jeton ; clé et origine vérifiées ; jeton expiré rafraîchi', async () => {
  const svc = await fakeService();
  const opened = [];
  const kc = memoryKeychain();
  let clock = Date.now();
  const gw = createGateway({ dataDir: path.join(TMP, 'a'), keychain: kc, openUrl: (u) => opened.push(u), now: () => clock });
  const cfg = gw.add('webflow', `${svc.base}/mcp`);
  assert.equal(cfg.url, 'http://127.0.0.1:4777/mcp/webflow');
  assert.match(cfg.headers['X-Vigie-Key'], /^[0-9a-f]{48}$/);
  assert.equal(gw.status().webflow.connected, false);

  const a = await gw.authorize('webflow');
  assert.equal(opened.length, 1, 'le navigateur s\'ouvre une fois');
  const done = await gw.callback(approveIn(svc, a.url, 'client-a', 120));
  assert.deepEqual([done.ok, done.label], [true, 'Principal']);
  assert.equal(svc.state.registered, 1);
  const st = gw.status().webflow;
  assert.equal(st.connected, true);
  assert.equal(st.profiles.length, 1);
  assert.ok(!JSON.stringify(st).includes('jeton-'), 'aucun jeton dans l\'état');
  assert.ok(!fs.readFileSync(gw.file, 'utf8').includes('jeton-'), 'aucun jeton dans le fichier');
  assert.ok([...kc._map.keys()].some((k) => k.startsWith('jeton:webflow:')), 'jeton dans le trousseau');

  const eng = await engine(gw);
  const key = cfg.headers['X-Vigie-Key'];
  const call = (init = {}, sub = '') => fetch(`${eng.base}/mcp/webflow${sub}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Vigie-Key': key, ...(init.headers || {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list' }), ...init });
  let r = await call();
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('mcp-session-id'), 'session-1', 'en-têtes du service transmis');
  assert.deepEqual((await r.json()).result, { space: 'client-a', method: 'tools/list' });
  assert.equal(svc.state.seen.at(-1).key, undefined, 'la clé locale ne part pas chez le service');

  // flux SSE relayé en continu
  r = await fetch(`${eng.base}/mcp/webflow`, { headers: { 'X-Vigie-Key': key, Accept: 'text/event-stream' } });
  assert.equal(r.headers.get('content-type'), 'text/event-stream');
  assert.equal(await r.text(), 'event: message\ndata: {"un":1}\n\nevent: message\ndata: {"deux":2}\n\n');

  // clé fausse, page web (Origin) : refusés sans rien envoyer au service
  const before = svc.state.seen.length;
  assert.equal((await call({ headers: { 'X-Vigie-Key': 'faux' } })).status, 403);
  assert.equal((await call({ headers: { Origin: 'https://site.example' } })).status, 403);
  assert.equal(svc.state.seen.length, before);

  // jeton bientôt expiré : rafraîchi avant l'appel
  clock += 100_000;
  r = await call();
  assert.equal(svc.state.refreshes, 1);
  assert.equal(svc.state.seen.at(-1).auth, 'jeton-client-a-2');
  // essai rapide : un espace accepté reste tel quel
  await gw.verify('webflow');
  assert.equal(gw.status().webflow.connected, true);
  // jeton refusé par le service (révoqué) : rafraîchi et requête rejouée une fois
  svc.state.tokens.delete('jeton-client-a-2');
  r = await call();
  assert.equal(r.status, 200);
  assert.equal(svc.state.refreshes, 2);
  // autorisation annulée chez le service (jeton et rafraîchissement refusés) : l'essai la marque à réautoriser
  svc.state.tokens.clear();
  const realRefresh = svc.state.refreshes;
  await gw.verify('webflow');
  assert.equal(svc.state.refreshes, realRefresh + 1, 'un rafraîchissement tenté');
  svc.state.tokens.clear();
  svc.state.revoked = true;
  await gw.verify('webflow');
  assert.ok(gw.status().webflow.profiles[0].error, 'marqué à réautoriser');
  assert.equal(gw.status().webflow.connected, false);
  eng.srv.close(); svc.srv.close();
});

test('espaces : un deuxième espace autorisé n\'annule pas le premier (une inscription par espace), changement en un clic ; secret au trousseau', async () => {
  const svc = await fakeService({ secret: true, oneGrantPerClient: true });
  const opened = [];
  const kc = memoryKeychain();
  const gw = createGateway({ dataDir: path.join(TMP, 'b'), keychain: kc, openUrl: (u) => opened.push(u) });
  const cfg = gw.add('webflow-pro', `${svc.base}/mcp`);
  await gw.callback(approveIn(svc, (await gw.authorize('webflow-pro', { label: 'Client A' })).url, 'client-a'));
  await gw.callback(approveIn(svc, (await gw.authorize('webflow-pro', { label: 'Client B' })).url, 'client-b'));
  assert.equal(svc.state.registered, 2, 'une inscription par espace : le service ne les confond pas');
  assert.ok(!fs.readFileSync(gw.file, 'utf8').includes('chut'), 'secret d\'application hors du fichier');
  const st = gw.status()['webflow-pro'];
  assert.deepEqual(st.profiles.map((p) => p.label), ['Client A', 'Client B']);
  assert.equal(st.active, st.profiles[1].id, 'le dernier autorisé devient actif');
  const eng = await engine(gw);
  const space = async () => (await (await fetch(`${eng.base}/mcp/webflow-pro`, { method: 'POST', headers: { 'X-Vigie-Key': cfg.headers['X-Vigie-Key'], 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) })).json()).result.space;
  assert.equal(await space(), 'client-b');
  gw.activate('webflow-pro', st.profiles[0].id);
  assert.equal(await space(), 'client-a', 'changement d\'espace immédiat');
  assert.equal(opened.length, 2, 'aucune autorisation de plus');
  gw.removeProfile('webflow-pro', st.profiles[0].id);
  assert.equal(gw.status()['webflow-pro'].active, st.profiles[1].id);
  assert.ok(![...kc._map.keys()].includes(`jeton:webflow-pro:${st.profiles[0].id}`), 'jeton de l\'espace retiré du trousseau');
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(gw.file, 'utf8')).clients).length, 1, 'son inscription aussi');
  // réautoriser un espace garde son inscription (pas de nouvelle)
  await gw.callback(approveIn(svc, (await gw.authorize('webflow-pro', { id: st.profiles[1].id })).url, 'client-b'));
  assert.equal(svc.state.registered, 2);
  gw.remove('webflow-pro');
  assert.equal(gw.status()['webflow-pro'], undefined);
  eng.srv.close(); svc.srv.close();
});

test('pas encore autorisé, service sans autorisation, adresse ou nom invalides', async () => {
  const svc = await fakeService();
  const gw = createGateway({ dataDir: path.join(TMP, 'c'), keychain: memoryKeychain(), openUrl: () => {} });
  const cfg = gw.add('notion', `${svc.base}/mcp`);
  const eng = await engine(gw);
  const r = await fetch(`${eng.base}/mcp/notion`, { method: 'POST', headers: { 'X-Vigie-Key': cfg.headers['X-Vigie-Key'] }, body: '{}' });
  assert.equal(r.status, 503, 'pas 401 : Claude Code ne doit pas chercher à s\'autoriser auprès de Vigie');
  assert.match((await r.json()).error.message, /autorise-le dans Vigie/);
  assert.throws(() => gw.add('../x', 'https://a.example/mcp'), /Nom de MCP invalide/);
  assert.throws(() => gw.add('x', 'http://a.example/mcp'), /https/);
  assert.equal(gw.ready('notion'), false, 'pas autorisé : les comptes ne basculent pas');
  const bad = await gw.callback(new URLSearchParams({ state: 'inconnu', code: 'x' }));
  assert.equal(bad.ok, false);
  eng.srv.close(); svc.srv.close();
});
