/**
 * The blob family registers its type-ids here, one import per provider module.
 * Each module self-registers through `registerResourceProviderLoader` with a
 * lazy loader, so importing the family costs no SDK until a connection of that
 * type is actually created (the `createDatabaseProvider` ruling, applied here).
 */
import "./s3";
import "./azure-blob";
