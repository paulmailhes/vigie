# Le MCP Webflow, point par point (vérifié le 2026-10-27, MCP Webflow 2.2)

Chaque appel porte `session_id`, `agent_id`, `context` et `actions[]` (un `label` par action).
« À la main » : ce que l'utilisateur fait dans Webflow ; mets-le dans « À faire dans Webflow », avec le chemin.

## Règles

- **Designer fermé** : les outils `data_*` répondent (éléments compris) ; `designer_tool` et `element_snapshot_tool`
  échouent (« Unable to connect to Webflow Designer ») : ne t'en sers pas.
- **Offre du site** : un 403 ou « does not have an Enterprise hosting plan » / « entitlement required » est définitif
  pour ce site. Le point passe en « À la main » (ou « non vérifié »), sans réessayer.
- `get_site_scripts` / `get_page_scripts` en 404 « Custom code block not found » : aucun script, pas une panne.
- **Jamais** : `publish_site`, `publish_collection_items`, `unpublish_collection_items`, `publish_branch`,
  `merge_branch`, `stage_site_branch`, `compress_assets` (remplace les fichiers sans garder l'original), les `delete_*`,
  `set_site_scripts`, les `clear_*`.
- `set_site_freeform_code` et `set_page_freeform_code` **remplacent tout le bloc** : relis-le, fusionne, puis écris
  le tout ; seulement pour une correction acceptée.
- Les écritures du CMS et du sitemap restent **en attente jusqu'à la publication** (que fait l'utilisateur).

## Domaine et publication — `data_sites_tool`

| Point | Lire | Corriger |
|---|---|---|
| Domaines | `get_site` → `customDomains` (vide : seulement le sous-domaine webflow.io) | À la main : Site settings › Publishing › domaines |
| Domaine par défaut, HTTPS, www | Pas exposés : curl (voir `verifications-en-ligne.md`) | À la main : Site settings › Publishing |
| Changements non publiés | `get_site` : `lastUpdated` plus récent que `lastPublished` = le Designer est en avance sur le site en ligne | — (le dire dans le rapport) |
| Fuseau, langue | `timeZone`, `locales.primary.tag` | À la main : Site settings › General / Localization |
| Google Analytics | `googleTagIds`, `dataCollectionEnabled` | À la main : Site settings › Apps & integrations |
| Favicon, webclip | Pas exposés : curl | À la main : Site settings › General |

## SEO et partage — `data_pages_tool`

| Point | Lire | Corriger |
|---|---|---|
| Pages | `list_pages` (avec `publishedPath`, la page modèle CMS, 404 et Password ; sans les dossiers) | — |
| Titre, description | `seo.title`, `seo.description` | `update_page_settings {page_id, seo:{title, description}}`, ou `bulk_update_pages` (100 pages au plus) |
| Slug | `slug` (absent pour l'accueil) | `update_page_settings {slug}` — **ne crée aucune redirection** : seulement sur une page jamais publiée |
| Open Graph | `openGraph {title, description, titleCopied, descriptionCopied, imageUrl, imageAssetId}` | mêmes actions (`imageAssetId` ou `imageUrl`, pas les deux) |
| Brouillon | `draft`, `archived` | `draft` : `update_page_settings {draft}` ; archiver : à la main |
| Canonical | Pas exposée : curl | À la main : Site settings › SEO › Global canonical URL |
| Sitemap (par page) | `data_sitemap_tool` › `list_pages_sitemap_status` (`includeInSitemap`) — souvent 403 selon l'offre | `update_page_sitemap_status` si l'offre le permet ; sinon à la main : Page settings › SEO › Sitemap indexing |
| robots.txt, redirections 301 | `data_enterprise_tool` (`get_robots_txt`, `list_301_redirects`) : Enterprise seulement | Enterprise : `create_301_redirect` ; sinon à la main : Site settings › SEO (robots.txt) et Site settings › Publishing › 301 redirects |
| Mot de passe | Pas exposé : curl (401 ou redirection vers /401) | À la main |

## Pages modèles du CMS

| Point | Lire | Corriger |
|---|---|---|
| SEO lié aux champs | `get_page_metadata` de la page qui porte `collectionId` : un champ lié s'écrit `{{wf {"path":"name",…} }}` ; un texte fixe = le même pour toutes les fiches | **À la main** : Page settings de la page modèle › SEO › « + Add field » (l'écriture d'une liaison n'est pas sûre par le MCP) |
| Fiches | `data_cms_tool` › `get_collection_details` (champs), `list_collection_items` (`fieldData`, `isDraft`) | `update_collection_items` (en attente de publication) |

## Titres — `data_element_tool`

| Point | Lire | Corriger |
|---|---|---|
| Titres d'une page | `query_elements {siteId, pageId, queries:[{element_filter:{type:"Heading"}}]}` → `settings.tag`, `headingLevel` ; texte : `children_depth: 1` (enfant `String`, `textContent`) | `set_heading_level {id, heading_level}` ; texte : `set_text` |
| **Composants** | La requête d'une page **ne descend pas dans les composants** (un H1 dans un composant « Titre » n'y apparaît pas) : relis-les avec `scope_component_id` | Modifier un composant change **toutes ses instances** : dis-le dans la proposition |
| La vérité | Le nombre de H1 se compte sur la page publiée (curl) | — |

## Liens — `data_element_tool`

| Point | Lire | Corriger |
|---|---|---|
| Liens d'éléments | `query_elements` types `Link`, `Button`, `LinkBlock` → `settings.link {linkType, href}` (le rendu fait foi si ça diverge) | `set_link {id, linkType: url / file / page / element / email / phone, link}` (Button, TextLink, LinkBlock) |
| Liens dans les composants | `ComponentInstance` → `instanceDetails.props[].value` (`{mode:"page", to:{pageId}}`, url…) | `data_component_props_tool` : à n'utiliser que si le schéma le permet clairement ; sinon à la main |
| Page visée supprimée | comparer les `pageId` visés à `list_pages` | `set_link` vers la bonne page |
| **Liens vers une fiche CMS** (cartes, boutons d'une liste) | — | **À la main** : Designer › élément › Link settings › Current Collection item (`set_link` n'a pas de type CMS) |
| Champs Lien du CMS | `list_collection_items` | `update_collection_items` |

## Images — `data_assets_tool`, `data_element_tool`

| Point | Lire | Corriger |
|---|---|---|
| Alt d'un asset | `list_assets` / `get_asset` → `altText` | `update_asset {asset_id, alt_text}` (`null` = décorative) |
| Alt d'un élément image | `query_elements` type `Image` → `altText` (`inherit` = repris de l'asset ou du CMS) | corrige l'asset de préférence |
| Alt d'une image CMS | `fieldData.<champ>.alt` | `update_collection_items` (à vérifier en relisant) |
| Poids | `size`, `contentType` | **À la main** (ou avec l'accord exprès de l'utilisateur : `compress_assets`, destructif) |

## Données structurées — `data_pages_tool`, `data_scripts_tool`

| Point | Lire | Corriger |
|---|---|---|
| JSON-LD d'une page | `query_pages_schema_markup {site_id, pages:[{id}]}` → `jsonLdSchema`, `isInherited` | `bulk_update_pages_schema_markup` (25 pages au plus ; objet, ou chaîne avec ou sans `<script>`) |
| Code du site / d'une page | `get_site_freeform_code`, `get_page_freeform_code` (head, footer) | `set_*_freeform_code` : remplacement complet, voir les règles |
| Pages modèles du CMS | inconnu | À la main : Page settings › Custom code, avec des champs du CMS |

## Formulaires — `data_forms_tool`

| Point | Lire | Corriger |
|---|---|---|
| Formulaires | `list_forms` / `get_form` → `fields`, `pageId`, `responseSettings` | — |
| Destinataires des notifications | pas exposés | **À la main** : Site settings › Forms |
| Message de réussite, redirection | élément de la page / `responseSettings` | À la main : Designer › réglages du formulaire |

## Ce qui n'existe pas

Aucun outil ne fait un audit SEO ou de liens tout fait (`data_aeo_tool`, `data_analyze_tool`, `data_optimize_tool`
parlent d'audience et de tests A/B, souvent hors offre).
