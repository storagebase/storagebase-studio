import { describe, test, expect } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AzureBlobIcon,
  AzureKeyVaultIcon,
  HashicorpVaultIcon,
  KafkaIcon,
  OpenBaoIcon,
} from "@/components/storagebase/resources/resource-icons";

describe("resource-icons", () => {
  // Hand-written and NOT type-enforced, like the db-icons list it mirrors: a
  // new resource type's icon is covered because its name was added here, and
  // the RESOURCE_UI_CONFIG exhaustiveness test fails until it is configured.
  const icons = [
    { name: "AzureBlobIcon", Component: AzureBlobIcon },
    { name: "KafkaIcon", Component: KafkaIcon },
    { name: "AzureKeyVaultIcon", Component: AzureKeyVaultIcon },
    { name: "HashicorpVaultIcon", Component: HashicorpVaultIcon },
    { name: "OpenBaoIcon", Component: OpenBaoIcon },
  ];

  for (const { name, Component } of icons) {
    test(`${name} renders a single-stroke currentColor SVG`, () => {
      const html = renderToStaticMarkup(React.createElement(Component, { className: "w-3.5 h-3.5" }));
      expect(html).toContain("<svg");
      expect(html).toContain('stroke="currentColor"');
      expect(html).toContain('stroke-width="1.5"');
      expect(html).toContain('aria-hidden="true"');
      expect(html).toContain("w-3.5 h-3.5");
    });
  }
});
