# Plan d'implémentation — UI Admin embarquée du kit (cible v1.5.0)

> **Pour l'agent implémenteur.** Ce plan est **décision-complet** : toutes les questions ouvertes
> de la spec sont tranchées ici. Tu implémentes, tu ne re-décides pas. En cas de contradiction
> entre ce plan et le code réel, **le code réel gagne pour l'existant** et tu signales l'écart ;
> pour le nouveau, **ce plan gagne**.

- **Spec & maquette (à lire en premier)** : `docs/PROPOSITION-UI-ADMIN-kit.html` (ouvrir dans un navigateur ; la maquette est le rendu cible pixel-près de `/admin/ui`).
- **Baseline** : `main` @ v1.4.0 publiée, suite de tests verte. Tout ce plan est **additif** → release **mineure 1.5.0**.
- **Conventions repo** (rappel `CLAUDE.md`) : TypeScript strict ESM, code + commentaires + commits **en anglais**, prose de marque « ShopiMind », `yarn build` + `yarn typecheck` + `yarn test` verts avant chaque commit. **Aucune nouvelle dépendance de production** (ni de dev, sauf justification forte — a priori zéro).

---

## 0. Décisions tranchées (ex-questions ouvertes §9 de la spec)

| # | Question | Décision |
|---|---|---|
| Q1 | Exposition par défaut | **(a)** Sans `adminPort`, admin + UI restent sur le port public (compat), **avec avertissement bruyant au démarrage**. `adminPort` = déploiement recommandé (listener dédié, `adminHost` défaut `127.0.0.1`). |
| Q2 | Révélation PII | **La session admin suffit en V1** (outil mono-opérateur). Pas de second secret. La révélation reste unitaire + confirmée + auditée. |
| Q3 | Hook `replayRejected` | **V2 — hors périmètre de ce chantier.** Ne rien implémenter, ne pas réserver d'endpoint. |
| Q4 | Rétention distincte des rejets | **Oui** : option `rejectedRetentionDays` (défaut = `retentionDays`). + `auditRetentionDays` (défaut **365**). |
| Q5 | Langue par défaut de l'UI | **Auto-détection** `navigator.language` (`fr*` → fr, sinon en), bascule manuelle persistée en `localStorage`. |
| Q6 | Nom de l'écran phare | FR : **« Rejets »** · EN : **« Rejected items »**. |

**Écarts assumés vs maquette (données non persistées — on n'affiche que du vrai) :**
- « Rejeux bloqués (7 j) » (webhooks) et « rejeux court-circuités » (inbound) ne sont **pas comptés en base** (le court-circuit ne crée pas de ligne). → **Retirer ces compteurs** de l'onglet Idempotence ; afficher uniquement : liste `inbound_event` (avec statuts), nombre de signatures retenues (`webhook_seen`) sur la période, et la rétention configurée.
- « taille du fichier SQLite » : calculée via `PRAGMA page_count` × `PRAGMA page_size` (pas d'accès fs).

---

## 1. Règles du chantier (non négociables)

1. **Additif only.** Les 5 endpoints admin existants (`/health`, `/admin/overview`, `/admin/status/{id}`, `/admin/installations/{id}/rejected`, `POST /admin/sync/{id}`) répondent **à l'identique** avec l'auth par en-tête → tests snapshot de non-régression.
2. **Zéro dépendance ajoutée** (`dependencies` npm inchangées : `@hapi/hapi`, `@shopimind/sdk-js`, `better-sqlite3`). Crypto : `node:crypto` uniquement.
3. **Invariants sécurité** (testés, voir §7) : valeur d'une ligne `integration_state.encrypted=1` **jamais lue** par les endpoints ; PII **masquée par défaut** ; toute mutation navigateur exige **CSRF** ; tout est **scopé** par `installation_id`.
4. **Ne pas toucher** : `src/security/signature.ts`, `src/security/crypto.ts`, `src/sdk/*`, le comportement du moteur de sync (seule exception : ajout **additif** de `mode` au résumé, §3.4), les workflows `.github/*`, la licence.
5. **Migrations append-only** : la v7 s'ajoute, on ne modifie jamais v1–v6.
6. **Un commit par jalon** (messages en anglais, préfixe `feat(admin-ui):`), branche **`feat/admin-ui`**. **Ne pas publier** : bump `1.5.0` + `CHANGELOG.md` dans le dernier commit, la Release GitHub (→ publication npm OIDC) est faite par l'humain.
7. La maquette HTML est la **référence visuelle** (structure, libellés, états vide/erreur/chargement, modales, thème sombre par défaut, accent `#94c840`). Tu peux améliorer le détail, pas changer la structure.

---

## 2. Architecture cible — fichiers

```text
src/
  http/
    admin-routes.ts          NOUVEAU  toutes les routes /admin/* (existantes déplacées + nouvelles) + /admin/ui
    admin-session.ts         NOUVEAU  sessions mémoire + cookies + CSRF + limiteur login
    admin-ui.generated.ts    GÉNÉRÉ   export const ADMIN_UI_HTML (committé, régénéré au prebuild)
    routes.ts                MODIFIÉ  garde webhooks/inbound/health ; délègue l'admin à admin-routes (flag d'exclusion)
  admin-ui/
    ui.html                  NOUVEAU  source de vérité de la page (éditable, ~70–90 kB)
  security/
    pii-mask.ts              NOUVEAU  masquage PII d'un JSON sérialisé
  store/
    migrations.ts            MODIFIÉ  + migration v7 (audit_log)
    repositories.ts          MODIFIÉ  + méthodes listées §3.2 + AuditRepo
    types.ts                 MODIFIÉ  + AuditRow, types de filtres
  sync/engine.ts             MODIFIÉ  + SyncSummary.mode (additif)
  runtime/create-app.ts      MODIFIÉ  câblage : audit, session, options, second listener, warnings
scripts/
  embed-admin-ui.mjs         NOUVEAU  ui.html → admin-ui.generated.ts (+ KIT_VERSION)
docs/                        (déjà là : spec + ce plan — non publiés sur npm, files:["dist"])
```

**Choix structurants :**
- **`buildAdminRoutes(deps)`** exporté depuis `admin-routes.ts`. `buildRoutes(deps)` (API publique, ne pas casser) accepte un nouveau champ optionnel `deps.excludeAdmin?: boolean` : `false`/absent → il inclut les routes admin comme aujourd'hui (compat) ; `true` → il ne sert que webhooks/inbound/health, et `create-app` monte `buildAdminRoutes` sur le **second listener**.
- **`KIT_VERSION`** : lue au runtime via `createRequire(import.meta.url)('../../package.json').version` (le `package.json` est publié dans le paquet) — pas de codegen pour la version.
- **`admin-ui.generated.ts`** : committé (comme les migrations SQL embarquées : rien à copier dans `dist`), régénéré par `prebuild`. Ajouter `.gitattributes` : `src/http/admin-ui.generated.ts linguist-generated=true`.
- `package.json` : ajouter `"prebuild": "node scripts/embed-admin-ui.mjs"` et `"pretest": "node scripts/embed-admin-ui.mjs"` (un clone frais doit pouvoir lancer `yarn test` directement).

---

## 3. Jalon J1 — Données & API lecture (commit 1)

### 3.1 Migration v7 — `audit_log`

```sql
-- version: 7, name: 'admin_audit'
CREATE TABLE audit_log (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  at               TEXT NOT NULL DEFAULT (datetime('now')),
  action           TEXT NOT NULL,            -- login|login_failed|logout|sync_triggered|reprovision_triggered|rejected_purged|pii_revealed
  installation_id  TEXT,
  target           TEXT,                     -- ex. 'rejected_item#1284'
  details_json     TEXT,
  ip               TEXT
);
CREATE INDEX idx_audit_log_at ON audit_log(at);
```

### 3.2 Repositories — signatures exactes (toutes en SQL préparé, `LIKE` uniquement via paramètres)

```ts
// InstallRepo
list(f: { status?: string; q?: string; limit: number; offset: number }): { items: InstallRow[]; total: number }
  // q: LIKE sur installation_id | shop_domain | shop_name ; tri updated_at DESC
countByStatus(): Record<string, number>

// WebhookLogRepo
listByInstallation(id: string, f: { event?: string; signatureOk?: boolean; limit: number; offset: number })
  : { items: WebhookLogRow[]; total: number }          // + type WebhookLogRow dans types.ts
countSince(hours: number): { total: number; refused: number }        // dashboard 24 h
lastForInstallation(id: string): { event: string|null; created_at: string } | undefined

// InboundEventRepo
listByInstallation(id: string, f: { limit: number; offset: number }): { items: InboundEventRow[]; total: number }

// WebhookSeenRepo
countByInstallationSince(id: string, days: number): number

// RejectedItemRepo
list(f: { installationId?: string; entity?: string; sinceDays?: number; q?: string; limit: number; offset: number })
  : { items: RejectedItemRow[]; total: number }        // q: LIKE sur reason
count(f: { installationId?: string; entity?: string; sinceDays?: number }): number
countByEntity(installationId?: string): Array<{ entity: string|null; n: number }>
deleteByIds(installationId: string, ids: number[]): number   // SCOPÉ install ; cap 500 ids ; retourne rows supprimées

// RunRepo
list(id: string, f: { limit: number; offset: number }): { items: SyncRunRow[]; total: number }

// IntegrationStateRepo — INVARIANT : ne jamais lire `value` d'une ligne chiffrée
listMeta(id: string): Array<{ key: string; encrypted: 0|1; updated_at: string; value_length: number; value_preview: string|null }>
  // SQL: SELECT key, encrypted, updated_at, length(value) AS value_length,
  //             CASE WHEN encrypted = 0 THEN substr(value, 1, 200) ELSE NULL END AS value_preview
  //      FROM integration_state WHERE installation_id = ? ORDER BY key
  // (le CASE garantit au niveau SQL que la valeur chiffrée n'est jamais matérialisée)

// AuditRepo (nouveau)
add(e: { action: string; installation_id?: string|null; target?: string|null; details?: unknown; ip?: string|null }): void
list(f: { limit: number; offset: number }): { items: AuditRow[]; total: number }
purgeOlderThan(days: number): number
```

Caps durs côté repo (défensifs, en plus des routes) : `limit ≤ 200` (500 pour `rejected_item`).

### 3.3 Masquage PII — `src/security/pii-mask.ts`

```ts
/** Masks PII inside a serialized JSON payload. Never throws: on parse failure,
 *  applies the regex pass to the raw string. Depth/cycle-safe (same guards as redact()). */
export function maskPiiJson(json: string): string
```
Règles : (1) toute **valeur** matchant un email → `m•••@•••.fr` (1er caractère + TLD conservés) ; (2) toute valeur « téléphone » (≥ 7 chiffres avec séparateurs) → garder les 2 derniers chiffres ; (3) valeurs des **clés** `/(first|last)_?name|phone|email|address|street|city|zip|postal|birth/i` → 1er caractère + `•••`. Ne touche ni les clés ni les nombres/booléens. Tests dédiés (y compris JSON invalide, imbrication profonde, tableaux).

### 3.4 Moteur — `SyncSummary.mode` (additif)

`runIntegrationSync` inscrit `mode: opts.fullBackfill ? 'full' : 'incremental'` dans le `SyncSummary` (type + valeur). Ne rien changer d'autre au moteur. Mettre à jour les tests qui snapshotent le résumé, sans en modifier la sémantique.

### 3.5 Endpoints lecture (dans `admin-routes.ts` ; auth = en-tête **ou** session J2 ; tous : rate-limit admin existant, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`)

| Endpoint | Retour (forme exacte) |
|---|---|
| `GET /admin/meta` | `{ kit_version, integration: { slug, name, version }, schema_version, node: process.version, db: { size_bytes }, options: { syncIntervalMinutes, retentionDays, rejectedRetentionDays, auditRetentionDays } }` |
| `GET /admin/installations?status&q&limit&offset` | `{ items, total, limit, offset }` |
| `GET /admin/installations/{id}` | `{ install, last_webhook, counters: { cursors, cursors_in_error, rejected_pending, webhooks_7d, inbound_7d, webhook_seen_7d }, provisioning: { sourceIds, defIds, inconsistencies: string[] } \| null, secrets: { access_token: boolean, inbound_secret: boolean } }` — provisioning parsé **côté serveur** depuis `__provisioning` (jamais le blob brut) ; `inconsistencies` = `source_key` présents dans `sync_cursor`/`rejected_item` mais absents de `sourceIds` |
| `GET /admin/installations/{id}/cursors` | `{ items: CursorRow[] }` (inclut `consecutive_failures`) |
| `GET /admin/installations/{id}/runs?limit&offset` | `{ items, total, … }` — `summary_json` renvoyé parsé (`summary`), tronqué à 64 kB |
| `GET /admin/installations/{id}/webhooks?event&sig&limit&offset` | `{ items, total, … }` — `payload_json` passé dans `maskPiiJson` |
| `GET /admin/installations/{id}/inbound?limit&offset` | `{ items, total, … }` |
| `GET /admin/installations/{id}/state` | `{ items: listMeta(...) }` |
| `GET /admin/rejected?installation&entity&since&q&limit&offset` | `{ items, total, … }` — `payload_json` masqué ; + `by_entity` (countByEntity) |
| `GET /admin/audit?limit&offset` | `{ items, total, … }` |

404 propre (`{ success:false, error:'not_found' }`) quand `{id}` est inconnu de `installs`.

### 3.6 Tests J1
- Un test par endpoint (200 forme exacte, 401 sans jeton, 400 params invalides, 404 id inconnu).
- **Invariant secrets** : seed `setSecret(...)` puis assertion sur la **réponse JSON brute** de `/state` : ni la valeur ni son déchiffrement n'apparaissent ; `value_preview === null` ; scan « le token seedé n'apparaît dans **aucune** réponse admin ».
- **Invariant PII** : seed un rejet avec email/téléphone → la réponse ne contient ni l'email ni le numéro en clair (regex).
- **Scoping** : seed 2 installations → les listes de A ne contiennent jamais les lignes de B.
- Repos : tests unitaires des nouvelles méthodes (dont `deleteByIds` scopé + cap).
- Non-régression : snapshots des 5 endpoints existants.

---

## 4. Jalon J2 — Session, CSRF & UI lecture (commit 2)

### 4.1 `admin-session.ts`

```ts
export interface AdminSessionManager {
  login(token: string, ip: string): { sid: string; csrf: string; ttlSeconds: number } | null; // null = jeton invalide
  check(sidCookie: string | undefined): { ok: boolean; csrf?: string };  // TTL 12 h GLISSANT (touch à chaque check ok)
  logout(sid: string): void;
}
export function createAdminSessionManager(opts: { verifyToken(t: string): boolean; now?(): number }): AdminSessionManager
```
- `sid`/`csrf` : `randomBytes(32).toString('hex')`. Store : `Map<sid, { expiresAt, csrf }>`, **20 sessions max** (éviction plus ancienne). `verifyToken` réutilise la comparaison temps constant de `routes.ts` (l'**extraire** dans un helper partagé, ex. `src/http/admin-auth.ts`, plutôt que la dupliquer).
- **Cookie** : `spm_admin_sid=<sid>; HttpOnly; SameSite=Strict; Path=/admin` + `Secure` si option `adminSecureCookie: true` (nouvelle option `CreateAppOptions`, défaut `false`, documentée « à activer derrière TLS »).
- **Login** : `POST /admin/session` body `{ token }` (JSON ≤ 4 kB) — limiteur dédié `createRateLimiter({ capacity: 5, refillPerSec: 1/12 })` par IP (≈ 5/min). Succès → cookie + `{ csrf, ttl }` ; échec → 401 + audit `login_failed`. `DELETE /admin/session` → logout + audit.
- **Auth unifiée** (`admin-auth.ts`) : `adminOk(req)` = en-tête valide **ou** session valide. **Mutations** (POST/DELETE hors `/admin/session` login) : si auth par session → exiger `x-csrf-token` égal au csrf de session **et** `Origin` absent ou same-origin ; si auth par en-tête (scripts) → pas de CSRF (pas de cookie en jeu).
- Audit des événements de session dès ce jalon (`login`, `login_failed`, `logout`).

### 4.2 La page — `src/admin-ui/ui.html` + génération

- **Reproduire la maquette** de `PROPOSITION-UI-ADMIN-kit.html` (mêmes écrans, tableaux, badges, modales, états vide/erreur/chargement, thème sombre défaut + clair, layout responsive ≥ 360 px). Retirer les éléments « démo spec » (bandeaux d'états affichés en permanence → ils deviennent les états réels).
- **Vanilla strict** : aucun import, aucun asset externe, `fetch()` + rendu DOM manuel (helpers `el()`/`fmt()`), **jamais** d'`innerHTML` avec données serveur (création de nœuds + `textContent` uniquement — anti-XSS structurel).
- **i18n** : dictionnaire `{ fr: {...}, en: {...} }` (~120 clés), défaut auto (Q5), bascule persistée `localStorage('spm_admin_lang')`. **Thème** persisté `localStorage('spm_admin_theme')`. (Préférences d'affichage uniquement — jamais de secret en storage.)
- **Comportements** : auto-refresh 30 s (Page Visibility → pause onglet caché) ; timestamps absolus + relatifs (`Intl.RelativeTimeFormat`) ; toute réponse 401 → retour à l'écran login ; erreurs réseau → bandeau réessayer ; recherche/filtres/pagination branchés sur les params des endpoints.
- **Placeholders** remplacés au service de la page : `__NONCE__` (CSP), `__CSRF__` (jeton de session ; vide si pas de session → écran login), `__LANG_DEFAULT__`.
- `scripts/embed-admin-ui.mjs` : lit `ui.html`, échappe, écrit `admin-ui.generated.ts` (`/* eslint-disable */` + bannière AUTO-GENERATED). Idempotent (pas de timestamp dedans).

### 4.3 Route `GET /admin/ui`

- Sert le HTML avec nonce frais (`randomBytes(16).base64`), en-têtes : `Content-Security-Policy: default-src 'none'; script-src 'nonce-…'; style-src 'nonce-…'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'` + `no-store`. Accessible sans session (la coquille ne contient aucune donnée ; le code est public sur npm de toute façon) — les données n'arrivent que via les endpoints authentifiés.
- Montée uniquement si `adminToken` configuré et `adminUi !== false` (nouvelle option `CreateAppOptions.adminUi?: boolean`, défaut `true`).

### 4.4 Tests J2
- Session : login ok/ko (+ audit), TTL glissant (fake now), éviction > 20, logout, cookie attributes (`HttpOnly`, `SameSite=Strict`, `Path=/admin`).
- CSRF : mutation avec session sans `x-csrf-token` → 403 ; avec mauvais token → 403 ; avec bon token → 200 ; auth en-tête sans CSRF → 200.
- Bruteforce : 6ᵉ login en 1 min → 429.
- `GET /admin/ui` : 200, CSP présente avec nonce, aucun `script-src 'unsafe-inline'`, `no-store`.
- 401 systématique : test paramétré qui itère sur **toutes** les routes `/admin/*` (introspection de `buildAdminRoutes`) sans auth → 401 (sauf `POST /admin/session`).

---

## 5. Jalon J3 — Actions & audit (commit 3)

### 5.1 Endpoints mutation (CSRF, audit, rate-limit)

| Endpoint | Comportement |
|---|---|
| `POST /admin/rejected/purge` body `{ installation_id, ids?: number[], filter?: { entity?, sinceDays? } }` | `ids` (≤ 500) **ou** `filter` (pas les deux). Suppression **scopée** à `installation_id`. Retour `{ success, deleted }`. Audit `rejected_purged` `{ n, ids? , filter? }`. |
| `POST /admin/rejected/{id}/reveal` body `{ installation_id }` | Vérifie que l'item appartient à l'installation. Retour `{ payload_json }` **non masqué**, `Cache-Control: no-store`. **Audit `pii_revealed` AVANT d'écrire la réponse** `{ target: 'rejected_item#<id>' }`. |
| `POST /admin/installations/{id}/webhook-log/{logId}/reveal` | Idem pour un payload de `webhook_log` (déjà expurgé à l'écriture — la révélation ne concerne que le masquage d'affichage). |
| `POST /admin/installations/{id}/reprovision` | Rejoue le plan de provisioning. **Refactor requis** : extraire de `dispatcher.ts` la logique commune `runReprovisionFor(id)` (buildContext → `integration.provisioning(ctx)` → `runProvisioning` → `state.set(PROVISIONING_KEY, …)`) utilisée par `onActivate`/`onConfigUpdated` **et** par cet endpoint (exposée via une dep de `create-app`). 409 si un sync est en cours pour l'installation (réutiliser le verrou `running`). Retour `{ success, sourceIds, defIds, errors }`. Audit `reprovision_triggered`. |
| `POST /admin/sync/{id}` (existant) | Ajouter **seulement** : écriture audit `sync_triggered` `{ mode }` + support CSRF/session. Réponse inchangée (snapshot). |

### 5.2 UI — branchement des actions
Modales conformes à la maquette : Synchroniser (radio incrémentale/full + note verrou), Re-provisionner, Purger (saisie `PURGER` obligatoire si > 10 items), Révéler la PII (avertissement « journalisé »). Après action : toast + rafraîchissement de l'écran + l'entrée d'audit visible dans l'écran Audit.

### 5.3 Tests J3
- Chaque action : succès + ligne d'audit **exacte** (action, target, details, ip) ; 401/403/404/409/429 ; scoping (purge de B via `installation_id` A → 0 supprimé) ; reveal : l'audit est écrit même si la réponse échoue ensuite (ordre vérifié) ; reprovision : idempotent (2 appels → même résultat, pas de doublon).

---

## 6. Jalon J4 — Isolation, options, finitions (commit 4 + commit release)

1. **Second listener** : `CreateAppOptions.adminPort?: number` + `adminHost?: string` (défaut `127.0.0.1` si `adminPort` posé). Si posé : `create-app` crée un 2ᵉ `createServer({ port: adminPort, host: adminHost })`, y monte `buildAdminRoutes`, passe `excludeAdmin: true` au listener public. `start()`/`stop()` gèrent les deux serveurs. `IntegrationApp` expose `adminServer?: Server`.
2. **Avertissements de posture** (au `start()`) :
   - admin/UI sur listener public (pas d'`adminPort`) → `logger.warn('admin UI is served on the PUBLIC listener — set adminPort (internal) or firewall /admin at the ingress')` ;
   - `adminToken` **< 16 caractères → l'admin ne monte pas** (`logger.error`, routes admin absentes) ; **< 32 → warn** (« use openssl rand -hex 32 »).
3. **Rétentions** : `rejectedRetentionDays` (défaut = `retentionDays`) et `auditRetentionDays` (défaut 365) câblées dans la purge quotidienne existante (`purgeOldRecords`).
4. **Docs** : section `README.md` (EN, utilisateur du paquet) « Operations UI » : capture conceptuelle, activation, `adminPort`, génération du jeton, ce que l'UI ne montre jamais (secrets/PII) ; `CLAUDE.md` : lignes d'architecture (`http/admin-*`, `admin-ui/`, migration v7) ; `CHANGELOG.md` : entrée 1.5.0 complète.
5. **Release prep (dernier commit)** : bump `package.json` → `1.5.0`, CHANGELOG, `npm pack --dry-run` propre (vérifier que `docs/`, `src/admin-ui/ui.html` et `scripts/` ne partent pas — `files:["dist"]` le garantit ; le HTML embarqué part via `dist/http/admin-ui.generated.js`). **Ne pas créer la Release** (humain).

---

## 7. Definition of Done (bloquante)

- [ ] `yarn build` + `yarn typecheck` + `yarn test` verts ; **zéro** modification de test existant autre que les ajouts prévus (§3.4 snapshots de résumé, §5.1 snapshot sync inchangé).
- [ ] `dependencies` de `package.json` inchangées.
- [ ] Les 7 familles de tests sécurité passent : 401 partout · CSRF · secrets jamais renvoyés (scan global) · PII masquée par défaut · reveal audité · scoping multi-tenant · bruteforce login 429. Plus les snapshots de rétrocompat des 5 endpoints existants.
- [ ] Parcours manuel complet au navigateur (via `makeTestApp` ou une intégration de dev) **sans jamais ouvrir le SQLite** : login → dashboard → installations → détail (7 onglets) → rejets (purge + reveal) → audit → logout. Aucune violation CSP en console.
- [ ] Empreinte : `admin-ui.generated.ts` ≤ 120 kB ; aucune requête réseau externe (vérifiable : CSP `connect-src 'self'`).
- [ ] 4 commits + 1 commit release sur `feat/admin-ui`, prêts pour revue humaine. Rien de publié.

---

## 8. Hors périmètre (ne pas faire)

- Hook `replayRejected` / endpoint replay (V2).
- RBAC / multi-utilisateurs, option `trustProxy`, chiffrement du fichier SQLite.
- Toute page du site de docs `shopimind-api-docs` (chantier séparé, après release).
- Toute modification du canal connecteur, du SDK, ou de la sémantique des curseurs.
