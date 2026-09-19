/**
 * The vault family registers its type-ids here, one import per provider
 * module. Each module self-registers through `registerResourceProviderLoader`
 * with a lazy loader, so importing the family costs no SDK until a connection
 * of that type is actually created. The Vault/OpenBao pair shares one module
 * (one module, two ids); the other three are one module each.
 */
import "./vault";
import "./azure-key-vault";
import "./aws-secrets-manager";
import "./aws-kms";
