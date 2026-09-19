/**
 * The blob family viewer barrel. Imported for effect by the inspector, which
 * reads viewers through the registry — one import per family with a viewer,
 * messaging and vault joining the same import when they land. No re-export:
 * the component is consumed through the registry, and the integration tests
 * import it directly, so a barrel re-export would be an unused hop knip
 * rightly flags.
 */
import "./BlobBrowser";
