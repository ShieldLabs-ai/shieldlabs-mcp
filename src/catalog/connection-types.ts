/** Plain-language description of one connection type. */
export interface ConnectionTypeInfo {
  value: string;
  label: string;
  meaning: string;
}

/** Known values of `connection_type`. Unknown strings can appear and are kept as sent. */
export const CONNECTION_TYPE_CATALOG: readonly ConnectionTypeInfo[] = [
  {
    value: 'direct',
    label: 'Direct',
    meaning: 'An ordinary connection without a masking signal, such as home Wi-Fi without a VPN.',
  },
  {
    value: 'mobile',
    label: 'Mobile',
    meaning: 'A cellular carrier, including tethering or a hotspot.',
  },
  { value: 'vpn', label: 'VPN', meaning: 'Traffic runs through a system-wide VPN.' },
  { value: 'proxy', label: 'Proxy', meaning: 'The connection is routed through a proxy.' },
  { value: 'tor', label: 'Tor', meaning: 'The connection exits through the Tor network.' },
  {
    value: 'privacy_relay',
    label: 'Privacy Relay',
    meaning: 'The connection is relayed through iCloud Private Relay.',
  },
  {
    value: 'browser_vpn_proxy',
    label: 'Browser VPN/Proxy',
    meaning: 'An in-browser VPN or proxy extension, not a system VPN.',
  },
  { value: 'unknown', label: 'Unknown', meaning: 'The connection type could not be resolved.' },
];

const BY_VALUE = new Map(CONNECTION_TYPE_CATALOG.map((info) => [info.value, info]));

/** Catalog entry for a connection type; unknown values get a generic description. */
export function connectionTypeInfo(value: string): ConnectionTypeInfo {
  return (
    BY_VALUE.get(value) ?? {
      value,
      label: value,
      meaning: 'A connection type this server does not know yet.',
    }
  );
}
