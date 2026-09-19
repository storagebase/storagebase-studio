/**
 * Family registration barrel. One import per landed family; families arrive as
 * `providers/<family>/index.ts`, each self-registering its type-ids.
 *
 * Imported for effect from exactly two places, and nowhere else:
 * - `src/lib/api/resource-route.ts` (server: covers every resource route,
 *   current and future, because they all run through `handleResourceRequest`),
 * - `src/components/Studio.tsx` (client: the standalone shell composes the
 *   build's families; the picker then offers what the server answers, and the
 *   embedded workspace stays tile-free because it never imports this barrel).
 *
 * Nothing else imports this barrel on purpose: unit tests start from an empty
 * registry and register fakes explicitly (the monotonic-registration ruling
 * the registry tests document), and an import here would silently populate it.
 */
import "./blob";
