/**
 * The vault family registers its type-ids here, one import per provider
 * module. Each module self-registers through `registerResourceProviderLoader`
 * with a lazy loader, so importing the family costs no SDK until a connection
 * of that type is actually created. Phase 3b ships Azure Key Vault alone;
 * HashiCorp Vault and OpenBao (one module, two ids, over `BasicVaultWorkbench`)
 * append their import line in phase 6.
 */
import "./azure-key-vault";
