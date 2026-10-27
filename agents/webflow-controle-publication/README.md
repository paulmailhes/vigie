# Contrôler un site Webflow avant publication

Analyse un site Webflow par le MCP Webflow (le site dans Webflow, publié ou non) et sur sa version en ligne (curl),
selon la grille du studio ; écrit un rapport dans le dossier du projet, corrige avec l'accord de l'utilisateur ce que
le MCP sait corriger (jamais de publication), et liste pas à pas ce qui reste à faire dans Webflow.

- `AGENT.md` : le formulaire (site, ce qu'il faut contrôler, précisions) et la consigne.
- `grille.md` : ce qu'on attend, partie par partie, et la gravité d'un écart (bloquant, à corriger, conseil).
- `webflow-mcp.md` : ce que le MCP Webflow lit et corrige, point par point, et ce qui reste à la main (vérifié le
  2026-10-27 : domaine, HTTPS, canonical, redirections 301 hors Enterprise, liens vers les fiches CMS, SEO des pages
  modèles et destinataires des formulaires ne passent pas par le MCP).
- `verifications-en-ligne.md` : les commandes curl (zsh de macOS) sur le site publié.

Le MCP et son espace de travail se choisissent dans le formulaire de Vigie (bloc « Outils ») ; le brief les nomme.
