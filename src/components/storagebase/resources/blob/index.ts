/**
 * The blob family viewer barrel. Imported for effect by the section shell,
 * which reads viewers through the registry — one import per family with a
 * viewer, vault and messaging joining with their own phases. No re-export:
 * the component is consumed through the registry, and the component tests
 * import it directly, so a barrel re-export would be an unused hop knip
 * rightly flags.
 */
import "./BlobBrowser";
