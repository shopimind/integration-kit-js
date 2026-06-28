/**
 * TYPE tests (checked by `tsc`, not at runtime).
 *
 * They prove by construction that a dynamic select declared with
 * `remote_data: string` is NON-REPRESENTABLE, and that a dynamic select REQUIRES
 * a well-formed `remote: RemoteRef`. If either of these errors stopped occurring,
 * `tsc` would fail on the unused `@ts-expect-error`.
 */
import type { ConfigSchema, ConfigField } from '../config-schema.js';

/* eslint-disable @typescript-eslint/no-unused-vars */

// Valid Hiboutik schema: dynamic 'stores' select via structured `remote`.
const valid: ConfigSchema = {
  steps: [
    {
      key: 'connection',
      label: { fr: 'Connexion Hiboutik', en: 'Hiboutik connection' },
      fields: [
        { key: 'hiboutik_account', type: 'text', required: true, label: { fr: 'Compte Hiboutik' } },
        { key: 'hiboutik_api_user', type: 'text', required: true, label: { fr: 'Utilisateur API' } },
        { key: 'hiboutik_api_key', type: 'password', required: true, sensitive: true, label: { fr: 'Clé API' } },
      ],
      on_complete: { action: 'test_connection' },
    },
    {
      key: 'stores',
      label: { fr: 'Magasins', en: 'Stores' },
      fields: [
        {
          key: 'store_ids',
          type: 'multiselect',
          required: true,
          label: { fr: 'Points de vente à synchroniser' },
          remote: { resource: 'stores', label_field: 'store_name', value_field: 'store_id' },
        },
      ],
    },
    {
      key: 'data',
      label: { fr: 'Données à synchroniser' },
      fields: [
        { key: 'sync_customers', type: 'checkbox', default: false, label: { fr: 'Clients' } },
        { key: 'sync_orders', type: 'checkbox', default: false, label: { fr: 'Commandes' } },
        { key: 'sync_products', type: 'checkbox', default: false, label: { fr: 'Catalogue produits' } },
        { key: 'sync_loyalty', type: 'checkbox', default: false, label: { fr: 'Points de fidélité' } },
      ],
    },
  ],
};
void valid;

// A dynamic select with `remote_data: 'stores'` (string) DOES NOT COMPILE.
const remoteDataStringRejected: ConfigField = {
  key: 'store_ids',
  type: 'multiselect',
  label: { fr: 'Magasins' },
  // @ts-expect-error — `remote_data` does not exist; use `remote: RemoteRef`.
  remote_data: 'stores',
};
void remoteDataStringRejected;

// A malformed `remote` (missing label_field / value_field) DOES NOT COMPILE.
const badRemote: ConfigField = {
  key: 'x',
  type: 'select',
  label: { fr: 'X' },
  // @ts-expect-error — `remote` requires resource + label_field + value_field.
  remote: { resource: 'stores' },
};
void badRemote;
