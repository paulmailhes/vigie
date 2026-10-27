# Vérifications sur le site publié (curl, zsh de macOS, rien à installer)

Le site en ligne montre la **dernière publication** : si le Designer est en avance (`lastUpdated` > `lastPublished`),
dis-le dans le rapport. Contrôle le **domaine du client** quand il est branché ; sinon le sous-domaine webflow.io (un
`robots.txt` « Disallow: / » y est normal : Webflow cache le sous-domaine aux moteurs, ce n'est pas un défaut).
Range les fichiers de travail dans le dossier du projet, sous `.vigie/controle/` (hors git).

```zsh
S=https://www.exemple.fr        # l'adresse publiée à contrôler, sans / final
D=.vigie/controle && mkdir -p $D
```

## Domaine, HTTPS, www

```zsh
curl -sI "$S/" | grep -iE '^(HTTP|location|strict-transport|x-robots-tag|content-type)'
for u in http://exemple.fr/ http://www.exemple.fr/ https://exemple.fr/ https://www.exemple.fr/; do
  printf '%s ' "$u"; curl -s -o /dev/null -w '%{http_code} -> %{redirect_url}\n' "$u"; done
curl -s -o /dev/null -w '%{http_code}\n' "$S/zz-inexistant-$RANDOM"     # 404 attendu
```
Attendu : une seule adresse répond 200, les autres redirigent en 301 vers elle, en https.

## robots.txt et sitemap

```zsh
curl -s "$S/robots.txt"
curl -s "$S/sitemap.xml" > $D/sitemap.xml
grep -o '<loc>https://[^/<]*' $D/sitemap.xml | sort -u          # les <loc> doivent viser l'hôte de $S
grep -o '<loc>[^<]*' $D/sitemap.xml | sed -e 's/<loc>//' -e "s#https://[^/]*#$S#" > $D/pages.txt
wc -l < $D/pages.txt
```

## Chaque page : H1, JSON-LD, langue, canonical, robots, titre et description

```zsh
for u in ${(f)"$(<$D/pages.txt)"}; do h=$(curl -s "$u")
 printf '%s | h1=%s | ld=%s | %s | canon=%s | robots=%s\n' "${u#$S}" \
  "$(print -r -- "$h" | grep -oi '<h1[ >]' | wc -l | tr -d ' ')" \
  "$(print -r -- "$h" | grep -o '<script[^>]*application/ld+json' | wc -l | tr -d ' ')" \
  "$(print -r -- "$h" | grep -o '<html[^>]*' | grep -o 'lang="[^"]*"')" \
  "$(print -r -- "$h" | grep -o '<link href="[^"]*" rel="canonical"' | cut -d'"' -f2)" \
  "$(print -r -- "$h" | grep -oi '<meta[^>]*name="robots"[^>]*>' | grep -o 'content="[^"]*"')"
 print -r -- "$h" | grep -o '<title>[^<]*' | head -1
done > $D/pages-controle.txt
```

## Liens de toutes les pages

```zsh
for u in ${(f)"$(<$D/pages.txt)"}; do
  curl -s "$u" | grep -oE 'href="[^"]*"' | cut -d'"' -f2 | awk -v p="$u" '{print p, $0}'; done > $D/liens.txt
awk '$2=="" || $2=="#"{print $1}' $D/liens.txt | sort | uniq -c                    # liens vides ou « # »
awk '$2 ~ /^http:\/\// || $2 ~ /webflow\.io/' $D/liens.txt | sort -u                 # http:// ou webflow.io
awk '$2 ~ /^\//{print $2}' $D/liens.txt | sed 's/#.*//' | sort -u | while read p; do
  c=$(curl -s -o /dev/null -w '%{http_code}' "$S$p"); [ "$c" != 200 ] && echo "$c $p"; done   # liens internes cassés
awk '$2 ~ /^https?:\/\// && $2 !~ /webflow\.io/{print $2}' $D/liens.txt | sort -u | head -80 | while read x; do
  c=$(curl -s -o /dev/null -L --max-time 10 -w '%{http_code}' "$x"); [ "$c" -ge 400 ] && echo "$c $x"; done  # externes
```
Pour retrouver la page d'un lien cassé : `grep ' /chemin-casse$' $D/liens.txt`. Les pages exclues du sitemap ne sont
pas parcourues : ajoute-les à `$D/pages.txt` (chemins de `list_pages`).

## Images : alt et poids

```zsh
for u in ${(f)"$(<$D/pages.txt)"}; do n=$(curl -s "$u" | grep -oE '<img [^>]*>' | grep -vE 'alt="[^"]+"' | wc -l | tr -d ' ')
  [ "$n" -gt 0 ] && echo "$n ${u#$S}"; done                                      # images sans alt (ou alt vide)
curl -s "$S/" | grep -oE '<img [^>]*src="[^"]*"' | grep -oE 'src="[^"]*"' | cut -d'"' -f2 | sort -u |
  while read i; do echo "$(curl -sI "$i" | awk 'tolower($1)=="content-length:"{print $2}' | tr -d '\r') $i"; done | sort -rn | head
```
Une image décorative peut avoir un alt vide : ne la compte comme défaut que si elle porte un sens.

## Données structurées

```zsh
curl -s "$S/" | tr '\n' ' ' | grep -o '<script[^>]*application/ld+json[^>]*>[^<]*</script>' \
  | sed -e 's/<script[^>]*>//' -e 's#</script>##' > $D/ld.txt                # un bloc par ligne
n=0; while IFS= read -r l; do n=$((n+1)); print -r -- "$l" > $D/ld-$n.json
  plutil -convert json -o /dev/null $D/ld-$n.json 2>/dev/null && echo "bloc $n valide" || echo "bloc $n INVALIDE"; done < $D/ld.txt
```
Seul `plutil -convert json` valide du JSON (`plutil -lint` refuse du JSON valide). Lis ensuite chaque bloc : type,
nom, adresse, téléphone, champs vides ou de démonstration. Même chose sur les autres pages (articles, expertises).
