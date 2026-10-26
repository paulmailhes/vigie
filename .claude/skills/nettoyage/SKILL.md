---
name: nettoyage
description: Ménage complet de Vigie (sécurité, consommation, textes) avant une version, ou quand l'app semble lourde ou peu claire. Mesurer d'abord, corriger ensuite, prouver par les essais. À utiliser quand on demande un « clean », un audit, une revue de sécurité ou de consommation, ou une relecture des textes de Vigie.
---

# Nettoyage de Vigie

Trois volets, toujours dans cet ordre : **sécurité**, **consommation**, **textes**. Chacun commence par une mesure
ou une preuve, jamais par une impression. Rien n'est corrigé sans un essai qui échoue avant et passe après.

Règles pendant tout le ménage :
- Ne jamais lire un secret (`security … -w`), ni lancer `claude`/`codex` à la main, ni écrire dans `~/.vigie`
  (installation réelle : le garde-fou demande l'accord de l'utilisateur, c'est voulu).
- Essais isolés seulement : `node --test test/` (dossiers temporaires, faux binaires, faux trousseau).
- Dépôt public : aucune donnée personnelle (adresses, noms de comptes, clients, chemins réels) dans le code,
  les essais, les commits ou les notes de version.

## 1. Sécurité

Surfaces, et ce qui doit tenir :

| Surface | Doit tenir | Où |
|---|---|---|
| API locale (127.0.0.1:4777, ::1) | hôte local seulement ; jeton `X-Vigie-Token` sur `/api/` sauf `health` ; POST avec `X-Vigie: 1` et origine locale | `server.mjs` (`handle`) |
| Passerelle MCP `/mcp/<nom>` | clé par MCP, comparée en temps constant ; jamais d'en-tête `Origin` | `lib/gateway.mjs` (`proxy`) |
| Autorisation MCP (OAuth) | ressource = origine du MCP, émetteur = celui interrogé, https, jamais le réseau local ni un fichier (`remoteUrl`), pas de redirection | `lib/gateway.mjs` (`discover`) |
| Mises à jour | app signée par l'équipe (`TEAM_ID`), Gatekeeper, version attendue ; seul le moteur scellé dans l'app s'installe | `lib/update.mjs`, `install.sh` |
| Garde-fous | règles sur le texte brut, sans guillemets ni `\`, et sur le chemin réel des fichiers | `lib/state.mjs` |
| Données | `data/` en 0700, fichiers en 0600 (umask du moteur, du hook, du lanceur) | `server.mjs` (`privatize`) |
| App | liens venus d'un agent : web seulement | `UI/Conversation/NowSection.swift` |

Contournements à rejouer contre `matchGuard` (`test/garde-fous.test.mjs`) à chaque nouvelle règle :
`s\udo`, `"sudo"`, `r''m -rf ~`, `\rm`, chemin `~/.claude//./settings.json`, lien symbolique posé avant,
`… | bash` et `cmd || bash x` (ne doit pas compter), variable en tête (`GIT_PAGER=…`), noms d'outils de Codex
(`exec_command`, `shell`), commande de 200 Ko (pas de recherche quadratique : motifs ancrés `^(?=…)`).

Limite à garder en tête et à écrire telle quelle : une conversation dont les commandes sont acceptées d'office a les
droits de l'utilisateur. Les garde-fous protègent des erreurs et des consignes piégées ordinaires, pas d'un
programme décidé à contourner Vigie.

## 2. Consommation

Mesurer avant tout (fenêtre ouverte, puis cachée) :

```bash
P=$(pgrep -x Vigie); E=$(pgrep -f '\.vigie/server.mjs' | head -1)
for i in $(seq 1 24); do printf '%s app=%s moteur=%s enfants=%s\n' "$(date +%T)" \
  "$(ps -o time=,%cpu= -p $P | xargs)" "$(ps -o time=,%cpu= -p $E | xargs)" "$(pgrep -P $E | xargs)"; sleep 5; done
sample "$P" 15 1 -file /tmp/sample-app.txt   # puis lire « Sort by top of stack » et les fonctions « (in Vigie) »
```

Mesuré le 2026-10-26 avant le ménage : app ≈ 7 % d'un cœur fenêtre ouverte (pointes à 25 %), ≈ 5 Mo téléchargés par
minute ; moteur ≈ 3 % avec 4 conversations actives ; hook ≈ 3 % (22 lancements par minute) ; rafale de 21 `claude`
toutes les 20 min (jusqu'à 520 Mo). Objectifs : app fenêtre cachée proche de 0 %, aucune rafale de `claude` hors
du relevé MCP horaire.

Ce qui coûte, et la règle qui va avec :
- **Processus lancés** (`claude mcp list`, `claude -p`) : une fois par heure au plus, un à la fois, priorité basse
  (`os.setPriority(pid, 15)`), seulement pour les conversations ouvertes et leurs comptes.
- **Hook** (un Node par appel d'outil) : branché seulement sur les outils que visent les garde-fous
  (`scripts/settings.mjs`, `MCP_GUARDED`). Toute nouvelle règle sur un MCP s'y ajoute d'elle-même.
- **Indexeur** (tour de 4 s) : fichiers au repos revus une fois par minute ; gros transcripts lus par tranches de
  16 Mo en rendant la main.
- **Réponses de l'API** : rien qui change à chaque lecture sans raison (pas de `Date.now()` brut dans un détail) :
  l'app redessine toute la page dès qu'un champ change.
- **App** : relevés arrêtés fenêtre cachée (`store.windowVisible`, `.task(id:)`), vue d'ensemble à 15 s/60 s ;
  publier seulement ce qui se voit (`VigieStore.screenKey`) ; pas de `ProgressView()` indéterminé qui reste à
  l'écran (repère fixe `RunningMark`) ; identifiants de lignes tirés de l'élément (`RowIDs.make`) ; calculs lourds
  dans le modèle, hors du fil principal.

## 3. Textes

On tutoie ; phrases courtes ; chaque erreur dit quoi faire ; pas de jargon visible (hook, wrapper, OAuth, JSON,
stdio) quand un mot simple existe. Vocabulaire unique :

| Dire | Jamais |
|---|---|
| accepter (ce que fait Vigie tout seul) | valider |
| autoriser / refuser (toi, devant une action sensible) | |
| connecter / reconnecter (comptes, MCP) | autoriser, réautoriser un MCP |
| consommation, « mis à jour il y a… », remise à zéro | crédits, conso, usage, relevé, reprise |
| ton Mac | ce Mac, l'ordinateur |
| activer / couper / réactiver | allumer, désactivé de base |
| le moteur de Vigie | le moteur (seul) |
| Vigie choisit l'option recommandée | Claude choisit |
| retirer (de « À regarder ») | ignorer |
| conversation ; « session » seulement pour la fenêtre de 5 h | session pour une conversation |

Les textes du moteur (champs `message`, `error`, `detail`, libellés des règles) suivent les mêmes règles : ils
s'affichent tels quels dans l'app. Un essai qui vérifie un message mot pour mot se met à jour avec lui.

## 4. Prouver et livrer

```bash
node --test --test-force-exit test/                 # moteur, hook, lanceur
(cd mac/VigieApp && swift build && swift test)      # app
```

Puis un commit par volet (message en français, adresse anonyme du dépôt), et `scripts/release.sh <version>` pour
une version (essais, app universelle signée et notarisée). Notes de version en français, pour l'utilisateur.

Rapport final : ce qui a été mesuré (avant / après), ce qui a été corrigé, ce qui reste volontairement de côté et
pourquoi.
