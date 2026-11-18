import type { SVGAttributes } from "react";

/**
 * The resource layer's hand-drawn marks, following src/components/icons/db-icons.tsx's
 * conventions: single-stroke SVGs (stroke width 1.5) painting with currentColor,
 * designed to read at their real 14px (w-3.5) sidebar size, no fills, no brand
 * logos — recognisable shapes, not trademarks.
 *
 * Fork-owned (STORAGEBASE.md P1): this path cannot collide with upstream. The
 * deferred D2 type-ids (S3, RabbitMQ, SQS, AWS KMS, AWS Secrets Manager) add
 * their marks here the day they are ported; RESOURCE_UI_CONFIG's exhaustive
 * table fails typecheck until they do.
 */

type IconProps = SVGAttributes<SVGSVGElement> & { className?: string };

function Svg({ children, ...props }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  );
}

/** Azure Blob: stacked blocks with the top one offset — the portal's blob rhythm. */
export function AzureBlobIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="4" y="13" width="7" height="7" />
      <rect x="13" y="13" width="7" height="7" />
      <rect x="8.5" y="4" width="7" height="7" />
    </Svg>
  );
}

/** Kafka: a log circle with topic partitions fanning out. */
export function KafkaIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="5" cy="12" r="2" />
      <circle cx="19" cy="5" r="2" />
      <circle cx="19" cy="12" r="2" />
      <circle cx="19" cy="19" r="2" />
      <path d="M7 11 17 5.8M7 12h10M7 13l10 5.2" />
    </Svg>
  );
}

/** HashiCorp Vault: a shield with a keyhole — the vault shape, not the logo. */
export function HashicorpVaultIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 3 5 6v5c0 5 3 8.4 7 10 4-1.6 7-5 7-10V6l-7-3Z" />
      <circle cx="12" cy="11" r="1.6" />
      <path d="M12 12.6V 15" />
    </Svg>
  );
}

/** OpenBao: the same vault shield with an open seam — a fork of the shape above. */
export function OpenBaoIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 3 5 6v5c0 5 3 8.4 7 10 4-1.6 7-5 7-10V6l-7-3Z" />
      <path d="M12 6v4M10.5 11h3l1 4h-5l1-4Z" />
    </Svg>
  );
}

/** Azure Key Vault: keys crossed behind the shield. */
export function AzureKeyVaultIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 3 6 5.5v4.7c0 4.3 2.6 7.3 6 8.8 3.4-1.5 6-4.5 6-8.8V5.5L12 3Z" />
      <circle cx="10.4" cy="10.5" r="1.2" />
      <path d="M11.3 11.4 14 14.2M14 14.2h1.6M14 14.2l.9 1M14 14.2l.9-1" />
    </Svg>
  );
}
