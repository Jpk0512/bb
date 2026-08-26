import {
  appKeybindingOverridesSchema,
  appSettingsSchema,
  defaultAppSettings,
  disabledModelsSchema,
  type AppKeybindingOverrides,
  type AppSettings,
  type DisabledModels,
} from "@bb/domain";
import type { DbConnection, DbQueryConnection } from "../connection.js";
import { appSettings, appSettingsValues } from "../schema.js";
import { eq, inArray } from "drizzle-orm";

const APP_SETTINGS_ROW_ID = "current";

const appSettingsKeySchema = appSettingsSchema.keyof();
const appSettingsKeys = appSettingsKeySchema.options;

/**
 * Keyboard overrides live in the same table under a reserved key. It is not an
 * `AppSettings` member, so general-settings reads skip it as an unknown key.
 */
const KEYBINDING_OVERRIDES_KEY = "keybindingOverrides";

/** Stored values are JSON text written by this module; corrupt text reads as a miss. */
function parseStoredValue(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function writeValue(
  db: DbQueryConnection,
  key: string,
  value: unknown,
  updatedAt: number,
): void {
  const text = JSON.stringify(value);
  db.insert(appSettingsValues)
    .values({ key, value: text, updatedAt })
    .onConflictDoUpdate({
      target: appSettingsValues.key,
      set: { value: text, updatedAt },
    })
    .run();
}

export function getAppSettings(db: DbConnection): AppSettings {
  // Defaults first, then each stored row that still names a live setting and
  // still holds a valid value. Per-key validation keeps one stale or corrupt
  // row from resetting every other preference.
  const values: Record<string, unknown> = { ...defaultAppSettings };
  const rows = db
    .select({ key: appSettingsValues.key, value: appSettingsValues.value })
    .from(appSettingsValues)
    .where(inArray(appSettingsValues.key, [...appSettingsKeys]))
    .all();

  for (const row of rows) {
    // The query already excludes keyboard and retired rows; this narrows the
    // key so the value can be checked against that setting's own schema.
    const key = appSettingsKeySchema.safeParse(row.key);
    if (!key.success) continue;
    const value = appSettingsSchema.shape[key.data].safeParse(
      parseStoredValue(row.value),
    );
    if (value.success) values[key.data] = value.data;
  }

  return appSettingsSchema.parse(values);
}

export function setAppSettings(db: DbConnection, settings: AppSettings): void {
  const updatedAt = Date.now();
  db.transaction((transaction) => {
    for (const key of appSettingsKeys) {
      writeValue(transaction, key, settings[key], updatedAt);
    }
  });
}

export function getAppKeybindingOverrides(
  db: DbConnection,
): AppKeybindingOverrides {
  const row = db
    .select({ value: appSettingsValues.value })
    .from(appSettingsValues)
    .where(eq(appSettingsValues.key, KEYBINDING_OVERRIDES_KEY))
    .get();

  if (row === undefined) {
    return [];
  }
  return appKeybindingOverridesSchema.parse(parseStoredValue(row.value));
}

export function setAppKeybindingOverrides(
  db: DbConnection,
  overrides: AppKeybindingOverrides,
): void {
  writeValue(db, KEYBINDING_OVERRIDES_KEY, overrides, Date.now());
}

export function getDisabledModels(db: DbConnection): DisabledModels {
  const row = db
    .select({ disabledModels: appSettings.disabledModels })
    .from(appSettings)
    .where(eq(appSettings.id, APP_SETTINGS_ROW_ID))
    .get();

  if (row === undefined) {
    return [];
  }
  return disabledModelsSchema.parse(JSON.parse(row.disabledModels));
}

export function setDisabledModels(
  db: DbConnection,
  disabledModels: DisabledModels,
): void {
  const updatedAt = Date.now();
  db.insert(appSettings)
    .values({
      id: APP_SETTINGS_ROW_ID,
      disabledModels: JSON.stringify(disabledModels),
      updatedAt,
    })
    .onConflictDoUpdate({
      target: appSettings.id,
      set: {
        disabledModels: JSON.stringify(disabledModels),
        updatedAt,
      },
    })
    .run();
}
