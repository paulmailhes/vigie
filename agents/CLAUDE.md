# Agents livrés avec Vigie — comment en écrire un

**Un dossier = un agent** : `agents/<id>/AGENT.md` (le formulaire et la consigne) et, si besoin, ses fichiers (scripts
Figma, images, modèles). Les agents partent avec chaque version de Vigie (`scripts/release.sh`, puis
`gh release create`) : la mise à jour remplace tout le dossier `~/.vigie/agents` chez chacun. Personne n'en ajoute de
son côté.

- L'id d'un agent est le nom de son dossier : ne le renomme pas (l'historique des lancements le suit).
- **Le dépôt est public** : rien de personnel dans un agent, ni client, ni adresse e-mail, ni identifiant d'équipe, ni
  lien vers un fichier privé. Les exemples sont inventés.
- Format complet de l'en-tête et du brief : [docs/agents.md](../docs/agents.md).

## Le fichier AGENT.md

```markdown
---
name: Démarrer un site Webflow          # le nom affiché, court, verbe à l'infinitif
description: Une phrase : ce que l'agent fait, pour qui
icon: globe                              # un symbole SF (sparkles, globe, doc.text, paintbrush…)
mcp: [webflow-pro]                       # les MCP dont il a besoin (Vigie montre leur état)
folder: ~/Code                           # dossier parent proposé pour le projet
creates:                                 # ce qu'il crée, montré dans le formulaire (12 phrases au plus)
  - Le site Webflow du projet, avec ses pages et ses collections
fields:                                  # le formulaire : un seul grand champ suffit le plus souvent
  - id: infos
    label: Ce que tu as sur le projet
    type: longtext                       # text, longtext, url, urls (une adresse par ligne), choices
    help: Colle ce que tu as ; glisse ici les fichiers utiles
  - id: controles                        # des cases à cocher illustrées
    label: Ce qu'il faut contrôler
    type: choices
    options: [Tout le site, SEO, Liens]  # 2 à 12, sur une ligne ; entre guillemets s'il y a une virgule
    icons: [checkmark.seal, magnifyingglass, link]   # un symbole SF par choix (facultatif)
    default: [Tout le site]              # cochés à l'ouverture (facultatif)
---
La consigne, en Markdown, écrite pour Claude.
```

- L'en-tête est un petit YAML : une clé par ligne, listes `[a, b]` ou `- a`, pas de texte sur plusieurs lignes,
  pas de tabulation ; `oui`/`non` sont des booléens (mets « Non » entre guillemets pour du texte).
- Dans la consigne : `{{id}}` d'un champ d'une ligne est remplacé par la valeur ; un long texte n'est jamais recopié
  (renvoi vers « Ce que tu m'as donné » dans le brief) ; `{{dossier_agent}}` = le dossier de l'agent, pour citer ses
  fichiers (`{{dossier_agent}}/figma/01-fondations.js`).
- Les fichiers glissés dans le formulaire arrivent dans `sources/` du projet ; le brief les liste.
- `mcp: [figma]` : n'importe quel MCP de ce service. L'utilisateur choisit dans le formulaire lequel (et, pour un MCP
  de la passerelle comme Webflow, son espace de travail) ; le brief les nomme sous « MCP à utiliser » : dis à l'agent
  de prendre celui-là.
- `node --test test/agents.test.mjs` vérifie que chaque agent livré se lit sans erreur.

## Les règles des agents

Reprends-les dans chaque consigne (voir `ourama-demarrer-projet/AGENT.md`, l'agent de référence) :
- **Français, tutoiement**, concret.
- **Aller au bout sans s'arrêter.** Questions à l'utilisateur **seulement avec l'outil de questions intégré**
  (AskUserQuestion), seulement quand la réponse change le résultat, l'option recommandée en premier avec
  « (recommandé) » (Vigie peut la choisir si personne n'est là). Jamais une liste de questions à la fin.
- **Ne rien inventer** : « — » quand on ne sait pas, « à confirmer » pour une déduction.
- **Lire tout ce qu'on a** : le brief, `sources/`, tout le dossier du projet (Word en HTML pour voir le surlignage,
  PDF, logos SVG…).
- **Ne rien publier, ne rien envoyer** (pas de push, pas de publication Webflow, pas d'e-mail) : on prépare, on montre.
- **Documenter dans le dossier du projet** (`CLAUDE.md`, `README.md`, `docs/`), puis un commit git local.
- **Compte rendu court** : les liens, ce qui est fait, ce qui reste à faire (des actions, pas des questions).
- **Le rapport pour Vigie** : le brief demande déjà à l'agent de tenir `.vigie/rapport-<id>.json` à jour (la page
  Agents le montre) ; dis dans la consigne ce qui va dans `todo` (seulement les actions de l'utilisateur) et `links`.
- Seulement les MCP que tout le monde a (Figma, Webflow…), pas d'outil personnel.

## Les scripts (Figma, Webflow…)

Quand un MCP doit construire beaucoup (un fichier Figma entier), mets le travail dans des scripts du dossier de
l'agent plutôt que dans la consigne :
- un script par étape, numérotés (`01-…`, `02-…`), qui **se retrouvent par nom** (pages, composants, variables,
  styles) : jamais d'identifiant à recopier d'une étape à l'autre ;
- les données passent par un repère à remplacer (`__PARAMS__`, `__DONNEES__`) par un objet JSON, documenté en tête
  du script ; la consigne dit de recopier le script **tel quel** ;
- chaque script refuse de refaire ce qui existe déjà (« … existe déjà : passe à la suite ») ;
- **essaie chaque script dans un fichier d'essai** avant de le livrer (puis supprime le fichier d'essai).

## Essayer un agent avant de le publier

Dans un dossier d'essai (`~/Code/essai-…`), ouvre une conversation Claude Code et demande-lui de suivre
`~/Code/vigie/agents/<id>/AGENT.md` (`{{dossier_agent}}` = ce dossier). Regarde-la aller au bout, corrige la consigne
ou les scripts, recommence. Puis une nouvelle version de Vigie : l'agent arrive chez tout le monde.
