# CLAUDE.md — @shopimind/integration-kit-js

Guide pour les assistants IA et les équipes ShopiMind travaillant dans ce dépôt.
Ce fichier est versionné dans git mais **n'est pas publié sur npm** (`package.json` → `"files": ["dist"]`).

## Ce qu'est ce dépôt
`@shopimind/integration-kit-js` : la fondation publique des intégrations ShopiMind, publiée sur npm.
Les intégrations se bâtissent dessus. Le kit fournit toute l'infrastructure (webhooks sécurisés, synchro à
curseur sûr, persistance SQLite avec **secrets chiffrés au repos**, ré-export du SDK ShopiMind, provisioning
idempotent, serveur HTTP, déclaration de widgets). Une intégration n'écrit que des fonctions pures + des
déclarations — elle ne réimplémente jamais l'infra.

## Écosystème
- `@shopimind/sdk-js` — SDK bas niveau pour dialoguer avec l'API ShopiMind (paquet séparé, dépendance ré-exportée).
- `@shopimind/integration-kit-js` — CE dépôt : la fondation des intégrations (kit JS ; des kits php/go suivront).
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
- `integration/` — le contrat `Integration<S>` + `defineIntegration`.
- `contracts/` — les types partagés (config, widgets, SDK, lifecycle).
- `sync/` — moteur à curseur (avance **seulement si `errors === 0`**), pagination streaming, concurrence bornée.
- `security/` — signature HMAC (corps brut, timing-safe, anti-rejeu), crypto AES-256-GCM, redaction.
- `store/` — SQLite + migrations versionnées (append-only) + repositories typés. **Seuls les secrets sont
  chiffrés** au repos (`setSecret`) ; les PII et l'état non-secret sont en clair, le fichier SQLite n'est pas chiffré.
- `sdk/` — helpers `withSource` (→ `SourceHandle`), `customData` (→ `CustomDataHandle`) et
  `sendBulk` (push sûr : chunké, throw sur transport, remonte les rejets) ; le client SDK provient
  de `@shopimind/sdk-js`, dépendance directe **ré-exportée** par le kit (`export * from '@shopimind/sdk-js'`).
  Plus de gateway/adaptateur : l'intégration tape le SDK directement via `ctx.spm` (un `SpmHttpClient`).
- `provisioning/` — find-or-create idempotent (sources de données, custom data + relations, events).
  Relations custom→custom : la cible peut être désignée par NOM (déf sœur), résolue en id à la création.
- `lifecycle/`, `http/`, `runtime/` — dispatcher de cycle de vie, serveur Hapi, assemblage (`createIntegrationApp`).

## Identité git
- Org GitHub : `shopimind`. Committer/pousser avec le compte **pro** du mainteneur (pas un compte perso).
- Vérifier `git config user.email` avant de committer (un IDE peut injecter une autre identité).

## Règles
- Garder le `README.md` strictement orienté utilisateur final.
- Respecter le TypeScript strict (pas de `any` opportuniste).
- Tout changement qui touche le contrat public du kit = bump de version approprié (semver).
