import type { SVGAttributes } from "react";

/**
 * The resource layer's hand-drawn marks, following src/components/icons/db-icons.tsx's
 * conventions: single-stroke SVGs (stroke width 1.5) painting with currentColor,
 * designed to read at their real 14px (w-3.5) sidebar size, no fills, no brand
 * logos — recognisable shapes, not trademarks.
 *
 * The two-eyes-plus-brackets pattern below is deliberate family coding: blob
 * marks are containers, messaging marks are channels with flow, vault marks
 * are shields. Within a family the silhouette differs by provider.
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

/** S3 and S3-compatible: a bucket with an object level inside. */
export function S3Icon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 8c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3Z" />
      <path d="M4 8v8c0 1.7 3.6 3 8 3s8-1.3 8-3V8" />
      <path d="M9 13h6" />
    </Svg>
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

/** RabbitMQ: a queue hop — two stations and a bouncing route between. */
export function RabbitmqIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3 5v14h18" />
      <path d="M7 15c0-4 2.5-8 6-8" />
      <circle cx="13" cy="7" r="1" />
      <path d="M7 15h4" />
    </Svg>
  );
}

/** SQS: a queue of parcels waiting in line. */
export function SqsIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3" y="4" width="5" height="5" />
      <rect x="3" y="15" width="5" height="5" />
      <rect x="14" y="9.5" width="5" height="5" />
      <path d="M8 6.5h3v5h3M8 17.5h3v-5" />
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

/** AWS Secrets Manager: a sealed envelope with a lock — a secret in transit, held. */
export function AwsSecretsManagerIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="4" y="6" width="16" height="12" rx="1.5" />
      <path d="m4 8 8 6 8-6" />
      <rect x="10" y="9" width="4" height="3" rx="0.6" />
    </Svg>
  );
}

/** AWS KMS: a key with a circuit node — cryptographic, not a lock. */
export function AwsKmsIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="8" cy="12" r="3" />
      <circle cx="8" cy="12" r="0.5" />
      <path d="M11 12h7M15 12v3M18 12v2" />
    </Svg>
  );
}
