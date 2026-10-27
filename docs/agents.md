# Agents

État (2026-10-26) : deuxième version du moteur. Format `AGENT.md` (avec `creates`), formulaire à un seul champ où
l'on colle ce qu'on a et où l'on glisse des fichiers (copiés dans `sources/`), reprise d'une conversation déjà ouverte
dans le dossier, ouverture dans VS Code ou dans l'app Claude par le moteur de Vigie, qui attend la fenêtre du projet
(`lib/agents.mjs`, `lib/opener.mjs`, `GET /api/v2/agents`, `GET /api/v2/agents/folder`, `POST /api/v2/agents/launch`,
voir [api-v2.md](api-v2.md)). La réflexion du départ et les décisions à prendre restent plus bas.

## L'idée

Un **agent** est une recette préparée à l'avance : « Démarrer un projet client », « Créer une page », « Relier le CMS »…
On la lance depuis Vigie en remplissant un petit formulaire ; elle enchaîne des actions sur des MCP (Figma, Webflow,
GitHub…) et dans le dossier de code. Ça marche comme une compétence (skill) de Claude Code, mais avec ce que Vigie sait
déjà faire autour : les bons MCP connectés une fois pour tous les comptes, le bon compte, le bon dossier, les actions
sensibles retenues, et un suivi comme pour n'importe quelle conversation.

Pour une agence, ça veut dire : chaque collègue lance la même recette et obtient le même point de départ, sans
connaître les outils par cœur.

## Exemple : démarrer un projet client

**Entrées (formulaire)** : le dossier de code (`~/Code/<client>`), et un seul champ où coller ce qu'on a :
questionnaire client déjà rempli, e-mail du client, site actuel (à refaire), sites de référence, notes ; ses fichiers
y sont glissés (brandbook, PDF, images) et copiés dans `sources/`. Le modèle Figma et l'espace Webflow de l'agence
sont connus de l'agent.

**Étapes** :
1. **Figma** : un fichier neuf, bien nommé, rangé dans le dossier projet de l'équipe, monté à partir du modèle.
2. **Références** : capture de chaque site de référence, avec une courte analyse (structure, ton, couleurs, ce qu'on
   garde), posées sur une page « Références » du fichier Figma et dans la documentation du projet.
3. **Webflow** : le site du client prêt à remplir (pages et CMS de base, styles de l'agence).
4. **Dépôt de code** : `~/Code/<client>` avec sa documentation (brief, questionnaire, références, décisions), son
   `CLAUDE.md`, git initialisé, et le dépôt GitHub privé s'il le faut.
5. **Compte rendu** : les liens (Figma, Webflow, dépôt) et ce qui reste à faire à la main.

## Ce que les MCP permettent aujourd'hui (vérifié le 2026-10-26)

| Besoin | Possible ? | Conséquence |
|---|---|---|
| Fichier Figma neuf dans un dossier projet | Oui (`create_new_file` avec `projectId`) | |
| Dupliquer un fichier Figma modèle | **Non** : ni le MCP ni l'API de Figma ne copient un fichier | L'agent **reconstruit le modèle** dans le fichier neuf avec ses propres scripts (`use_figma`), rangés à côté d'`AGENT.md` ; ou bien le modèle devient une bibliothèque d'équipe publiée ; ou on duplique d'un clic et on colle le lien |
| Écrire dans un fichier Figma, y poser des images | Oui (`use_figma`, `upload_assets`) | |
| Créer un site Webflow | **Non** : le MCP lit, remplit et publie des sites existants ; l'API réserve la création aux espaces Enterprise | Un **site modèle** est dupliqué à la main dans Webflow (un clic), puis l'agent le remplit (pages, CMS, styles) |
| Capturer un site de référence | Oui, sans MCP : Chrome sans fenêtre (`--headless=new --screenshot`) | Un navigateur pilotable (Claude in Chrome, Playwright) seulement pour les pages derrière une connexion |
| Dossier, fichiers, git, GitHub | Oui (Claude Code lui-même, `gh`) | |

## Où ranger un agent

Les agents sont **livrés avec Vigie** : un agent = un dossier du dépôt, `agents/<id>/AGENT.md`, avec ses fichiers
(scripts, images). Chaque version les emporte (`scripts/release.sh`) et la mise à jour remplace tout
`~/.vigie/agents` chez chacun ; personne n'en ajoute de son côté. Pour en écrire un : [agents/CLAUDE.md](../agents/CLAUDE.md).

`<id>` est le nom du dossier : minuscules, chiffres et tirets, 64 caractères au plus (`demarrer-projet`). Un dossier
au nom invalide ou sans `AGENT.md` n'est pas listé ; un `AGENT.md` de plus de 256 Ko est listé avec une erreur, sans
pouvoir être lancé. `node --test test/agents.test.mjs` vérifie que chaque agent livré se lit sans erreur.

## Lancer sans rien faire de plus

L'extension Claude Code de VS Code et l'app Claude ne font que **préremplir** le message d'un lien (un lien ne doit
pas pouvoir faire travailler Claude). Avec l'accès « Accessibilité » de macOS (une fois, depuis le formulaire), l'app
Vigie l'envoie toute seule (`mac/…/Data/AgentAutoSend.swift`) :
- elle appuie sur Entrée seulement dans le champ de Claude (« Message input » dans VS Code) et seulement s'il contient
  le message de l'agent (le chemin de son brief), puis vérifie qu'il est parti ;
- dans VS Code, un dossier tout neuf : VS Code demande s'il fait confiance à ses auteurs et l'extension Claude Code ne
  démarre pas avant (`untrustedWorkspaces: false`) ; Vigie répond oui pour ce dossier-là seulement, dans la fenêtre du
  projet ;
- une conversation déjà ouverte dans VS Code : l'extension refuse le message (« Session is already open ») ; Vigie le
  colle dans son champ s'il est vide (jamais par-dessus un brouillon), puis l'envoie.

Sans l'accès, rien ne change : le message attend dans le champ.

## Le rapport pour Vigie

Le brief demande à chaque agent de tenir à jour `<dossier>/.vigie/rapport-<id>.json` (forme dans `api-v2.md`,
« Rapports d'agents »). La page Agents le montre dans « Derniers lancements », à la seconde : en cours ou terminé, le
verdict, les décomptes, ce que l'agent a fait, ce qui reste à valider (l'utilisateur coche), le rapport détaillé, la
conversation et le dossier. Rien à écrire dans `AGENT.md` pour ça ; une phrase qui dit quoi mettre dans `todo` aide.

## Format d'AGENT.md

Un en-tête entre deux lignes `---`, puis la consigne en Markdown, écrite pour Claude.

```markdown
---
name: Démarrer un projet client
description: Brief, références et préparation du premier rendez-vous
icon: wand.and.stars
mcp: [figma]
folder: ~/Code
creates:
  - Le dossier du projet et sa documentation (brief, questionnaire, références, premier rendez-vous)
  - Les captures des sites de référence
  - Le fichier Figma du projet, monté sur le modèle du studio
fields:
  - id: brief
    label: Ce que tu as
    type: longtext
    required: true
    help: Colle le questionnaire, l'e-mail du client, ses liens, tes notes ; glisse ses fichiers (PDF, brandbook, images)
---
Tu prépares le premier rendez-vous de ce projet, à partir de « Ce que tu as » et des fichiers joints (dans `sources/`).

1. Dans ce dossier, crée `docs/` : `brief.md` (ce que le client veut, ce qu'il aime, ce qu'il n'aime pas, ses
   contraintes), `questionnaire.md` (les réponses rangées par thème), `references.md` (pour chaque site de
   référence : ce qu'il en dit, ce qu'on en garde).
2. Lis le site actuel et les sites de référence cités ; capture chacun dans `docs/captures/` ; note ce qui marche
   et ce qui ne marche pas.
3. Crée le fichier Figma du projet avec les scripts de `{{dossier_agent}}/figma/`, puis, sur la page « Début de
   mission » : le brief en quelques blocs, une carte par site de référence (capture, ce que le client aime, ce
   qu'il n'aime pas).
4. Termine par un compte rendu : les liens, et ce qui reste à faire à la main.
```

**En-tête**

| Clé | Obligatoire | Valeur |
|---|---|---|
| `name` | oui | nom affiché (120 caractères au plus) |
| `description` | non | une phrase sous le nom |
| `icon` | non | nom de symbole SF (`wand.and.stars`) |
| `mcp` | non | MCP nécessaires, par leur service (`figma`, `webflow`, `gmail`…) : n'importe quel MCP de ce service fait l'affaire, quel que soit son nom (`figma-pro`, connecteur `claude.ai Figma`…), le mieux connecté compte ; un nom sans service connu (`outil-maison`) : ce MCP-là. La page montre leur état et propose d'ajouter ou de connecter ce qui manque |
| `folder` | non | dossier parent proposé pour le projet, absolu ou en `~/…` (défaut `~/Code`). Il suit la règle du dossier du projet (voir « Comment il se lance »), sauf qu'il peut être le dossier perso lui-même (`~` : projets rangés en `~/<client>`) ; sinon l'agent est listé avec une erreur (« « folder » : ~/.ssh est réservé (tes clés). Change-le dans AGENT.md. ») et ne se lance pas |
| `creates` | non | ce que l'agent crée, montré dans le formulaire (« Ce que l'agent va créer ») : des phrases courtes en lignes `- …` (ou une seule phrase), 12 au plus, 200 caractères chacune |
| `fields` | non | le formulaire : une liste de champs (30 au plus). Souvent un seul, de type `longtext`, où l'on colle tout ce qu'on a |

Une phrase de `creates` qui contient « : » (`- Figma : le fichier`) ou qui se lit comme un booléen (`- Oui`) se met
entre guillemets ; sinon l'agent est listé avec une erreur (« « creates » : phrase 1 illisible. Mets-la entre
guillemets… »).

Chaque champ : `id` (minuscules, chiffres et `_`, commence par une lettre, unique), `label` (obligatoire), `type`
(`text` par défaut, `longtext`, `url`, `urls` : une adresse par ligne, `choices` : des cases à cocher), `required`
(`true`/`false`), `help` (une aide sous le champ), `placeholder` (exemple grisé dans le champ). Les clés inconnues
sont ignorées.

Cases à cocher (`type: choices`) : `options` (2 à 12 choix, sur une ligne : `options: [Tout le site, SEO, "Liens,
ancres"]`, 80 caractères au plus chacun), et en option `icons` (un symbole SF par choix, dans le même ordre) et
`default` (cochés à l'ouverture). L'app les montre en tuiles illustrées ; le brief liste les choix cochés, un par
ligne, et `{{id}}` les écrit sur une ligne, séparés par des virgules. `required: true` : au moins un. Un choix
envoyé qui n'est pas dans `options` est refusé au lancement.

L'en-tête est un petit morceau de YAML, lu par Vigie sans dépendance :

- une clé par ligne, `clé: valeur` (ou `clé : valeur`) ;
- listes entre crochets (`[a, b]`) ou en lignes `- a` sous la clé ; liste de champs en `- id: …` puis les autres
  clés alignées dessous ;
- valeurs entre guillemets (`"…"`, `'…'`) ou non ; `true`, `false`, `oui`, `non` sont des booléens : pour écrire
  « Non » comme texte, mets-le entre guillemets ;
- `#` précédé d'une espace commence un commentaire (entre guillemets, c'est du texte) ;
- espaces seulement pour le retrait, pas de tabulation ; pas de texte sur plusieurs lignes (`|`, `>`), pas d'objet
  entre accolades, deux niveaux au plus.

Un `AGENT.md` mal écrit ne bloque rien : l'agent est listé avec une phrase qui dit quoi corriger (« Ligne 4 :
guillemets non fermés. »), et ne peut pas être lancé.

**Consigne** : tout ce qui suit l'en-tête. `{{id}}` d'un champ d'une ligne (`text`, `url`) y est remplacé par la
valeur saisie, telle quelle (« {{client}} — Projet » donne « Cabinet Martin — Projet »). En début de ligne, même
derrière `- `, `1. ` ou `> `, un début de valeur qui ouvrirait un titre ou un bloc Markdown (`## `, ```` ``` ````,
`~~~`, `> `, `- `, `<`…) est neutralisé par une barre oblique inverse. « +33 6… » ou « -20 % » restent tels quels.
`{{id}}` d'un long texte ou d'une liste d'adresses (`longtext`, `urls`) n'y recopie jamais la valeur : il devient un
renvoi, « Questionnaire avant le premier rendez-vous » (plus haut, dans « Ce que tu m'as donné »). Un questionnaire
collé ne peut donc pas écrire ses propres consignes. Champ vide : « (non fourni) ».
`{{dossier_agent}}` donne le dossier de l'agent (chemin réel, lien symbolique suivi) : un agent peut y porter ses
propres fichiers (scripts, images, modèles) et la consigne les cite par `{{dossier_agent}}/…`.

## Comment il se lance

1. Page **Agents** de l'app : une carte par agent, avec ses MCP nécessaires et leur état pour le compte des nouvelles
   conversations (celui sur lequel la conversation partira).
2. **Lancer** ouvre le formulaire, dans cet ordre :
   - **Projet** : le dossier, proposé d'après `folder` et ce qui est tapé (`~/Code/<nom>`). À chaque changement,
     l'app demande au moteur de Vigie ce qu'il en pense (`GET /api/v2/agents/folder`) : « Nouveau dossier : Vigie le
     crée. », « Dossier existant · N fichiers dans sources/ », ou la raison du refus (bouton grisé).
   - **Conversation existante** : si une conversation Claude Code a été lancée dans ce dossier, l'app la montre (titre,
     quand, où, si elle est ouverte) et propose de la **continuer** (par défaut, la plus récente) ou d'en ouvrir une
     nouvelle. L'agent garde son historique et y ajoute ce qu'il doit créer.
   - **Le champ** (ou les champs de l'agent) : un grand texte où coller ce qu'on a (questionnaire, e-mail du client,
     liens, notes), et où **glisser des fichiers** (PDF, Word, brandbook, images, dossiers) ou les ajouter avec
     « Ajouter des fichiers… ». Ils seront copiés dans `sources/` du projet.
   - **Ce que l'agent va créer** : la liste `creates` de son `AGENT.md`.
   - **Ouvrir dans** : VS Code ou l'app Claude (seulement ce qui est installé), puis **Lancer** (ou **Continuer**).
3. Le moteur de Vigie vérifie **tout avant de rien créer** : le formulaire (champs obligatoires, tailles), le dossier,
   les fichiers joints, l'outil choisi (installé ?) et la conversation à reprendre (toujours dans ce dossier ?). Le
   dossier doit être dans ton dossier perso, jamais le dossier perso lui-même, ni un dossier réservé :

   | Dossier réservé | Raison affichée |
   |---|---|
   | `~/.vigie` | dossier de Vigie |
   | `~/Library` | réglages du Mac et des apps, iCloud Drive et Dropbox compris |
   | `~/.claude` | réglages de Claude Code |
   | `~/.claude-comptes` | comptes Claude Code de Vigie |
   | `~/.ssh` | tes clés |
   | `~/.codex` | réglages de Codex |

   `~/Library` l'est en entier, avec iCloud Drive (`~/Library/Mobile Documents`) et Dropbox
   (`~/Library/CloudStorage`). Les majuscules et les variantes d'une lettre ne comptent pas, comme pour le disque
   du Mac : `~/.SSH` et `~/.ßh` sont `~/.ssh`. Un lien, ou un autre chemin du même disque (`/System/Volumes/Data/…`),
   vers l'un d'eux ou vers un dossier qu'il contient est refusé aussi : `~/Dropbox`, qui mène à
   `~/Library/CloudStorage/Dropbox`, par exemple. Le refus dit pourquoi et où aller (« Dossier refusé : ~/.ssh est
   réservé (tes clés). Choisis un dossier ailleurs, dans ~/Code par exemple. »).
4. Vigie crée le dossier s'il manque, copie les fichiers joints dans `sources/`, et écrit `.vigie/agent-<id>.md` : le
   nom de l'agent, la date, le dossier, « Conversation : nouvelle » ou « Conversation : reprise (…) », ce que tu as
   saisi, la liste des fichiers joints (`sources/…`), puis la consigne remplie. Le dossier `.vigie` a toujours son
   `.gitignore` : le brief (questionnaire du client…) ne part jamais dans git. Il est ajouté s'il manque. Déjà là, il
   est gardé s'il ignore le brief (une ligne `*`, par exemple) ; sinon Vigie n'écrit rien et te dit quoi faire selon
   le cas : ajouter la ligne `*` à la fin ; le remplacer par un fichier qui la contient s'il dépasse 64 Ko ou n'est
   pas un fichier ordinaire ; le rendre lisible s'il ne l'est pas.
5. Le moteur de Vigie ouvre VS Code ou l'app Claude, avec le message prêt (« Lance l'agent … : lis le fichier … et
   suis ses consignes ») : tu l'envoies, la conversation lit le brief et le suit. Quand le message n'a pas pu être
   prérempli, l'app le copie : tu le colles (⌘V) et tu l'envoies.

Un refus du moteur de Vigie s'affiche en bas du formulaire, qui reste ouvert ; rien n'est créé, rien ne s'ouvre.

Rien de nouveau à surveiller : c'est une conversation comme les autres, avec ses actions sensibles et sa consommation
dans Vigie. Le brief est lisible par la conversation, mais le modifier passe par toi : Vigie protège tous les dossiers
`.vigie` (garde-fou « réglages de Vigie »).

### Fichiers joints

Glissés dans le champ, ou ajoutés avec « Ajouter des fichiers… » : des fichiers ou des dossiers, 50 au plus, 1 Go et
5 000 fichiers au plus en tout (dossiers parcourus). L'app dépose les pièces glissées depuis Mail ou Safari (fichiers
« promis ») dans un dossier temporaire à elle, puis donne ce chemin.

- **Copiés** dans `<dossier>/sources/` (créé en `0755`, fichiers en `0644`, date d'origine gardée), sous leur nom ; si
  le nom est pris, « nom (2).ext », « nom (3).ext »… : rien n'est jamais écrasé. Un fichier déjà dans `sources/`
  n'est pas recopié. Un dossier joint est recopié avec ses sous-dossiers ; les liens symboliques et les fichiers
  spéciaux (tubes) qu'il contient sont laissés de côté.
- **Refusés**, avant toute copie (un seul refus, et rien n'est copié) : un chemin introuvable (« Fichier joint
  introuvable : charte.pdf. »), un lien symbolique (« Fichier joint refusé : raccourci.pdf est un lien. Joins le
  fichier lui-même. »), un fichier ou un dossier dans un dossier réservé, par son chemin, par un lien dans le chemin
  ou dans une autre casse (« Fichier joint refusé : ~/.ssh est réservé (tes clés). »), un dossier qui est ou contient
  ton dossier perso ou le dossier du projet, un fichier qui a un autre nom ailleurs sur le disque (lien physique :
  ce pourrait être une clé), un fichier illisible (« … macOS ne laisse pas Vigie le lire : copie-le ailleurs… » quand
  macOS refuse l'accès au Bureau, aux Documents ou aux Téléchargements), ou plus que les limites (« Fichiers joints
  trop gros : 1 Go au plus. »).
- **Permis** : hors du dossier perso (clé USB, `/Volumes/…`), et les dossiers temporaires du système (`/tmp`,
  `/private/var/folders/…`, celui du moteur), même s'ils étaient rangés sous un dossier réservé.
- Le moteur de Vigie n'écrit que dans `<dossier>/sources` et `<dossier>/.vigie` (et crée `<dossier>` s'il manque) :
  un `sources` qui n'est pas un dossier ordinaire (un lien, par exemple) est refusé. Chaque fichier est rouvert sans
  suivre de lien et doit être celui qui a été vérifié (même numéro sur le disque) : remplacé entre-temps, il n'est
  pas copié (« Fichier joint modifié pendant la copie : … Relance l'agent. »). Si une copie échoue (disque plein),
  ce lancement retire ce qu'il avait déjà copié.

### Reprendre une conversation

Le formulaire montre les conversations Claude Code (pas Codex) lancées dans ce dossier exactement (chemin réel :
liens résolus, majuscules sans importance), connues de Vigie (7 derniers jours), la plus récente d'abord, 5 au plus ;
leur titre est celui de l'app Claude s'il existe. Continuer l'une d'elles : le brief dit « Conversation : reprise (tu
continues une conversation existante : tiens compte de ce qui a déjà été fait, ne refais pas ce qui existe). » et le
message devient « Lance l'agent « … » dans cette conversation : lis le fichier … et suis ses consignes. Tiens compte
de ce qu'on a déjà fait ici. » Si la conversation n'est plus dans ce dossier au moment du lancement : « Cette
conversation n'est plus dans ce dossier : relance en nouvelle conversation. »

### Dans VS Code ou dans l'app Claude

`Ouvrir dans` propose ce qui est installé : VS Code (dans `/Applications` ou `~/Applications`, avec l'extension Claude
Code) et l'app Claude. Le dernier choix est retenu. C'est le moteur de Vigie qui ouvre (`/usr/bin/open`, avec des
arguments, jamais par un shell ; chaque valeur des liens encodée) :

| Où | Nouvelle conversation | Reprise |
|---|---|---|
| VS Code | `open -a "Visual Studio Code" <dossier>`, puis, quand la fenêtre est prête, `vscode://anthropic.claude-code/open?prompt=…` | le même lien avec `&session=<uuid>` |
| App Claude | `claude://code/new?folder=…&q=…&source=vigie` (message prérempli, 2 592 caractères au plus ; plus long : sans `q`, l'app copie le message) | `claude://code/continue?session=local_<id>` si la conversation est née dans l'app, sinon `claude://resume?session=<uuid>` ; aucun ne prend de message : l'app le copie |

**Attente de la fenêtre de VS Code.** VS Code envoie un lien `vscode://` à sa dernière fenêtre active : ouvert trop
tôt (l'ancienne attente fixe de 2,5 s), le message partait dans la fenêtre d'un autre projet. Chaque fenêtre où
l'extension Claude Code démarre écrit `~/.claude/ide/<port>.lock` (`pid`, `workspaceFolders`). Le moteur de Vigie
attend donc la fenêtre **du projet** : un `.lock` écrit par VS Code (`ideName` ; Cursor et Windsurf écrivent au même
endroit), ouvert sur ce seul dossier (chemin réel, casse pliée), dont le `pid` est vivant et dont le port répond (le
fichier d'une fenêtre fermée reste sur le disque, son port non). Déjà là avant l'ouverture : 800 ms (le temps qu'elle passe devant). Sinon :
sondage toutes les 300 ms, 25 s au plus, puis 1,5 s (le temps que l'extension écoute). Pas prête à temps : le lien
n'est **pas** envoyé (il partirait ailleurs) ; VS Code est ouvert sur le projet et l'app copie le message. L'attente
passe par des minuteries : le moteur répond aux autres demandes pendant ce temps (le lancement peut durer ~30 s).
« Ouvrir une conversation » (vue d'ensemble) attend la fenêtre de la même façon.

La réponse dit ce qui s'est ouvert (`opened`), et l'app affiche le message :

| `opened` | Message |
|---|---|
| `full` (VS Code) | VS Code s'ouvre sur le projet, avec le message prêt dans Claude Code : envoie-le. |
| `full` (app Claude) | L'app Claude s'ouvre sur le projet, avec le message prêt : envoie-le. |
| `folder` | VS Code est ouvert sur le projet, mais le message n'a pas pu partir dans Claude Code (si VS Code demande de faire confiance au dossier, accepte) : il est copié, colle-le dans Claude Code et envoie-le. |
| `no-prompt` | La conversation s'ouvre dans l'app Claude : le message est copié, colle-le (⌘V) et envoie-le. |
| `none` (VS Code) | Le dossier est prêt, mais VS Code ne s'est pas ouvert : le message est copié, ouvre le dossier dans VS Code, et colle-le dans Claude Code. |
| `none` (app Claude) | Le dossier est prêt, mais l'app Claude ne s'est pas ouverte : le message est copié, ouvre l'app Claude, puis une conversation Claude Code sur ce dossier, et colle-le. |

En reprise, les phrases nomment la conversation à ouvrir (« ouvre la conversation « … » dans le panneau de Claude
Code, puis colle-le ») : collé dans une autre, le message perdrait son historique.

## Ce qui reste

- **Choix du compte au lancement** : la conversation part sur le compte des nouvelles conversations (réglable dans
  Comptes). Un compte conseillé par agent viendra si on en a besoin.
- **Lancement en fond** (`claude -p` en flux JSON), avec le compte rendu dans Vigie : plus tard.
- **Garde-fous** : publier un site, supprimer, envoyer un e-mail restent des actions sensibles. Il faudra ajouter la
  publication Webflow (`publish_site`) aux règles.
- **Aucun secret dans un agent** : les connexions passent par la passerelle MCP de Vigie.
- **Fichiers joints et accès de macOS** : macOS ne laisse pas le moteur de Vigie lire le Bureau, les Documents, les
  Téléchargements, iCloud Drive ou un disque externe. C'est à l'app que tu confies ces fichiers (glissés, choisis) :
  elle en fait une copie dans son dossier temporaire, instantanée sur le même disque, et c'est cette copie que le
  moteur range dans `sources/`. Avant de copier, l'app refuse ce que le moteur refuserait et que la copie effacerait :
  un lien symbolique, un lien physique, `~/Library` (sauf iCloud Drive et Dropbox), un dossier qui contient ton dossier
  perso, plus d'1 Go ou de 5 000 fichiers.
- **Fichiers sensibles hors des dossiers réservés** (`~/.claude.json`, `~/.aws`, `~/.gnupg`…) : joints seulement si
  tu les choisis toi-même (cachés dans le Finder) ; à ajouter aux dossiers réservés si le besoin se présente.

## Encore à décider

La première version a tranché les points 1 (le modèle Figma est reconstruit par les scripts de l'agent : aucune
manipulation à la main, et le modèle s'améliore en modifiant les scripts) et 4 (visible dans VS Code) ; le reste est
ouvert.

1. ~~Le modèle Figma~~ : reconstruit par l'agent.
2. Webflow : site modèle dupliqué à la main, ou l'agent part d'un site vide déjà créé ?
3. ~~Les agents de l'équipe~~ : livrés avec Vigie, une nouvelle version pour un agent nouveau ou corrigé.
4. Lancement : visible dans VS Code (on suit et on corrige en direct), ou en fond ?
5. « Programmer à l'avance » : préparé à l'avance (la bibliothèque), ou aussi planifié à une heure donnée ?

## Étapes proposées

1. **Première version** : format `AGENT.md`, page Agents, lancement dans VS Code (fait côté moteur le 2026-10-26),
   et un premier agent « Démarrer un projet client » avec un modèle Figma en bibliothèque et un site Webflow modèle.
2. **Deuxième version** (moteur, 2026-10-26) : un seul champ et des fichiers joints, `creates`, reprise d'une
   conversation, VS Code ou app Claude, ouverture par le moteur qui attend la fenêtre du projet.
3. **Ensuite** : lancement en fond et compte rendu dans Vigie, captures des sites de référence par un navigateur.
4. **Puis** : lancements planifiés si on en a besoin. (Les agents partent avec les versions de Vigie : pas de
   bibliothèque à ajouter soi-même.)
