# CLAUDE.md (@shopimind/integration-kit-js)

Guide pour les assistants IA et les équipes ShopiMind travaillant dans ce dépôt.
Ce fichier est versionné dans git mais **n'est pas publié sur npm** (`package.json` → `"files": ["dist"]`).

## Ce qu'est ce dépôt
`@shopimind/integration-kit-js` : la fondation publique des intégrations ShopiMind, publiée sur npm.
Les intégrations se bâtissent dessus. Le kit fournit toute l'infrastructure (webhooks sécurisés, synchro à
curseur sûr, persistance SQLite avec **secrets chiffrés au repos**, ré-export du SDK ShopiMind, provisioning
idempotent, serveur HTTP, déclaration de widgets). Une intégration n'écrit que des fonctions pures + des
déclarations ; elle ne réimplémente jamais l'infra.

## Écosystème
- `@shopimind/sdk-js` : SDK bas niveau pour dialoguer avec l'API ShopiMind (paquet séparé, dépendance ré-exportée).
- `@shopimind/integration-kit-js` (CE dépôt) : la fondation des intégrations (kit JS ; des kits php/go suivront).
- Une intégration se bâtit sur le kit, qu'elle consomme via la version publiée `@shopimind/integration-kit-js@^x.y.z`.

## Stack & commandes
- TypeScript **strict**, ESM (`NodeNext`), Node 18+. Gestionnaire de paquets : **yarn**.
- `yarn build` (tsc -b) · `yarn test` (vitest, fichiers `src/**/*.test.ts`) · `yarn clean`.
- Toujours **build + test verts** avant de pousser.

## Langue
- **Messages de commit** : en **anglais**.
- **Commentaires de code** (et identifiants) : en **anglais**.
- **`README.md`** : en **anglais** (orienté utilisateur du paquet, public international).

## Branches & flux de travail (PAS de git-flow)
- Une seule branche longue : **`main`** (toujours verte et publiable).
- Développer sur des branches courtes : `feat/...`, `fix/...`, `chore/...` → **Pull Request** → merge dans `main`.
- Les **versions** sont marquées par des **tags / Releases `vX.Y.Z`**, pas par une branche `master`.
- Pas de branches `develop` / `release/*` / `hotfix/*`.

## Versionner & publier (npm)
- `.github/workflows/ci.yml` → sur **push** : build + test (ne publie pas).
- `.github/workflows/publish.yml` → sur **Release publiée** : publication npm **via OIDC (sans token)**.
- Pour publier une version :
  1. changements mergés dans `main` ;
  2. bump `version` dans `package.json` (**semver** : patch = correction, minor = ajout compatible, major = cassant) ;
  3. commit `chore(release): vX.Y.Z` + push ;
  4. créer une **Release GitHub `vX.Y.Z`** → la publication npm est automatique.
- Ne pas publier à la main ; toujours passer par la Release. Le workflow saute la publication si la version existe déjà.

## Contenu publié sur npm
- `"files": ["dist"]` → seul `dist/` est publié (+ `package.json`, `README.md`, `LICENSE`).
- `CLAUDE.md`, docs de dev, `src/`, `.github/`, tests, configs → **restent dans git, hors paquet npm**.
- Vérifier le contenu du paquet : `npm pack --dry-run`.
- Le `README.md` est **orienté intégrateur** (utilisateur du paquet) : n'y mettre **aucun** détail interne
  (microservices, stratégie de dépôts, sections mainteneur…).

## Repères d'architecture (src/)
- `integration/` : le contrat `Integration<S>` + `defineIntegration`.
- `contracts/` : les types partagés (config, widgets, SDK, lifecycle).
- `sync/` : moteur à curseur (avance **seulement si `errors === 0`**), pagination streaming, concurrence bornée.
- `security/` : signature HMAC (corps brut, timing-safe, anti-rejeu), crypto AES-256-GCM, redaction.
- `store/` regroupe la persistance, un **PORT async** (`port.ts` : `IntegrationStore`, 9 stores + migrate/ping/close)
  avec deux adapters officiels : `store/sqlite/` (défaut, better-sqlite3) et `store/postgres/` (pg, schéma dédié
  configurable dans la base de l'intégrateur). `repositories.ts` = les FAÇADES kit au-dessus du port (async) :
  clamps de pagination, conversions jours→cutoffs ISO, sérialisation défensive, et **chiffrement des secrets**
  (`state.setSecret`, AES-256-GCM + AAD). Un adapter ne voit jamais un secret en clair. Timestamps générés côté
  JS (ISO UTC, `time.ts`), jamais par le SQL ; parsing tolérant aux lignes legacy v1 (`parseStoreTimestamp`).
  Migrations versionnées append-only PAR DIALECTE (sqlite v1..v8 historiques + v9 qui normalise une fois
  les timestamps écrits par la v1 via `datetime('now')`, sans quoi les deux formats se comparent mal
  (`' '` < `'T'`) et une purge de rétention supprimerait jusqu'à 24 h de journaux hérités en avance ;
  postgres v1 consolidée).
  La suite de conformité (`testing/store-conformance.ts`, export `./store-testing`) est le contrat exécutable du
  port. Les deux adapters la passent en CI (PG réel via service docker, `TEST_POSTGRES_URL`) ; un store tiers
  doit la passer aussi. Politique semver du port : extensions possibles en minor, retraits en major uniquement.
  Drivers en **peer deps optionnelles** (`better-sqlite3`, `pg`) chargés dynamiquement : une intégration installe
  le sien. **Seuls les secrets sont chiffrés** au repos ; les PII et l'état non-secret sont en clair, le fichier
  SQLite / la base PG ne sont pas chiffrés par le kit.
- `sdk/` fournit les helpers `withSource` (→ `SourceHandle`), `customData` (→ `CustomDataHandle`) et
  `sendBulk` (push sûr : chunké, throw sur transport, remonte les rejets) ; le client SDK provient
  de `@shopimind/sdk-js`, dépendance directe **ré-exportée** par le kit (`export * from '@shopimind/sdk-js'`).
  Plus de gateway/adaptateur : l'intégration tape le SDK directement via `ctx.spm` (un `SpmHttpClient`).
- `provisioning/` : find-or-create idempotent (sources de données, custom data + relations, events).
  Relations custom→custom : la cible peut être désignée par NOM (déf sœur), résolue en id à la création.
- `lifecycle/`, `http/`, `runtime/` : dispatcher de cycle de vie, serveur Hapi, assemblage (`createIntegrationApp`).
- **Surface admin & UI d'exploitation** (100 % côté intégrateur, ne lit que le SQLite local) :
  - `http/admin-auth.ts` (comparaison timing-safe du jeton), `http/admin-session.ts` (session
    navigateur : cookie HttpOnly `SameSite=Strict` + CSRF, TTL glissant, cap LRU),
    `http/admin-routes.ts` (routes `/admin/*` : lecture paginée, actions auditées, `/admin/ui`).
  - `runtime/admin-data.ts` (provider lecture → DTO, **masque la PII**, ne matérialise jamais un
    secret), `runtime/admin-actions.ts` (purge/reveal/reprovision + écriture audit),
    `security/pii-mask.ts` (masquage e-mail/téléphone/nom/adresse).
  - `admin-ui/ui.html` = UI vanilla autonome (aucune dépendance) **embarquée** dans
    `http/admin-ui.generated.ts` par `scripts/embed-admin-ui.mjs` (hooks `prebuild`/`pretest`) ;
    servie avec une CSP à nonce par requête. Régénérer via `yarn embed:ui` après toute édition du HTML.
  - Options `createIntegrationApp` : `adminToken`, `adminPort`/`adminHost` (listener séparé, loopback
    par défaut), `adminSecureCookie`, `rejectedRetentionDays`, `auditRetentionDays`.

## Identité git
- Org GitHub : `shopimind`. Committer/pousser avec le compte **pro** du mainteneur (pas un compte perso).
- Vérifier `git config user.email` avant de committer (un IDE peut injecter une autre identité).

## Règles
- Garder le `README.md` strictement orienté utilisateur final.
- Respecter le TypeScript strict (pas de `any` opportuniste).
- Tout changement qui touche le contrat public du kit = bump de version approprié (semver).
