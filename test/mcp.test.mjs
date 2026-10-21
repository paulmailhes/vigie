// Tests des MCP : node --test test/
// Tout se passe dans un dossier temporaire (HOME, ~/Code, comptes, VIGIE_DATA) : les vrais
// .claude.json et .mcp.json de l'utilisateur ne sont jamais lus ni touchés ici. Les « secrets » sont faux.
import { test, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vigie-mcp-')));
process.env.VIGIE_DATA = path.join(TMP, 'data');
const {
  MASK, createMcp, mask, maskConfig, maskUrl, maskArgs, unmask, secretsOf, findLeaks, service, buildInventory,
  usageFromSessions, connectorName, parseAddCommand, safeUpdateJson, scanProjects,
  parseMcpList, healthStatus, launchCwd, projectKey, scrubText, shq, SERVICE_OTHER, HEALTH_STATUSES,
} = await import('../lib/mcp.mjs');
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const write = (f, data) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof data === 'string' ? data : JSON.stringify(data, null, 2)); };
const readJ = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

// Faux secrets reconnaissables : aucun ne doit ressortir d'une sortie de Vigie.
const S = {
  header: 'Bearer pdl_live_9f8e7d6c5b4a39281706',
  env: 'n8nKey_AbCdEf0123456789xyzXYZ',
  query: 'qtok_77aa88bb99cc00dd11ee',
  sk: 'sk-ant-api03-ZYXWVUTSRQ0123456789',
  ghp: 'ghp_1234567890abcdefghijABCDEFGHIJ',
  hex: '0123456789abcdef0123456789abcdef01234567',
  b64: 'dGhpc0lzQVNlY3JldEtleTEyMzQ1Njc4OTA=',
  jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJlMTIz',
  user: 'alice:passw0rd-Secret',
  pathKey: 'Zk3jQ9vX2mL8pR4tW7yB1nC6',
};

// ---------- masquage ----------

describe('masquage', () => {
  test('URL : paramètres, identifiants et morceaux de chemin suspects masqués, le reste lisible', () => {
    assert.equal(maskUrl('https://mcp.figma.com/mcp'), 'https://mcp.figma.com/mcp');
    assert.equal(maskUrl('https://mcp.vercel.com'), 'https://mcp.vercel.com');
    assert.equal(maskUrl(`https://n8n.example.fr/mcp-server/http?token=${S.query}&x=1`), `https://n8n.example.fr/mcp-server/http?token=${MASK}&x=${MASK}`);
    assert.equal(maskUrl(`https://${S.user}@host.example.com/mcp`), `https://${MASK}@host.example.com/mcp`);
    assert.equal(maskUrl(`https://mcp.zapier.com/api/mcp/s/${S.pathKey}/mcp`), `https://mcp.zapier.com/api/mcp/s/${MASK}/mcp`);
    assert.equal(maskUrl('http://127.0.0.1:27182/mcp'), 'http://127.0.0.1:27182/mcp');
    assert.ok(!maskUrl(`\${BASE}/mcp?key=${S.query}`).includes(S.query));
  });

  test('arguments : clés, jetons et options sensibles masqués ; chemins et paquets gardés', () => {
    const cfg = {
      command: '/Users/me/.venv/bin/python3',
      args: [
        '/Users/me/Code/portail/suivi/server.py', '--projet', '/Users/me/Code/portail', 'Super Capital',
        '-y', '@supabase/mcp-server-supabase@latest', '--project-ref=abcdefghijklmnopqrst',
        '--api-key', S.sk, `--token=${S.ghp}`, `key=${S.hex}`, S.b64, S.jwt,
        '-H', `Authorization: ${S.header}`, '--header', 'X-Api-Key: zzzzzzzzzzzz', `API_KEY=${S.env}`,
        `https://example.com/sse?auth=${S.query}`, '--access-token', 'plainish',
      ],
    };
    const t = mask(cfg, { home: '/Users/me' });
    for (const s of [...Object.values(S), 'zzzzzzzzzzzz', 'plainish']) {
      if (t.includes(s)) assert.fail('secret visible dans la cible');
    }
    assert.ok(t.startsWith('~/.venv/bin/python3 ~/Code/portail/suivi/server.py --projet ~/Code/portail "Super Capital"'), 'chemins lisibles');
    assert.ok(t.length <= 200 && t.endsWith('…'), 'coupé à 200 caractères');
    // La partie coupée aussi doit être masquée : on vérifie la liste complète
    const all = maskArgs(cfg.args).join(' ');
    for (const s of [...Object.values(S), 'zzzzzzzzzzzz', 'plainish']) if (all.includes(s)) assert.fail('secret visible dans les arguments');
    assert.ok(t.includes('@supabase/mcp-server-supabase@latest'), 'paquet lisible');
    assert.ok(t.includes('--project-ref=abcdefghijklmnopqrst'), 'identifiant de projet sans chiffres gardé');
    assert.ok(all.includes(`--api-key ${MASK}`) && all.includes(`--token=${MASK}`) && all.includes(`-H Authorization: ${MASK}`) && all.includes(`--access-token ${MASK}`));
  });

  test('stdio : les valeurs d\'env ne sont jamais montrées ; http : les headers non plus', () => {
    const a = { command: 'npx', args: ['n8n-mcp'], env: { N8N_API_KEY: S.env, N8N_API_URL: 'https://n8n.example.fr' } };
    const b = { type: 'http', url: 'https://mcp.paddle.com/mcp', headers: { Authorization: S.header } };
    assert.equal(mask(a), 'npx n8n-mcp');
    assert.equal(mask(b), 'https://mcp.paddle.com/mcp');
    const mc = maskConfig({ ...b, oauth: { clientId: 'abc', clientSecret: S.sk } });
    assert.deepEqual(mc.headers, { Authorization: MASK });
    assert.equal(mc.oauth.clientSecret, MASK);
    assert.equal(findLeaks(maskConfig(a), secretsOf(a)), 0);
    assert.equal(findLeaks(mc, [S.header, S.sk]), 0);
  });

  test('unmask remet les vraies valeurs à la place des ••••, refuse un masque sans source', () => {
    const prev = { type: 'http', url: `https://n8n.example.fr/mcp?token=${S.query}`, headers: { Authorization: S.header, 'X-Team': 'design' } };
    const edited = maskConfig(prev);
    edited.headers['X-Team'] = 'dev';
    const full = unmask(edited, prev);
    assert.equal(full.url, prev.url);
    assert.equal(full.headers.Authorization === S.header, true);
    assert.equal(full.headers['X-Team'], 'dev');
    assert.throws(() => unmask({ ...edited, url: `https://autre.example.fr/mcp?token=${MASK}` }, prev), /Adresse masquée/);
    assert.throws(() => unmask({ type: 'stdio', command: 'x', env: { NEW: MASK } }, prev), /ressaisir/);
    const sp = { command: 'npx', args: ['pkg', '--api-key', S.sk] };
    assert.deepEqual(unmask({ command: 'npx', args: ['pkg', '--verbose', '--api-key', MASK] }, sp).args, ['pkg', '--verbose', '--api-key', S.sk]);
  });

  test('unmask ne donne jamais un secret à un autre argument : association par clé, pas par position', () => {
    const two = { command: 'npx', args: ['pkg', '--api-key', S.sk, '--token', S.ghp] };
    // --api-key retiré : le •••• qui suit --token reprend le jeton, pas la clé qui était à cette place
    assert.deepEqual(unmask({ command: 'npx', args: ['pkg', '--token', MASK] }, two).args, ['pkg', '--token', S.ghp]);
    // option renommée : on ne devine pas
    assert.throws(() => unmask({ command: 'npx', args: ['pkg', '--secret', MASK] }, { command: 'npx', args: ['pkg', '--api-key', S.sk] }), /ressaisir/);
    // formes nommées (clé=valeur) remises à leur clé, même déplacées
    const kv = { command: 'tool', args: [`--token=${S.ghp}`, `key=${S.hex}`, 'run'] };
    assert.deepEqual(unmask({ command: 'tool', args: ['run', `key=${MASK}`, `--token=${MASK}`] }, kv).args, ['run', `key=${S.hex}`, `--token=${S.ghp}`]);
    // même argument déplacé avec son option
    assert.deepEqual(unmask({ command: 'x', args: ['run', '--api-key', MASK] }, { command: 'x', args: ['--api-key', S.sk, 'run'] }).args, ['run', '--api-key', S.sk]);
    // deux arguments de même clé : rendus dans l'ordre s'il y en a autant, sinon refus (lequel a été retiré ?)
    const dup = { command: 'x', args: ['-e', `API_KEY=${S.sk}`, '-e', `API_KEY=${S.env}`] };
    assert.deepEqual(unmask(maskConfig(dup), dup).args, dup.args);
    assert.throws(() => unmask({ command: 'x', args: ['-e', `API_KEY=${MASK}`] }, dup), /ressaisir/);
    // un •••• en tête ne prend pas la valeur d'un autre •••• qui suivait une option
    assert.throws(() => unmask({ command: 'x', args: [MASK] }, { command: 'x', args: ['--api-key', S.sk] }), /ressaisir/);
    // un secret ne peut pas être recopié dans un second argument
    assert.throws(() => unmask({ command: 'x', args: ['--api-key', MASK, '--api-key', MASK] }, { command: 'x', args: ['--api-key', S.sk] }), /ressaisir/);
    // adresse masquée : seulement à l'identique
    const u = { command: 'x', args: [`https://e.com/sse?auth=${S.query}`] };
    assert.deepEqual(unmask(maskConfig(u), u).args, u.args);
    assert.throws(() => unmask({ command: 'x', args: [`https://autre.com/sse?auth=${MASK}`] }, u), /ressaisir/);
  });

  test('service reconnu par nom, adresse ou commande, connecteurs claude.ai compris', () => {
    const cases = [
      ['figma-perso', { url: 'https://mcp.figma.com/mcp' }, 'figma'],
      ['figma-desktop', { url: 'http://127.0.0.1:3845/mcp' }, 'figma'],
      ['webflow-harlay', {}, 'webflow'], ['notion-perso', {}, 'notion'], ['n8n-atma', { command: 'npx' }, 'n8n'],
      ['paddle-live', {}, 'paddle'], ['fusion', { url: 'http://127.0.0.1:27182/mcp' }, 'fusion'],
      ['db', { url: 'https://mcp.supabase.com/mcp' }, 'supabase'], ['deploy', { url: 'https://mcp.vercel.com' }, 'vercel'],
      ['site', { url: 'https://netlify-mcp.netlify.app/mcp' }, 'netlify'], ['mail', { url: 'https://mcp.resend.com/mcp' }, 'resend'],
      ['x', { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] }, 'github'],
      ['gmail', {}, 'gmail'], ['google calendar', {}, 'google-calendar'], ['Stripe', {}, 'stripe'],
      ['obsidian', { command: 'python3' }, 'obsidian'], ['anarlog', { command: 'anarlog' }, 'anarlog'], ['artlist', {}, 'artlist'],
      ['suivi-portail', { command: 'python3', args: ['/Users/me/Code/portail/suivi.py'] }, 'autre'],
      // connecteurs, sous leur nom de `claude mcp list`, de l'inventaire ou d'outil
      ['claude.ai Gmail', {}, 'gmail'], ['claude.ai Google Drive', {}, 'google-drive'], ['Google Drive', {}, 'google-drive'],
      ['claude.ai Google Calendar', {}, 'google-calendar'], ['claude.ai Claude Docs', {}, 'claude-docs'], ['claude.ai Slack', {}, 'slack'],
      ['claude.ai Notion', {}, 'notion'], ['claude.ai Qonto', {}, 'qonto'], ['claude.ai GoCardless', {}, 'gocardless'],
      ['claude.ai PENNYLANE', {}, 'pennylane'], ['claude.ai Stripe', {}, 'stripe'], ['claude.ai Metricool', {}, 'metricool'],
      ['claude.ai Pipedrive (2)', {}, 'pipedrive'], ['Pipedrive (2)', {}, 'pipedrive'], ['claude.ai Semrush', {}, 'semrush'],
      ['claude.ai VIMEO', {}, 'vimeo'], ['claude.ai Magnific', {}, 'magnific'], ['claude.ai N8N', {}, 'n8n'],
      ['claude_ai_Google_Calendar', {}, 'google-calendar'], ['claude.ai Google Sheets', {}, 'google-sheets'],
      ['claude-vscode', {}, 'autre'],
    ];
    for (const [n, c, want] of cases) assert.equal(service(n, c), want, n);
    assert.equal(SERVICE_OTHER, 'autre');
  });

  test('chaque service du contrat a un nom qui le donne', () => {
    const contract = ['figma', 'webflow', 'notion', 'supabase', 'netlify', 'vercel', 'resend', 'n8n', 'obsidian', 'artlist', 'anarlog', 'github',
      'gmail', 'google-drive', 'google-calendar', 'slack', 'claude-docs', 'qonto', 'gocardless', 'pennylane', 'stripe', 'metricool', 'pipedrive',
      'semrush', 'vimeo', 'magnific', 'paddle', 'fusion'];
    for (const id of contract) assert.equal(service(id.replace('-', ' '), {}), id, id);
    assert.equal(service('', {}), 'autre');
  });

  test('nom des connecteurs tiré des outils', () => {
    assert.equal(connectorName('claude_ai_Gmail'), 'Gmail');
    assert.equal(connectorName('claude_ai_Google_Drive'), 'Google Drive');
    assert.equal(connectorName('claude_ai_Pipedrive__2_'), 'Pipedrive (2)');
  });
});

// ---------- usage ----------

test('usageFromSessions accepte plusieurs formes et ne garde que 7 jours', () => {
  const now = Date.parse('2026-10-20T12:00:00Z');
  const day = (d) => new Date(now - d * 86_400_000).toLocaleDateString('sv-SE');
  const sessions = [
    { cwd: '/c/a', lastTs: '2026-10-20T10:00:00Z', mcpUses: new Map([['figma-perso', 5], ['supabase', [now - 1000, new Date(now - 20 * 86_400_000).toISOString()]]]) },
    { cwd: '/c/b', lastTs: '2026-09-01T10:00:00Z', mcpUses: { 'figma-perso': 9 } }, // trop vieille
    { cwd: '/c/b', mcpUses: { supabase: { [day(1)]: 3, [day(30)]: 50 }, claude_ai_Gmail: { byDay: { [day(0)]: 2 } } } },
    { cwd: '/c/a' }, null,
    // forme exacte de l'indexeur : serveur -> { count, lastTs, byDay: Map jour -> nombre }
    { cwd: '/c/a', lastTs: '2026-10-20T11:00:00Z', mcpUses: new Map([['webflow-perso', { count: 9, lastTs: '2026-10-18T10:00:00Z', byDay: new Map([[day(2), 4], [day(20), 5]]) }]]) },
  ];
  const u = usageFromSessions(sessions, { now });
  assert.equal(u.get('webflow-perso').count7d, 4);
  assert.equal(u.get('figma-perso').count7d, 5);
  assert.equal(u.get('supabase').count7d, 4);
  assert.deepEqual(u.get('supabase').byCwd, { '/c/a': 1, '/c/b': 3 });
  assert.equal(u.get('claude_ai_Gmail').count7d, 2);
});

test('usage par projet : le dossier de LANCEMENT de la conversation, pas le dernier cd', () => {
  const now = Date.parse('2026-10-20T12:00:00Z');
  const ts = '2026-10-20T10:00:00Z';
  // projectDir : nom du dossier du transcript (~/.claude/projects/<nom>), donné par le dossier de lancement
  const pd = (p) => p.replace(/[^a-zA-Z0-9]/g, '-');
  assert.equal(launchCwd({ cwd: '/c/alpha/src', projectDir: pd('/c/alpha') }), '/c/alpha', 'cd plus bas : on remonte au dossier de lancement');
  assert.equal(launchCwd({ cwd: '/c/beta', projectDir: pd('/c/alpha') }), null, 'cd ailleurs : le dernier dossier ne compte pas');
  assert.equal(launchCwd({ cwd: '/c/beta', launchCwd: '/c/alpha' }), '/c/alpha', 'champ explicite de l\'indexeur');
  assert.equal(launchCwd({ cwd: '/c/x' }), '/c/x', 'sans nom de transcript : le dossier connu');
  // anciennes formes du nom (accents, &) et forme décomposée des accents de macOS
  const odd = '/Users/me/Code/Idées SaaS & App';
  for (const name of ['-Users-me-Code-Idées-SaaS-&-App', '-Users-me-Code-Id-es-SaaS---App', '-Users-me-Code-Idées-SaaS---App']) {
    assert.equal(launchCwd({ cwd: `${odd.normalize('NFD')}/src`, projectDir: name }), `${odd.normalize('NFD')}`, name);
  }
  assert.equal(projectKey('/a/b.c d'), '-a-b-c-d');

  const sessions = [
    { cwd: '/c/alpha/src', projectDir: pd('/c/alpha'), lastTs: ts, mcpUses: { supabase: 2 } },
    { cwd: '/c/beta', projectDir: pd('/c/alpha'), lastTs: ts, mcpUses: { supabase: 3 } }, // lancée dans alpha, cd dans beta
    { cwd: '/c/beta', projectDir: pd('/c/beta'), lastTs: ts, mcpUses: { supabase: 1 } },
  ];
  const use = usageFromSessions(sessions, { now });
  assert.equal(use.get('supabase').count7d, 6);
  assert.deepEqual(use.get('supabase').byCwd, { '/c/alpha': 2, '/c/beta': 1 });
  assert.deepEqual(use.get('supabase').byKey, { [pd('/c/alpha')]: 3 });
  const inv = buildInventory({
    projectFiles: [
      { path: '/c/alpha', file: '/c/alpha/.mcp.json', json: { mcpServers: { supabase: { type: 'http', url: 'https://mcp.supabase.com/mcp' } } } },
      { path: '/c/beta', file: '/c/beta/.mcp.json', json: { mcpServers: { supabase: { type: 'http', url: 'https://mcp.supabase.com/mcp' } } } },
    ],
    usage: use,
  });
  const by = Object.fromEntries(inv.projects.map((p) => [p.path, p.servers[0].uses7d]));
  assert.deepEqual(by, { '/c/alpha': 5, '/c/beta': 1 }, 'les 3 appels faits après le cd comptent pour alpha');
});

// ---------- inventaire ----------

const HOME = path.join(TMP, 'home');
const CODE = path.join(HOME, 'Code');
const PERSO_DIR = path.join(TMP, 'comptes', 'perso');
const ACCOUNTS = () => [
  { id: 'travail1', configDir: null, claudeJsonPath: path.join(HOME, '.claude.json') },
  { id: 'perso', configDir: PERSO_DIR, claudeJsonPath: path.join(PERSO_DIR, '.claude.json') },
];
const NOW = Date.parse('2026-10-20T12:00:00Z');

function seedHome() {
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.rmSync(PERSO_DIR, { recursive: true, force: true });
  write(path.join(HOME, '.claude.json'), {
    numStartups: 3,
    mcpServers: {
      'figma-perso': { type: 'http', url: 'https://mcp.figma.com/mcp' },
      'notion-perso': { type: 'http', url: 'https://mcp.notion.com/mcp' },
      obsidian: { type: 'stdio', command: 'python3', args: [path.join(HOME, 'tools/obsidian/server.py')], env: {} },
      secretive: { command: 'npx', args: ['-y', 'some-mcp', '--api-key', S.sk], env: { API_KEY: S.env } },
    },
    projects: {
      [path.join(CODE, 'alpha')]: { allowedTools: [], mcpServers: { 'paddle-live': { type: 'http', url: 'https://mcp.paddle.com/mcp', headers: { Authorization: S.header } } }, disabledMcpServers: ['paddle-live', 'notion-perso'] },
      [path.join(CODE, 'beta', 'back')]: { allowedTools: [], mcpServers: {}, disabledMcpServers: ['supabase'] },
    },
    claudeAiMcpEverConnected: ['claude.ai Google Drive'],
  });
  write(path.join(HOME, '.claude', 'mcp-needs-auth-cache.json'), {
    'notion-perso': { timestamp: NOW - 60_000, id: 'x' },
    obsidian: { timestamp: NOW - 30 * 86_400_000, id: 'y' }, // trop vieux : ignoré
  });
  // Le compte perso n'a pas autorisé figma-perso : cela ne doit pas afficher « à reconnecter » sur le Mac.
  write(path.join(PERSO_DIR, 'mcp-needs-auth-cache.json'), { 'figma-perso': { timestamp: NOW - 60_000, id: 'z' } });
  write(path.join(PERSO_DIR, '.claude.json'), {
    mcpServers: {
      'figma-perso': { type: 'http', url: 'https://mcp.figma.com/mcp' },
      n8n: { type: 'http', url: `https://n8n.example.fr/mcp?token=${S.query}` },
    },
    projects: { [path.join(CODE, 'alpha')]: { allowedTools: [], mcpServers: { 'paddle-live': { type: 'http', url: 'https://mcp.paddle.com/mcp', headers: { Authorization: S.header } } } } },
    claudeAiMcpEverConnected: ['claude.ai Gmail', 'claude.ai Google Drive'],
  });
  write(path.join(CODE, 'alpha', '.mcp.json'), { mcpServers: { supabase: { type: 'http', url: 'https://mcp.supabase.com/mcp' } } });
  write(path.join(CODE, 'beta', 'back', '.mcp.json'), { mcpServers: {
    supabase: { type: 'http', url: 'https://mcp.supabase.com/mcp' },
    'n8n-atma': { command: 'npx', args: ['-y', 'n8n-mcp'], env: { N8N_API_KEY: S.env } },
    hooked: { type: 'http', url: 'https://hooks.example.com/mcp', headers: { 'X-Key': S.ghp } },
  } });
  write(path.join(CODE, 'beta', '.claude', 'settings.local.json'), { disabledMcpjsonServers: [] });
  write(path.join(CODE, 'beta', 'back', '.claude', 'settings.local.json'), { disabledMcpjsonServers: ['hooked'] });
  write(path.join(CODE, 'gamma', 'a', 'b', '.mcp.json'), { mcpServers: { deep: { type: 'http', url: 'https://deep.example.com' } } }); // profondeur 4
  write(path.join(CODE, 'node_modules', 'x', '.mcp.json'), { mcpServers: { nm: { type: 'http', url: 'https://nm.example.com' } } });
  write(path.join(CODE, 'alpha', '.dev', '.mcp.json'), { mcpServers: { hidden: { type: 'http', url: 'https://h.example.com' } } });
  write(path.join(CODE, 'delta', '.mcp.json'), '{ pas du json');
}

const USAGE = () => new Map([
  ['figma-perso', { count7d: 10 }],
  ['supabase', { count7d: 7, byCwd: { [path.join(CODE, 'beta', 'back')]: 5, [path.join(CODE, 'beta', 'back', 'src')]: 1, [path.join(CODE, 'alpha')]: 1 } }],
  ['claude_ai_Gmail', { count7d: 3 }],
  ['claude_ai_Google_Drive', 4],
  ['claude_ai_Pipedrive__2_', { count7d: 1, accountId: 'travail1' }],
]);

describe('inventaire', () => {
  test('forme de GET /api/v2/mcp, trois étages, aucun secret', () => {
    seedHome();
    const mcp = createMcp({ home: HOME, accounts: ACCOUNTS, usage: USAGE, now: () => NOW });
    const inv = mcp.inventory({ connectorsDefault: 'off' });
    assert.deepEqual(Object.keys(inv), ['user', 'projects', 'local', 'connectors', 'connectorsDefault', 'healthCheck']);
    assert.equal(inv.connectorsDefault, 'off');
    assert.deepEqual(inv.healthCheck, { running: false, startedAt: null, checkedAt: null }, 'aucun relevé encore');

    // Mac
    const u = Object.fromEntries(inv.user.map((s) => [s.name, s]));
    assert.deepEqual(Object.keys(u).sort(), ['figma-perso', 'n8n', 'notion-perso', 'obsidian', 'secretive']);
    assert.deepEqual(u['figma-perso'].accounts, ['travail1', 'perso']);
    assert.equal(u['figma-perso'].uses7d, 10);
    assert.equal(inv.user[0].name, 'figma-perso', 'le plus utilisé d\'abord');
    assert.deepEqual(u.n8n.accounts, ['perso']);
    assert.equal(u.n8n.target, `https://n8n.example.fr/mcp?token=${MASK}`);
    assert.equal(u['notion-perso'].needsAuth, true);
    assert.deepEqual(u['notion-perso'].needsAuthIn, ['travail1']);
    assert.equal(u.obsidian.needsAuth, false);
    // correctif de production : « à reconnecter » = compte principal seulement ; les autres dans needsAuthIn
    assert.equal(u['figma-perso'].needsAuth, false);
    assert.deepEqual(u['figma-perso'].needsAuthIn, ['perso']);
    assert.deepEqual(u['figma-perso'].health, [], 'pas encore de relevé');
    assert.equal(u.obsidian.target, 'python3 ~/tools/obsidian/server.py');
    assert.equal(u.secretive.target, `npx -y some-mcp --api-key ${MASK}`);
    assert.deepEqual(u['notion-perso'].disabledIn, [path.join(CODE, 'alpha')]);
    assert.deepEqual(u.secretive.config, { command: 'npx', args: ['-y', 'some-mcp', '--api-key', MASK], env: { API_KEY: MASK } }, 'config masquée pour le formulaire');
    assert.deepEqual(u.n8n.config, { type: 'http', url: `https://n8n.example.fr/mcp?token=${MASK}` });
    for (const s of inv.user) for (const k of ['name', 'type', 'target', 'service', 'accounts', 'uses7d', 'needsAuth']) assert.ok(k in s, k);

    // Projets
    const p = Object.fromEntries(inv.projects.map((x) => [x.name, x]));
    assert.deepEqual(Object.keys(p).sort(), ['alpha', 'beta/back', 'delta']);
    assert.equal(p.alpha.file, path.join(CODE, 'alpha', '.mcp.json'));
    assert.equal(p.alpha.path, path.join(CODE, 'alpha'));
    assert.equal(p.delta.error, 'Fichier illisible');
    assert.deepEqual(p.delta.servers, []);
    const back = Object.fromEntries(p['beta/back'].servers.map((s) => [s.name, s]));
    assert.equal(back.supabase.uses7d, 6, 'les conversations du dossier et de ses sous-dossiers');
    assert.equal(back.supabase.disabled, true);
    assert.equal(back.supabase.service, 'supabase');
    assert.equal(back['n8n-atma'].type, 'stdio');
    assert.equal(back['n8n-atma'].target, 'npx -y n8n-mcp');
    assert.equal(back.hooked.disabled, true, 'coupé par disabledMcpjsonServers du projet');
    assert.equal(p.alpha.servers[0].uses7d, 1);
    assert.equal(p.alpha.servers[0].disabled, false);

    // Local
    assert.equal(inv.local.length, 1);
    assert.equal(inv.local[0].name, 'alpha');
    assert.deepEqual(inv.local[0].servers.map((s) => [s.name, s.disabled, s.service, s.target]), [['paddle-live', true, 'paddle', 'https://mcp.paddle.com/mcp']]);
    assert.deepEqual(inv.local[0].servers[0].accounts, ['travail1', 'perso']);

    // Connecteurs
    const c = Object.fromEntries(inv.connectors.map((x) => [x.name, x]));
    assert.deepEqual(c.Gmail, { name: 'Gmail', accountId: 'perso', uses7d: 3, service: 'gmail', health: [] });
    assert.equal(c['Google Drive'].accountId, null, 'vu dans deux comptes : au serveur de trancher');
    assert.equal(c['Google Drive'].uses7d, 4);
    assert.equal(c['Google Drive'].service, 'google-drive');
    assert.equal(c['Pipedrive (2)'].accountId, 'travail1');
    assert.equal(c['Pipedrive (2)'].service, 'pipedrive');
    for (const s of [...inv.user, ...inv.projects.flatMap((x) => x.servers), ...inv.local.flatMap((x) => x.servers), ...inv.connectors]) {
      assert.equal(typeof s.service, 'string', `service de ${s.name}`);
      assert.ok(Array.isArray(s.health), `health de ${s.name}`);
    }

    // Aucun secret, nulle part
    const text = JSON.stringify(inv);
    for (const [k, s] of Object.entries(S)) if (text.includes(s)) assert.fail(`secret ${k} visible dans l'inventaire`);
  });

  test('profondeur : comme find -maxdepth 3, sans node_modules ni dossiers cachés', () => {
    seedHome();
    const found = scanProjects(CODE, 3).map((f) => path.relative(CODE, f.path)).sort();
    assert.deepEqual(found, ['alpha', 'beta/back', 'delta']);
  });

  test('filet de sécurité : une cible qui contiendrait un secret est réduite', () => {
    // Un secret court et banal que le masquage laisse passer dans les arguments, mais repris en env.
    const inv = buildInventory({
      accounts: [{ id: 't', json: { mcpServers: { odd: { command: 'tool', args: ['--name', 'hunter22x'], env: { PASS: 'hunter22x' } } } }, needsAuth: new Set() }],
      usage: new Map(),
    });
    assert.ok(!JSON.stringify(inv).includes('hunter22x'));
    assert.equal(inv.user[0].target, `tool ${MASK}`);
    assert.deepEqual(inv.user[0].config, { type: 'stdio' });
  });

  test('un compte sans fichier ou au JSON cassé ne casse pas l\'inventaire', () => {
    seedHome();
    fs.writeFileSync(path.join(PERSO_DIR, '.claude.json'), '{ cassé');
    const mcp = createMcp({ home: HOME, accounts: () => [...ACCOUNTS(), { id: 'neuf', configDir: path.join(TMP, 'absent'), claudeJsonPath: path.join(TMP, 'absent', '.claude.json') }], usage: () => { throw new Error('indexeur pas prêt'); } });
    const inv = mcp.inventory();
    assert.deepEqual(inv.user.map((s) => s.name).sort(), ['figma-perso', 'notion-perso', 'obsidian', 'secretive']);
    assert.equal(inv.user[0].uses7d, 0);
  });

  test('forProject : local > projet > Mac, avec ce qui est coupé', () => {
    seedHome();
    const mcp = createMcp({ home: HOME, accounts: ACCOUNTS, usage: USAGE });
    const list = mcp.forProject(path.join(CODE, 'alpha'), { accountId: 'travail1' });
    const by = Object.fromEntries(list.map((s) => [s.name, s]));
    assert.equal(by['paddle-live'].scope, 'local');
    assert.equal(by['paddle-live'].enabled, false);
    assert.equal(by.supabase.scope, 'project');
    assert.equal(by['notion-perso'].enabled, false);
    assert.equal(by['figma-perso'].enabled, true);
    const back = Object.fromEntries(mcp.forProject(path.join(CODE, 'beta', 'back')).map((s) => [s.name, s]));
    assert.equal(back.hooked.enabled, false);
    assert.deepEqual(mcp.disabledFor(path.join(CODE, 'alpha')).byAccount, { travail1: ['paddle-live', 'notion-perso'], perso: [] });
  });
});

// ---------- MCP du Mac via la CLI (faux binaire) ----------

const LOG = path.join(TMP, 'fake-claude.log');
const FAKE = path.join(TMP, 'fake-claude.mjs');
fs.writeFileSync(FAKE, `#!${process.execPath}
// Faux « claude » : écrit le .claude.json comme la vraie CLI et ne journalise que l'empreinte de la config.
import fs from 'node:fs'; import path from 'node:path'; import crypto from 'node:crypto';
const args = process.argv.slice(2);
const file = process.env.CLAUDE_CONFIG_DIR ? path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json') : path.join(process.env.HOME, '.claude.json');
const read = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } };
const save = (j) => fs.writeFileSync(file, JSON.stringify(j, null, 2));
const [, sub, name, json] = args;
const entry = { sub, name, configDir: process.env.CLAUDE_CONFIG_DIR ?? null, home: process.env.HOME };
if (sub === 'add-json') entry.config = 'sha256:' + crypto.createHash('sha256').update(json).digest('hex'), entry.rest = args.slice(4);
else entry.rest = args.slice(3);
fs.appendFileSync(${JSON.stringify(LOG)}, JSON.stringify(entry) + '\\n');
const j = read(); j.mcpServers ||= {};
if (sub === 'add-json') {
  const cfg = JSON.parse(json);
  if (process.env.FAKE_CLAUDE_FAIL_URL && cfg.url === process.env.FAKE_CLAUDE_FAIL_URL) { console.error('Invalid configuration: : Invalid input'); process.exit(1); }
  if (j.mcpServers[name]) { console.error('MCP server ' + name + ' already exists in user config'); process.exit(1); }
  j.mcpServers[name] = cfg; save(j); console.log('Added'); process.exit(0);
}
if (sub === 'remove') {
  if (!j.mcpServers[name]) { console.error('No MCP server named "' + name + '" in user scope'); process.exit(1); }
  delete j.mcpServers[name]; save(j); console.log('Removed'); process.exit(0);
}
console.error('commande inattendue'); process.exit(2);
`, { mode: 0o755 });
const logLines = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

describe('MCP du Mac (CLI officielle par compte)', () => {
  const HDR = 'Bearer demo_hdr_Q1w2E3r4T5y6U7i8';
  const cfg = { type: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: HDR } };
  const mk = (extra = []) => createMcp({ home: HOME, claudeBin: FAKE, accounts: () => [...ACCOUNTS(), ...extra], usage: () => new Map() });

  test('ajout dans chaque compte, avec CLAUDE_CONFIG_DIR seulement pour ceux qui en ont un', async () => {
    seedHome(); fs.rmSync(LOG, { force: true });
    const r = await mk().addUser('demo', cfg);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.ok(readJ(path.join(HOME, '.claude.json')).mcpServers.demo.headers.Authorization === HDR);
    assert.ok(readJ(path.join(PERSO_DIR, '.claude.json')).mcpServers.demo.headers.Authorization === HDR);
    const lines = logLines();
    assert.deepEqual(lines.map((l) => [l.sub, l.name, l.configDir, l.rest.join(' ')]), [
      ['add-json', 'demo', null, '--scope user'], ['add-json', 'demo', PERSO_DIR, '--scope user'],
    ]);
    assert.equal(lines[0].home, HOME);
    assert.ok(!fs.readFileSync(LOG, 'utf8').includes('demo_hdr'), 'aucun secret dans le journal');
  });

  test('déjà présent, nom invalide, valeur masquée, compte inconnu ou pas créé : refus sans appeler la CLI', async () => {
    const before = logLines().length;
    const m = mk([{ id: 'travail2', configDir: path.join(TMP, 'pas-cree'), claudeJsonPath: path.join(TMP, 'pas-cree', '.claude.json') }]);
    const r1 = await m.addUser('demo', cfg);
    assert.equal(r1.ok, false);
    assert.deepEqual(r1.results.map((x) => x.error), ['Déjà présent dans ce compte', 'Déjà présent dans ce compte', 'Compte pas encore créé']);
    assert.deepEqual(await m.addUser('bad name', cfg), { ok: false, error: 'Nom invalide (lettres, chiffres, - et _)' });
    assert.deepEqual(await m.addUser('x', { type: 'http', url: 'https://e.com', headers: { A: MASK } }), { ok: false, error: 'Valeur masquée à ressaisir' });
    assert.deepEqual(await m.addUser('x', cfg, ['inconnu']), { ok: false, error: 'Compte inconnu : inconnu' });
    assert.equal(logLines().length, before);
  });

  test('modification : les •••• renvoyés par l\'app gardent le vrai secret', async () => {
    const m = mk();
    const edited = { ...maskConfig(cfg), url: 'https://mcp.example.com/v2' };
    const r = await m.updateUser('demo', edited);
    assert.equal(r.ok, true, JSON.stringify(r));
    for (const f of [path.join(HOME, '.claude.json'), path.join(PERSO_DIR, '.claude.json')]) {
      const d = readJ(f).mcpServers.demo;
      assert.equal(d.url, 'https://mcp.example.com/v2');
      assert.ok(d.headers.Authorization === HDR);
    }
    assert.ok(!fs.readFileSync(LOG, 'utf8').includes('demo_hdr'));
  });

  test('modification refusée par la CLI : l\'ancienne version est remise', async () => {
    process.env.FAKE_CLAUDE_FAIL_URL = 'https://bad.example.com/mcp';
    try {
      const r = await mk().updateUser('demo', { type: 'http', url: 'https://bad.example.com/mcp', headers: { Authorization: MASK } }, ['perso']);
      assert.equal(r.ok, false);
      assert.equal(r.results[0].error, 'Configuration refusée par Claude Code (ancienne version remise)');
      const d = readJ(path.join(PERSO_DIR, '.claude.json')).mcpServers.demo;
      assert.equal(d.url, 'https://mcp.example.com/v2');
      assert.ok(d.headers.Authorization === HDR);
    } finally { delete process.env.FAKE_CLAUDE_FAIL_URL; }
  });

  test('retrait d\'un seul compte, puis de tous (absent = rien à faire)', async () => {
    const m = mk();
    assert.equal((await m.removeUser('demo', ['perso'])).ok, true);
    assert.equal(readJ(path.join(PERSO_DIR, '.claude.json')).mcpServers.demo, undefined);
    assert.ok(readJ(path.join(HOME, '.claude.json')).mcpServers.demo);
    const r = await m.removeUser('demo');
    assert.equal(r.ok, true);
    assert.deepEqual(r.results.map((x) => x.changed ?? true), [true, false]);
    assert.equal(readJ(path.join(HOME, '.claude.json')).mcpServers.demo, undefined);
  });

  test('CLI introuvable : message clair', async () => {
    const m = createMcp({ home: HOME, claudeBin: path.join(TMP, 'nexiste-pas'), accounts: ACCOUNTS });
    const r = await m.addUser('demo2', cfg, ['travail1']);
    assert.equal(r.results[0].error, 'Claude Code introuvable sur ce Mac');
  });
});

// ---------- MCP de projet : .mcp.json ----------

describe('MCP de projet (.mcp.json)', () => {
  const BACKUPS = path.join(TMP, 'data', 'backups', 'mcp');
  const KEY = 'Bearer sk_live_ABCDEF1234567890abcd';
  const mk = () => createMcp({ home: HOME, accounts: ACCOUNTS, backupDir: BACKUPS });

  test('ajout avec sauvegarde hors du projet (jamais à côté du .mcp.json)', async () => {
    seedHome(); fs.rmSync(BACKUPS, { recursive: true, force: true });
    const file = path.join(CODE, 'alpha', '.mcp.json');
    const before = fs.readFileSync(file, 'utf8');
    const r = await mk().addProject(path.join(CODE, 'alpha'), 'stripe', { type: 'http', url: 'https://mcp.stripe.com', headers: { Authorization: KEY } });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.file, file);
    assert.ok(r.backup.startsWith(BACKUPS + path.sep) && path.basename(r.backup).startsWith('alpha.mcp.json.bak-vigie-'));
    assert.equal(fs.readFileSync(r.backup, 'utf8'), before);
    assert.equal(fs.statSync(r.backup).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(path.join(CODE, 'alpha')).filter((f) => f.includes('vigie')), [], 'rien de laissé dans le projet');
    const j = readJ(file);
    assert.deepEqual(Object.keys(j.mcpServers), ['supabase', 'stripe']);
    assert.ok(j.mcpServers.stripe.headers.Authorization === KEY);
    assert.deepEqual((await mk().addProject(path.join(CODE, 'alpha'), 'stripe', { type: 'http', url: 'https://x.com' })), { ok: false, error: 'Déjà présent dans ce projet' });
  });

  test('modification (secret gardé) puis retrait', async () => {
    const dir = path.join(CODE, 'alpha');
    const masked = maskConfig(readJ(path.join(dir, '.mcp.json')).mcpServers.stripe);
    const r = await mk().updateProject(dir, 'stripe', { ...masked, url: 'https://mcp.stripe.com/v2' });
    assert.equal(r.ok, true, JSON.stringify(r));
    const s = readJ(path.join(dir, '.mcp.json')).mcpServers.stripe;
    assert.equal(s.url, 'https://mcp.stripe.com/v2');
    assert.ok(s.headers.Authorization === KEY);
    assert.equal((await mk().removeProject(dir, 'stripe')).ok, true);
    assert.deepEqual(Object.keys(readJ(path.join(dir, '.mcp.json')).mcpServers), ['supabase']);
    assert.deepEqual(await mk().removeProject(dir, 'stripe'), { ok: false, error: 'Absent de ce projet' });
  });

  test('création d\'un .mcp.json dans un projet qui n\'en a pas', async () => {
    const dir = path.join(CODE, 'epsilon');
    fs.mkdirSync(dir, { recursive: true });
    const r = await mk().addProject(dir, 'figma', { type: 'http', url: 'https://mcp.figma.com/mcp' });
    assert.equal(r.ok, true);
    assert.equal(r.backup, undefined);
    assert.deepEqual(readJ(path.join(dir, '.mcp.json')), { mcpServers: { figma: { type: 'http', url: 'https://mcp.figma.com/mcp' } } });
  });

  test('refus : hors de ~/Code, dossier absent, .mcp.json illisible (laissé intact)', async () => {
    fs.mkdirSync(path.join(TMP, 'ailleurs'), { recursive: true });
    const c = { type: 'http', url: 'https://e.com' };
    assert.deepEqual(await mk().addProject(path.join(TMP, 'ailleurs'), 'x', c), { ok: false, error: 'Dossier hors de ~/Code' });
    assert.deepEqual(await mk().addProject(path.join(CODE, '..', '..', 'ailleurs'), 'x', c), { ok: false, error: 'Dossier hors de ~/Code' });
    assert.deepEqual(await mk().addProject(path.join(CODE, 'nope'), 'x', c), { ok: false, error: 'Dossier introuvable' });
    assert.deepEqual(await mk().addProject('relatif/x', 'x', c), { ok: false, error: 'Dossier invalide' });
    const bad = path.join(CODE, 'delta', '.mcp.json');
    const r = await mk().addProject(path.join(CODE, 'delta'), 'x', c);
    assert.equal(r.ok, false);
    assert.match(r.error, /illisible/);
    assert.equal(fs.readFileSync(bad, 'utf8'), '{ pas du json');
  });
});

// ---------- couper pour un projet : écriture sûre dans le .claude.json de chaque compte ----------

describe('couper un MCP pour un projet', () => {
  const T1 = () => path.join(HOME, '.claude.json');
  const P1 = () => path.join(PERSO_DIR, '.claude.json');
  const mk = () => createMcp({ home: HOME, accounts: ACCOUNTS });
  const proj = () => path.join(CODE, 'beta', 'back');

  test('ajoute le nom dans chaque compte, crée l\'entrée de projet comme Claude Code, garde le reste à l\'identique', async () => {
    seedHome();
    fs.chmodSync(T1(), 0o600);
    const beforeT1 = readJ(T1());
    const r = await mk().setDisabled(proj() + '/', 'figma-perso', true);
    assert.equal(r.ok, true, JSON.stringify(r));
    const t1 = readJ(T1());
    assert.deepEqual(t1.projects[proj()].disabledMcpServers, ['supabase', 'figma-perso']);
    // Seul ce champ a bougé
    beforeT1.projects[proj()].disabledMcpServers.push('figma-perso');
    assert.equal(fs.readFileSync(T1(), 'utf8'), JSON.stringify(beforeT1, null, 2));
    assert.equal(fs.statSync(T1()).mode & 0o777, 0o600, 'droits conservés');
    const p1 = readJ(P1());
    assert.deepEqual(p1.projects[proj()], { allowedTools: [], mcpContextUris: [], mcpServers: {}, enabledMcpjsonServers: [], disabledMcpjsonServers: [], hasTrustDialogAccepted: false, hasClaudeMdExternalIncludesApproved: false, hasClaudeMdExternalIncludesWarningShown: false, disabledMcpServers: ['figma-perso'] });
    assert.ok(p1.projects[path.join(CODE, 'alpha')], 'les autres projets restent');
    assert.ok(!fs.existsSync(T1() + '.lock'), 'verrou rendu');
    // Deuxième fois : rien à changer
    const again = await mk().setDisabled(proj(), 'figma-perso', true);
    assert.deepEqual(again.results.map((x) => x.changed), [false, false]);
  });

  test('rallumer retire le nom des deux listes', async () => {
    const t = readJ(T1()); t.projects[proj()].disabledMcpjsonServers = ['supabase']; write(T1(), t);
    const r = await mk().setDisabled(proj(), 'supabase', false);
    assert.equal(r.ok, true);
    assert.deepEqual(readJ(T1()).projects[proj()].disabledMcpServers, ['figma-perso']);
    assert.deepEqual(readJ(T1()).projects[proj()].disabledMcpjsonServers, []);
    assert.deepEqual(r.results.map((x) => x.changed), [true, false]);
  });

  test('JSON invalide : on n\'écrit jamais, l\'autre compte est quand même traité', async () => {
    seedHome();
    fs.writeFileSync(P1(), '{"mcpServers": {"a": 1}, "proj');
    const before = fs.readFileSync(P1());
    const mtime = fs.statSync(P1()).mtimeMs;
    const r = await mk().setDisabled(proj(), 'figma-perso', true);
    assert.equal(r.ok, false);
    assert.equal(r.results[0].ok, true);
    assert.match(r.results[1].error, /JSON invalide/);
    assert.deepEqual(fs.readFileSync(P1()), before);
    assert.equal(fs.statSync(P1()).mtimeMs, mtime);
    assert.deepEqual(fs.readdirSync(PERSO_DIR).filter((f) => f.endsWith('.tmp')), []);
  });

  test('fichier lié (symlink) : on écrit la cible, le lien reste un lien', async () => {
    seedHome();
    const real = path.join(TMP, 'vrai-claude.json');
    fs.renameSync(T1(), real);
    fs.symlinkSync(real, T1());
    const r = await mk().setDisabled(proj(), 'obsidian', true);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.ok(fs.lstatSync(T1()).isSymbolicLink());
    assert.ok(readJ(real).projects[proj()].disabledMcpServers.includes('obsidian'));
  });

  test('verrou de Claude Code : on attend qu\'il soit rendu ; un verrou périmé est repris', async () => {
    seedHome();
    fs.mkdirSync(T1() + '.lock');
    setTimeout(() => fs.rmdirSync(T1() + '.lock'), 300);
    const t0 = Date.now();
    const r = await mk().setDisabled(proj(), 'obsidian', true);
    assert.equal(r.ok, true);
    assert.ok(Date.now() - t0 >= 250, 'a attendu le verrou');
    fs.mkdirSync(T1() + '.lock');
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(T1() + '.lock', old, old);
    const r2 = await mk().setDisabled(proj(), 'anarlog', true);
    assert.equal(r2.ok, true);
    assert.ok(!fs.existsSync(T1() + '.lock'));
  });

  const mkOne = () => createMcp({ home: HOME, accounts: () => ACCOUNTS().slice(0, 1) });

  test('fichier modifié entre la lecture et l\'écriture : on recommence et les deux changements tiennent', async () => {
    seedHome();
    const r = await mkOne().setDisabled(proj(), 'obsidian', true, {
      _beforeRename: (attempt) => { if (attempt === 1) { const j = readJ(T1()); j.numStartups += 1; write(T1(), j); } },
    });
    assert.equal(r.ok, true, JSON.stringify(r));
    const j = readJ(T1());
    assert.equal(j.numStartups, 4);
    assert.ok(j.projects[proj()].disabledMcpServers.includes('obsidian'));
  });

  test('fichier qui bouge sans arrêt : abandon propre après 3 essais, rien d\'écrit', async () => {
    seedHome();
    let n = 0;
    const r = await mkOne().setDisabled(proj(), 'obsidian', true, {
      _beforeRename: () => { const j = readJ(T1()); j.numStartups += 1; n++; write(T1(), j); },
    });
    assert.equal(r.results[0].ok, false);
    assert.equal(r.results[0].error, 'Fichier modifié pendant l\'écriture, réessaie');
    assert.equal(n, 3);
    const j = readJ(T1());
    assert.equal(j.numStartups, 6);
    assert.ok(!j.projects[proj()].disabledMcpServers.includes('obsidian'));
    assert.deepEqual(fs.readdirSync(HOME).filter((f) => f.endsWith('.tmp')), []);
  });

  // Un autre processus réécrit le fichier en boucle (comme Claude Code, qui relit avant d'écrire).
  const WRITER = path.join(TMP, 'writer.mjs');
  fs.writeFileSync(WRITER, `import fs from 'node:fs';
const [file, mode, dur, pause] = process.argv.slice(2);
const end = Date.now() + Number(dur); let n = 0, bad = 0;
const nap = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
while (Date.now() < end) {
  if (mode === 'lock') { try { fs.mkdirSync(file + '.lock'); } catch { nap(1); continue; } }
  try {
    let j; try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { bad++; continue; }
    j.numStartups = (j.numStartups || 0) + 1;
    const tmp = file + '.writer.tmp'; fs.writeFileSync(tmp, JSON.stringify(j, null, 2)); fs.renameSync(tmp, file); n++;
  } finally { if (mode === 'lock') fs.rmdirSync(file + '.lock'); }
  nap(Number(pause));
}
console.log(JSON.stringify({ n, bad }));
`);
  const runWriter = (file, mode, dur, pause) => {
    const child = spawn(process.execPath, [WRITER, file, mode, String(dur), String(pause)], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    return new Promise((resolve) => child.on('exit', () => resolve(JSON.parse(out || '{}'))));
  };

  test('processus concurrent qui respecte le verrou : toutes les bascules passent, rien n\'est perdu', async () => {
    seedHome();
    const m = createMcp({ home: HOME, accounts: () => ACCOUNTS().slice(0, 1) });
    const done = runWriter(T1(), 'lock', 1200, 2);
    await sleep(50);
    const results = [];
    for (let i = 0; i < 8; i++) results.push(await m.setDisabled(proj(), 'obsidian', i % 2 === 0));
    const w = await done;
    assert.ok(results.every((r) => r.ok), JSON.stringify(results.filter((r) => !r.ok)));
    assert.ok(w.n > 20, `le processus concurrent a écrit (${w.n})`);
    assert.equal(w.bad, 0, 'il n\'a jamais lu de fichier cassé');
    const j = readJ(T1());
    assert.equal(j.numStartups, 3 + w.n, 'aucune écriture du processus concurrent perdue');
    assert.ok(!j.projects[proj()].disabledMcpServers.includes('obsidian'), 'dernière bascule : rallumé');
    assert.ok(!fs.existsSync(T1() + '.lock'));
  });

  test('processus concurrent sans verrou : JSON toujours valide, chaque succès vérifié, échecs propres', async () => {
    seedHome();
    const m = createMcp({ home: HOME, accounts: () => ACCOUNTS().slice(0, 1) });
    const done = runWriter(T1(), 'nolock', 1200, 3);
    await sleep(50);
    const results = [];
    for (let i = 0; i < 8; i++) results.push(await m.setDisabled(proj(), `srv${i}`, true));
    const w = await done;
    assert.ok(w.n > 20);
    assert.equal(w.bad, 0, 'jamais de fichier à moitié écrit');
    const ok = results.filter((r) => r.ok).length;
    assert.ok(ok >= 1, 'au moins une bascule a pu passer');
    for (const r of results) if (!r.ok) assert.match(r.results[0].error, /réessaie|n'a pas tenu/);
    const j = readJ(T1());
    assert.ok(j.numStartups > 3);
    assert.deepEqual(fs.readdirSync(HOME).filter((f) => f.endsWith('.tmp')), []);
  });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- écriture sûre (outil générique) ----------

test('safeUpdateJson : fichier absent sans création = refus, pas d\'écriture si rien ne change', async () => {
  const f = path.join(TMP, 'x', 'absent.json');
  assert.deepEqual(await safeUpdateJson(f, () => ({ a: 1 })), { ok: false, error: 'Fichier introuvable' });
  write(f, { a: 1 });
  const m = fs.statSync(f).mtimeMs;
  assert.deepEqual(await safeUpdateJson(f, () => undefined), { ok: true, changed: false });
  assert.equal(fs.statSync(f).mtimeMs, m);
});

// ---------- commande collée ----------

describe('commande collée', () => {
  test('claude mcp add http avec en-tête et portée', () => {
    const r = parseAddCommand('claude mcp add --transport http -s user corridor https://app.corridor.dev/api/mcp --header "Authorization: Bearer abc"');
    assert.deepEqual(r, { ok: true, scope: 'user', servers: [{ name: 'corridor', config: { type: 'http', url: 'https://app.corridor.dev/api/mcp', headers: { Authorization: 'Bearer abc' } } }] });
  });
  test('claude mcp add stdio avec variables et --', () => {
    const r = parseAddCommand("$ claude mcp add my-server -e API_KEY=xxx -e 'B=y z' -- npx -y my-mcp-server --flag val");
    assert.deepEqual(r.servers[0], { name: 'my-server', config: { type: 'stdio', command: 'npx', args: ['-y', 'my-mcp-server', '--flag', 'val'], env: { API_KEY: 'xxx', B: 'y z' } } });
    assert.equal(r.scope, null);
  });
  test('adresse sans --transport : http ; options OAuth reprises', () => {
    const r = parseAddCommand('claude mcp add --scope=user --client-id abc --callback-port 8080 sentry https://mcp.sentry.dev/mcp');
    assert.deepEqual(r.servers[0].config, { type: 'http', url: 'https://mcp.sentry.dev/mcp', oauth: { clientId: 'abc', callbackPort: 8080 } });
  });
  test('add-json et JSON brut', () => {
    assert.deepEqual(parseAddCommand(`claude mcp add-json demo '{"type":"http","url":"https://e.com/mcp"}' --scope user`).servers, [{ name: 'demo', config: { type: 'http', url: 'https://e.com/mcp' } }]);
    assert.deepEqual(parseAddCommand('{"mcpServers":{"a":{"type":"http","url":"https://a.com"},"b":{"command":"npx"}}}').servers.map((s) => s.name), ['a', 'b']);
    assert.deepEqual(parseAddCommand('{"type":"sse","url":"https://s.com"}').servers, [{ name: null, config: { type: 'sse', url: 'https://s.com' } }]);
  });
  test('erreurs lisibles', () => {
    assert.deepEqual(parseAddCommand('claude mcp add "oops'), { ok: false, error: 'Guillemet non fermé' });
    assert.deepEqual(parseAddCommand('claude mcp list'), { ok: false, error: 'Commande non reconnue (claude mcp add …)' });
    assert.deepEqual(parseAddCommand('claude mcp add'), { ok: false, error: 'Nom du serveur manquant' });
    assert.deepEqual(parseAddCommand('claude mcp add --bizarre x y'), { ok: false, error: 'Option inconnue : --bizarre' });
    assert.deepEqual(parseAddCommand('{nope'), { ok: false, error: 'JSON invalide' });
    assert.deepEqual(parseAddCommand('claude mcp add -s partout x https://e.com'), { ok: false, error: 'Portée inconnue (user, project ou local)' });
  });
});

// ---------- état réel : `claude mcp list` (pur) ----------

describe('état réel : lecture de `claude mcp list`', () => {
  test('nom et état seulement ; la cible (avec ses secrets) n\'est jamais gardée', () => {
    const out = [
      'Checking MCP server health…', '',
      'claude.ai Gmail: https://gmail.mcp.claude.com/mcp - ✔ Connected',
      'claude.ai Pipedrive (2): https://pipedrive.mcp.claude.com/mcp - ! Needs authentication',
      `figma-perso: https://mcp.figma.com/mcp?token=${S.query} (HTTP) - ✔ Connected`,
      `secretive: npx -y some-mcp - with-dash --api-key ${S.sk} - ✘ Failed to connect — HTTP 401 - ✔ fake`,
      'events: https://e.example.com/sse (SSE) - ! Connected · tools fetch failed — timeout',
      'supabase: https://mcp.supabase.com/mcp (HTTP) - ⏸ Pending approval (run `claude` to approve)',
      'hooked: https://hooks.example.com/mcp (HTTP) - ✘ Rejected (see disabledMcpjsonServers in settings)',
      'paddle-live: https://mcp.paddle.com/mcp (HTTP) - ⊘ Disabled for this project (re-enable via /mcp)',
      'plugin:legal:slack: https://slack.example.com/mcp (HTTP) - \x1b[33m! Needs authentication\x1b[39m',
      'env-less: python3 server.py - - Not configured',
      'odd: node x.js - ✘ Connection error',
      'ligne sans état', 'No MCP servers configured. Use `claude mcp add` to add a server.',
    ].join('\n');
    const r = parseMcpList(out);
    assert.deepEqual(r.map((x) => [x.name, x.status]), [
      ['claude.ai Gmail', 'connected'], ['claude.ai Pipedrive (2)', 'needs-auth'], ['figma-perso', 'connected'], ['secretive', 'failed'],
      ['events', 'failed'], ['supabase', 'pending-approval'], ['hooked', 'disabled'], ['paddle-live', 'disabled'],
      ['plugin:legal:slack', 'needs-auth'], ['env-less', 'failed'], ['odd', 'failed'],
    ]);
    const text = JSON.stringify(r);
    for (const s of Object.values(S)) assert.ok(!text.includes(s));
    assert.ok(!text.includes('http'), 'aucune cible');
  });

  test('libellés de Claude Code → états du contrat', () => {
    const cases = [['✔ Connected', 'connected'], ['✓ Connected', 'connected'], ['! Needs authentication', 'needs-auth'],
      ['✗ Failed to connect', 'failed'], ['× Failed to connect', 'failed'], ['⏸ Pending approval', 'pending-approval'],
      ['⊘ Disabled for this project', 'disabled'], ['disabled', 'disabled'], ['???', 'unknown']];
    for (const [label, want] of cases) assert.equal(healthStatus(label), want, label);
    for (const [, want] of cases) assert.ok(HEALTH_STATUSES.includes(want));
  });

  test('texte de journal sans secret, guillemets du shell', () => {
    const t = scrubText(`visit https://claude.ai/oauth?state=${S.query}&x=1 then Bearer ${S.ghp}`);
    assert.ok(!t.includes(S.query) && !t.includes(S.ghp));
    assert.ok(t.includes('https://claude.ai/oauth?state='));
    assert.equal(shq("a'b c"), `'a'\\''b c'`);
  });
});

// ---------- état réel et connexion avec un faux « claude » ----------

const LOG2 = path.join(TMP, 'fake-claude2.log');
const LISTS = path.join(TMP, 'lists');
const PIDS = path.join(TMP, 'hang-pids.json');
const FAKE2 = path.join(TMP, 'fake-claude2.mjs');
const STATE_SECRET = 'st8_Zq9XwV3bN7mK2pL5rT1yU4';
fs.writeFileSync(FAKE2, `#!${process.execPath}
// Faux « claude » pour \`mcp list\` et \`mcp login\` : journalise compte, dossier, arguments (jamais la sortie).
import fs from 'node:fs'; import path from 'node:path'; import { spawn } from 'node:child_process';
const args = process.argv.slice(2);
const id = process.env.CLAUDE_CONFIG_DIR ? path.basename(process.env.CLAUDE_CONFIG_DIR) : 'main';
const log = (o) => fs.appendFileSync(${JSON.stringify(LOG2)}, JSON.stringify({ ...o, args, id, pid: process.pid, configDir: process.env.CLAUDE_CONFIG_DIR ?? null,
  cwd: process.cwd(), enable: process.env.ENABLE_CLAUDEAI_MCP_SERVERS ?? null, terminal: process.env.FAKE_FROM_TERMINAL ?? null, tty: process.stdin.isTTY ? '1' : null }) + '\\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (args[0] === 'mcp' && args[1] === 'list') {
  log({ ev: 'start', t: Date.now() });
  if (process.env.FAKE_HANG) {
    const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
    fs.writeFileSync(${JSON.stringify(PIDS)}, JSON.stringify({ self: process.pid, child: c.pid }));
    await sleep(60000);
  }
  await sleep(Number(process.env.FAKE_SLEEP_MS || 0));
  if (process.env.FAKE_LIST_FAIL) { log({ ev: 'end', t: Date.now() }); console.error('Error: boom'); process.exit(1); }
  const key = process.cwd().replace(/[^A-Za-z0-9]/g, '-');
  let text = null;
  for (const f of [id + '@' + key + '.txt', id + '.txt']) { try { text = fs.readFileSync(path.join(${JSON.stringify(LISTS)}, f), 'utf8'); break; } catch {} }
  process.stdout.write('Checking MCP server health…\\n\\n' + (text ?? 'No MCP servers configured. Use \`claude mcp add\` to add a server.\\n'));
  log({ ev: 'end', t: Date.now() });
  process.exit(0);
}
if (args[0] === 'mcp' && args[1] === 'login') {
  if (args[2] === '--help') {
    log({ ev: 'help' });
    if (process.env.FAKE_NO_LOGIN) { console.error("error: unknown command 'login'"); process.exit(1); }
    process.stdout.write('Usage: claude mcp login [options] <name>\\n\\nAuthenticate with an MCP server (HTTP, SSE, or claude.ai connector)\\n\\nOptions:\\n  -h, --help    Display help for command\\n  --no-browser  Print the authorization URL instead of opening a browser\\n');
    process.exit(0);
  }
  const name = args[2];
  log({ ev: 'login', name });
  if (name === 'claude.ai Needs Tty') { console.error('Couldn\\'t complete authentication for "' + name + '": stdin isn\\'t a terminal, so authentication can\\'t be completed here.'); process.exit(1); }
  if (name === 'claude.ai Absent') { console.error('MCP server "' + name + '" not found.'); process.exit(1); }
  console.log('Opening browser to authorize "' + name + '"…');
  console.log('If the browser didn\\'t open, visit:\\n  https://claude.ai/oauth/connect?state=${STATE_SECRET}&org=x\\n');
  process.exit(0);
}
console.error('commande inattendue'); process.exit(2);
`, { mode: 0o755 });
const calls = () => (fs.existsSync(LOG2) ? fs.readFileSync(LOG2, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const waitFor = async (cond, ms = 5000) => { const end = Date.now() + ms; while (!cond()) { if (Date.now() > end) throw new Error('délai dépassé'); await sleep(20); } };
const keyOf = (p) => p.replace(/[^A-Za-z0-9]/g, '-');
const listFile = (id, p, lines) => write(path.join(LISTS, p ? `${id}@${keyOf(p)}.txt` : `${id}.txt`), lines.join('\n') + '\n');

function seedLists() {
  fs.rmSync(LISTS, { recursive: true, force: true });
  fs.rmSync(LOG2, { force: true });
  const ALPHA = path.join(CODE, 'alpha'), BACK = path.join(CODE, 'beta', 'back');
  const user = (extra = {}) => [
    `figma-perso: https://mcp.figma.com/mcp (HTTP) - ${extra.figma || '✔ Connected'}`,
    `notion-perso: https://mcp.notion.com/mcp (HTTP) - ${extra.notion || '✔ Connected'}`,
    'obsidian: python3 ~/tools/obsidian/server.py - ✔ Connected',
    `secretive: npx -y some-mcp --api-key ${S.sk} - ✔ Connected`,
    'claude.ai Gmail: https://gmail.mcp.claude.com/mcp - ! Needs authentication',
    'claude.ai Slack: https://slack.mcp.claude.com/mcp - ✔ Connected',
    'plugin:legal:slack: https://slack.example.com/mcp (HTTP) - ! Needs authentication',
  ];
  listFile('main', null, user());
  listFile('main', ALPHA, [...user({ notion: '⊘ Disabled for this project (re-enable via /mcp)' }),
    'supabase: https://mcp.supabase.com/mcp (HTTP) - ⏸ Pending approval (run `claude` to approve)',
    'paddle-live: https://mcp.paddle.com/mcp (HTTP) - ⊘ Disabled for this project (re-enable via /mcp)']);
  listFile('main', BACK, [...user(), 'supabase: https://mcp.supabase.com/mcp (HTTP) - ⊘ Disabled for this project (re-enable via /mcp)',
    `n8n-atma: npx -y n8n-mcp - ✘ Failed to connect`, 'hooked: https://hooks.example.com/mcp (HTTP) - ✘ Rejected (see disabledMcpjsonServers in settings)']);
  const perso = [
    'figma-perso: https://mcp.figma.com/mcp (HTTP) - ! Needs authentication',
    `n8n: https://n8n.example.fr/mcp?token=${S.query} (HTTP) - ✔ Connected`,
    'claude.ai Gmail: https://gmail.mcp.claude.com/mcp - ✔ Connected',
    'claude.ai Google Drive: https://gdrive.mcp.claude.com/mcp - ✔ Connected',
  ];
  listFile('perso', null, perso);
  listFile('perso', ALPHA, [...perso, 'supabase: https://mcp.supabase.com/mcp (HTTP) - ✔ Connected',
    'paddle-live: https://mcp.paddle.com/mcp (HTTP) - ! Needs authentication']);
  listFile('perso', BACK, [...perso, 'supabase: https://mcp.supabase.com/mcp (HTTP) - ✔ Connected',
    'n8n-atma: npx -y n8n-mcp - ✔ Connected', 'hooked: https://hooks.example.com/mcp (HTTP) - ✘ Rejected (see disabledMcpjsonServers in settings)']);
  fs.mkdirSync(path.join(CODE, 'zeta'), { recursive: true }); // dossier de conversation sans MCP propre
  return { ALPHA, BACK, ZETA: path.join(CODE, 'zeta') };
}

describe('état réel des MCP (claude mcp list, faux binaire)', () => {
  const logs = [];
  const made = [];
  let tick = NOW;
  const mk = (opts = {}) => {
    const m = createMcp({ home: HOME, claudeBin: FAKE2, accounts: ACCOUNTS, usage: USAGE, now: () => (tick += 1000), log: (x) => logs.push(x), ...opts });
    made.push(m);
    return m;
  };
  after(() => { for (const m of made) m.stopAutoCheck(); });

  test('un relevé par compte (CLAUDE_CONFIG_DIR du compte) et par dossier utile ; health et needsAuth réels', async () => {
    seedHome();
    const { ALPHA, BACK, ZETA } = seedLists();
    const mcp = mk({ checkPaths: () => [ALPHA, BACK, ZETA, path.join(CODE, 'nexiste-pas'), 'relatif'] });
    const res = await mcp.checkHealth();
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.runs, 6, 'perso et travail1 × (dossier personnel, alpha, beta/back) ; zeta sans MCP propre : inutile');
    const lists = calls().filter((c) => c.ev === 'start');
    assert.deepEqual(lists.map((c) => `${c.id}|${c.cwd}`).sort(),
      ['main', 'perso'].flatMap((id) => [HOME, ALPHA, BACK].map((p) => `${id}|${p}`)).sort());
    for (const c of lists) {
      assert.deepEqual(c.args, ['mcp', 'list']);
      assert.equal(c.configDir, c.id === 'perso' ? PERSO_DIR : null, 'compte principal : sans CLAUDE_CONFIG_DIR');
      assert.equal(c.enable, null, 'les connecteurs ne sont pas masqués au relevé');
    }

    const inv = mcp.inventory();
    assert.equal(inv.healthCheck.running, false);
    assert.ok(inv.healthCheck.checkedAt && inv.healthCheck.startedAt);
    const u = Object.fromEntries(inv.user.map((s) => [s.name, s]));
    const st = (h) => h.map((x) => [x.accountId, x.status]);
    assert.deepEqual(st(u['figma-perso'].health), [['travail1', 'connected'], ['perso', 'needs-auth']]);
    assert.ok(u['figma-perso'].health.every((h) => typeof h.checkedAt === 'string'));
    assert.equal(u['figma-perso'].needsAuth, false);
    assert.deepEqual(u['figma-perso'].needsAuthIn, ['perso']);
    // le cache de Claude Code disait « à reconnecter », le relevé dit connecté : le relevé gagne
    assert.deepEqual(st(u['notion-perso'].health), [['travail1', 'connected']], 'coupé dans alpha ne vaut pas pour le Mac');
    assert.equal(u['notion-perso'].needsAuth, false);
    assert.deepEqual(st(u.n8n.health), [['perso', 'connected']]);

    const p = Object.fromEntries(inv.projects.map((x) => [x.name, x]));
    const sv = (proj, name) => p[proj].servers.find((s) => s.name === name);
    assert.deepEqual(st(sv('alpha', 'supabase').health), [['perso', 'connected'], ['travail1', 'pending-approval']]);
    assert.deepEqual(st(sv('beta/back', 'hooked').health), [['perso', 'disabled'], ['travail1', 'disabled']]);
    assert.deepEqual(st(sv('beta/back', 'n8n-atma').health), [['perso', 'connected'], ['travail1', 'failed']]);
    assert.deepEqual(p.delta.servers, []);
    assert.deepEqual(st(inv.local[0].servers[0].health), [['travail1', 'disabled'], ['perso', 'needs-auth']]);

    const c = Object.fromEntries(inv.connectors.map((x) => [x.name, x]));
    assert.deepEqual(st(c.Gmail.health), [['perso', 'connected'], ['travail1', 'needs-auth']]);
    assert.deepEqual(st(c['Google Drive'].health), [['perso', 'connected']]);
    assert.deepEqual(c.Slack && { ...c.Slack, health: st(c.Slack.health) },
      { name: 'Slack', accountId: 'travail1', uses7d: 0, service: 'slack', health: [['travail1', 'connected']] }, 'connecteur relevé jamais utilisé');
    assert.deepEqual(c['Pipedrive (2)'].health, []);
    assert.ok(!inv.connectors.some((x) => /plugin/.test(x.name)));

    const text = JSON.stringify(inv) + logs.join('\n');
    for (const [k, s] of Object.entries(S)) if (text.includes(s)) assert.fail(`secret ${k} visible`);
  });

  test('conversation : état par compte et dossier de lancement, MCP coupé = disabled', () => {
    const { ALPHA, ZETA } = { ALPHA: path.join(CODE, 'alpha'), ZETA: path.join(CODE, 'zeta') };
    const mcp = made[made.length - 1];
    const by = (list) => Object.fromEntries(list.map((s) => [s.name, s.status]));
    assert.deepEqual(by(mcp.forProject(ALPHA, { accountId: 'travail1' })), {
      'figma-perso': 'connected', 'notion-perso': 'disabled', obsidian: 'connected', secretive: 'connected', supabase: 'pending-approval', 'paddle-live': 'disabled',
    });
    assert.deepEqual(by(mcp.forProject(ALPHA, { accountId: 'perso' })), {
      'figma-perso': 'needs-auth', n8n: 'connected', supabase: 'connected', 'paddle-live': 'needs-auth',
    });
    // dossier sans relevé propre : les MCP du Mac prennent le relevé du dossier personnel (parent)
    assert.deepEqual(by(mcp.forProject(path.join(ZETA, 'src'), { accountId: 'travail1' })).obsidian, 'connected');
    assert.equal(mcp.statusFor('Gmail', { scope: 'connector', accountId: 'perso', cwd: ZETA }), 'connected');
    assert.equal(mcp.statusFor('claude_ai_Gmail', { accountId: 'travail1', cwd: ZETA }), 'needs-auth');
    assert.equal(mcp.statusFor('claude_ai_Google_Drive', { accountId: 'travail1', cwd: ZETA }), 'unknown');
    assert.equal(mcp.statusFor('plugin_legal_slack', { scope: 'plugin', accountId: 'travail1', cwd: ZETA }), 'needs-auth');
    assert.equal(mcp.statusFor('supabase', { scope: 'project', accountId: 'travail1', cwd: ZETA }), 'unknown', 'un MCP de projet ne se prend pas ailleurs');
    assert.equal(mcp.statusFor('supabase', { scope: 'project', accountId: 'travail1', cwd: path.join(ALPHA, 'src') }), 'pending-approval');
  });

  test('au plus un relevé à la fois : les demandes pendant un relevé n\'en font qu\'un de plus', async () => {
    seedHome();
    const { ALPHA, BACK } = seedLists();
    process.env.FAKE_SLEEP_MS = '150';
    try {
      const mcp = mk({ checkPaths: () => [ALPHA, BACK], checkConcurrency: 2 });
      const first = mcp.checkHealth();
      assert.equal(mcp.healthState().running, true);
      const r1 = await mcp.requestCheck({ accountId: 'perso' });
      const r2 = await mcp.requestCheck({ accountId: 'perso', path: ALPHA });
      assert.equal(r1.ok, true);
      assert.equal(r1.queued, true);
      assert.equal(r2.queued, true);
      assert.equal(r1.startedAt, mcp.inventory().healthCheck.startedAt);
      await first;
      await waitFor(() => !mcp.healthState().running && calls().filter((c) => c.ev === 'end').length >= 9);
      await sleep(100);
      const starts = calls().filter((c) => c.ev === 'start');
      const ends = calls().filter((c) => c.ev === 'end');
      assert.equal(starts.length, 9, '6 pour le premier, 3 pour les deux demandes fusionnées (perso : base, alpha, beta/back)');
      assert.deepEqual(starts.slice(6).map((c) => c.id), ['perso', 'perso', 'perso']);
      const firstEnd = Math.max(...ends.filter((e) => starts.slice(0, 6).some((s) => s.pid === e.pid)).map((e) => e.t));
      assert.ok(Math.min(...starts.slice(6).map((s) => s.t)) >= firstEnd, 'le second relevé attend la fin du premier');
      // jamais plus de 2 « claude mcp list » en même temps
      const ev = [...starts.map((s) => [s.t, 1]), ...ends.map((e) => [e.t, -1])].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      let cur = 0, max = 0;
      for (const [, d] of ev) { cur += d; max = Math.max(max, cur); }
      assert.ok(max <= 2, `parallélisme ${max}`);
    } finally { delete process.env.FAKE_SLEEP_MS; }
  });

  test('délai dépassé : la CLI et les MCP qu\'elle a lancés sont arrêtés, l\'état reste « unknown »', async () => {
    seedHome(); seedLists();
    process.env.FAKE_HANG = '1';
    fs.rmSync(PIDS, { force: true });
    try {
      const mcp = mk({ accounts: () => ACCOUNTS().slice(0, 1), checkTimeoutMs: 400 });
      const t0 = Date.now();
      const res = await mcp.checkHealth();
      assert.ok(Date.now() - t0 < 5000);
      assert.deepEqual([res.ok, res.runs, res.failed], [false, 1, 1]);
      assert.ok(logs.some((l) => l.includes('Claude Code ne répond pas (1 s)')));
      const { self, child } = JSON.parse(fs.readFileSync(PIDS, 'utf8'));
      await waitFor(() => { try { process.kill(child, 0); return false; } catch { return true; } }, 3000);
      assert.throws(() => process.kill(self, 0), /ESRCH/);
      const u = Object.fromEntries(mcp.inventory().user.map((s) => [s.name, s]));
      assert.deepEqual(u['figma-perso'].health.map((h) => h.status), ['unknown']);
    } finally { delete process.env.FAKE_HANG; }
  });

  test('un relevé raté garde l\'état connu précédent et sa date', async () => {
    seedHome(); seedLists();
    const mcp = mk({ accounts: () => ACCOUNTS().slice(0, 1) });
    await mcp.checkHealth();
    const before = mcp.inventory().user.find((s) => s.name === 'figma-perso').health;
    process.env.FAKE_LIST_FAIL = '1';
    try {
      const res = await mcp.checkHealth();
      assert.equal(res.ok, false);
    } finally { delete process.env.FAKE_LIST_FAIL; }
    assert.deepEqual(mcp.inventory().user.find((s) => s.name === 'figma-perso').health, before);
    assert.ok(logs.some((l) => /relevé impossible \(travail1, ~\) : Échec : Error: boom/.test(l)));
  });

  test('relevé automatique toutes les N ms, arrêtable ; demande refusée si compte ou dossier inconnu', async () => {
    seedHome(); seedLists();
    const mcp = mk({ accounts: () => ACCOUNTS().slice(0, 1) });
    mcp.startAutoCheck({ firstDelayMs: 5, everyMs: 60 });
    await waitFor(() => calls().filter((c) => c.ev === 'end').length >= 3, 3000);
    mcp.stopAutoCheck();
    await waitFor(() => !mcp.healthState().running);
    const n = calls().length;
    await sleep(200);
    assert.equal(calls().length, n, 'plus rien après l\'arrêt');
    assert.deepEqual(await mcp.requestCheck({ accountId: 'inconnu' }), { ok: false, error: 'Compte inconnu' });
    assert.deepEqual(await mcp.requestCheck({ path: 'relatif' }), { ok: false, error: 'Dossier invalide' });
    assert.deepEqual(await mcp.requestCheck({ path: path.join(CODE, 'nexiste-pas') }), { ok: false, error: 'Dossier introuvable' });
  });
});

describe('connecter un MCP (claude mcp login, faux binaire)', () => {
  const terminal = [];
  const logs = [];
  const made = [];
  // Faux Terminal : exécute la commande préparée comme le ferait Terminal (sans fenêtre).
  const fakeTerminal = (command) => {
    terminal.push(command);
    const c = spawn('/bin/sh', ['-c', command], { env: { ...process.env, FAKE_FROM_TERMINAL: '1' }, stdio: 'ignore' });
    c.unref();
    return Promise.resolve({ ok: true });
  };
  const mk = (opts = {}) => {
    const m = createMcp({ home: HOME, claudeBin: FAKE2, accounts: ACCOUNTS, usage: USAGE, dataDir: path.join(TMP, 'data'), openTerminal: fakeTerminal,
      markerPollMs: 30, recheckAfterMs: 60_000, log: (x) => logs.push(x), ...opts });
    made.push(m);
    return m;
  };
  after(() => { for (const m of made) m.stopAutoCheck(); });
  const JOURNAL = path.join(TMP, 'data', 'mcp-connect.log');
  const MARKERS = path.join(TMP, 'data', 'mcp-login');
  // Attendre la fin des connexions lancées dans le faux Terminal et des relevés qui les suivent.
  const settle = async (mcp) => {
    await waitFor(() => !fs.existsSync(MARKERS) || fs.readdirSync(MARKERS).length === 0, 5000);
    await sleep(50);
    await waitFor(() => !mcp.healthState().running, 5000);
  };

  test('connecteur claude.ai : lancé détaché dans le bon compte et le bon dossier, puis relevé', async () => {
    seedHome();
    const { ALPHA } = seedLists();
    fs.rmSync(JOURNAL, { force: true });
    const mcp = mk();
    const r = await mcp.connect({ name: 'claude.ai Gmail', accountId: 'perso', path: ALPHA });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.mode, 'browser');
    assert.match(r.message, /navigateur/);
    const login = calls().filter((c) => c.ev === 'login');
    assert.deepEqual(login.map((c) => [c.name, c.configDir, c.cwd, c.terminal]), [['claude.ai Gmail', PERSO_DIR, ALPHA, null]]);
    assert.ok(calls().some((c) => c.ev === 'help' && c.args.join(' ') === 'mcp login --help'), 'options vérifiées d\'abord');
    await waitFor(() => calls().some((c) => c.ev === 'end' && c.id === 'perso' && c.cwd === ALPHA));
    await waitFor(() => !mcp.healthState().running);
    assert.equal(mcp.statusFor('Gmail', { scope: 'connector', accountId: 'perso', cwd: ALPHA }), 'connected');
    assert.equal(terminal.length, 0);
    const j = fs.readFileSync(JOURNAL, 'utf8');
    assert.ok(j.includes('claude.ai Gmail') && j.includes('Opening browser'));
    assert.ok(!j.includes(STATE_SECRET) && !logs.join('\n').includes(STATE_SECRET), 'adresse d\'autorisation masquée');
    assert.equal(fs.statSync(JOURNAL).mode & 0o777, 0o600);
  });

  test('MCP OAuth du Mac : dans un pseudo-terminal, sans fenêtre ; dans le bon compte ; relevé à la fin', async () => {
    seedHome(); seedLists();
    terminal.length = 0;
    const mcp = mk();
    const r = await mcp.connect({ name: 'notion-perso' });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.mode, 'browser');
    assert.equal(terminal.length, 0, 'Terminal ne s\'ouvre plus');
    await waitFor(() => calls().some((c) => c.ev === 'login' && c.name === 'notion-perso'));
    assert.ok(calls().filter((c) => c.ev === 'login' && c.name === 'notion-perso').every((c) => c.tty === '1'), 'avec un vrai terminal');
    await waitFor(() => calls().some((c) => c.ev === 'end' && c.id === 'main' && c.cwd === HOME));
    terminal.length = 0;
    assert.equal((await mcp.connect({ name: 'figma-perso', accountId: 'perso', path: path.join(CODE, 'alpha') })).ok, true);
    assert.equal(terminal.length, 0);
    await waitFor(() => calls().some((c) => c.ev === 'login' && c.name === 'figma-perso' && c.configDir === PERSO_DIR));
    await settle(mcp);
  });

  test('MCP OAuth sans Python du système : Terminal en repli, avec la commande prête', async () => {
    seedHome(); seedLists();
    terminal.length = 0;
    const mcp = mk({ ptyPython: '/nulle/part/python3' });
    const r = await mcp.connect({ name: 'notion-perso' });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.mode, 'terminal');
    assert.equal(terminal.length, 1);
    const cmd = terminal[0];
    assert.ok(cmd.startsWith(`cd ${shq(HOME)} && env -u CLAUDE_CONFIG_DIR -u ENABLE_CLAUDEAI_MCP_SERVERS ${shq(FAKE2)} mcp login 'notion-perso'; echo $? > `), cmd);
    await waitFor(() => calls().some((c) => c.ev === 'login' && c.name === 'notion-perso'));
    assert.ok(calls().filter((c) => c.ev === 'login' && c.name === 'notion-perso').every((c) => c.terminal === '1'), 'seulement depuis Terminal');
    // fin de la commande constatée (fichier témoin) : relevé du compte dans ce dossier
    await waitFor(() => calls().some((c) => c.ev === 'end' && c.id === 'main' && c.cwd === HOME));
    await waitFor(() => fs.readdirSync(path.join(TMP, 'data', 'mcp-login')).length === 0, 3000);
    // autre compte : son dossier de configuration
    terminal.length = 0;
    assert.equal((await mcp.connect({ name: 'figma-perso', accountId: 'perso', path: path.join(CODE, 'alpha') })).ok, true);
    assert.ok(terminal[0].startsWith(`cd ${shq(path.join(CODE, 'alpha'))} && env -u ENABLE_CLAUDEAI_MCP_SERVERS CLAUDE_CONFIG_DIR=${shq(PERSO_DIR)} `), terminal[0]);
    await waitFor(() => calls().some((c) => c.ev === 'login' && c.name === 'figma-perso' && c.configDir === PERSO_DIR));
    await settle(mcp);
  });

  test('connecteur qui demande un terminal : Terminal en repli ; erreurs lisibles ; refus sans lancer la CLI', async () => {
    seedHome(); seedLists();
    terminal.length = 0;
    const mcp = mk();
    const r = await mcp.connect({ name: 'claude.ai Needs Tty' });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.mode, 'terminal');
    assert.ok(terminal[0].includes(`mcp login 'claude.ai Needs Tty'`));
    await waitFor(() => calls().some((c) => c.ev === 'login' && c.name === 'claude.ai Needs Tty' && c.terminal === '1'));
    await settle(mcp);
    assert.deepEqual(await mcp.connect({ name: 'claude.ai Absent' }), { ok: false, error: 'Ce MCP n\'est pas déclaré pour ce compte et ce dossier' });
    const n = calls().length;
    assert.deepEqual(await mcp.connect({ name: 'obsidian' }), { ok: false, error: 'Ce MCP tourne sur le Mac : il n\'a pas de connexion par navigateur' });
    assert.deepEqual(await mcp.connect({ name: 'paddle-live', path: path.join(CODE, 'alpha') }), { ok: false, error: 'Ce MCP se connecte avec la clé de sa configuration : rien à autoriser' });
    assert.deepEqual(await mcp.connect({ name: '--help' }), { ok: false, error: 'Nom invalide' });
    assert.deepEqual(await mcp.connect({ name: 'a\nb' }), { ok: false, error: 'Nom invalide' });
    assert.deepEqual(await mcp.connect({ name: 'figma-perso', accountId: 'inconnu' }), { ok: false, error: 'Compte inconnu' });
    assert.deepEqual(await mcp.connect({ name: 'figma-perso', path: 'relatif' }), { ok: false, error: 'Dossier invalide' });
    assert.equal(calls().length, n, 'aucun appel à la CLI');
    assert.ok(!calls().some((c) => c.ev === 'login' && ['obsidian', 'paddle-live', '--help'].includes(c.name)));
  });

  test('CLI sans « mcp login » : refus clair, rien de lancé', async () => {
    process.env.FAKE_NO_LOGIN = '1';
    terminal.length = 0;
    try {
      const r = await mk().connect({ name: 'claude.ai Gmail' });
      assert.deepEqual(r, { ok: false, error: 'Cette version de Claude Code ne sait pas connecter un MCP (claude mcp login)' });
      assert.equal(terminal.length, 0);
    } finally { delete process.env.FAKE_NO_LOGIN; }
  });
});

// ---------- .mcp.json lié vers un fichier hors du projet ----------

describe('.mcp.json qui est un lien symbolique', () => {
  const mk = () => createMcp({ home: HOME, accounts: ACCOUNTS, backupDir: path.join(TMP, 'data', 'backups', 'mcp') });
  const cfg = { type: 'http', url: 'https://mcp.figma.com/mcp' };

  test('lien vers ~/.claude.json : édition refusée avec un message clair, rien d\'écrit', async () => {
    seedHome();
    const dir = path.join(CODE, 'lie');
    fs.mkdirSync(dir, { recursive: true });
    fs.symlinkSync(path.join(HOME, '.claude.json'), path.join(dir, '.mcp.json'));
    const before = fs.readFileSync(path.join(HOME, '.claude.json'), 'utf8');
    for (const r of [await mk().addProject(dir, 'x', cfg), await mk().updateProject(dir, 'figma-perso', cfg), await mk().removeProject(dir, 'figma-perso')]) {
      assert.equal(r.ok, false);
      assert.match(r.error, /lien vers ~\/\.claude\.json, hors du projet : Vigie ne le modifie pas/);
    }
    assert.equal(fs.readFileSync(path.join(HOME, '.claude.json'), 'utf8'), before);
    assert.ok(fs.lstatSync(path.join(dir, '.mcp.json')).isSymbolicLink());
    const p = mk().inventory().projects.find((x) => x.name === 'lie');
    assert.match(p.readOnly, /hors du projet/);
    assert.equal(mk().inventory().projects.find((x) => x.name === 'alpha').readOnly, undefined);
    // lien cassé : refusé aussi
    const broken = path.join(CODE, 'casse');
    fs.mkdirSync(broken, { recursive: true });
    fs.symlinkSync(path.join(TMP, 'nulle-part.json'), path.join(broken, '.mcp.json'));
    assert.match((await mk().addProject(broken, 'x', cfg)).error, /lien cassé/);
    assert.ok(!fs.existsSync(path.join(TMP, 'nulle-part.json')));
  });

  test('lien vers un fichier du projet lui-même : permis, la cible est écrite et le lien reste', async () => {
    const dir = path.join(CODE, 'interne');
    write(path.join(dir, 'config', 'mcp.json'), { mcpServers: {} });
    fs.symlinkSync(path.join(dir, 'config', 'mcp.json'), path.join(dir, '.mcp.json'));
    const r = await mk().addProject(dir, 'figma', cfg);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.ok(fs.lstatSync(path.join(dir, '.mcp.json')).isSymbolicLink());
    assert.deepEqual(readJ(path.join(dir, 'config', 'mcp.json')).mcpServers.figma, cfg);
  });
});
