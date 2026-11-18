/**
 * Family registration barrel. One import per landed family; families arrive as
 * `providers/<family>/index.ts`, each self-registering its type-ids.
 *
 * Imported for effect by the request handler (`handle-request`), which every
 * `/api/sb/resources/**` and `/api/sb/<family>/**` route runs through — so one
 * import covers the whole server surface. The blob family lands with phase 3a;
 * the vaults and messaging barrels land with their own phases.
 */
import "./blob";
import "./vaults";
