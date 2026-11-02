/** The product name shown in the window title and in the application shell. */
export const PRODUCT_NAME = "MyManDev AI Workspace";

/**
 * The name of the folder that holds the application's local data, inside the
 * system's per-user application data folder. It is fixed and does not follow
 * the product name or the application name: renaming it after a release
 * would need a data migration.
 */
export const DATA_FOLDER_NAME = "MyManDev";

/**
 * The name of the folder that holds the application's local data on Windows,
 * inside the local application data folder (`%LOCALAPPDATA%`), which a
 * roaming profile never copies to another machine. The device key (#94) is
 * stored there, so that it stays on this machine. macOS and Linux have no
 * roaming folder; there the device key is stored in the data folder. It is
 * fixed like `DATA_FOLDER_NAME`: renaming it after a release would lose the
 * device key.
 */
export const LOCAL_DATA_FOLDER_NAME = "MyManDev";
