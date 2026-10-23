// Vigie — passerelle MCP : une seule autorisation par service, valable pour tous les comptes Claude.
//
// Chaque compte déclare le MCP comme http://127.0.0.1:<port>/mcp/<nom>, avec un en-tête X-Vigie-Key (clé tirée au
// hasard, propre à ce MCP). Vigie y ajoute le jeton du service et relaie la requête telle quelle (réponse JSON ou
// flux SSE, en continu). Un compte n'a donc rien à autoriser : la passerelle l'a fait une fois pour tous.
//
// Autorisation (spécification MCP) : découverte de la ressource protégée (RFC 9728) et du serveur d'autorisation
// (RFC 8414), inscription automatique de Vigie (RFC 7591), code d'autorisation avec PKCE S256, ressource visée
// (RFC 8707), rafraîchissement du jeton. Plusieurs autorisations par MCP (« espaces » : un espace Webflow par client,
// par exemple) ; une seule est active, on en change en un clic, sans rien réautoriser.
//
// Jetons et secrets d'application : trousseau du Mac (service « Vigie MCP »), jamais dans les fichiers ni les
// journaux. data/gateway.json ne garde que les adresses, les clés locales et les noms d'espaces.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { spawnSync, spawn } from 'node:child_process';

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PENDING_MS = 15 * 60_000;     // une autorisation commencée vaut 15 min
const REFRESH_BEFORE = 60_000;       // jeton rafraîchi s'il expire dans moins d'une minute
const MAX_BODY = 10 * 1024 * 1024;   // requête MCP relayée : 10 Mo au plus

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const sha = (s) => crypto.createHash('sha256').update(s).digest();
const hashId = (s) => sha(String(s)).toString('hex').slice(0, 16);
const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);

export class GatewayError extends Error {}

// Trousseau du Mac : une entrée par jeton ou secret, contenu JSON en base64 (rien dans les arguments de commande :
// l'écriture passe par l'entrée standard de `security -i`).
export function macKeychain({ service = 'Vigie MCP', bin = '/usr/bin/security' } = {}) {
  const safe = (a) => { if (!/^[A-Za-z0-9:._-]{1,200}$/.test(a)) throw new GatewayError('Nom d\'entrée de trousseau invalide'); return a; };
  return {
    get(account) {
      const r = spawnSync(bin, ['find-generic-password', '-s', service, '-a', safe(account), '-w'], { encoding: 'utf8', timeout: 5000 });
      if (r.status !== 0) return null;
      try { return JSON.parse(Buffer.from(r.stdout.trim(), 'base64').toString('utf8')); } catch { return null; }
    },
    set(account, value) {
      const data = Buffer.from(JSON.stringify(value)).toString('base64');
      const r = spawnSync(bin, ['-i'], { input: `add-generic-password -U -s "${service}" -a "${safe(account)}" -w "${data}"\n`, encoding: 'utf8', timeout: 5000 });
      if (r.status !== 0) throw new GatewayError('Trousseau du Mac : écriture impossible');
    },
    delete(account) { spawnSync(bin, ['delete-generic-password', '-s', service, '-a', safe(account)], { timeout: 5000 }); },
  };
}

// Mémoire seulement (tests).
export function memoryKeychain() {
  const m = new Map();
  return { get: (a) => (m.has(a) ? JSON.parse(m.get(a)) : null), set: (a, v) => { m.set(a, JSON.stringify(v)); }, delete: (a) => { m.delete(a); }, _map: m };
}

// WWW-Authenticate: Bearer resource_metadata="…", scope="…" → { resource_metadata, scope, … }
export function parseAuthenticate(header) {
  const out = {};
  for (const m of String(header || '').matchAll(/([a-zA-Z_]+)="([^"]*)"/g)) out[m[1].toLowerCase()] = m[2];
  return out;
}

export function createGateway({
  dataDir, port = 4777, keychain = macKeychain(), fetchImpl = globalThis.fetch, now = () => Date.now(),
  openUrl = (u) => { try { spawn('/usr/bin/open', [u], { stdio: 'ignore', detached: true }).unref(); } catch { /* le lien reste affiché */ } },
  requestImpl = null, log = () => {},
} = {}) {
  const FILE = path.join(dataDir, 'gateway.json');
  // port : nombre, ou fonction (moteur lancé sur un port libre)
  const portOf = () => (typeof port === 'function' ? port() : port);
  const redirectUriOf = () => `http://localhost:${portOf()}/oauth/callback`;
  const pending = new Map();   // state -> autorisation en cours
  const tokens = new Map();    // compte de trousseau -> jetons (évite de relire le trousseau à chaque requête)
  const refreshing = new Map();

  const read = () => {
    try { const j = JSON.parse(fs.readFileSync(FILE, 'utf8')); return { servers: isObj(j.servers) ? j.servers : {}, clients: isObj(j.clients) ? j.clients : {} }; } catch { return { servers: {}, clients: {} }; }
  };
  const write = (j) => {
    fs.mkdirSync(dataDir, { recursive: true });
    const tmp = `${FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(j, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, FILE);
  };
  const tokenKey = (name, profileId) => `jeton:${name}:${profileId}`;
  const clientKey = (issuer) => `client:${hashId(issuer)}`;
  const iso = () => new Date(now()).toISOString();

  function server(name) {
    const s = read().servers[name];
    if (!s) throw new GatewayError(`« ${name} » ne passe pas par Vigie`);
    return s;
  }

  // Ce que chaque compte Claude déclare pour ce MCP.
  function accountConfig(name) {
    const s = server(name);
    // 127.0.0.1 et pas localhost : Vigie n'écoute qu'en IPv4, localhost peut viser ::1 d'abord
    return { type: 'http', url: `http://127.0.0.1:${portOf()}/mcp/${name}`, headers: { 'X-Vigie-Key': s.key } };
  }

  function add(name, url) {
    if (!NAME_RE.test(name)) throw new GatewayError('Nom de MCP invalide');
    let u;
    try { u = new URL(url); } catch { throw new GatewayError('Adresse invalide'); }
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname))) throw new GatewayError('Adresse https:// attendue');
    const j = read();
    const old = j.servers[name];
    j.servers[name] = { url: u.toString(), key: old?.key || crypto.randomBytes(24).toString('hex'), profiles: old?.profiles || [], active: old?.active || null, addedAt: old?.addedAt || iso(), open: old?.open || false };
    write(j);
    return accountConfig(name);
  }

  // Oublie un espace : son jeton, et son inscription chez le service (avec son secret) si elle lui est propre.
  function forget(j, name, profileId) {
    const ref = stored(name, profileId)?.client;
    keychain.delete(tokenKey(name, profileId));
    tokens.delete(tokenKey(name, profileId));
    if (ref?.includes('#') && j.clients[ref]) {
      if (j.clients[ref].hasSecret) keychain.delete(clientKey(ref));
      delete j.clients[ref];
    }
  }

  function remove(name) {
    const j = read();
    const s = j.servers[name];
    if (!s) return;
    for (const p of s.profiles || []) forget(j, name, p.id);
    delete j.servers[name];
    write(j);
    changed(name, { forget: true });
  }

  // ----- découverte -----
  async function getJson(url, init = {}) {
    const r = await fetchImpl(url, { ...init, headers: { Accept: 'application/json', ...(init.headers || {}) }, signal: AbortSignal.timeout(15_000) });
    let body = null;
    try { body = await r.json(); } catch { /* pas du JSON */ }
    return { ok: r.ok, status: r.status, body, headers: r.headers };
  }
  function wellKnown(base, kind) {
    const u = new URL(base);
    const p = u.pathname.replace(/\/$/, '');
    return [`${u.origin}/.well-known/${kind}${p}`, ...(p ? [`${u.origin}/.well-known/${kind}`] : [])];
  }
  async function discover(mcpUrl) {
    const probe = await fetchImpl(mcpUrl, {
      method: 'POST', signal: AbortSignal.timeout(15_000),
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'Vigie', version: '1' } } }),
    });
    try { await probe.body?.cancel?.(); } catch { /* rien à lire */ }
    if (probe.status !== 401) return { open: probe.ok };
    const wa = parseAuthenticate(probe.headers.get('www-authenticate'));
    let resource = mcpUrl, issuer = null, scope = wa.scope || null;
    for (const u of wa.resource_metadata ? [wa.resource_metadata] : wellKnown(mcpUrl, 'oauth-protected-resource')) {
      const r = await getJson(u).catch(() => null);
      if (r?.ok && isObj(r.body)) {
        resource = r.body.resource || resource;
        issuer = Array.isArray(r.body.authorization_servers) ? r.body.authorization_servers[0] : null;
        if (!scope && Array.isArray(r.body.scopes_supported) && r.body.scopes_supported.length) scope = r.body.scopes_supported.join(' ');
        break;
      }
    }
    issuer ||= new URL(mcpUrl).origin; // ancienne spécification : le serveur MCP est aussi le serveur d'autorisation
    let meta = null;
    for (const u of [...wellKnown(issuer, 'oauth-authorization-server'), ...wellKnown(issuer, 'openid-configuration')]) {
      const r = await getJson(u).catch(() => null);
      if (r?.ok && isObj(r.body) && r.body.authorization_endpoint && r.body.token_endpoint) { meta = r.body; break; }
    }
    if (!meta) throw new GatewayError('Ce service ne publie pas comment l\'autoriser');
    return { open: false, resource, scope, issuer: meta.issuer || issuer, authorizationEndpoint: meta.authorization_endpoint, tokenEndpoint: meta.token_endpoint,
      registrationEndpoint: meta.registration_endpoint || null, authMethods: meta.token_endpoint_auth_methods_supported || ['client_secret_basic'] };
  }

  // ----- inscription de Vigie auprès du service : une par espace -----
  // Webflow ne garde qu'une autorisation active par application et par utilisateur (vérifié le 2026-10-21 :
  // autoriser un 2e espace annulait le 1er). Avec une inscription par espace, chaque espace a la sienne.
  // ref : « <émetteur>#<mcp>#<espace> » (les anciennes inscriptions, une par émetteur, restent lues).
  async function client(meta, ref) {
    const j = read();
    const known = j.clients[ref];
    const redirectUri = redirectUriOf();
    if (known?.clientId && known.redirectUri === redirectUri) return known;
    if (!meta.registrationEndpoint) throw new GatewayError('Ce service n\'accepte pas l\'inscription automatique d\'une application');
    const method = meta.authMethods.includes('none') ? 'none' : meta.authMethods.includes('client_secret_post') ? 'client_secret_post' : 'client_secret_basic';
    const r = await getJson(meta.registrationEndpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: 'Vigie', redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: method }),
    });
    if ([401, 403].includes(r.status)) throw new GatewayError('Ce service n\'accepte que certaines applications (comme Claude Code) : il reste branché compte par compte');
    if (!r.ok || !r.body?.client_id) throw new GatewayError(`Inscription de Vigie refusée par le service (${r.status})`);
    const c = { clientId: r.body.client_id, redirectUri, tokenAuth: r.body.token_endpoint_auth_method || method, hasSecret: !!r.body.client_secret, registeredAt: iso() };
    if (r.body.client_secret) keychain.set(clientKey(ref), { client_secret: r.body.client_secret });
    const j2 = read();
    j2.clients[ref] = c;
    write(j2);
    return c;
  }

  function clientAuth(issuer, c, form) {
    const headers = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
    const secret = c.hasSecret ? keychain.get(clientKey(issuer))?.client_secret : null;
    if (secret && c.tokenAuth === 'client_secret_basic') {
      headers.Authorization = `Basic ${Buffer.from(`${encodeURIComponent(c.clientId)}:${encodeURIComponent(secret)}`).toString('base64')}`;
    } else {
      form.set('client_id', c.clientId);
      if (secret) form.set('client_secret', secret);
    }
    return headers;
  }

  // ----- autorisation : ouvre la page du service ; la réponse revient sur /oauth/callback -----
  // profile : { id } pour réautoriser un espace, { label } pour en ajouter un ; rien : l'espace actif (ou le premier).
  async function authorize(name, profile = {}) {
    const s = server(name);
    const meta = await discover(s.url);
    if (meta.open) {
      const j = read(); j.servers[name].open = true; write(j);
      return { ok: true, open: true };
    }
    const existing = profile.id ? s.profiles.find((p) => p.id === profile.id) : profile.label ? null : s.profiles.find((p) => p.id === s.active);
    const profileId = existing?.id || b64url(crypto.randomBytes(6));
    const label = String(profile.label || existing?.label || 'Principal').slice(0, 60);
    const ref = `${meta.issuer}#${name}#${profileId}`;
    const c = await client(meta, ref);
    const verifier = b64url(crypto.randomBytes(32));
    const state = b64url(crypto.randomBytes(24));
    for (const [k, v] of pending) if (now() - v.at > PENDING_MS) pending.delete(k);
    pending.set(state, { name, profileId, label, verifier, meta: { ...meta, client: ref }, at: now() });
    const u = new URL(meta.authorizationEndpoint);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('client_id', c.clientId);
    u.searchParams.set('redirect_uri', redirectUriOf());
    u.searchParams.set('code_challenge', b64url(sha(verifier)));
    u.searchParams.set('code_challenge_method', 'S256');
    u.searchParams.set('state', state);
    u.searchParams.set('resource', meta.resource);
    if (meta.scope) u.searchParams.set('scope', meta.scope);
    openUrl(u.toString());
    return { ok: true, url: u.toString() };
  }

  async function tokenRequest(meta, form) {
    const ref = meta.client || meta.issuer;
    const c = read().clients[ref];
    if (!c) throw new GatewayError('Vigie n\'est plus inscrit auprès de ce service : réautorise');
    const headers = clientAuth(ref, c, form);
    const r = await getJson(meta.tokenEndpoint, { method: 'POST', headers, body: form.toString() });
    if (!r.ok || !r.body?.access_token) throw new GatewayError(`Le service a refusé (${r.status}${r.body?.error ? ` : ${r.body.error}` : ''})`);
    const b = r.body;
    return { access_token: b.access_token, refresh_token: b.refresh_token || null, token_type: b.token_type || 'Bearer',
      expires_at: Number.isFinite(Number(b.expires_in)) ? now() + Number(b.expires_in) * 1000 : null, scope: b.scope || meta.scope || null };
  }

  // Retour du navigateur : échange du code contre un jeton, rangé dans le trousseau. Renvoie { ok, name, label } ou { ok:false, error }.
  async function callback(params) {
    const p = pending.get(String(params.get('state') || ''));
    if (!p) return { ok: false, error: 'Autorisation inconnue ou expirée : recommence depuis Vigie.' };
    pending.delete(params.get('state'));
    if (params.get('error')) return { ok: false, name: p.name, error: `Le service a refusé : ${params.get('error_description') || params.get('error')}` };
    const form = new URLSearchParams({ grant_type: 'authorization_code', code: String(params.get('code') || ''), redirect_uri: redirectUriOf(), code_verifier: p.verifier, resource: p.meta.resource });
    let t;
    try { t = await tokenRequest(p.meta, form); } catch (e) { return { ok: false, name: p.name, error: e.message }; }
    const j = read();
    const s = j.servers[p.name];
    if (!s) return { ok: false, error: 'Ce MCP a été retiré entre-temps.' };
    let profile = s.profiles.find((x) => x.id === p.profileId);
    if (!profile) {
      profile = { id: p.profileId, label: p.label, addedAt: iso() };
      s.profiles.push(profile);
    }
    profile.authorizedAt = iso();
    delete profile.error;
    s.active = profile.id;
    const stored = { ...t, issuer: p.meta.issuer, client: p.meta.client, tokenEndpoint: p.meta.tokenEndpoint, resource: p.meta.resource, scopeAsked: p.meta.scope };
    keychain.set(tokenKey(p.name, profile.id), stored);
    tokens.set(tokenKey(p.name, profile.id), stored);
    write(j);
    changed(p.name);
    log(`passerelle : « ${p.name} » autorisé (${profile.label})`);
    return { ok: true, name: p.name, label: profile.label };
  }

  function stored(name, profileId) {
    const k = tokenKey(name, profileId);
    if (!tokens.has(k)) { const v = keychain.get(k); if (v) tokens.set(k, v); }
    return tokens.get(k) || null;
  }

  function markError(name, profileId, error) {
    const j = read();
    const p = j.servers[name]?.profiles?.find((x) => x.id === profileId);
    if (p) { p.error = String(error).slice(0, 200); write(j); }
  }
  // Le service a répondu avec ce jeton : une marque « à réautoriser » restée d'avant ne vaut plus.
  function clearError(name, profileId) {
    const j = read();
    const p = j.servers[name]?.profiles?.find((x) => x.id === profileId);
    if (p?.error) { delete p.error; write(j); }
  }

  async function refresh(name, profileId) {
    const k = tokenKey(name, profileId);
    if (refreshing.has(k)) return refreshing.get(k);
    const job = (async () => {
      const t = stored(name, profileId);
      if (!t?.refresh_token) throw new GatewayError(`« ${name} » doit être réautorisé dans Vigie`);
      const meta = { issuer: t.issuer, client: t.client, tokenEndpoint: t.tokenEndpoint, resource: t.resource, scope: t.scopeAsked };
      const form = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: t.refresh_token, resource: t.resource });
      const n = await tokenRequest(meta, form);
      const next = { ...t, ...n, refresh_token: n.refresh_token || t.refresh_token };
      keychain.set(k, next);
      tokens.set(k, next);
      clearError(name, profileId);
      return next;
    })();
    refreshing.set(k, job);
    // Seul un refus du service marque l'espace « à réautoriser » ; une coupure réseau (fetch failed, délai) ne dit
    // rien de l'autorisation (2026-10-23 : un espace marqué ainsi alors qu'il marchait sur tous les comptes).
    try { return await job; } catch (e) { if (e instanceof GatewayError) markError(name, profileId, e.message); throw e; } finally { refreshing.delete(k); }
  }

  async function accessToken(name, { force = false } = {}) {
    const s = server(name);
    if (s.open) return null;
    if (!s.active) throw new GatewayError(`« ${name} » n'est pas encore autorisé : autorise-le dans Vigie (page MCP)`);
    let t = stored(name, s.active);
    if (!t) throw new GatewayError(`« ${name} » doit être réautorisé dans Vigie (page MCP)`);
    if (force || (t.expires_at && t.expires_at - now() < REFRESH_BEFORE)) t = await refresh(name, s.active);
    return t.access_token;
  }

  // ----- sessions des conversations -----
  // Une session MCP du service reste liée à l'autorisation qui l'a ouverte (Webflow : l'espace du jeton du début,
  // vu le 2026-10-23). La passerelle garde donc, pour chaque session d'une conversation, la session du service qui la
  // sert et l'autorisation sous laquelle elle a été ouverte. Quand l'autorisation change (autre espace, réautorisation),
  // elle en rouvre une en coulisse avec le nouveau jeton, sous le même identifiant pour la conversation, et ferme les
  // flux d'écoute (Claude Code les rouvre et relit ses outils) : rien à recharger dans VS Code.
  // Pas encore autorisé au démarrage d'une conversation : la passerelle répond elle-même (un outil qui dit d'autoriser
  // dans Vigie), puis prévient la conversation que ses outils ont changé dès l'autorisation. Avant, elle répondait
  // une erreur, et Claude Code abandonnait ce MCP jusqu'au rechargement de VS Code.
  const epochs = new Map();    // nom -> numéro de l'autorisation en cours
  const sessions = new Map();  // session vue par la conversation -> { name, upstream, epoch, init, proto, local, at }
  const listeners = new Map(); // nom -> flux d'écoute ouverts { res, up, local }
  const SESSIONS_MAX = 1000;
  const epochOf = (name) => epochs.get(name) || 0;
  function remember(sid, entry) {
    entry.at = now();
    sessions.set(sid, entry);
    if (sessions.size > SESSIONS_MAX) {
      const old = [...sessions.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, sessions.size - SESSIONS_MAX);
      for (const [k] of old) sessions.delete(k);
    }
    return entry;
  }
  const LIST_CHANGED = `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })}\n\n`;
  // L'autorisation de ce MCP a changé : les sessions seront rouvertes à leur prochaine requête ; flux d'écoute fermés
  // (ceux de la passerelle préviennent d'abord que les outils ont changé).
  function changed(name, { forget = false } = {}) {
    epochs.set(name, epochOf(name) + 1);
    for (const l of listeners.get(name) || []) {
      try {
        if (l.up) { l.up.unpipe(l.res); l.up.destroy(); }
        if (l.local) l.res.write(LIST_CHANGED);
        l.res.end();
      } catch { /* déjà fermé */ }
    }
    listeners.delete(name);
    if (forget) for (const [k, e] of sessions) if (e.name === name) sessions.delete(k);
  }
  function listen(name, res, l) {
    if (!listeners.has(name)) listeners.set(name, new Set());
    const entry = { res, ...l };
    listeners.get(name).add(entry);
    res.on('close', () => listeners.get(name)?.delete(entry));
  }
  const drain = (up) => new Promise((resolve) => { up.on('end', resolve); up.on('error', resolve); up.on('close', resolve); up.resume(); });
  // Rouvre une session du service pour cette conversation, avec l'autorisation en cours. Une seule à la fois par session.
  function reopen(name, s, entry) {
    if (entry.reopening) return entry.reopening;
    entry.reopening = (async () => {
      const target = new URL(s.url);
      const init = entry.init || Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize',
        params: { protocolVersion: entry.proto || '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: '1' } } }));
      for (let attempt = 0; attempt < 2; attempt++) {
        const token = await accessToken(name, { force: attempt > 0 });
        const h = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'content-length': String(init.length) };
        if (entry.proto) h['mcp-protocol-version'] = entry.proto;
        if (token) h.authorization = `Bearer ${token}`;
        const up = await send(target, 'POST', h, init);
        const sid = up.headers['mcp-session-id'] || null;
        await drain(up);
        if (up.statusCode === 401 && token && attempt === 0) continue;
        if (up.statusCode < 200 || up.statusCode >= 300) return false;
        if (sid) {
          // fin de l'ouverture (spécification MCP) : notifications/initialized
          const n = Buffer.from(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
          try { await drain(await send(target, 'POST', { ...h, 'content-length': String(n.length), 'mcp-session-id': sid }, n)); } catch { /* le service la tient pour faite */ }
        }
        Object.assign(entry, { upstream: sid, epoch: epochOf(name), local: false });
        return true;
      }
      return false;
    })().finally(() => { entry.reopening = null; });
    return entry.reopening;
  }
  // Session tenue par la passerelle tant que le MCP n'est pas autorisé.
  function localSession(req, res, name, sid, msg) {
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
      res.write(': vigie\n\n');
      return listen(name, res, { local: true });
    }
    if (req.method === 'DELETE') { sessions.delete(sid); res.writeHead(200); return res.end(); }
    if (!isObj(msg) || msg.id === undefined || msg.id === null) { res.writeHead(202); return res.end(); }
    const text = `« ${name} » n'est pas encore autorisé : l'utilisateur doit l'autoriser dans Vigie (page MCP). Ses outils apparaîtront ici tout seuls ensuite, sans recharger VS Code.`;
    const result = msg.method === 'tools/list' ? { tools: [{ name: 'autoriser_dans_vigie', description: text, inputSchema: { type: 'object', properties: {} } }] }
      : msg.method === 'tools/call' ? { content: [{ type: 'text', text }], isError: true }
      : msg.method === 'ping' ? {}
      : null;
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(result ? { jsonrpc: '2.0', id: msg.id, result } : { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: text } }));
  }

  // ----- relais : http://localhost:<port>/mcp/<nom>[/…] → le service, avec son jeton -----
  function reply(res, status, message) {
    if (res.headersSent) return res.end();
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: `Vigie : ${message}` } }));
  }
  const DROP = new Set(['host', 'connection', 'keep-alive', 'authorization', 'x-vigie-key', 'content-length', 'transfer-encoding', 'upgrade', 'proxy-connection', 'te', 'trailer', 'origin', 'cookie']);

  function send(target, method, headers, body) {
    const lib = target.protocol === 'http:' ? http : https;
    const req = (requestImpl || lib.request)(target, { method, headers });
    return new Promise((resolve, reject) => {
      req.on('response', resolve);
      req.on('error', reject);
      req.end(body);
    });
  }

  async function proxy(req, res, name, rest = '', search = '') {
    let s;
    try { s = server(name); } catch { return reply(res, 404, `« ${name} » ne passe pas par Vigie`); }
    // Pas de page web : seuls les clients MCP locaux (sans en-tête Origin) avec la clé de ce MCP passent.
    if (req.headers.origin) return reply(res, 403, 'origine refusée');
    const key = String(req.headers['x-vigie-key'] || '');
    if (key.length !== s.key.length || !crypto.timingSafeEqual(Buffer.from(key), Buffer.from(s.key))) return reply(res, 403, 'clé de passerelle invalide');
    const chunks = [];
    let size = 0;
    for await (const c of req) { size += c.length; if (size > MAX_BODY) return reply(res, 413, 'requête trop grande'); chunks.push(c); }
    const body = Buffer.concat(chunks);
    let msg = null;
    try { msg = body.length ? JSON.parse(body.toString('utf8')) : null; } catch { /* pas du JSON : relayé tel quel */ }
    const isInit = !rest && req.method === 'POST' && isObj(msg) && msg.method === 'initialize';
    const sid = String(req.headers['mcp-session-id'] || '') || null;
    let entry = sid ? sessions.get(sid) : null;
    // Session inconnue (moteur relancé) : reprise telle quelle, pour pouvoir la rouvrir au prochain changement.
    if (sid && !entry && !rest) entry = remember(sid, { name, upstream: sid, epoch: epochOf(name), init: null, proto: req.headers['mcp-protocol-version'] || null, local: false });
    if (entry) entry.at = now();
    if (!s.open && !ready(name)) {
      if (isInit && !sid) {
        const id = `vigie-${b64url(crypto.randomBytes(18))}`;
        remember(id, { name, upstream: null, epoch: -1, init: body, proto: msg.params?.protocolVersion || null, local: true });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Mcp-Session-Id': id });
        return res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {
          protocolVersion: msg.params?.protocolVersion || '2025-06-18', capabilities: { tools: { listChanged: true } },
          serverInfo: { name: `vigie-${name}`, version: '1' },
          instructions: `« ${name} » passe par Vigie et n'est pas encore autorisé : ses outils arriveront dès que l'utilisateur l'aura autorisé dans Vigie.` } }));
      }
      if (entry?.local) return localSession(req, res, name, sid, msg);
    }
    // Autorisation changée depuis l'ouverture de la session (ou session de la passerelle) : rouverte en coulisse.
    if (entry && (entry.local || entry.epoch !== epochOf(name))) {
      let ok = false;
      try { ok = await reopen(name, s, entry); } catch (e) { return reply(res, 503, e.message); }
      if (!ok) return reply(res, 502, `le service n'a pas rouvert la session de « ${name} »`);
    }
    const target = new URL(s.url);
    if (rest) target.pathname = `${target.pathname.replace(/\/$/, '')}/${rest}`;
    if (search) target.search = search;
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (!DROP.has(k.toLowerCase())) headers[k] = v;
    if (entry) { if (entry.upstream) headers['mcp-session-id'] = entry.upstream; else delete headers['mcp-session-id']; }
    if (body.length) headers['content-length'] = String(body.length);
    let up;
    for (let attempt = 0; attempt < 2; attempt++) {
      let token;
      try { token = await accessToken(name, { force: attempt > 0 }); } catch (e) { return reply(res, 503, e.message); }
      if (token) headers.authorization = `Bearer ${token}`;
      try { up = await send(target, req.method, headers, body.length ? body : undefined); } catch (e) { return reply(res, 502, `service injoignable (${e.code || e.message})`); }
      if (up.statusCode !== 401 || !token || attempt > 0) break;
      up.resume(); // jeton refusé : on rafraîchit et on réessaie une fois
    }
    if (up.statusCode === 401) { up.resume(); markError(name, s.active, 'Jeton refusé'); return reply(res, 503, `« ${name} » doit être réautorisé dans Vigie (page MCP)`); }
    if (up.statusCode < 400 && s.active && s.profiles?.find((p) => p.id === s.active)?.error) clearError(name, s.active);
    const out = {};
    for (const [k, v] of Object.entries(up.headers)) if (!['connection', 'keep-alive', 'transfer-encoding', 'set-cookie'].includes(k)) out[k] = v;
    const upSid = up.headers['mcp-session-id'];
    if (isInit && !sid && upSid) remember(String(upSid), { name, upstream: String(upSid), epoch: epochOf(name), init: body, proto: msg.params?.protocolVersion || null, local: false });
    else if (entry && upSid) out['mcp-session-id'] = sid; // la conversation garde son identifiant
    if (entry && (up.statusCode === 404 || req.method === 'DELETE')) sessions.delete(sid); // fermée côté service : elle se rouvrira d'elle-même
    res.writeHead(up.statusCode, out);
    res.on('close', () => up.destroy());
    // flux d'écoute : fermé si l'autorisation change (Claude Code le rouvre et relit ses outils)
    if (req.method === 'GET' && String(up.headers['content-type'] || '').includes('text/event-stream')) listen(name, res, { up, local: false });
    up.pipe(res);
  }

  // Essai rapide de l'espace actif (initialize avec son jeton, rafraîchi au besoin) : un espace que le service
  // n'accepte plus est marqué « à réautoriser » tout de suite, pas à la prochaine requête d'une conversation.
  async function verify(name) {
    const s = read().servers[name];
    if (!s || s.open) return;
    const probe = async (token) => {
      const r = await fetchImpl(s.url, { method: 'POST', signal: AbortSignal.timeout(15_000),
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'Vigie', version: '1' } } }) });
      try { await r.body?.cancel?.(); } catch { /* rien à lire */ }
      return r.status;
    };
    // chaque espace, pas seulement l'actif : le menu montre « à réautoriser » avant qu'on y passe
    for (const p of s.profiles || []) {
      const t = stored(name, p.id);
      if (!t) continue;
      try {
        let status = await probe(t.access_token);
        if (status === 401) status = await probe((await refresh(name, p.id)).access_token);
        if (status === 401) markError(name, p.id, 'Jeton refusé par le service');
        else if (status >= 200 && status < 300) clearError(name, p.id);
      } catch { /* refresh a déjà noté l'erreur, ou service injoignable : rien à conclure */ }
    }
  }

  // ----- espaces -----
  function activate(name, profileId) {
    const j = read();
    const s = j.servers[name];
    if (!s?.profiles?.some((p) => p.id === profileId)) throw new GatewayError('Espace inconnu');
    s.active = profileId;
    write(j);
    changed(name);
  }
  function renameProfile(name, profileId, label) {
    const j = read();
    const p = j.servers[name]?.profiles?.find((x) => x.id === profileId);
    if (!p) throw new GatewayError('Espace inconnu');
    p.label = String(label || '').trim().slice(0, 60) || p.label;
    write(j);
  }
  function removeProfile(name, profileId) {
    const j = read();
    const s = j.servers[name];
    if (!s) return;
    s.profiles = (s.profiles || []).filter((p) => p.id !== profileId);
    const wasActive = s.active === profileId;
    if (wasActive) s.active = s.profiles[0]?.id || null;
    forget(j, name, profileId);
    write(j);
    if (wasActive) changed(name);
  }

  // État pour l'app (aucun jeton, aucune clé).
  function status() {
    const j = read();
    return Object.fromEntries(Object.entries(j.servers).map(([name, s]) => [name, {
      url: s.url, open: !!s.open, active: s.active,
      connected: !!s.open || (!!s.active && !s.profiles.find((p) => p.id === s.active)?.error && !!stored(name, s.active)),
      profiles: (s.profiles || []).map((p) => ({ id: p.id, label: p.label, authorizedAt: p.authorizedAt || null, error: p.error || null })),
    }]));
  }
  const names = () => Object.keys(read().servers);
  // Prêt à servir les comptes : sans autorisation (open), ou un espace actif dont on a le jeton.
  const ready = (name) => { const s = read().servers[name]; return !!s && (!!s.open || (!!s.active && !!stored(name, s.active))); };
  const has = (name) => !!read().servers[name];

  return { add, remove, authorize, callback, proxy, accessToken, activate, renameProfile, removeProfile, status, names, has, ready, verify, accountConfig, discover, redirectUri: redirectUriOf, file: FILE };
}
