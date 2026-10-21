# Vigie

**Vigie veille sur Claude Code (et Codex) pendant que tu travailles… ou pendant que tu dors.**

Tu lances Claude Code pour plusieurs heures, et tu reviens pour trouver une fenêtre « Autoriser ? » qui attend depuis le début ? Vigie s'en charge à ta place. Les demandes sans risque sont validées toutes seules, et les actions sensibles t'attendent toujours. Tu suis tout dans une petite app Mac : tes conversations, ta consommation, tes comptes et tes MCP.

> **Bêta.** Vigie est en test. Il marche au quotidien, mais attends-toi à quelques angles encore à arrondir. Les retours sont les bienvenus (onglet *Issues*).

![Vue d'ensemble](docs/images/vue-ensemble.png)

## Ce que fait Vigie

- **Il valide pour toi** les demandes d'autorisation de Claude Code (commandes, fichiers, outils, MCP), dans toutes tes conversations, y compris celles déjà ouvertes.
- **Il garde pour toi les actions sensibles** : `sudo`, suppression de dossiers importants, `git push --force`, effacement de disque, paiements, envoi d'e-mails, publications, réglages de Claude Code ou du shell. Elle s'affiche à la fois dans ta conversation (la fenêtre habituelle de Claude Code) et dans Vigie : tu réponds où tu veux, l'autre se ferme.
- **Il répond aux questions quand tu n'es pas là**, si tu le veux. Après un délai, Claude prend l'option recommandée, et tu relis son choix ensuite (« Ça me va » ou « Changer »).
- **Il te montre où en est chaque conversation** : ta demande, son message en direct, sa feuille de route, le fil de ce qu'elle a fait (commits, déploiements, tests, agents).
- **Il suit ta consommation** par compte et par conversation : session de 5 h, semaine, et l'heure exacte de remise à zéro.
- **Il gère plusieurs comptes Claude** : ils restent connectés en même temps, et tu choisis le compte de chaque conversation.
- **Il gère tes MCP**, avec leur état sur chaque compte et un bouton « Connecter » qui ouvre directement la page d'autorisation.

Tout se passe sur ton Mac : Vigie n'envoie tes conversations nulle part.

## Installation

Il te faut :

- un Mac avec **macOS 26** (Tahoe) ou plus récent, Apple Silicon ou Intel ;
- **Node.js 20** ou plus récent : s'il n'est pas sur ton Mac, l'installation pose sa propre copie (version officielle, vérifiée) dans `~/.vigie/node`, sans toucher au reste ;
- **Claude Code**, dans VS Code ou dans le terminal.

Puis, dans le Terminal :

```bash
curl -fsSL https://raw.githubusercontent.com/paulmailhes/vigie/main/install.sh | bash
```

L'app s'ouvre sur un court accueil :

1. ce que fait Vigie ;
2. les actions sensibles, qui restent à toi ;
3. tes comptes IA : Claude (à ajouter et connecter en un clic) et Codex ;
4. tes MCP ;
5. l'auto-accept et les notifications.

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

Trois familles : **MCP de ce Mac** (dans toutes tes conversations), **MCP des projets** (fichier `.mcp.json` d'un dossier) et **MCP du compte** (branchés à ton compte sur claude.ai, coupés ou activés par défaut dans les nouvelles conversations).

Chaque MCP tient sur une ligne : « ✓ Tous tes comptes » quand il marche partout, sinon seuls les comptes à régler apparaissent, avec leur bouton (**Connecter**, **Ajouter**, **échec**). « Partout » le connecte sur tous tes comptes, l'un après l'autre. Chaque compte Claude garde sa propre autorisation : il faut connecter un MCP une fois par compte.

La **bibliothèque** (bouton « + ») propose les serveurs officiels des éditeurs (Notion, Figma, GitHub, Linear, Stripe…) : tu coches tes comptes, Vigie l'ajoute puis ouvre la page d'autorisation.

## Codex (OpenAI)

Vigie suit aussi tes conversations **Codex** (l'extension VS Code d'OpenAI), dans la même liste, avec une pastille « Codex ». Pour chacune, tu vois :

- ta demande et son message en direct ;
- son plan et ses commits ;
- ses agents ;
- sa consommation : la semaine de ton compte ChatGPT et l'heure de remise à zéro.

L'auto-accept marche aussi pour Codex : Vigie branche son hook dans `~/.codex/hooks.json`. Les demandes d'autorisation sont acceptées, et les actions sensibles t'attendent dans Vigie, comme pour Claude.

**Une étape à faire une fois :** Codex demande de faire confiance à un nouveau hook. Dans le Terminal, lance `codex`, tape `/hooks` et accepte celui de Vigie.

Une conversation ne peut pas passer de Claude à Codex : leurs historiques sont incompatibles.

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
