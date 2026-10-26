# Agents

État (2026-10-26) : première version du moteur construite. Format `AGENT.md`, liste et lancement dans VS Code
(`lib/agents.mjs`, `GET /api/v2/agents`, `POST /api/v2/agents/launch`, voir [api-v2.md](api-v2.md)). La réflexion du
départ et les décisions à prendre restent plus bas.

## L'idée

Un **agent** est une recette préparée à l'avance : « Démarrer un projet client », « Créer une page », « Relier le CMS »…
On la lance depuis Vigie en remplissant un petit formulaire ; elle enchaîne des actions sur des MCP (Figma, Webflow,
GitHub…) et dans le dossier de code. Ça marche comme une compétence (skill) de Claude Code, mais avec ce que Vigie sait
déjà faire autour : les bons MCP connectés une fois pour tous les comptes, le bon compte, le bon dossier, les actions
sensibles retenues, et un suivi comme pour n'importe quelle conversation.

Pour une agence, ça veut dire : chaque collègue lance la même recette et obtient le même point de départ, sans
connaître les outils par cœur.

## Exemple : démarrer un projet client

**Entrées (formulaire)** : nom du client ; site actuel (à refaire) ; questionnaire client déjà rempli (texte ou fichier) ;
sites de référence (adresses) ; modèle Figma de l'agence ; espace Webflow ; dossier de code.

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

Un agent = un dossier, `~/.vigie/data/agents/<id>/AGENT.md` (le dossier `agents` est créé par Vigie au premier
affichage de la page). `<id>` est le nom du dossier : minuscules, chiffres et tirets, 64 caractères au plus
(`demarrer-projet`). Un dossier au nom invalide ou sans `AGENT.md` n'est pas listé ; un `AGENT.md` de plus de 256 Ko
est listé avec une erreur, sans pouvoir être lancé.

Un agent d'équipe peut vivre dans un dépôt git partagé : un lien symbolique suffit
(`ln -s ~/Code/agents-equipe/demarrer-projet ~/.vigie/data/agents/demarrer-projet`).

## Format d'AGENT.md

Un en-tête entre deux lignes `---`, puis la consigne en Markdown, écrite pour Claude.

```markdown
---
name: Démarrer un projet client
description: Brief, références et préparation du premier rendez-vous
icon: wand.and.stars
mcp: [figma-pro]
folder: ~/Code
fields:
  - id: client
    label: Nom du client
    required: true
    help: Il sert aussi à nommer le dossier du projet
    placeholder: Cabinet Martin
  - id: site
    label: Site actuel
    type: url
    placeholder: https://studio-exemple.fr
  - id: questionnaire
    label: Questionnaire avant le premier rendez-vous
    type: longtext
    help: Le résumé du questionnaire, tel quel
  - id: references
    label: Sites de référence
    type: urls
    help: Une adresse par ligne
  - id: figma
    label: Fichier Figma du projet
    type: url
    help: Duplique le modèle dans Figma, range-le dans le dossier des projets, puis colle son lien ici
---
Tu prépares le premier rendez-vous avec {{client}}.

1. Dans ce dossier, crée `docs/` : `brief.md` (ce que le client veut, ce qu'il aime, ce qu'il n'aime pas, ses
   contraintes), `questionnaire.md` (les réponses rangées par thème), `references.md` (pour chaque site de
   référence : ce qu'il en dit, ce qu'on en garde).
2. Lis le site actuel ({{site}}) et les sites de référence ; note ce qui marche et ce qui ne marche pas.
3. Dans le fichier Figma ({{figma}}), sur la page « Début de mission » : le brief en quelques blocs, puis une carte
   par site de référence (capture, ce que le client aime, ce qu'il n'aime pas). S'il n'y a pas de lien, demande-le.
4. Termine par un compte rendu : les liens, et ce qui reste à faire à la main.
```

**En-tête**

| Clé | Obligatoire | Valeur |
|---|---|---|
| `name` | oui | nom affiché (120 caractères au plus) |
| `description` | non | une phrase sous le nom |
| `icon` | non | nom de symbole SF (`wand.and.stars`) |
| `mcp` | non | MCP nécessaires, par leur nom dans Claude Code (`figma-pro`, ou `Gmail` pour un connecteur claude.ai) ; la page montre leur état |
| `folder` | non | dossier parent proposé pour le projet, absolu ou en `~/…` (défaut `~/Code`). Il suit la règle du dossier du projet (voir « Comment il se lance »), sauf qu'il peut être le dossier perso lui-même (`~` : projets rangés en `~/<client>`) ; sinon l'agent est listé avec une erreur et ne se lance pas |
| `fields` | non | le formulaire : une liste de champs (30 au plus) |

Chaque champ : `id` (minuscules, chiffres et `_`, commence par une lettre, unique), `label` (obligatoire), `type`
(`text` par défaut, `longtext`, `url`, `urls` : une adresse par ligne), `required` (`true`/`false`), `help` (une aide
sous le champ), `placeholder` (exemple grisé dans le champ). Les clés inconnues sont ignorées.

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
2. **Lancer** ouvre le formulaire et le dossier du projet (proposé : `folder` + le nom du client).
3. Vigie vérifie le formulaire (champs obligatoires, tailles) et le dossier : dans ton dossier perso, jamais le dossier
   perso lui-même, ni `~/.vigie`, `~/Library`, `~/.claude`, `~/.claude-comptes`, `~/.ssh`, `~/.codex`. Les
   majuscules ne comptent pas, comme pour le disque du Mac : `~/.SSH` est `~/.ssh`. Un lien, ou un autre chemin du
   même disque (`/System/Volumes/Data/…`), vers l'un d'eux est refusé aussi.
4. Vigie crée le dossier s'il manque, et y écrit `.vigie/agent-<id>.md` : le nom de l'agent, la date, ce que tu as
   saisi, puis la consigne remplie. Le dossier `.vigie` a toujours son `.gitignore` : le brief (questionnaire du
   client…) ne part jamais dans git. Il est ajouté s'il manque. Déjà là, il est gardé s'il ignore le brief (une ligne
   `*`, par exemple) ; sinon Vigie n'écrit pas le brief et te dit quoi y ajouter.
5. L'app ouvre VS Code sur le dossier, puis un onglet Claude Code avec le message prêt (« Lance l'agent … : lis le
   fichier … et suis ses consignes ») : tu l'envoies, la conversation lit le brief et le suit.

Dans l'app, la feuille vérifie le dossier comme le moteur, avant le clic : le bouton reste grisé et la raison
s'affiche sous le dossier. Un refus du moteur s'affiche en bas de la feuille, qui reste ouverte. Sans VS Code, rien
n'est créé. Si VS Code ne s'ouvre pas, la feuille propose de copier le message.

Rien de nouveau à surveiller : c'est une conversation comme les autres, avec ses actions sensibles et sa consommation
dans Vigie. Le brief est lisible par la conversation, mais le modifier passe par toi : Vigie protège tous les dossiers
`.vigie` (garde-fou « réglages de Vigie »).

## Ce qui reste

- **Choix du compte au lancement** : la conversation part sur le compte des nouvelles conversations (réglable dans
  Comptes). Un compte conseillé par agent viendra si on en a besoin.
- **Lancement en fond** (`claude -p` en flux JSON), avec le compte rendu dans Vigie : plus tard.
- **Garde-fous** : publier un site, supprimer, envoyer un e-mail restent des actions sensibles. Il faudra ajouter la
  publication Webflow (`publish_site`) aux règles.
- **Aucun secret dans un agent** : les connexions passent par la passerelle MCP de Vigie.

## Encore à décider

La première version a tranché les points 1 (le modèle Figma est reconstruit par les scripts de l'agent : aucune
manipulation à la main, et le modèle s'améliore en modifiant les scripts) et 4 (visible dans VS Code) ; le reste est
ouvert.

1. ~~Le modèle Figma~~ : reconstruit par l'agent.
2. Webflow : site modèle dupliqué à la main, ou l'agent part d'un site vide déjà créé ?
3. Les agents de l'équipe : quel dépôt, et qui les tient à jour ?
4. Lancement : visible dans VS Code (on suit et on corrige en direct), ou en fond ?
5. « Programmer à l'avance » : préparé à l'avance (la bibliothèque), ou aussi planifié à une heure donnée ?

## Étapes proposées

1. **Première version** : format `AGENT.md`, page Agents, lancement dans VS Code (fait côté moteur le 2026-10-26),
   et un premier agent « Démarrer un projet client » avec un modèle Figma en bibliothèque et un site Webflow modèle.
2. **Ensuite** : lancement en fond et compte rendu dans Vigie, captures des sites de référence par un navigateur.
3. **Puis** : bibliothèque d'équipe partagée, et lancements planifiés si on en a besoin.
