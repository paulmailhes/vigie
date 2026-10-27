# Démarrer un projet Ourama

Brand et premier rendez-vous : à partir du nom du client, du questionnaire et des sites de référence, l'agent crée le
dossier du projet (`~/Code/<client>` : brief, questionnaire rangé, références, préparation du rendez-vous), capture
les sites, puis construit le fichier Figma du projet sur le modèle Ourama et remplit la page « Début de mission ».

- `AGENT.md` : le formulaire (en-tête) et la consigne.
- `figma/*.js` : les scripts qui construisent le modèle dans un fichier Figma neuf (le MCP Figma ne sait pas
  dupliquer un fichier). Pour améliorer le modèle, on modifie ces scripts : chaque nouveau projet en profite.
  - 01 pages (Couverture, Début de mission, Pistes, Wireframe, UX, Brandbook, Toolbox, Composants), couleurs et
    espacements (variables), styles de texte ;
  - 02 composants de la marque Ourama ; 02b kit des maquettes grises et du plan du site ;
  - 03 couverture pleine page, d'une couleur propre au projet (celle du client, sinon une couleur du studio) ;
  - 04 début de mission (calqué sur le questionnaire Ourama), rempli par 10 ;
  - 05 trois pistes graphiques (palette, polices, planche d'ambiance) ;
  - 06 wireframe : le plan du site, une carte par page avec ses sections (structure type d'un site de cabinet) ;
  - 07 UX : les maquettes grises des pages clés (accueil, cabinet, expertise, actualités, article, ressources, contact) ;
  - 08 brandbook ; 09 toolbox (la boîte à outils de la marque du client) ;
  - 10 remplit le début de mission ; 11 pose l'identité actuelle du client dans le Brandbook.
- `figma/logo-ourama.svg` : le logo, envoyé dans Figma avant le script 02.

Police : Hanken Grotesk, la plus proche de Switzer parmi celles que le MCP peut charger. Dans un fichier, « Remplacer
les polices » repasse tout en Switzer d'un coup.
