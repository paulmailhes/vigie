# Agents : réflexion

État : idée à préparer, rien n'est construit. Écrit le 2026-10-26.

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
| Dupliquer un fichier Figma modèle | **Non** : ni le MCP ni l'API de Figma ne copient un fichier | Le modèle devient une **bibliothèque d'équipe publiée** (composants, styles, variables) que l'agent pose dans le fichier neuf ; ou bien on duplique le modèle d'un clic et on colle le lien dans le formulaire |
| Écrire dans un fichier Figma, y poser des images | Oui (`use_figma`, `upload_assets`) | |
| Créer un site Webflow | **Non** : le MCP lit, remplit et publie des sites existants ; l'API réserve la création aux espaces Enterprise | Un **site modèle** est dupliqué à la main dans Webflow (un clic), puis l'agent le remplit (pages, CMS, styles) |
| Capturer un site de référence | Pas avec les MCP en place | Ajouter un navigateur pilotable (Claude in Chrome ou un MCP Playwright) |
| Dossier, fichiers, git, GitHub | Oui (Claude Code lui-même, `gh`) | |

## Comment ça s'intègre à Vigie

- **Un agent = un dossier** : `AGENT.md` (en tête : nom, description, champs du formulaire, MCP nécessaires, compte
  conseillé, dossier de travail), puis la consigne en Markdown, comme une compétence, et les fichiers joints
  (gabarits de documentation, par exemple).
- **Bibliothèque** : les agents personnels dans `~/.vigie/agents`, et ceux de l'équipe dans un dépôt git partagé,
  installés comme la bibliothèque de MCP.
- **Page « Agents »** dans la barre latérale (Outils : MCP, Agents, Historique). Une carte par agent, avec ses MCP
  nécessaires et leur état (connecté, à connecter). « Lancer » ouvre le formulaire, puis le choix du compte et du
  dossier.
- **Lancement, première version** : une conversation Claude Code dans VS Code, dans le dossier choisi, avec la consigne
  remplie. Rien de nouveau à surveiller : Vigie suit déjà les conversations, leurs actions sensibles et leur
  consommation. **Plus tard** : en fond (`claude -p` en flux JSON), avec le compte rendu dans Vigie.
- **Garde-fous inchangés** : publier un site, supprimer, envoyer un e-mail restent des actions sensibles. Il faudra
  ajouter la publication Webflow (`publish_site`) aux règles.
- **Aucun secret dans un agent** : les connexions passent par la passerelle MCP de Vigie.

## À décider avant de construire

1. Le modèle Figma : bibliothèque d'équipe publiée, ou duplication à la main puis lien collé ?
2. Webflow : site modèle dupliqué à la main, ou l'agent part d'un site vide déjà créé ?
3. Les agents de l'équipe : quel dépôt, et qui les tient à jour ?
4. Lancement : visible dans VS Code (on suit et on corrige en direct), ou en fond ?
5. « Programmer à l'avance » : préparé à l'avance (la bibliothèque), ou aussi planifié à une heure donnée ?

## Étapes proposées

1. **Première version** : format `AGENT.md`, page Agents, lancement dans VS Code, et un premier agent « Démarrer un
   projet client » avec un modèle Figma en bibliothèque et un site Webflow modèle.
2. **Ensuite** : lancement en fond et compte rendu dans Vigie, captures des sites de référence par un navigateur.
3. **Puis** : bibliothèque d'équipe partagée, et lancements planifiés si on en a besoin.
