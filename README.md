# Vigie

**Vigie veille sur Claude Code pendant que tu travailles… ou pendant que tu dors.**

Tu lances Claude Code pour plusieurs heures, et tu reviens pour trouver une fenêtre « Autoriser ? » qui attend depuis le début ? Vigie s'en charge à ta place. Les demandes sans risque sont validées toutes seules, et les actions sensibles t'attendent toujours. Tu suis tout dans une petite app Mac : tes conversations, ta consommation, tes comptes et tes MCP.

> **Bêta.** Vigie est en test. Il marche au quotidien, mais attends-toi à quelques angles encore à arrondir. Les retours sont les bienvenus (onglet *Issues*).

![Vue d'ensemble](docs/images/vue-ensemble.png)

## Ce que fait Vigie

- **Il valide pour toi** les demandes d'autorisation de Claude Code (commandes, fichiers, outils, MCP), dans toutes tes conversations, y compris celles déjà ouvertes.
- **Il garde pour toi les actions sensibles** : `sudo`, suppression de dossiers importants, `git push --force`, effacement de disque, paiements, envoi d'e-mails, publications, réglages de Claude Code ou du shell. L'action attend ton accord dans Vigie, et un clic suffit.
- **Il répond aux questions quand tu n'es pas là**, si tu le veux. Après un délai, Claude prend l'option recommandée, et tu relis son choix ensuite (« Ça me va » ou « Changer »).
- **Il te montre où en est chaque conversation** : ta demande, son message en direct, sa feuille de route, le fil de ce qu'elle a fait (commits, déploiements, tests, agents).
- **Il suit ta consommation** par compte et par conversation : session de 5 h, semaine, et l'heure exacte de remise à zéro.
- **Il gère plusieurs comptes Claude** : ils restent connectés en même temps, et tu choisis le compte de chaque conversation.
- **Il gère tes MCP**, avec leur état sur chaque compte et un bouton « Connecter » qui ouvre directement la page d'autorisation.

Tout se passe sur ton Mac : Vigie n'envoie tes conversations nulle part.

## Installation

Il te faut :

- un Mac avec **macOS 26** (Tahoe) ou plus récent, Apple Silicon ou Intel ;
- **Node.js 20** ou plus récent ([nodejs.org](https://nodejs.org), ou `brew install node`) ;
- **Claude Code**, dans VS Code ou dans le terminal.

Puis, dans le Terminal :

```bash
curl -fsSL https://raw.githubusercontent.com/paulmailhes/vigie/main/install.sh | bash
```

L'app s'ouvre sur un court accueil :

1. ce que fait Vigie ;
2. où autoriser les actions sensibles ;
3. tes comptes Claude, à ajouter et connecter en un clic ;
4. l'auto-accept et les notifications.

Ensuite, Vigie vit dans la barre des menus (les jumelles).

**Mettre à jour :** relance la même commande. Tes réglages et ton historique sont gardés.

## Plusieurs comptes Claude

Tu as un abonnement perso et un abonnement pro, ou plusieurs comptes de travail ? Ajoute-les dans Vigie, avec un nom et une adresse. Ton navigateur s'ouvre sur la page de connexion de Claude, et le compte reste connecté.

Active ensuite « Un compte par conversation dans VS Code » : chaque conversation choisit son compte dans son en-tête, et Vigie te montre sur quel compte elle tourne vraiment.

![Comptes](docs/images/comptes.png)

Changer le compte d'une conversation la relance sur l'autre compte avec tout son historique. Elle reprend à ton prochain message dans VS Code. Le nouveau compte relit alors toute la conversation, ce qui consomme des crédits : Vigie affiche le nombre de tokens à relire avant de basculer.

## Une conversation

![Une conversation](docs/images/conversation.png)

- **Maintenant** : ta demande, depuis combien de temps elle y travaille, son dernier message en direct, ce qui en est sorti (commits, fichiers, tests, agents) et ce qui tourne en ce moment.
- **Feuille de route** : le document d'état qu'elle tient à jour (`ETAT.md`, `STATUS`, `ROADMAP`, `TODO`…), section par section, ou son plan en étapes.
- **Fil** : seulement les jalons, sans les centaines de petites actions.
- **Onglets** : Fichiers, Agents, Tests, MCP, Toutes les actions.

## MCP

![MCP](docs/images/mcp.png)

Chaque MCP a une colonne par compte : ✓ quand il marche, **Connecter** quand il faut l'autoriser, **Échec** en rouge s'il échoue. « Partout » le connecte sur tous tes comptes, l'un après l'autre. Chaque compte Claude garde sa propre autorisation : il faut connecter un MCP une fois par compte.

## Comment ça marche

- Un **hook** de Claude Code (`hook.mjs`) reçoit chaque demande d'autorisation et répond à la place de la fenêtre. En cas de doute, il ne répond rien : la fenêtre normale de Claude Code s'affiche, jamais l'inverse.
- Un **moteur local** (`server.mjs`, Node.js, sans dépendance) lit les conversations de Claude Code sur ton Mac et sert l'app sur `http://127.0.0.1:4777`, en local uniquement.
- L'**app Mac** (SwiftUI) affiche le tout et envoie tes réglages au moteur.
- Le **lanceur de comptes** (`bin/claude-account-wrapper`, facultatif) démarre chaque conversation VS Code sur le compte que tu lui as choisi.

Les fichiers de Vigie sont dans `~/.vigie`, et ses données (réglages, historique) dans `~/.vigie/data`. Le hook est branché dans `~/.claude/settings.json`. Une sauvegarde de ce fichier est faite à chaque modification.

## Désinstaller

```bash
~/.vigie/scripts/uninstall.sh          # retire le hook, le moteur et l'app ; garde tes réglages
~/.vigie/scripts/uninstall.sh --tout   # efface aussi ~/.vigie
```

Claude Code redevient exactement comme avant, et les conversations ouvertes reprennent tout de suite le fonctionnement normal.

## Développer

```bash
git clone https://github.com/paulmailhes/vigie.git && cd vigie
node --test test/            # tests du moteur et du hook
./scripts/install.sh         # installe depuis les sources (construit l'app : il faut Xcode ou ses outils)
```

L'app se construit avec `mac/build-app.sh`, et la documentation de l'API locale est dans [docs/api-v2.md](docs/api-v2.md).

## Licence

MIT. Voir [LICENSE](LICENSE).
