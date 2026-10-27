# API v2 de Vigie (contrat entre le moteur et l'app Mac)

Serveur : `http://127.0.0.1:4777`. JSON UTF-8. Dates en ISO 8601 UTC (`"2026-10-20T01:14:00.000Z"`), l'app les affiche en heure locale.
Accès : chaque requête sur `/api/` porte l'en-tête `X-Vigie-Token` (le jeton écrit par le moteur dans `data/api-token`, privé), sinon 401 ; seul `GET /api/v2/health` s'en passe. Écritures : `POST` avec `Content-Type: application/json` **et** `X-Vigie: 1` (sinon 403). Réponse d'écriture : `{ "ok": true, ... }` ou `{ "ok": false, "error": "phrase courte en français" }` avec un code 4xx.
Tout champ marqué `?` peut être `null` ou absent. Les textes sont déjà en français et courts : l'app les affiche tels quels.

## Types communs

```jsonc
// AccountSummary
{
  "id": "travail1",                 // identifiant stable : travail1 | travail2 | perso | …
  "label": "Travail 1",
  "email": "alex@studio-exemple.fr",        // ? inconnu tant que le compte n'est pas connecté
  "expectedEmail": "alex@studio-exemple.fr",  // ? adresse prévue pour ce compte
  "wrongAccount": false,            // true si connecté avec une autre adresse que celle prévue : l'app le signale
  "connected": true,                // d'après le coffre des connexions s'il a un état frais (contenu du trousseau), sinon l'entrée existe
  "login": { "state": "ok", "since": "2026-10-23T08:20:30.000Z", "restoredAt": null }, // ? vu par le coffre (voir plus bas)
  "isDefault": true,                // compte des nouvelles conversations (et de celles jamais associées)
  "usage": {
    "session":   { "pct": 100, "resetsAt": "2026-10-20T00:40:00.000Z" },   // ? fenêtre de 5 h
    "week":      { "pct": 39,  "resetsAt": "2026-10-26T19:00:00.000Z" },   // ?
    "weekModel": { "label": "Fable", "pct": 55, "resetsAt": "2026-10-26T18:59:00.000Z" }, // ?
    "observedAt": "2026-10-20T00:12:00.000Z",  // ? âge du relevé (affiché « il y a 12 min »)
    "source": "session"             // session (relevé écrit par une vraie session) | ping (petite requête de relevé) ; null si aucun
  }
  // Règle : jamais de relevé périmé. Un pourcentage dont la remise à zéro est passée, ou un relevé de plus de 6 h,
  // est remplacé par null (l'app affiche « — » et propose « Actualiser »).
  // weekModel n'arrive que par les vraies sessions : null pour un compte qui n'a pas travaillé récemment.
}

// ConversationSummary
{
  "id": "b1b9b451-c53c-439e-b804-3689257268e3",
  "title": "Refaire le site Horizon complet",
  "project": "atelier",
  "cwd": "/Users/alex/Code/atelier",
  "status": "working",              // working | idle | waiting | blocked | closed
  "running": true,
  "accountId": "travail1",          // ? null si inconnu (= compte par défaut)
  "autoAccept": true,               // valeur effective
  "autoAcceptOverride": null,       // ? true/false si réglé pour cette conversation seulement
  "connectors": "off",              // off | on : connecteurs de compte pour cette conversation (effectif)
  "agentsRunning": 2,
  "workflowsRunning": 1,
  "weekPct": 14.2,                  // ? estimation de la part de la semaine du compte
  "lastActivity": "2026-10-20T00:25:31.000Z",
  "needsYou": 1,                    // nombre d'éléments « à regarder » de cette conversation
  "headline": "Étape L2.24 sur L2.29"   // ? une ligne : tâche en cours, sinon début du dernier compte rendu
}
```

## GET /api/v2/overview

```jsonc
{
  "now": "…",
  "settings": {
    "autoAccept": true,
    "questionsAuto": false,          // « Quand je ne suis pas là, Claude choisit l'option recommandée »
    "questionWaitMin": 20,
    "connectorsDefault": "off",
    "guard": { "enabled": true, "waitMin": 10,
               "rules": [ { "id": "sudo", "label": "Commande administrateur (sudo)", "disabled": false } ] }
  },
  "since": "2026-10-19T21:40:00.000Z",          // dernier passage de l'utilisateur (POST /api/v2/seen)
  "sinceSummary": { "accepted": 1284, "questionsAuto": 2, "blocked": 1, "reports": 2, "testsFailed": 3, "limits": 0 },
  "toReview": [
    { "id": "q:7f3a…", "kind": "question",      // question | blocked | waiting | limit
      "conversationId": "…", "conversationTitle": "Atelier",
      "title": "Quel fond pour la charte ?",
      "detail": "Claude a pris « Fond B (recommandé) »",
      "ts": "…",
      "question": {                              // ? seulement pour kind = question
        "id": "7f3a…",
        "items": [ { "question": "Quel fond pour la charte ?", "header": "Fond", "multiSelect": false,
                     "options": [ { "label": "Fond B (recommandé)", "description": "…" }, { "label": "Fond A", "description": "…" } ],
                     "chosen": "Fond B (recommandé)" } ] } }
  ],
  "reports": [
    { "kind": "artifact",                        // artifact | missionDone | workflowDone
      "conversationId": "…", "conversationTitle": "Atelier",
      "title": "Analyse finale atelier", "detail": "Pourquoi atelier perd des joueurs…",
      "url": "https://claude.ai/artifact/…",    // ?
      "ts": "…" }
  ],
  "accounts": [ /* AccountSummary */ ],
  "conversations": [ /* ConversationSummary, ouvertes d'abord puis fermées des dernières 48 h */ ],
  "engine": { "indexing": false, "wrapperActive": false }
}
```

## GET /api/v2/conversation/:id

```jsonc
{
  "summary": { /* ConversationSummary */ "branch": "v1.4", "startedAt": "…" },
  "now": {
    "text": "La charte 1.4 est appliquée écran par écran…",   // ? dernier compte rendu de Claude (≤ 600 caractères)
    "ts": "…",
    "tasks": [ { "text": "L2.24 Icônes de fin de partie", "status": "doing" } ],  // done | doing | todo ; [] si aucune liste
    "tasksTs": "…",                 // ? quand la liste de tâches a été mise à jour pour la dernière fois
    "plan": {                       // ? plan en plusieurs étapes suivi par la conversation (fichier de plan qu'elle a écrit ou lu)
      "title": "Plan d'exécution 1.4",
      "file": "/Users/alex/Code/atelier/atelier/docs/superpowers/plans/2026-10-19-1.4-execution.md",
      "updatedAt": "…",             // dernière modification du fichier
      "steps": [ { "id": "L2.24", "text": "Icônes de fin de partie", "status": "doing", "group": "C. La charte appliquée aux écrans" } ],
      "done": 23, "total": 31,
      "current": "L2.24"            // ? étape en cours (première non faite)
    }
  },
  "chapters": [   // plus récent d'abord, 30 max ; un chapitre = une vraie demande de l'utilisateur
    { "id": "…", "prompt": "applique la partie C du plan…", "start": "…", "end": "…", "durationMs": 1303616,
      "stats": { "workflows": 1, "agents": 11, "artifacts": 0, "files": 24, "tests": 40, "testsFailed": 3, "commits": 6 },
      "outcome": "L2.19 à L2.23 faites…" }      // ? dernier message texte de Claude dans ce chapitre
  ],
  "accepted": [   // décisions de Vigie pour cette conversation, plus récent d'abord, 300 max
    { "ts": "…", "kind": "command",            // command | commit | push | file | web | mcp | agent | question | other
      "title": "Lancer les tests et vérifier les types", "detail": "npx vitest run && npx tsc -b",
      "decision": "auto" }                      // auto | you | blocked | waiting | denied
  ],
  "activity": [   // fil des actions de Claude et de ses agents, plus récent d'abord, 300 max
    { "ts": "…", "kind": "file", "title": "Modifie Pastille.tsx", "detail": "apps/web/src/components/Pastille.tsx", "agent": "faire:L2.22", "ok": true }
  ],
  "agents": {
    "running": [ { "id": "…", "title": "faire:L2.24", "type": "workflow-subagent", "workflow": "partie-c-charte-ecrans",
                   "phase": "Faire", "startedAt": "…", "lastAt": "…", "durationMs": 120000,
                   "actions": 44, "files": 3, "tests": 2, "status": "running", "lastAction": "Lance vitest" } ],
    "done": [ /* même forme, status : done | failed | killed | idle */ ]
  },
  "workflows": [ { "id": "wf_…", "name": "partie-c-charte-ecrans", "summary": "…", "status": "running",
                   "startedAt": "…", "durationMs": 1303616, "agents": 11, "tokens": 387955, "phases": ["Faire", "Réfuter"] } ],
  "artifacts": [ { "title": "Charte atelier 1.4", "url": "https://claude.ai/artifact/…", "description": "…", "ts": "…", "publishes": 2 } ],
  "files": [ { "path": "/Users/…/Pastille.tsx", "name": "Pastille.tsx", "ext": "tsx", "kind": "code",   // code | style | page | doc | data | image | media | config | other
               "created": false, "writes": 1, "ts": "…", "by": "faire:L2.22", "location": "project" } ],  // project | elsewhere | scratch
  "tests": [ { "ts": "…", "kind": "tests", "ok": true, "passed": 245, "failed": 0,   // tests | e2e | types | lint | build
               "title": "Lancer vitest et tsc", "command": "…", "by": "refuter:L2.22" } ],
  "mcp": [ { "name": "figma-perso", "scope": "user", "uses": 350, "enabled": true } ],   // scope : project | user | local | connector | plugin
  "tokens": { "today": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }, "total": { /* idem */ } },
  "limits": [ { "ts": "…", "text": "You've hit your session limit · resets 11:40pm" } ]
}
```

## GET /api/v2/mcp

```jsonc
{
  "user": [   // MCP de ton Mac, valables dans tous les comptes
    { "name": "figma-perso", "type": "http", "target": "https://mcp.figma.com/mcp", "service": "figma",
      "accounts": ["travail1"],          // comptes où il est déclaré (l'app propose de recopier dans les autres)
      "uses7d": 3657, "needsAuth": false }
  ],
  "projects": [
    { "path": "/Users/alex/Code/atelier", "name": "atelier", "file": "/Users/alex/Code/atelier/.mcp.json",
      "servers": [ { "name": "supabase", "type": "stdio", "target": "npx -y @supabase/mcp-server-supabase …", "service": "supabase",
                     "uses7d": 1428, "disabled": false } ] }
  ],
  "local": [ { "path": "/Users/alex/Code/outil-design", "name": "outil-design",
               "servers": [ { "name": "paddle-live", "type": "http", "target": "…", "service": "paddle", "uses7d": 0, "disabled": true } ] } ],
  "connectors": [ { "name": "Gmail", "accountId": "travail1", "uses7d": 192 } ],
  "connectorsDefault": "off"
}
```
`target` ne contient jamais de secret : valeurs de `env`, `headers`, paramètres d'URL et arguments ressemblant à des clés sont remplacés par `••••`.

## GET /api/v2/accounts

```jsonc
{
  "accounts": [ /* AccountSummary */ { "configDir": null, "keychainItem": "Claude Code-credentials", "dirReady": true } ],
  "defaultForNew": "travail1",
  "wrapper": { "path": "/Users/alex/Code/auto-accept/bin/claude-account-wrapper", "active": false }
}
```

## Écritures

| Point d'entrée | Corps | Effet |
|---|---|---|
| `POST /api/v2/settings` | `{ autoAccept?, questionsAuto?, questionWaitMin?, connectorsDefault?, guard?: { enabled?, waitMin?, rules?: [{id, disabled}] } }` | réglages généraux |
| `POST /api/v2/conversation/:id/settings` | `{ autoAccept?: bool\|null, accountId?: string, connectors?: "on"\|"off"\|null }` | réglages de la conversation ; changer `accountId` renvoie `{ ok, switch: { state: "done"\|"pending", message } }` |
| `POST /api/v2/questions/:id/review` | `{ action: "ok" }` ou `{ action: "change", answers: { "<question>": "<label>" } }` | `change` renvoie `{ ok, correction: "texte à envoyer", delivered: bool, openUrl? }` |
| `POST /api/v2/seen` | `{}` | « j'ai tout vu » |
| `POST /api/v2/mcp/user` | `{ action: "add"\|"update"\|"remove", name, config?, accounts?: [ids] }` | via `claude mcp … --scope user` par compte |
| `POST /api/v2/mcp/project` | `{ action: "add"\|"update"\|"remove", path, name, config? }` | édite `<path>/.mcp.json` (sauvegarde) |
| `POST /api/v2/mcp/disable` | `{ path, name, disabled: bool }` | coupe ou rallume un MCP pour un projet |
| `POST /api/v2/accounts` | `{ action: "create", label }`, `{ action: "rename", id, label }`, `{ action: "setDefault", id }`, `{ action: "connect", id }`, `{ action: "wrapper", enable: bool }`, `{ action: "refresh", id? }` | gestion des comptes ; refresh relève l'usage (session, semaine) du compte (ou de tous) par une requête minimale, au plus une fois toutes les 10 min par compte |
| `GET /api/v2/agents/runs` | — | les derniers lancements d'agents (50 au plus, le dernier par agent et par dossier) et le rapport de chacun : `{ runs: [{ id, agent, name, icon, folder, surface, session, conversation, at, report, reportFile, unreadable, changedAt }] }` (voir « Rapports d'agents ») |
| `POST /api/v2/agents/runs` | `{ action: "todo", id, index, done }` ou `{ action: "hide", id }` | coche ou décoche une action du rapport (le fichier est réécrit, le reste intact) ; retire un lancement de la liste (le rapport reste dans le dossier du projet) ; 404 lancement inconnu, 400 action introuvable |
| `POST /api/v2/agents/launch` | `{ id, values: { "<champ>": "texte" }, folder, files?, surface?, session?, mcp? }` | prépare le dossier d'un agent (fichiers joints copiés, consigne écrite) et l'ouvre dans VS Code ou l'app Claude (voir « Agents » plus bas) |

`config` d'un MCP : la forme de Claude Code, `{ "type": "stdio", "command": "…", "args": [], "env": {} }` ou `{ "type": "http", "url": "…", "headers": {} }`.

## Précisions (serveur v2)

Ajouts compatibles : de nouveaux champs facultatifs, jamais de champ retiré ni renommé. L'app ignore les clés qu'elle ne connaît pas.
Les fixtures `mac/VigieApp/Fixtures/*.json` sont de vraies réponses du serveur (vérifiées sans secret). `test/server.test.mjs` vérifie qu'elles suivent ce contrat. Les liens `conversation-<id>.json` pointent vers `conversation-<projet>.json`.

### Erreurs et statuts HTTP
Toute erreur renvoie `{ "ok": false, "error": "phrase courte" }`, en lecture comme en écriture.
| Statut | Cas |
|---|---|
| 400 | JSON illisible, corps qui n'est pas un objet, valeur refusée, action MCP ou compte refusée, adresse invalide (`//`) |
| 401 | `X-Vigie-Token` absent ou faux (toute route `/api/` sauf `/api/v2/health`) |
| 403 | hôte autre que 127.0.0.1/localhost, `X-Vigie: 1` absent, `Origin` d'un autre site |
| 404 | adresse inconnue ; conversation ou question introuvable (une conversation de plus de 48 h n'a plus de détail) |
| 405 | méthode non prise en charge sur une adresse connue (ex. `GET /api/v2/settings`) |
| 413 | corps de plus de 1 Mo |
| 500 | erreur interne (`"Erreur interne de Vigie."`), détail dans le journal du serveur, masqué |
Toutes les réponses portent `X-Frame-Options: DENY` et une `Content-Security-Policy` (`frame-ancestors 'none'`) ; aucune n'autorise CORS.
`GET /api/v2/health` → `{ ok, version: 2, indexing, history }` (sans jeton : lu par `scripts/install.sh` pour attendre le moteur).

### ConversationSummary
- `accountId` : le compte noté pour la conversation (`data/accounts.json`), sinon `"travail1"` : sans choix noté, le lanceur la reprend sur Travail 1.
- `status` : `blocked` quand un garde-fou attend la décision de l'utilisateur dans VS Code, `waiting` quand une question attend (ou quand Claude Code dit « en attente »).
- `weekPct` = poids d'usage de la conversation depuis le début de la semaine du compte (`week.resetsAt` − 7 j), divisé par le poids de toutes les conversations de ce compte sur la même période, multiplié par `week.pct`. Poids = input + 5 × output + 1,25 × écriture cache + 0,1 × lecture cache, rangé par organisation (pièces jointes `credential_org`), l'organisation du compte venant de `oauthAccount.organizationUuid`. Arrondi au dixième. `null` si le compte n'a pas de relevé hebdomadaire, pas d'organisation connue, ou aucun usage sur la période.
- `needsYou` = nombre d'éléments de `toReview` de cette conversation.
- Champs ajoutés : `contextTokens` (? taille du contexte, pour « ≈ N k tokens relus » en cas de bascule), `pendingAccountId` (? bascule en attente vers ce compte), `waitingFor` (? texte de Claude Code). Dans le détail seulement : `branch`, `startedAt`.

### toReview
Ce qui attend l'utilisateur maintenant d'abord (plus récent d'abord), puis ce qui s'est passé depuis `since`, 100 au plus. Le préfixe de `id` dit d'où vient l'élément :
| `id` | `kind` | Quand |
|---|---|---|
| `g:<conv>:<ts>` | `blocked` | garde-fou en attente dans VS Code (`detail` : « … sinon refusée dans N min ») |
| `w:<conv>:<ts>` | `waiting` | question en attente (« … Claude choisit l'option recommandée dans N min ») |
| `c:<conv>` | `waiting` | conversation que Claude Code dit en attente de l'utilisateur |
| `s:<conv>:<ts>` | `waiting` | bascule de compte faite : envoyer un message pour relancer la conversation |
| `q:<id>` | `question` | question répondue à la place de l'utilisateur, pas encore relue |
| `b:<conv>:<ts>` | `blocked` | action refusée par un garde-fou depuis `since` : à faire soi-même |
| `l:<conv>:<ts>` | `limit` | limite atteinte depuis `since` (la plus récente par conversation ; `detail` = texte de Claude Code) |
Une attente n'est plus listée si son délai est passé (+ 2 min), si le processus du hook est mort, si la conversation est fermée, ou si un événement de fin a suivi. Ainsi, une réponse de l'utilisateur dans VS Code ne laisse pas d'« attente fantôme ».
`reports` : tout depuis `since`, et au moins les dernières 24 h, 60 au plus. `sinceSummary.reports` ne compte que depuis `since`.
`engine.notices` (? liste de phrases) : réparations des dossiers de comptes à signaler.

### Détail d'une conversation
- `accepted[].decision` d'après le journal du hook : `auto-accepte`, `question-auto` → `auto` ; `garde-fou-bloque` → `blocked` ; `*-attente` encore en cours → `waiting` (une attente finie n'a pas de ligne : sa suite en a une) ; `*-tu-as-repondu`, `*-pour-toi`, `*-rendu(e)`, `refus-classifieur-pour-toi`, `reponse-perdue` → `you` ; `refuse-mode-auto` → `denied`. `detail` est masqué (clés, jetons). Pour un garde-fou, il commence par le nom de la règle (`« règle » · commande`). Pour une question : `Choisi : <option>`. Champ ajouté : `agent` (? nom de l'agent).
- `mcp[]` : tout ce qui est branché pour le dossier et le compte de la conversation (même non utilisé, `uses: 0`), plus ce qu'elle a utilisé. `scope` peut aussi valoir `unknown` (serveur utilisé mais introuvable aujourd'hui dans les configurations, ex. retiré depuis, ou `claude-vscode` ajouté par l'extension), avec `enabled: null`. Connecteur : `enabled` = connecteurs de la conversation activés. Champs ajoutés : `service`, `lastTs`.
- `tests[]` : champs ajoutés `pending` (test de fond pas encore fini, `ok: null`), `expectedFail` (étape rouge voulue, à montrer neutre, non comptée dans `testsFailed`), `line`.

### GET /api/v2/mcp
Champs ajoutés : sur chaque serveur `config` (configuration masquée, pour préremplir la modification : renvoyer les `••••` tels quels, le serveur remet les vraies valeurs) ; `user[].differs` (définition différente selon les comptes), `user[].disabledIn` (projets où il est coupé), `local[].servers[].accounts`, `projects[].error` (`.mcp.json` illisible), `connectors[].service`. `connectors[].accountId` vient de l'organisation des conversations qui ont utilisé le connecteur, sinon du compte qui le connaît ; `null` si ambigu.

### Réponses des écritures
| Point d'entrée | Réponse en cas de succès |
|---|---|
| `POST /api/v2/settings` | `{ ok, settings }` (même forme que `overview.settings`) |
| `POST /api/v2/conversation/:id/settings` | `{ ok, switch?: { state, message, estimate? }, conversation: { autoAccept, autoAcceptOverride, connectors, accountId } }` |
| `POST /api/v2/questions/:id/review` | `{ ok, correction, delivered: false, openUrl }` : copier `correction`, puis ouvrir `openUrl` s'il n'est pas `null` |
| `POST /api/v2/seen` | `{ ok, since }` ; `{ ts }` facultatif (pas dans le futur) |
| `POST /api/v2/mcp/user`, `/disable` | `{ ok, results: [{ accountId, ok, changed?, skipped?, error? }] }` ; en échec, `error` = « Compte : raison · Compte : raison » |
| `POST /api/v2/mcp/project` | `{ ok, changed?, file?, backup? }` (sauvegarde rangée dans les données de Vigie, pas dans le projet) |
| `POST /api/v2/accounts` | ce que renvoie le module des comptes (`{ ok, message?, account?, … }`) ; `create` accepte aussi `email?`, `health` répare les liens |
Valeurs vérifiées (sinon 400, rien n'est écrit) : booléens stricts ; `questionWaitMin` entier de 1 à 120 ; `guard.waitMin` de 0 à 120 ; `""` et `null` refusés (jamais changés en 0) ; `guard.rules` = `[{ id, disabled }]` sur des règles existantes. `questionsAuto: true` garde l'ancien mode « tout de suite » s'il est déjà actif. `:id` d'une conversation = UUID. `:id` d'une question : avec ou sans `q:`. Conversation : la bascule de compte est faite en premier, et si elle est refusée, rien d'autre n'est changé.

### Comptes (champs ajoutés par le module des comptes)
`AccountSummary` peut porter `expectedEmail` (? adresse prévue pour ce compte) et `wrongAccount` (connecté avec une autre adresse que celle prévue).

### Connexions (coffre, `lib/vault.mjs`, 2026-10-23)
`AccountSummary.login` (null sans état de moins de 15 min) : `state` = `ok` | `restored` (remise par Vigie à ce passage) | `restoring` (perdue, remise en cours) | `lost` (perdue, rien à remettre) | `dead` (refusée par Anthropic : jetons vidés par Claude Code) | `logged-out` | `unknown` (trousseau illisible à ce passage : `connected` garde la dernière valeur connue) ; `since` (? début de cet état) ; `restoredAt` (? dernière remise).

Le coffre publie `data/connexions.json` toutes les 20 s, lu par le lanceur : `{ v: 1, checkedAt, checkedAtEpoch, accounts: { <id>: { connected, state, since, restoredAt, email } }, codex }`. Jamais rien de secret.

Dans « À regarder » (`toReview`, `kind: "waiting"`) : `cx:<compte>:<état>` (« <compte> : à reconnecter » ; `lost`, `dead`, `restoring` depuis plus de 2 min, et le compte du Mac s'il est `logged-out`), `cf:<conversation>:<compte>` (« Partie sur <compte> » : conversation ouverte lancée sur un autre compte que le sien, qui n'était pas connecté). `engine.notices` : « Connexion de <compte> remise par Vigie à HH:MM… » pendant une heure.

Journal du lanceur (`data/launches.log`), raisons nouvelles : `sans-choix` (reprise jamais associée : compte des nouvelles conversations), `repli:<voulu>:<raison>` (compte voulu inutilisable : `non-connecte`, `historique-non-relie`, `dossier-absent`, `chemin`, `compte-inconnu`), `connexion-du-mac` (compte du Mac déconnecté : une conversation neuve part dessus pour que la connexion de VS Code l'atteigne), `deconnexion` / `connexion` (`auth logout` / `auth login` de l'extension, sans fiche de processus).

## Ajouts du 2026-10-20 (retours de l'utilisateur, tour 2)

### Cartes de la vue d'ensemble : champs en plus dans ConversationSummary

```jsonc
{
  "progress": { "done": 23, "total": 31, "label": "Plan 1.4", "current": "L2.24 Icônes de fin de partie" },  // ? plan, sinon liste de tâches
  "tests": { "failedRecent": 2, "running": 1, "lastOk": true, "lastTs": "…", "lastTitle": "vitest + tsc" },  // failedRecent : échecs des 2 dernières heures non suivis d'une réussite du même genre
  "accepted": { "today": 412, "sinceSeen": 128 },
  "artifacts": { "count": 14, "last": { "title": "Charte atelier 1.4", "url": "…", "ts": "…" } },
  "agentsRunning": 2, "workflowsRunning": 1          // déjà présents
}
```

### État réel des MCP (sans requête au modèle : `claude mcp list`, ~7 s, par compte et par dossier)

Chaque serveur de `GET /api/v2/mcp` (user, projects[].servers, local[].servers) et chaque connecteur gagne :

```jsonc
"health": [ { "accountId": "travail1", "status": "connected", "checkedAt": "…" } ]
// status : connected | needs-auth | failed | pending-approval | disabled | unknown
```

et chaque entrée de `conversation.mcp[]` gagne `"status"` (le dernier état connu pour le dossier et le compte de la conversation).
Les relevés (noms et états, jamais une adresse) sont gardés dans `data/mcp-health.json` (0600) et relus au démarrage :
après une mise à jour, les états sont là tout de suite (un relevé de plus d'un jour est oublié). Un MCP vérifié seul
porte sa propre date ; un relevé complet commencé avant ne l'écrase pas. `GET /api/v2/agents` vérifie seul, en fond,
le MCP choisi d'un agent encore jamais vu (une fois par minute au plus).
Icônes : le champ `service` (figma, webflow, notion, supabase, netlify, vercel, resend, n8n, obsidian, artlist, anarlog, github, gmail, google-drive, google-calendar, slack, claude-docs, qonto, gocardless, pennylane, stripe, metricool, pipedrive, semrush, vimeo, magnific, paddle, fusion, autre) est fourni pour tous les serveurs ET connecteurs ; l'app associe une icône par service.

| Point d'entrée | Corps | Effet |
|---|---|---|
| `POST /api/v2/mcp/check` | `{ accountId?, path? }` | relance tout de suite la vérification (sinon toutes les 10 min) ; renvoie `{ ok, startedAt }` |
| `POST /api/v2/mcp/verify` | `{ names: ["figma-pro"], accountId? }` | vérifie chaque MCP **seul** (`claude mcp get <nom>`, ≈ 2 s au lieu de tous les MCP du compte), sur ce compte ou sur chaque compte qui le déclare ; la réponse attend les résultats : `{ ok, results: [{ name, accountId, status, checkedAt }] }`. Un connecteur claude.ai (pas de `claude mcp get`) : `pending: true`, un relevé complet de ce compte part en fond. 400 liste vide (20 noms au plus), nom invalide, compte inconnu |
| `GET /api/v2/changes?since=N` | — | attend le prochain changement d'état des MCP (relevé, vérification, fin d'une autorisation, passerelle), 20 s au plus ; renvoie `{ version }`. Sans `since`, ou `since` en retard : tout de suite. L'app relit alors la page affichée, à la seconde |
| `POST /api/v2/mcp/connect` | `{ name, accountId?, path? }` | lance `claude mcp login <name>` dans le bon compte et le bon dossier : le navigateur s'ouvre sur la page d'autorisation du service ; renvoie `{ ok, message }` ; une vérification suit à la fin |

### Actions sensibles : décider depuis l'app (tour 2)

Chaque élément `toReview` de kind `blocked` (garde-fou) porte :

```jsonc
{
  "kind": "blocked",
  "state": "waiting",            // waiting : la conversation attend encore ta décision (hook en attente) | blocked : refusée
  "pendingId": "91234",          // ? identifiant de l'attente (pid du hook) quand state = waiting
  "expiresAt": "…",              // ? fin de l'attente (refus automatique ensuite)
  "rule": "Commande administrateur (sudo)",
  "command": "sudo …",           // texte exact de l'action (jamais tronqué ici, 4000 caractères max)
  "byAgent": "verifier:contrat", // ? null = la conversation elle-même
  "conversationId": "…", "cwd": "…",
  "needsPassword": true          // commande sudo : à lancer soi-même dans Terminal
}
```

| Point d'entrée | Corps | Effet |
|---|---|---|
| `POST /api/v2/pending/:pendingId` | `{ decision: "allow" \| "deny" }` | répond à une action sensible en attente, comme un clic dans VS Code ; renvoie `{ ok, message }` ; 404 si l'attente est finie |
| `POST /api/v2/review/:id/dismiss` | `{}` | retire l'élément de « À regarder » |
| `POST /api/v2/open` | `{ kind: "conversation", id }` ou `{ kind: "terminal", command, cwd }` | ouvre la conversation dans VS Code, ou Terminal avec la commande préparée (non exécutée : L'utilisateur appuie sur Entrée et tape son mot de passe) |

Mécanisme côté hook : pendant l'attente d'un garde-fou, le hook relit `data/decisions.json` toutes les 3 s ; une entrée `{ "<pendingId>": "allow" | "deny" }` y est prise comme la réponse de l'utilisateur (puis effacée).

### Précisions du serveur (tour 2)

**Cartes (`conversations[]`)**
- `progress` : `null` sans plan ni liste de tâches. `label` = titre du plan (60 caractères au plus) ou « Tâches » ; `current` = « L2.24 Texte de l'étape » (90 au plus).
- `tests` : toujours un objet. `failedRecent` compte des lancements (pas des tests distincts) ; l'étape rouge voulue et un échec rattrapé ensuite par une réussite du même genre ne comptent pas. `running` : tests de fond pas encore finis d'une conversation ouverte. `failures` (? présent seulement si `failedRecent > 0`) : 5 au plus, plus récent d'abord, `{ title, line?, kind, ts, by? }` (`by` = agent).
- `accepted` : toujours un objet ; événements `auto-accepte` et `question-auto` de la conversation, `today` depuis minuit (heure du Mac), `sinceSeen` depuis `since`.
- `artifacts` : toujours un objet, `{ count, last? }`.
- `connectors` (effectif) vaut `on` tant que le lanceur n'est pas actif (`engine.wrapperActive: false`) : sans lui rien ne coupe les connecteurs, ils sont chargés. Lanceur actif : le réglage (conversation, sinon `connectorsDefault`). Même règle pour `conversation.connectors` dans la réponse de `POST /conversation/:id/settings` et pour `mcp[].enabled` d'un connecteur.
- Conversations jetables (lancées sous `/tmp`, `/private/tmp`, `/var/folders`, le dossier temporaire ou un dossier `scratchpad`, jamais sous le dossier personnel) : une fois fermées, ni carte, ni rapport, ni élément « À regarder ». Ouvertes, elles restent listées.

**Fil des décisions : `recentAccepted` (dans `GET /api/v2/overview`)**
```jsonc
"recentAccepted": [   // les 30 dernières décisions de Vigie, toutes conversations confondues, plus récent d'abord
  { "ts": "…", "conversationId": "…", "conversationTitle": "Atelier", "project": "atelier",
    "kind": "command", "title": "Lancer les tests", "detail": "npx vitest run", "decision": "auto",
    "agent": "faire:L2.22",   // ? nom de l'agent
    "service": null }         // ? service du MCP appelé (icône), pour kind = mcp
]
```
Mêmes règles que `accepted[]` du détail : attentes finies écartées, `detail` masqué, conversations jetables écartées. Les anciennes lignes de question du journal (entrée brute de l'outil en JSON, coupée à 600 caractères) s'affichent comme les nouvelles : `title` = la question, `detail` = « question [option / option] ». `accepted[]` du détail porte aussi `service`.

**À regarder**
- `g:` (`state: "waiting"`) : listée seulement si le hook vit et est bien un `hook.mjs` (vérifié par `ps`), si `ts + guard.waitMin` (réglage actuel) n'est pas passé, si aucune ligne suivante du même `pid` (ni ligne de fin de la même action) ne l'a close, et si la conversation est ouverte. Champs : `pendingId` (pid du hook), `expiresAt`, `rule`, `ruleId`, `command` (masquée : clés remplacées par `••••` ; 4000 caractères au plus), `byAgent` (? nom de l'agent), `cwd`, `needsPassword`. `detail` : « … · décide ici ou dans VS Code, sinon refusée dans N min. ».
- `b:` (`state: "blocked"`) : refus d'un garde-fou depuis `since` ; mêmes champs sans `pendingId` ni `expiresAt`, plus `reason` : `delai` | `jamais` | `sous-agent`. Un refus de l'utilisateur depuis l'app (`garde-fou-refuse-app`) n'est pas « à faire toi-même » et n'y figure pas. Pour « Voir » : `command` + `cwd` → `POST /open` (terminal), `conversationId` → `POST /open` (conversation).
- `l:` : une limite dont la remise à zéro est passée n'est plus listée ni comptée dans `needsYou`. L'heure est lue dans le texte de Claude Code (« resets 11:40pm », « resets Oct 26, 7pm », heure du Mac) ; sans heure lisible : 5 h pour une limite de session, 7 jours sinon. `sinceSummary.limits` compte toujours toutes les limites depuis `since`.
- Élément écarté (`POST /review/:id/dismiss`) : caché tant qu'il ne change pas (son `ts` n'est pas plus récent que la date de l'écart). Liste dans `data/ui.json` (`dismissed`, gardée 14 jours, 500 au plus). Écarter un `q:` le note aussi relu, comme « Ça me va ».

**Réponses des écritures du tour 2**
| Point d'entrée | Réponse | Erreurs |
|---|---|---|
| `POST /api/v2/pending/:pendingId` | `{ ok, pendingId, decision, message }` ; écrit `data/decisions.json` : `{ "<pendingId>": { "decision", "ts", "sessionId" } }` (la forme courte reste comprise par le hook) | 400 décision autre que `allow`/`deny` ; 404 attente finie (hook mort, délai passé, déjà répondue) ; 503 fichier verrouillé, réessayer |
| `POST /api/v2/review/:id/dismiss` | `{ ok, id }` | 404 identifiant illisible |
| `POST /api/v2/open` `{ kind: "conversation", id }` | `{ ok, opened, message, openUrl }` : `open -a "Visual Studio Code" <dossier de lancement>`, puis, quand la fenêtre de ce dossier est prête (même attente que le lancement d'un agent, `lib/opener.mjs` : jusqu'à ~27 s), le lien `vscode://anthropic.claude-code/open?session=<id>` (onglet de la conversation, rien n'est envoyé) : `opened: "full"`. Fenêtre pas prête à temps : le lien ne part pas (il ouvrirait la conversation dans la fenêtre d'un autre projet), `opened: "folder"`, `openUrl: null`, « VS Code est ouvert sur <dossier>, mais Claude Code n'a pas répondu à temps : ouvre la conversation depuis son panneau. » | 404 conversation inconnue ou dossier disparu ; 400 VS Code ne s'ouvre pas |
| `POST /api/v2/open` `{ kind: "terminal", command, cwd?, id?, pendingId? }` | `{ ok, mode, message }`. `mode: "typed"` : Terminal s'ouvre dans `cwd` avec la commande TAPÉE, pas lancée (zsh `print -rz` ; la commande passe par un fichier 0600 effacé aussitôt lu, jamais par le texte de la fenêtre). `mode: "clipboard"` (shell autre que zsh, ou macOS refuse à Vigie de piloter Terminal) : commande copiée, Terminal ouvert | 400 commande vide ou trop longue, texte masqué introuvable, commande contenant une clé alors qu'il faudrait la copier (jamais copiée) |
| `POST /api/v2/mcp/check` `{ accountId?, path? }` | `{ ok, startedAt, queued? }` (`queued` : un relevé tourne déjà, la demande part dans le suivant) | 400 compte inconnu, dossier invalide ou introuvable |
| `POST /api/v2/mcp/connect` `{ name, accountId?, path?, scope?, force? }` | `{ ok, message, mode }` : `browser` (connecteur claude.ai : le navigateur s'ouvre sur claude.ai ; relevé aussitôt puis 90 s plus tard ; MCP OAuth du Mac : `claude mcp login` sans fenêtre, et dès l'autorisation finie ce MCP est vérifié seul puis relevé) ou `terminal` (repli : Terminal s'ouvre sur `claude mcp login <nom>` dans le bon compte et le bon dossier ; relevé à la fin) | 400 nom invalide, compte inconnu, MCP stdio ou à clé dans sa configuration (« rien à autoriser »), MCP relevé `connected` sans `force: true` (« Déjà connecté » : `claude mcp login` effacerait ses jetons) |

`command` (terminal) peut être le texte masqué reçu dans `toReview` : le serveur retrouve la commande exacte dans le journal (ou par `id` d'un élément `g:`/`b:`, ou par `pendingId`). `name` (connect) d'un connecteur : son nom affiché (« Gmail ») suffit, le serveur le passe à la CLI sous la forme « claude.ai Gmail ». L'app ne propose « Connecter » que pour `needs-auth` ou `failed`.

**État réel des MCP**
- `claude mcp list` (aucune requête au modèle) : 20 s après le démarrage puis toutes les 10 min, un relevé à la fois, 2 CLI en parallèle au plus. Dossiers : le dossier personnel (MCP du Mac et connecteurs), puis les dossiers de LANCEMENT des conversations ouvertes et des fermées de moins de 48 h, plus récentes d'abord, seulement s'ils ont des MCP propres (`.mcp.json` ici ou au-dessus, MCP locaux ou coupés), 12 au plus.
- `GET /api/v2/mcp` : `healthCheck { running, startedAt?, checkedAt? }` au premier niveau ; `health[]` sur chaque serveur et connecteur (vide tant qu'aucun relevé ne le couvre) ; `user[].needsAuth` = compte principal seulement (état relevé s'il existe, sinon cache de Claude Code), `user[].needsAuthIn` = tous les comptes concernés ; `connectors[]` inclut les connecteurs vus au relevé jamais utilisés (`uses7d: 0`) ; `projects[].readOnly` (? phrase) : `.mcp.json` lié hors du projet, pas modifiable depuis l'app.
- `conversation.mcp[].status` : dernier état relevé pour le compte et le dossier de LANCEMENT de la conversation (registre de Claude Code, sinon dossier du transcript) ; `unknown` sans relevé ; `disabled` si coupé.
- `service` : `autre` (plus `other`) ; ids précis `google-drive`, `google-calendar`, `google-sheets`, `claude-docs`, `gmail` ; quelques ids hors de la liste (linear, postgres…) que l'app peut ignorer.

**Plan suivi (`now.plan`, `progress`)**
- Le plan est le dernier `.md` de plan lu, écrit ou cité par la conversation (outils de fichier, commandes, arguments de compétence) ou désigné par un registre `.superpowers/sdd`. Une commande qui cite plus de 3 plans (inventaire) est ignorée. `steps` : 400 au plus ; `current` = id de l'étape, sinon son texte.
- Étape finie : case cochée, marque du titre (« — FAIT le », ✅, « (terminée) »), ligne « Task X: complete » du registre, ou agents `faire:`/`refuter:<étape>` finis puis suivis d'une étape plus loin. Étape en cours : celle du dernier agent s'il est plus récent que le registre ; sinon la dernière citée dans le registre si elle n'est pas finie (ou la suivante non faite) ; sinon la première non faite.

**Journal du hook (`history.jsonl`)**
Chaque ligne porte `pid`. Les lignes de garde-fou portent `ruleId` ; `garde-fou-bloque` porte `raison` (`delai` | `jamais` | `sous-agent`). Nouveaux événements : `garde-fou-autorise-app` (décision `you`) et `garde-fou-refuse-app` (décision `denied`). Dès qu'un garde-fou est en jeu, l'action est notée jusqu'à 4000 caractères (600 sinon).

**Comptes**
`usage.source` : `session` | `ping` | null. `refresh` : au plus une fois par minute et par compte sur un clic ; le serveur relève aussi de lui-même, toutes les 60 s, les comptes dont le relevé a plus de 30 min (au plus toutes les 10 min par compte).

## Ajouts du tour 3 (2026-10-20) : consommation, alertes, garde-fous « seulement par Vigie »

### Consommation en direct (ConversationSummary)

```jsonc
"rate": {
  "weekPctPerHour": 1.2,        // ? % de la semaine du COMPTE consommé par heure, sur les 10 dernières minutes (agents compris)
  "tokensPerMin": 48000,        // tokens bruts par minute (entrée + sortie + cache), agents compris — affiché au survol
  "spark": [0, 0.4, 1.1, …],    // 30 valeurs, une par minute (poids d'usage), pour une mini-courbe
  "trend": "up"                 // up | flat | down
},
"alert": { "kind": "emballe", "since": "…", "reason": "Les mêmes tests échouent en boucle depuis 20 min (14 lancements)." }  // ? null si rien
```
« S'emballe » = consommation anormale : débit > 3 × sa médiane des 2 dernières heures ET > 0,5 %/h, ou la même commande de test qui échoue ≥ 6 fois en 20 min, ou un agent qui répète la même action ≥ 8 fois.

### Graphique : `GET /api/v2/usage/series?window=60|600|1200` (minutes)

```jsonc
{
  "from": "…", "to": "…", "stepMin": 1,          // 1 min pour 1 h, 10 min pour 10 h, 20 min pour 20 h
  "unit": "weekPct",                             // les valeurs sont en % de la semaine du compte de la conversation ; tokens bruts en plus
  "conversations": [
    { "id": "…", "title": "Atelier", "project": "atelier", "accountId": "travail1", "running": true,
      "points": [ { "t": "…", "weekPct": 0.03, "tokens": 512000 } ] }
  ],
  "accounts": [ { "id": "travail1", "label": "Perso", "points": [ { "t": "…", "weekPct": 0.05 } ] } ]
}
```
Toutes les conversations des 20 dernières heures (ouvertes et fermées), agents et workflows compris (leur usage compte pour leur conversation).

### Garde-fous « seulement par Vigie » (choix de l'utilisateur)

Réglage `guard.mode` : `"vigie"` (par défaut désormais) ou `"vscode"` (ancien comportement : fenêtre VS Code proposée N min).
En mode `vigie`, une action sensible est **refusée sur le moment** (message à Claude : elle attend l'accord de l'utilisateur dans Vigie, continuer le reste, ne la relancer à l'identique qu'après l'avoir reçu) et apparaît dans `toReview` avec `state: "awaiting"`, `approvalId`, `command`, `rule`, `conversationId`.
L'utilisateur l'autorise : `POST /api/v2/approvals` `{ approvalId }` → autorisation **à usage unique**, pour la **commande exacte** (même outil, mêmes paramètres, même conversation), valable 2 h ; le hook la consomme à la relance et journalise `garde-fou-autorise-vigie`. Réponse `{ ok, message, delivered, openUrl? }` : la conversation est prévenue (« L'utilisateur a autorisé : … Relance-la à l'identique. ») par la voie la plus sûre disponible ; sinon le message est renvoyé pour que l'app le copie et ouvre la conversation.
L'utilisateur refuse : `POST /api/v2/approvals` `{ approvalId, decision: "deny" }` → l'élément sort de la liste, rien n'est envoyé.

### Précisions du serveur (tour 3)

**`rate` et `alert` (ConversationSummary, toujours présents ; `alert` vaut `null` si rien)**
- Usage minute par minute gardé 24 h par conversation (agents et workflows compris : leurs transcripts comptent pour leur conversation), en poids d'usage (même formule que `weekPct`) et en tokens bruts (entrée + sortie + cache lu + cache écrit).
- `weekPctPerHour` = poids des 10 dernières minutes (minute en cours comprise) de l'organisation du compte de la conversation ÷ poids de ce compte sur sa fenêtre hebdo × `week.pct` × 6. `null` dans les mêmes cas que `weekPct`. Arrondi au centième.
- `tokensPerMin` : moyenne des 10 dernières minutes (entier). `spark` : 30 entiers, poids d'usage brut par minute (plus ancien d'abord, la dernière valeur est la minute en cours) ; l'app les normalise. `trend` : 10 dernières minutes comparées aux 10 d'avant (`up` > +25 %, `down` < −25 %, sinon `flat`).
- `alert` (conversations ouvertes seulement), première règle qui s'applique : (1) même commande de test en échec ≥ 6 fois en 20 min (étape rouge voulue et tests pas finis exclus) ; (2) un agent qui répète la même action (même outil, mêmes paramètres affichés) ≥ 8 fois en 20 min ; (3) débit des 10 dernières minutes > 3 × la médiane des tranches de 10 min ACTIVES des 2 h précédentes (au moins 3 tranches actives : une conversation qui démarre n'a pas de référence) et > 0,5 %/h. `since` : premier échec / première répétition / début de la fenêtre de 10 min. `reason` : une phrase en français.

**`GET /api/v2/usage/series?window=60|600|1200`**
- 60 points par série, seaux alignés sur le pas (1, 10 ou 20 min), le dernier contient la minute en cours ; `from` = début du premier seau, `to` = maintenant ; `t` = début du seau. Autre `window` : 400.
- `conversations` : ouvertes, et fermées dont la dernière activité date de moins de 20 h (les jetables fermées exclues), ouvertes d'abord puis plus récentes ; champs en plus : `lastActivity`. `weekPct` du point : conversion du compte de la conversation (`null` sans relevé hebdo ou sans organisation) ; `tokens` : tokens bruts toutes organisations.
- `accounts` : comptes dont l'organisation est connue, usage de toutes les conversations de cette organisation (jetables comprises) ; points `{ t, weekPct, tokens }`.

**Garde-fous `guard.mode`**
- `overview.settings.guard.mode` : `vigie` | `vscode`. `POST /api/v2/settings { guard: { mode } }` (autre valeur : 400). Un `state.json` sans `mode` vaut `vigie`.
- Mode `vigie` : le hook refuse aussitôt (conversation VS Code, terminal ou agent de fond), journalise `garde-fou-en-attente-vigie` (`approvalId` 16 hex, `hash` = empreinte SHA-256 de conversation + outil + paramètres exacts, `action` = commande complète, 4000 caractères au plus, `rule`, `ruleId`). Le délai `guard.waitMin` ne sert qu'au mode `vscode`. L'auto-accept coupé passe avant tout : fenêtre normale.
- Élément `toReview` : `id` = `v:<approvalId>`, `kind: "blocked"`, `state: "awaiting"`, `approvalId`, `command` (masquée), `rule`, `ruleId`, `conversationId`, `cwd`, `byAgent`, `needsPassword`, `approved` (autorisée, relance pas encore faite), `approvedUntil`. Un seul élément par appel identique (le dernier refus), listé 24 h, rangé avec ce qui attend l'utilisateur maintenant. Retiré une fois l'appel relancé avec l'autorisation (`garde-fou-autorise-vigie`), refusé par l'utilisateur, ou écarté (`POST /review/v:<id>/dismiss`). Une autorisation expirée sans relance : l'élément redevient simplement à autoriser. `needsYou` le compte ; `status` de la conversation n'est pas changé (elle continue).
- `POST /api/v2/approvals` : `{ ok, approvalId, decision: "allow", expiresAt, message, delivered: false, openUrl, needsPassword }` ; `openUrl` = `vscode://anthropic.claude-code/open?session=<uuid>&prompt=<message>` (encodé pour survivre aux deux décodages, comme `questions/:id/review`), `null` si l'identifiant de conversation n'est pas un UUID. Refus : `{ ok, approvalId, decision: "deny", message }` (une autorisation pas encore utilisée pour le même appel est retirée). Erreurs : 400 décision autre que `allow`/`deny` ou `approvalId` illisible ; 404 élément introuvable, déjà relancé, refusé ou de plus de 24 h ; 503 fichier verrouillé.
- `data/approvals.json` : `{ "<approvalId>": { decision, sessionId, tool, hash, ts, expiresAt? } }`, écrit sous verrou ; le hook retire l'autorisation qu'il consomme (usage unique). Comme `decisions.json`, les garde-fous `config-claude`, `config-claude-shell`, `api-vigie` et `jeton-vigie` retiennent une conversation qui l'écrirait ou lirait le jeton. Limite : une conversation dont les commandes sont acceptées d'office a les droits de l'utilisateur ; un agent décidé à contourner Vigie (un script écrit puis lancé) le peut. Les garde-fous protègent des erreurs et des consignes piégées ordinaires, pas d'un programme hostile.
- Journal : `garde-fou-en-attente-vigie` → `accepted[].decision = "blocked"` et compté dans `sinceSummary.blocked` ; `garde-fou-autorise-vigie` → `you`.

## Ajouts du 2026-10-20 (bascule de compte)

- `ConversationSummary.account` (conversations qui tournent, sinon `null`) : `{ chosen, running, pending: { to, since } | null, history: [{ ts, accountId, reason }] }`. `running` = compte du processus réellement lancé (fichier du lanceur), `history` = 10 derniers lancements lus dans `data/launches.log`.
- `POST /api/v2/conversation/:id/settings` accepte `now: true` avec `accountId` : la conversation est arrêtée même en plein travail (message « Interrompue : écris « continue »… »). Sans `now`, la bascule attend la fin du tour et des commandes de fond (vrais enfants shell du processus, plus le transcript).
- Alerte « s'emballe » : une boucle = même outil avec exactement les mêmes paramètres (`sig`, empreinte de l'entrée) ; l'app notifie au plus une fois par conversation et par tranche de 3 h.

## Agents (2026-10-26, `lib/agents.mjs`, `lib/opener.mjs`)

Un agent est une recette livrée avec Vigie, `<dossier du moteur>/agents/<id>/AGENT.md` (`~/.vigie/agents`, remplacé
à chaque mise à jour), format décrit dans [agents.md](agents.md). Le moteur relit ce dossier à chaque appel (rien en
cache) et ne le crée jamais : absent, la liste est vide.

### GET /api/v2/agents

```jsonc
{
  "account": { "id": "travail1", "label": "Perso" }, // ? compte des nouvelles conversations : celui sur lequel partira la conversation
  "surfaces": { "available": ["vscode", "claude-app"], "chosen": "vscode" },  // où un agent peut s'ouvrir
  "agents": [                                         // triés par nom (sans tenir compte des accents ni des majuscules)
    {
      "id": "demarrer-projet",                        // nom du dossier : /^[a-z0-9][a-z0-9-]{0,63}$/
      "name": "Démarrer un projet client",
      "description": "Brief, références et préparation du premier rendez-vous",  // ? null
      "icon": "wand.and.stars",                       // ? nom de symbole SF, null
      "folder": "/Users/alex/Code",                   // dossier PARENT proposé pour le projet (« ~ » développé ; ~/Code par défaut)
      "fields": [
        { "id": "brief", "label": "Ce que tu as", "type": "longtext",  // text | longtext | url | urls (une adresse par ligne) | choices
          "required": true, "help": "Colle le questionnaire, l'e-mail du client…", "placeholder": null },  // help, placeholder : ? null
        { "id": "controles", "label": "Ce qu'il faut contrôler", "type": "choices", "required": true, "help": null, "placeholder": null,
          "options": ["Tout le site", "SEO"], "icons": ["checkmark.seal", "magnifyingglass"], "defaults": ["Tout le site"] }  // icons : ? null
      ],
      "mcp": [ { "name": "figma", "service": "figma", "status": "connected", "chosen": "figma-pro", "connect": "figma-pro",
                 "servers": [ { "name": "figma-pro", "status": "connected", "connect": true },
                              { "name": "figma-perso", "status": "needs-auth", "connect": true } ] } ],  // MCP nécessaires, pour ce compte
      // un MCP de la passerelle porte aussi ses espaces et l'actif : "spaces": [{ "id", "label" }], "space": "<id>" 
      "creates": ["Le dossier du projet et sa documentation", "Le fichier Figma du projet"],  // ce que l'agent crée ([] si absent)
      "error": null                                   // ? phrase si AGENT.md est illisible : agent listé mais pas lançable
    }
  ]
}
```
- `surfaces.available` : dans cet ordre, `vscode` si VS Code est installé (`/Applications` ou `~/Applications`,
  « Visual Studio Code.app ») avec l'extension Claude Code (`~/.vscode/extensions/anthropic.claude-code-…`, ou celles
  de VS Code Insiders, Cursor, Windsurf), et `claude-app` si l'app Claude est installée. `chosen` : la dernière surface
  d'un lancement réussi (`agentsSurface` dans `state.json`) si elle est encore disponible, sinon la première
  disponible, sinon `null`.
- `creates` : les phrases de la clé `creates` d'`AGENT.md` (12 au plus, 200 caractères chacune), `[]` si elle manque
  ou si l'agent est illisible.
- `mcp[]` : un MCP demandé par l'agent (`name`, tel qu'écrit dans `AGENT.md`). `service` : son service (`figma` pour `figma` comme pour `figma-pro`), `null` pour un nom sans service connu. Avec un service, n'importe quel MCP de ce service compte, quel que soit son nom : ceux du Mac (dossier perso), de la passerelle et les connecteurs claude.ai (sous leur nom court, `Figma`) ; `servers` les liste avec leur état, le mieux connecté d'abord (`connect` : se connecte par `POST /api/v2/mcp/connect`, pas par la passerelle). `chosen` : celui que l'agent utilisera, le dernier choisi au lancement s'il est encore là (`data/state.json`, `agentsMcp`), sinon le premier ; `status` est le sien (`missing` : aucun) et `connect` son nom s'il se connecte d'ici. Sans service : ce MCP-là. Un MCP de la passerelle (Webflow) porte `spaces` (ses espaces autorisés) et `space` (l'actif, le seul qu'il voit) : l'app le change par `POST /api/v2/gateway { action: "activate" }`, et le brief nomme l'espace actif au lancement.
- `mcp[].status` : `connected` | `needs-auth` | `failed` | `pending-approval` | `disabled` | `unknown` | `missing`. MCP de la passerelle : `connected` s'il est autorisé, sinon `needs-auth`. Les autres : dernier relevé de `claude mcp list` pour ce compte, et à défaut celui du connecteur claude.ai de ce nom (`Gmail` comme `claude.ai Gmail`) ; `unknown` sans relevé.
- Agent illisible (`error` non nul) : `name` est celui de l'en-tête s'il se lit, sinon `id` ; `fields`, `mcp` et `creates` sont vides ; `folder` vaut ~/Code. Le `folder` de l'en-tête (un dossier parent) passe par la règle du lancement (voir `folder` plus bas), sauf qu'il peut être le dossier perso lui-même (`~`) : hors du dossier perso ou dans un dossier réservé, il donne `error`, la raison seule puis où la corriger (`« folder » : <raison> Change-le dans AGENT.md.`, par exemple « « folder » : ~/.ssh est réservé (tes clés). Change-le dans AGENT.md. » ou « « folder » : il doit être dans ton dossier perso. Change-le dans AGENT.md. »), et l'agent ne se lance pas (`Cet agent ne peut pas être lancé : « folder » : …`). Un sous-dossier au nom invalide, sans `AGENT.md`, ou un fichier à la place d'un dossier n'est pas listé. `AGENT.md` de plus de 256 Ko : listé avec une erreur. 200 agents au plus.

### GET /api/v2/agents/folder?path=<chemin absolu ou ~/…>

Ce que le formulaire montre pour le dossier choisi (l'app le demande à chaque changement, après 400 ms de calme).

```jsonc
{
  "path": "/Users/alex/Code/cabinet-martin",          // chemin normalisé (« ~ » développé) ; refusé : le texte reçu
  "exists": true,                                     // le dossier existe déjà (sinon le lancement le crée)
  "error": null,                                      // ? la raison du refus du dossier : le reste est alors vide
  "conversations": [                                  // la plus récente d'abord, 5 au plus
    { "id": "<uuid>", "title": "Charte du cabinet", "lastActivity": "2026-10-26T21:09:00.000Z", "running": true, "surface": "vscode" }
  ],
  "sources": ["charte.pdf", "plaquette.pdf"]          // noms dans <path>/sources/
}
```
- `error` : la phrase du lancement pour ce dossier (règle de `folder`, plus bas : `Dossier refusé : …`), ou
  `Dossier refusé : <path> est un fichier. Choisis un autre dossier.`, ou `Dossier refusé : <path>/.vigie n'est pas un
  dossier. Renomme-le, ou choisis un autre dossier.` ; `null` si le dossier est accepté.
- `conversations` : conversations Claude Code (pas Codex) connues de Vigie (lues en entier : 48 h, ou pour l'usage
  seulement : 7 jours) dont le dossier de lancement est exactement ce dossier (chemin réel : liens résolus, casse
  pliée comme pour les refus ; un sous-dossier n'en est pas un). `title` : titre de l'app Claude s'il existe, sinon le
  titre connu (titre de la conversation, nom du registre), sinon `null`. `running` : ouverte en ce moment. `surface`
  (`vscode`, `claude-app`, `terminal`) : d'où elle vient (même règle que `ConversationSummary.surface` ; une
  conversation lue pour l'usage seulement est `claude-app` si l'app Claude la connaît, sinon `vscode`).
- `sources` : noms rangés dans `<path>/sources/` (fichiers et dossiers, sans les fichiers cachés), triés, 50 au plus ;
  `[]` si `sources/` n'existe pas ou n'est pas un dossier ordinaire (un lien n'est pas lu).
- 400 `Indique un dossier.` si `path` manque ou est vide.

### Rapports d'agents

Chaque lancement est noté (`data/agent-runs.json`) et son rapport part « en cours » : `<dossier>/.vigie/rapport-<id>.json`.
Le brief dit à l'agent de le tenir à jour (section « Le rapport pour Vigie ») : `status` (`running`, `done`,
`blocked`), `title`, `verdict`, `level` (`ok`, `warn`, `block`), `counts` (`ok`, `warn`, `block`), `report` (chemin
du rapport détaillé, dans le dossier), `links` (`https` seulement), `done` (ce que l'agent a fait), `todo` (ce qui reste
à l'utilisateur : `{ text, where, severity: block | warn | info, done }`). Le moteur le relit à chaque appel, vérifié
et borné (un fichier, pas un lien, 256 Ko au plus ; textes sur une ligne ; 100 actions, 50 lignes « fait », 10 liens) :
chaque action porte son `index` dans le fichier. Il surveille les dossiers `.vigie` des lancements montrés : un rapport
réécrit réveille `GET /api/v2/changes`.

### POST /api/v2/agents/launch

Corps : `{ "id": "demarrer-projet", "values": { "brief": "…" }, "folder": "/Users/alex/Code/cabinet-martin",
"files": ["/Volumes/Clé/charte.pdf"], "surface": "vscode", "session": null, "mcp": { "figma": "figma-pro" } }`
(`files`, `surface`, `session`, `mcp` facultatifs). `mcp` : le MCP choisi par service (clé : `service`, ou `name`
sans service), parmi les `servers` de `GET /api/v2/agents` (sinon 400, rien n'est créé) ; il est retenu pour la fois
suivante. Le brief nomme, sous « MCP à utiliser », le MCP retenu pour chaque besoin et le début du nom de ses outils
(`mcp__figma-pro__`, `mcp__claude_ai_Figma__` pour un connecteur).

```jsonc
{
  "ok": true,
  "folder": "/Users/alex/Code/cabinet-martin",                        // chemin absolu normalisé, créé ou déjà là
  "briefFile": "/Users/alex/Code/cabinet-martin/.vigie/agent-demarrer-projet.md",
  "prompt": "Lance l'agent « Démarrer un projet client » : lis le fichier …/agent-demarrer-projet.md et suis ses consignes, dans le dossier ….",
  "surface": "vscode",                                                // vscode | claude-app : où il s'est ouvert
  "opened": "full",                                                   // full | folder | no-prompt | none
  "copied": ["sources/charte.pdf", "sources/brandbook/"],             // fichiers joints copiés (un dossier finit par /)
  "message": "VS Code s'ouvre sur le projet, avec le message prêt dans Claude Code : envoie-le."
}
```
- **Tout est vérifié avant de rien créer** (formulaire, dossier, fichiers joints, surface, conversation à reprendre) ;
  un refus ne crée rien et n'ouvre rien. Puis le dossier est préparé (dossier, `.vigie`, copies dans `sources/`,
  brief) et **le moteur ouvre** VS Code ou l'app Claude (`lib/opener.mjs` ; seul `/usr/bin/open` est lancé, avec des
  arguments, jamais par un shell). La réponse peut prendre ~30 s (attente de la fenêtre de VS Code, par des
  minuteries : le moteur répond aux autres requêtes pendant ce temps). `openUrl` n'existe plus.
- `opened` et `message` :

  | `opened` | Quand | `message` |
  |---|---|---|
  | `full` | VS Code : la fenêtre du projet était prête, le lien est parti | VS Code s'ouvre sur le projet, avec le message prêt dans Claude Code : envoie-le. |
  | `full` | App Claude, nouvelle conversation : message prérempli | L'app Claude s'ouvre sur le projet, avec le message prêt : envoie-le. |
  | `folder` | VS Code ouvert sur le projet, mais sa fenêtre n'a pas répondu à temps (ou le lien a échoué) : lien pas envoyé | VS Code est ouvert sur le projet, mais le message n'a pas pu partir dans Claude Code (si VS Code demande de faire confiance au dossier, accepte) : il est copié, colle-le dans Claude Code et envoie-le. |
  | `no-prompt` | App Claude : reprise, ou message trop long pour être prérempli | La conversation s'ouvre dans l'app Claude : le message est copié, colle-le (⌘V) et envoie-le. |
  | `none` | `open` en échec | VS Code : Le dossier est prêt, mais VS Code ne s'est pas ouvert : le message est copié, ouvre le dossier dans VS Code, et colle-le dans Claude Code. App Claude : Le dossier est prêt, mais l'app Claude ne s'est pas ouverte : le message est copié, ouvre l'app Claude, puis une conversation Claude Code sur ce dossier, et colle-le. |

  En reprise (`session`), les phrases nomment la conversation à ouvrir avant de coller (« la conversation « titre » »).

  « copié » : c'est l'app qui copie `prompt` dans le presse-papiers, dès que `opened` n'est pas `full`.
- **VS Code** : `open -a "Visual Studio Code" <folder>`, puis attente de la fenêtre du projet : un
  `~/.claude/ide/<port>.lock` (le dossier `ide` sous `<dossier perso>/.claude`, fichier ordinaire de 64 Ko au plus, lu
  sans suivre de lien ; 200 au plus) dont `ideName` vaut « Visual Studio Code » (pas Cursor ni Windsurf), dont
  `workspaceFolders` est ce seul `folder` (chemin réel, casse pliée), dont le `pid` (entier > 1) est vivant
  (`process.kill(pid, 0)`) et dont le port répond sur 127.0.0.1 (le fichier d'une fenêtre fermée reste, son port non ;
  le pid, celui de VS Code, peut avoir été repris). Déjà là avant l'ouverture : 800 ms, puis le lien. Sinon : sondage
  toutes les 300 ms, 25 s au plus (`VIGIE_IDE_WAIT_MS` dans les essais), puis 1,5 s, puis le lien. Lien :
  `vscode://anthropic.claude-code/open?prompt=<prompt>` (encodé pour survivre à deux décodages : VS Code, puis
  l'extension) suivi de `&session=<uuid>` pour une reprise. Pas prête à temps : le lien n'est pas envoyé (VS Code
  l'enverrait à sa dernière fenêtre active, celle d'un autre projet).
- **App Claude** : nouvelle conversation, `claude://code/new?folder=<folder>&q=<prompt>&source=vigie` (chaque valeur
  passée par `encodeURIComponent` ; `prompt` de plus de 2 592 caractères : sans `q`, `opened: "no-prompt"`). Reprise :
  `claude://code/continue?session=local_<id>` si la conversation est née dans l'app (son fichier
  `claude-code-sessions/…/local_<id>.json` porte `cliSessionId`), sinon `claude://resume?session=<uuid>` ; aucun des
  deux ne prend de message (`opened: "no-prompt"`).
- `surface` : `vscode` ou `claude-app` ; par défaut `surfaces.chosen`. Retenue dans `state.json` (`agentsSurface`)
  après un lancement réussi. Valeur inconnue : `Où ouvrir l'agent ? « vscode » ou « claude-app ».` Pas installée (400,
  rien de créé) : `VS Code et son extension Claude Code ne sont pas sur ton Mac : choisis l'app Claude, ou
  installe-les.` / `L'app Claude n'est pas sur ton Mac : choisis VS Code, ou installe-la.` ; aucune des deux : `Ni VS
  Code (avec son extension Claude Code) ni l'app Claude ne sont sur ton Mac : installe l'un des deux, puis relance
  l'agent.`
- `session` : uuid d'une conversation à reprendre ; elle doit être une conversation de ce dossier (celles de `GET
  /api/v2/agents/folder`, sans la limite de 5), sinon 400 `Cette conversation n'est plus dans ce dossier : relance en
  nouvelle conversation.` (aussi pour un `session` qui n'est pas un uuid). Message de reprise : `Lance l'agent
  « <name> » dans cette conversation : lis le fichier <briefFile> et suis ses consignes. Tiens compte de ce qu'on a
  déjà fait ici.` ; sinon `Lance l'agent « <name> » : lis le fichier <briefFile> et suis ses consignes, dans le
  dossier <folder>.`
- `files` : chemins absolus (50 au plus) de fichiers ou de dossiers à joindre, copiés dans `<folder>/sources/` (créé
  en `0755` ; fichiers `0644`, date d'origine gardée) : même nom, ou « nom (2).ext », « nom (3).ext »… s'il est pris
  (jamais d'écrasement : création exclusive) ; un dossier joint est recopié avec ses sous-dossiers, ses liens
  symboliques et fichiers spéciaux laissés de côté ; un fichier déjà dans `<folder>/sources/` n'est pas recopié (il
  est cité dans le brief) ; un même fichier joint deux fois compte une fois. 1 Go et 5 000 fichiers au plus en tout
  (sous-dossiers compris). Hors du dossier perso : permis (clé USB, `/Volumes/…`). Dossiers temporaires du système
  (`os.tmpdir()`, `/tmp`, `/private/var/folders/…`) : permis, même rangés sous un dossier réservé (un dossier
  temporaire qui contient le dossier perso ne compte pas). Chaque fichier est rouvert sans suivre de lien au moment de
  la copie et doit être celui qui a été vérifié (même appareil, même numéro) ; si une copie échoue, les copies de ce
  lancement sont retirées. Refus (400, rien de copié, rien de créé) :

  | Cas | Phrase |
  |---|---|
  | pas une liste de chaînes | `Fichiers joints illisibles : ajoute-les de nouveau.` |
  | plus de 50 | `Trop de fichiers joints : 50 au plus. Range-les dans un dossier, et joins le dossier.` |
  | chemin relatif, `~`, plus de 1 024 caractères | `Fichier joint illisible : <nom>. Ajoute-le de nouveau.` |
  | introuvable | `Fichier joint introuvable : <nom>. Retire-le de la liste, puis ajoute-le de nouveau.` |
  | lien symbolique en tête | `Fichier joint refusé : <nom> est un lien. Joins le fichier lui-même.` |
  | dans un dossier réservé du dossier perso (même règle que `folder` : chemin écrit, chemin réel, identité sur le disque, casse pliée), ou un dossier joint qui en contient un | `Fichier joint refusé : ~/<dossier> est réservé (<raison>). Retire-le de la liste.` |
  | un dossier qui est, ou contient, le dossier perso | `Fichier joint refusé : <nom> est ton dossier perso. Joins des fichiers ou un dossier précis.` / `… contient ton dossier perso. …` |
  | un dossier qui contient le dossier du projet | `Fichier joint refusé : <nom> contient le dossier du projet. Joins les fichiers un par un.` |
  | un fichier qui a un autre nom sur le disque (lien physique) | `Fichier joint refusé : <nom> a un autre nom sur le disque (lien physique). Joins-en une copie.` |
  | ni fichier ni dossier (tube, prise) | `Fichier joint refusé : <nom> n'est ni un fichier ni un dossier. Retire-le de la liste.` |
  | illisible (droits) | `Fichier joint illisible : <nom>. Vérifie ses droits, ou joins-en une copie.` |
  | illisible (macOS refuse au moteur le Bureau, les Documents, les Téléchargements) | `Fichier joint illisible : <nom>. macOS ne laisse pas Vigie le lire : copie-le ailleurs (dans ~/Code, par exemple), puis joins la copie.` |
  | plus d'1 Go / de 5 000 fichiers | `Fichiers joints trop gros : 1 Go au plus. Retire les plus gros de la liste, ou joins un dossier plus petit.` / `Fichiers joints trop nombreux : 5 000 fichiers au plus. Joins un dossier plus petit, ou seulement les fichiers utiles.` |
  | `<folder>/sources` n'est pas un dossier ordinaire (un lien, un fichier) | `Dossier refusé : <folder>/sources n'est pas un dossier. Renomme-le, ou choisis un autre dossier.` |
  | remplacé entre la vérification et la copie | `Fichier joint modifié pendant la copie : <nom>. Relance l'agent.` |

  `<nom>` : le nom du fichier, sur une ligne, 120 caractères au plus.
- `values` : un objet ; chaque valeur une chaîne (ou absente, ou `null` = vide). `text` et `url` : 2 000 caractères au plus ; `longtext` et `urls` : 200 000. Les clés inconnues sont ignorées. Le corps entier reste sous 1 Mo (sinon 413).
- `folder` : chemin absolu ou commençant par `~`. Il doit être DANS le dossier perso, pas le dossier perso lui-même (`Dossier refusé : choisis un dossier dans ton dossier perso, pas le dossier perso lui-même.`), ni sous un dossier réservé : `~/.vigie` (dossier de Vigie), `~/Library` (réglages du Mac et des apps, iCloud Drive et Dropbox compris : `~/Library` l'est en entier, `Mobile Documents` et `CloudStorage` aussi), `~/.claude` (réglages de Claude Code), `~/.claude-comptes` (comptes Claude Code de Vigie), `~/.ssh` (tes clés), `~/.codex` (réglages de Codex). Refus : `Dossier refusé : ~/<dossier> est réservé (<raison>). Choisis un dossier ailleurs, dans ~/Code par exemple.` Le chemin réel (liens résolus, casse du disque) et l'identité sur le disque (appareil et numéro du dossier : un autre chemin du même dossier, comme `/System/Volumes/Data/Users/…`) sont vérifiés aussi : un lien vers un dossier réservé, vers un dossier qu'il contient (`~/Dropbox` qui mène à `~/Library/CloudStorage/Dropbox`) ou vers le dossier perso est refusé, un `~/Code` relié à un disque externe est accepté. Les refus ne tiennent compte ni des majuscules, ni des formes Unicode, ni des variantes d'une lettre (`ß`, `ẞ`, `ſ`), comme le disque du Mac : `~/.SSH`, `~/.ẞh`, ou `~/.CODEX` qui n'existe pas encore, sont refusés comme `~/.ssh` et `~/.codex`. Plus de 1 024 caractères ou un caractère de contrôle : `Dossier refusé : chemin trop long ou illisible. Choisis un autre dossier.` S'il existe, ce doit être un dossier (ses droits ne changent pas ; sinon `Dossier refusé : <folder> est un fichier. Choisis un autre dossier.`) ; sinon il est créé avec ses parents manquants, en `0755`. Seuls `<folder>`, `<folder>/sources` et `<folder>/.vigie` sont écrits.
- Écrit `<folder>/.vigie/agent-<id>.md` (fichier `0600`, remplacé à chaque lancement ; `.vigie` créé en `0755`). `.vigie/.gitignore` « * » est écrit s'il manque, même quand `.vigie` existait déjà, pour que le brief ne parte jamais dans git ; un `.gitignore` déjà là est gardé s'il protège le brief : un fichier ordinaire (git ne suit pas un lien), avec une ligne `*`, `/*`, `**`, `*.md`, `agent-*.md` ou `agent-<id>.md`, sans ligne `!…` après elle qui puisse le réintégrer. Sinon, 400 sans brief ni copie, et une phrase selon le cas (`<fichier>` = `<folder>/.vigie/.gitignore`) : contenu qui ne protège pas, `Dossier refusé : <fichier> laisserait la consigne de l'agent partir dans git. Ajoute à la fin la ligne « * », ou choisis un autre dossier.` ; plus de 64 Ko (non lu), `Dossier refusé : <fichier> est trop gros pour être vérifié (64 Ko au plus). Remplace-le par un fichier avec la ligne « * », ou choisis un autre dossier.` ; lien, dossier ou tube, `Dossier refusé : <fichier> n'est pas un fichier, git ne le lit pas. Remplace-le par un fichier avec la ligne « * », ou choisis un autre dossier.` ; fermé (`EACCES`, `EPERM`), `Dossier refusé : <fichier> est illisible. Rends-le lisible, ou remplace-le par un fichier avec la ligne « * ».` S'il ne peut pas être écrit, le brief ne l'est pas (`Dossier impossible à préparer : …`). Contenu : `# Agent : <name>`, la date, le dossier du projet, la ligne `Conversation : nouvelle` ou `Conversation : reprise (tu continues une conversation existante : tiens compte de ce qui a déjà été fait, ne refais pas ce qui existe).`, `## Ce que tu m'as donné` (un `### <label>` par champ, sa valeur ou « (non fourni) » ; long texte dans un bloc de code, adresses en liste, valeur d'une ligne dont le début qui ouvrirait un titre ou un bloc Markdown est neutralisé par `\` ; puis `### Fichiers joints` : un chemin `sources/…` par ligne, copié ou déjà là, ou « Aucun »), puis `## Consignes`, toujours la dernière section : la consigne de l'agent, `{{id}}` remplacé par la valeur saisie pour `text` et `url` (telle quelle ; début neutralisé en début de ligne, même derrière `- `, `1. ` ou `> `), par un renvoi pour `longtext` et `urls` (« <label> » (plus haut, dans « Ce que tu m'as donné »)), ou par « (non fourni) ».

| Statut | Cas (`{ "ok": false, "error": "…" }`) |
|---|---|
| 400 | `Champ manquant : <label>` (obligatoire vide ou fait d'espaces) ; `<label> : texte attendu.` ; `<label> : trop long (2 000 caractères au plus).` ; `Valeurs du formulaire illisibles.` ; dossier refusé (`Choisis le dossier du projet.`, `Dossier refusé : …`, `Dossier impossible à préparer : …`) ; fichier joint refusé (tableau plus haut) ; surface absente ou inconnue ; conversation à reprendre qui n'est plus dans ce dossier ; `Cet agent ne peut pas être lancé : <erreur de son AGENT.md>` |
| 404 | `Agent introuvable.` (id invalide, dossier ou `AGENT.md` absent) |
Comme toute écriture : `X-Vigie-Token` (401) et `X-Vigie: 1` (403) obligatoires.
