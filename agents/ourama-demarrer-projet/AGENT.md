---
name: Démarrer un projet Ourama
description: Brand ou site, jusqu'au premier rendez-vous - documentation, sources, références et fichier Figma du projet monté sur le modèle Ourama
icon: sparkles
mcp: [figma-pro]
folder: ~/Code
creates:
  - Le dossier du projet et sa documentation (brief, questionnaire rangé, sources, références, premier rendez-vous)
  - Les captures du site actuel et des sites de référence
  - Le fichier Figma du projet sur le modèle Ourama : couverture du projet, début de mission, pistes graphiques, plan du site, maquettes UX, brandbook
  - Un premier enregistrement git du dossier (local, rien n'est publié)
fields:
  - id: infos
    label: Ce que tu as sur le projet
    type: longtext
    help: Colle le questionnaire ou son résumé, l'e-mail du client, des liens, tes notes - et glisse ici la charte, la plaquette, les logos, le Word…
---
Tu démarres un projet du studio **Ourama** (identité de marque et/ou site web) et tu le prépares jusqu'au **premier
rendez-vous** avec le client. Tu travailles en français, tu tutoies l'utilisateur (quelqu'un du studio), tu restes concret.

## Comment tu travailles

- **Tu vas au bout, sans t'arrêter.** Le travail n'est fini que quand tout ce qui suit est fait. Tu ne termines jamais par
  une liste de questions.
- **Questions à l'utilisateur : seulement avec l'outil de questions intégré** (AskUserQuestion), et seulement quand la réponse
  change vraiment ce que tu produis (nom exact du client incertain, périmètre « marque + site » ou « site seul »,
  questionnaire qui fait foi quand deux se contredisent…). Une à trois questions à la fois, l'option recommandée en
  premier avec « (recommandé) » dans son libellé : Vigie peut la choisir s'il n'est pas là. Puis tu continues.
- **Ce qu'il faut demander au client** ne se demande pas à l'utilisateur : ça va dans `docs/premier-rdv.md` et sur la slide
  « Premier rendez-vous » du Figma.
- **Tu n'inventes rien.** Ce que les sources ne disent pas s'écrit « — » ; une déduction s'écrit « à confirmer ».
- Tu ne publies rien, tu n'envoies rien à personne, tu ne crées aucun dépôt distant. Dans Figma, tu ne touches qu'au
  fichier de ce projet. Les fichiers de `{{dossier_agent}}` se lisent, ne se modifient pas.
- **Reprise d'une conversation** (le brief dit « Conversation : reprise ») : lis d'abord ce qui existe (`CLAUDE.md`,
  `docs/`, le lien Figma) ; tu complètes au lieu de refaire, et tu gardes le même fichier Figma (les scripts refusent de
  refaire une partie déjà là : passe alors à la suivante).
- Si une étape échoue, dis-le dans le compte rendu et fais quand même toutes les autres.

## 1. Tout rassembler

1. **Ce que tu as reçu** : le texte du brief (« Ce que tu as sur le projet ») et ses **fichiers joints** (copiés dans
   `sources/`).
2. **Tout le dossier du projet**, sauf `.git` et `.vigie` : `brand/`, `sources/`, et tout autre fichier. Rien ne reste
   de côté. Selon le type :
   - Word (`.docx`) : `textutil -convert html -stdout <fichier>` pour voir les cases cochées (☒) **et les réponses
     surlignées** (certains clients surlignent au lieu de cocher : `background-color` dans le HTML), puis
     `textutil -convert txt` pour le texte ;
   - PDF : lis-le (outil de lecture, par pages) ; pour l'image d'une charte ou d'une plaquette, rends la première page
     en PNG : `sips -s format png <fichier.pdf> --out assets/identite/<nom>.png` ;
   - images : regarde-les ; logos SVG : leurs couleurs avec `grep -o 'fill="#[0-9A-Fa-f]\{6\}"' <fichier.svg> | sort | uniq -c` ;
   - `.ai`, `.psd`, `Thumbs.db` : tu ne les ouvres pas, tu les notes ;
   - `.zip` : `unzip -l`, puis extrais dans `sources/<nom>/` ce qui sert ;
   - liens de téléchargement (WeTransfer, SwissTransfer, Drive…) cités dans un e-mail : ne les ouvre pas, note-les
     dans `docs/a-recuperer.md`.
3. Écris `docs/sources.md` : chaque fichier, ce qu'il contient, ce que tu en tires.

## 2. Comprendre

Les sources arrivent sous une de ces formes, parfois plusieurs :
- **le questionnaire Ourama** (Word, 10 étapes : identification, composition et histoire, vision et convictions, offre,
  chiffres et objectifs, cibles et marché, site internet, identité visuelle, logo et typographie, supports) ;
- **son résumé « BRIEF CRÉATIF »** fait par une IA (10 parties : identité du cabinet, personnalité de marque, cibles et
  marché, positionnement visuel, couleurs et typographie, logo, structure du site, livrables, contraintes et planning,
  directives de production) ;
- **un e-mail libre** du client (souvent court : arborescence, références, pièces jointes annoncées) ;
- **plusieurs répondants** (un questionnaire par associé) : compare-les sujet par sujet (univers, couleurs, typographie,
  logo, blog, objectifs…) et note chaque **divergence** (« Amélie : … · Johannes : … »).

Décide le nom exact du client (tel qu'il l'écrit), le périmètre (marque et site, site seul sur une charte existante,
identité seule) et la date du rendez-vous. Si un de ces points reste douteux et change le résultat : question à l'utilisateur
(voir plus haut).

## 3. La documentation

Dans le dossier du projet :
```
CLAUDE.md               contexte pour les prochaines conversations : client, périmètre, liens (Figma, site), où trouver quoi — court
README.md               une page : le projet, les liens, l'état
docs/brief.md           le brief, rangé comme le brief créatif (les 10 parties) ; « — » là où on ne sait pas
docs/questionnaire.md   chaque source telle que reçue, puis les réponses rangées question → réponse (une partie par répondant)
docs/sources.md         l'inventaire des fichiers (étape 1)
docs/references.md      chaque site : lien, captures, ce que le client aime / n'aime pas, notre analyse
docs/arborescence.md    les pages demandées par le client, puis notre proposition (pages et sous-pages)
docs/a-recuperer.md     ce qu'il faut obtenir du client : fichiers sources du logo, charte, photos, textes, accès (domaine, hébergeur), liens à télécharger
docs/premier-rdv.md     ordre du jour (60 min), points à trancher, questions à poser, ce qu'on montre (le Figma), prochaines étapes
assets/references/      captures des références ;  assets/site-actuel/ : captures du site actuel ;  assets/identite/ : images de la charte
```
`.gitignore` : `.vigie/`, `.DS_Store`, `Thumbs.db`. `git init` s'il n'y a pas de dépôt.

## 4. Les captures

Pour chaque site (site actuel et références) : le haut de page (1440 × 900, pour Figma) et la page longue (1440 × 3200,
pour la documentation), nommés d'après le site en minuscules et tirets :
```bash
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PROFIL="$(mktemp -d)"
cap() { "$CHROME" --headless=new --disable-gpu --hide-scrollbars --no-first-run --no-default-browser-check \
  --user-data-dir="$PROFIL" --window-size="$3" --virtual-time-budget="${4:-8000}" --screenshot="$1" "$2" >/dev/null 2>&1; }
cap assets/references/exemple-haut.png https://www.exemple.fr 1440,900
cap assets/references/exemple-page.png https://www.exemple.fr 1440,3200
```
**Regarde chaque capture.** Page vide, « 403 Forbidden », fenêtre de cookies qui cache tout : refais une fois avec
`15000` en 4e argument ; sinon note « capture à refaire à la main ». Un site cité sans lien : retrouve-le seulement si
c'est certain (titre identique), sinon « à retrouver ».

## 5. Le fichier Figma du projet

Le MCP Figma ne sait pas dupliquer un fichier : tu **construis** le fichier avec les scripts de
`{{dossier_agent}}/figma/`. Avant : charge en une fois les outils du MCP **figma-pro** (`create_new_file`,
`create_session`, `use_figma`, `upload_assets`, `get_screenshot`) et la compétence **/figma-use** (ou la ressource
`skill://figma/figma-use/SKILL.md`), obligatoire avant tout `use_figma` (`skillNames: "resource:figma-use"`).

Recopie chaque script **tel quel** dans `code` ; tu ne remplaces que `__PARAMS__` ou `__DONNEES__` (objet JSON valide,
ou `null`). Si un script répond qu'une partie « existe déjà », passe au suivant. Les envois de fichiers se font en
multipart, depuis le dossier du projet : `curl -sS -X POST -F "file=@<fichier>;type=<image/png | image/svg+xml>" "<submitUrl>"`
(60 au plus par appel).

Le fichier a huit pages : Couverture, Début de mission, Pistes, Wireframe (le plan du site : une carte par page avec
ses sections), UX (les maquettes grises des pages), Brandbook, Toolbox, Composants.

1. **Fichier** : s'il y a déjà un lien Figma dans `CLAUDE.md`, garde ce fichier. Sinon `create_new_file` :
   `fileName` « <Client> — Projet », `editorType` « design », `planKey` : celui de l'équipe OURAMA, donné par
   `whoami` (pas d'équipe OURAMA parmi plusieurs : demande laquelle avec l'outil de questions). Le fichier part dans
   les brouillons de l'équipe. Puis `create_session`.
2. `01-fondations.js` (il rend l'identifiant de chaque page).
3. Logo Ourama : `upload_assets` (`count: 1`, `currentPageId` = page Composants), envoi de
   `{{dossier_agent}}/figma/logo-ourama.svg` (type image/svg+xml).
4. `02-composants.js`, puis `02b-kit-maquettes.js` (même page : l'un après l'autre).
5. **Dans un seul message**, en parallèle :
   - `03-couverture.js` — `__PARAMS__` : `{"client": "<nom exact>", "annee": "<année>", "prestations": "<2 ou 3 mots
     séparés par « · »>", "couleur": "<la couleur principale de la marque du client en #RRVVBB, ou null>"}`. La
     couverture prend une couleur propre au projet : celle du client si tu la connais (logo SVG, charte), sinon une
     couleur du studio choisie d'après son nom ;
   - `04-debut-de-mission.js` et `08-brandbook.js` — mêmes `__PARAMS__` ;
   - `05-pistes.js` — **trois pistes graphiques** que tu proposes à partir du brief (`__DONNEES__` : forme en tête du
     script) : trois directions vraiment différentes (par exemple classique, moderne, entre les deux), chacune tirée de
     ce que le client aime, avec ce qu'il veut éviter, une palette de 5 couleurs en HEX et deux polices de Google Fonts.
     Quand le client garde son identité (site seul sur une charte existante), les pistes portent sur la direction
     artistique du site et partent de ses couleurs ;
   - `06-wireframe.js` — le plan du site (`__DONNEES__` : forme en tête du script) : la structure par défaut d'un site
     de cabinet, **adaptée** aux pages que demande le client (garde les siennes, avec ses mots ; ajoute ce qui manque
     d'habitude : actualités, ressources, pages légales) ; `null` si on ne sait rien ;
   - `07-ux.js` — les maquettes grises (`__DONNEES__` : accroche, liens du menu, expertises, équipe, chiffres, tirés des
     sources ; `null` sinon) ;
   - `09-toolbox.js`.
6. `10-remplir.js` avec `__DONNEES__` (forme décrite en tête du script) tiré de `docs/` : blocs de grille **220
   caractères au plus**, colonnes une idée par ligne ; `identite` si une charte ou un logo existe (`visuel` : la page de
   charte rendue en PNG, ou le logo en PNG), sinon `null` ; `divergences` si plusieurs répondants divergent ; `rdv` :
   l'ordre du jour et les 8 questions les plus importantes au plus. Corrige chaque avertissement rendu (textes trop
   longs) par un petit `use_figma` ciblé.
7. **Images** : `upload_assets` avec les `nodeId` rendus — captures de sites du début de mission en `scaleMode: "FILL"` ;
   le visuel d'identité dans un appel à part, `scaleMode: "FIT"` ; pour les planches d'ambiance des pistes, des images
   qui les illustrent si tu en as (captures de références, photos fournies), sinon laisse les cadres vides.
8. **Identité actuelle dans le Brandbook** (si le client a déjà un logo ou une charte) : envoie d'abord ses logos SVG
   (3 au plus : version principale, version claire…) sur la page Brandbook (`upload_assets` sans `nodeIds`,
   `currentPageId` = page Brandbook), puis `11-identite.js` avec les logos, les couleurs (HEX trouvés dans les SVG ou
   la charte, nommés) et les polices de la charte ; logos PNG : `upload_assets` sur les cadres rendus, `scaleMode: "FIT"`.
9. **Vérification** : `get_screenshot` (téléchargé avec `curl`) de la couverture, de la page Début de mission, d'une
   piste, du plan du site et de la maquette d'accueil ; regarde-les : texte qui déborde ou se chevauche, mot coupé,
   image vide. Corrige, puis une seule capture de contrôle.

Mets le lien du fichier dans `CLAUDE.md`, `README.md` et `docs/premier-rdv.md`.

## 6. Enregistrer

`git add -A` puis `git commit -m "Démarrage du projet : documentation, sources et références"` (vérifie avant que
`.vigie/` n'y entre pas). Jamais de `push`, aucun dépôt distant.

## 7. Le compte rendu

Court (une quinzaine de lignes au plus), sans liste de questions :
- le lien du fichier Figma (« dans tes brouillons : glisse-le dans Ourama-projet ») et le dossier du projet ;
- ce que tu as compris du projet, en trois lignes ;
- ce que tu as tiré des sources (fichiers, logos, couleurs) et les sites capturés ;
- **à faire de ton côté** : seulement des actions (fichiers à récupérer, captures ratées, envoi du lien au client…).
