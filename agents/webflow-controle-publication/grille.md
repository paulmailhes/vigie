# Grille de contrôle avant publication

Chaque point : ce qu'on attend, et la gravité d'un écart.
- **Bloquant** : ne pas publier tant que ce n'est pas réglé.
- **À corriger** : à régler avant la mise en ligne si possible.
- **Conseil** : améliore le site, ne bloque rien.

## 1. Domaine et publication

| Point | Attendu | Gravité |
|---|---|---|
| Offre d'hébergement | Une offre de site (CMS ou Business) : sans elle, ni domaine, ni sitemap, ni 301, ni langues, et 50 envois de formulaire en tout. Signes : « Add CMS or Business Hosting » sur la recherche, réglages du sitemap refusés, `sitemap.xml` en 404 | Bloquant |
| Domaine personnalisé | Le domaine du client est branché, et un domaine est choisi par défaut (avec ou sans www) | Bloquant |
| HTTPS | `http://` redirige en 301 vers `https://`, certificat valide | Bloquant |
| www / sans www | L'un redirige en 301 vers l'autre, jamais deux versions qui répondent 200 | Bloquant |
| Sous-domaine webflow.io | Exclu de l'indexation une fois le domaine branché | À corriger |
| Pages brouillon | Aucune page utile laissée en brouillon ; aucune page d'essai publiée | À corriger |
| Page 404 | Personnalisée, avec un lien vers l'accueil | À corriger |
| Mot de passe | Aucune protection oubliée sur le site ou une page | Bloquant |
| Favicon et webclip | Favicon 32 × 32 et webclip 256 × 256 posés | À corriger |
| Fuseau horaire | Celui du client (Europe/Paris) : il date les articles du CMS et les envois de formulaire | À corriger |
| E-commerce du modèle | Pas de pages /checkout, /product/… ni de produits de démonstration publiés (modèles achetés) | Bloquant |
| Redirections 301 | Anciennes adresses importantes (ancien site) redirigées vers les nouvelles | À corriger |

## 2. SEO et partage (chaque page, et chaque modèle de page CMS)

| Point | Attendu | Gravité |
|---|---|---|
| Titre SEO | Présent, unique, 30 à 60 caractères, le sujet de la page puis le nom du cabinet | À corriger |
| Méta description | Présente, unique, 70 à 160 caractères, donne envie de cliquer | À corriger |
| Slug | Court, en minuscules, avec des tirets, sans accent ni mot vide inutile | Conseil |
| Open Graph | Titre, description et image (1200 × 630) ; à défaut, ceux du SEO | À corriger |
| Pages CMS | Titre et description liés à des champs de la collection (pas le même texte sur tous les articles) | À corriger |
| Canonical | URL canonique du site = le domaine choisi par défaut | À corriger |
| Indexation | Les pages utiles sont indexables ; les pages techniques (merci, recherche, 401, styleguide) et les outils internes (générateur de signature, carte de visite…) exclus ou en noindex | À corriger |
| sitemap.xml | Généré automatiquement, accessible, sans page exclue ni brouillon | À corriger |
| robots.txt | Ne bloque pas le site (pas de `Disallow: /` oublié), indique le sitemap | Bloquant si tout est bloqué |
| Langue | Attribut `lang` du site juste (`fr`) | À corriger |

## 3. Titres et contenus

| Point | Attendu | Gravité |
|---|---|---|
| H1 | Un et un seul H1 par page (modèles CMS compris), qui dit le sujet de la page | À corriger |
| Ordre des titres | H2 sous H1, H3 sous H2 : pas de niveau sauté pour la mise en forme | Conseil |
| Titres vides | Aucun titre vide ou réduit à un espace | À corriger |
| Textes provisoires | Aucun « Lorem ipsum », « Heading », « This is some text… », « Titre ici » | Bloquant |
| Mentions | Mentions légales et politique de confidentialité présentes et liées depuis le pied de page | Bloquant |

## 4. Liens

| Point | Attendu | Gravité |
|---|---|---|
| Liens cassés | Aucun lien interne qui mène à une 404 | Bloquant |
| Liens vides | Aucun bouton ou lien vers `#` ou sans destination, sauf ancre voulue | À corriger |
| Liens CMS | Les cartes et boutons des listes CMS mènent bien à leur page (liés à l'élément courant) | Bloquant |
| webflow.io | Aucun lien en dur vers le sous-domaine webflow.io | À corriger |
| http:// | Aucun lien en `http://` vers le site lui-même | À corriger |
| Liens externes | Répondent ; s'ouvrent dans un nouvel onglet si c'est le choix du site | Conseil |
| Téléphone et e-mail | `tel:` et `mailto:` justes | À corriger |

## 5. Images

| Point | Attendu | Gravité |
|---|---|---|
| Texte alternatif | Chaque image qui porte un sens a un alt qui la décrit ; décoratives : alt vide assumé | À corriger |
| Poids | Pas d'image de plus de 500 Ko ; formats WebP/AVIF quand c'est possible | Conseil |
| Taille | Pas d'image bien plus grande que son affichage | Conseil |

## 6. Données structurées (JSON-LD)

| Point | Attendu | Gravité |
|---|---|---|
| Présence | Au moins `Organization` (ou `LegalService` pour un cabinet d'avocats) sur l'accueil : nom, url, logo, adresse, téléphone, `sameAs` | À corriger |
| Pages | `BreadcrumbList` sur les pages profondes ; `Article` sur les articles ; `FAQPage` seulement si une vraie FAQ est visible | Conseil |
| Validité | JSON valide, sans champ vide ni valeur de démonstration | Bloquant si le JSON est cassé |
| Cohérence | Nom, adresse et téléphone identiques au site et à la fiche Google | À corriger |

## 7. CMS

| Point | Attendu | Gravité |
|---|---|---|
| Éléments de démonstration | Aucun article ou fiche d'exemple publié | Bloquant |
| Champs obligatoires | Remplis sur les éléments publiés (image, résumé, auteur…) | À corriger |
| Slugs | Propres et uniques | Conseil |
| Pages modèles | SEO lié aux champs (voir 2) ; H1 lié au nom de l'élément | À corriger |

## 8. Formulaires

| Point | Attendu | Gravité |
|---|---|---|
| Destinataires | Les notifications partent vers l'adresse du client, pas vers celle du studio | Bloquant |
| Messages | Message de réussite et d'erreur en français | À corriger |
| Consentement | Case ou mention RGPD et lien vers la politique de confidentialité | À corriger |
| Anti-spam | reCAPTCHA ou protection équivalente si le formulaire est public | Conseil |

## 9. Accessibilité (le minimum)

| Point | Attendu | Gravité |
|---|---|---|
| Boutons | Un texte ou un `aria-label` sur chaque bouton ou lien à icône | À corriger |
| Contraste | Texte lisible sur son fond | Conseil |
| Champs | Chaque champ de formulaire a un libellé | À corriger |
