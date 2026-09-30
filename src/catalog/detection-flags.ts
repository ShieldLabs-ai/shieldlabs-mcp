import type { DetectionFlags } from '@shieldlabs/node';

export type DetectionFlagKey = keyof DetectionFlags;

/** Plain-language description of one detection flag. */
export interface DetectionFlagInfo {
  flag: DetectionFlagKey;
  label: string;
  /** True when the flag usually comes with a weighted risk signal; false for informational flags (weight 0). */
  scored: boolean;
  meaning: string;
}

/** The 19 detection flags, in wire order. */
export const DETECTION_FLAG_CATALOG: readonly DetectionFlagInfo[] = [
  { flag: 'vpn', label: 'VPN', scored: true, meaning: 'A VPN was detected on the connection.' },
  {
    flag: 'privacy_relay',
    label: 'Privacy Relay',
    scored: true,
    meaning: 'The connection goes through iCloud Private Relay or a similar privacy relay.',
  },
  {
    flag: 'browser_vpn_proxy',
    label: 'Browser VPN/Proxy',
    scored: true,
    meaning: 'An in-browser VPN or proxy extension is in use.',
  },
  {
    flag: 'tor',
    label: 'Tor',
    scored: true,
    meaning: 'The connection exits through the Tor network.',
  },
  {
    flag: 'proxy',
    label: 'Proxy',
    scored: true,
    meaning:
      'The connection is routed through a proxy (from a scored risk signal or IP reputation data).',
  },
  {
    flag: 'datacenter_ip',
    label: 'Datacenter IP',
    scored: true,
    meaning: 'The IP address belongs to a datacenter or hosting network.',
  },
  {
    flag: 'abuser',
    label: 'Abuser Flag',
    scored: true,
    meaning: 'The IP address has a record of abuse in IP reputation data.',
  },
  {
    flag: 'os_mismatch',
    label: 'OS Mismatch',
    scored: true,
    meaning: 'The reported operating system contradicts other evidence about the device.',
  },
  {
    flag: 'os_not_detected',
    label: 'OS not Detected',
    scored: true,
    meaning: 'The operating system could not be derived from the available evidence.',
  },
  {
    flag: 'timezone_mismatch',
    label: 'Timezone Mismatch',
    scored: true,
    meaning: 'The device timezone does not match the location of the IP address.',
  },
  {
    flag: 'anti_detect_browser',
    label: 'Anti-detect Browser',
    scored: true,
    meaning: 'Anti-detect or device-spoofing tooling is present.',
  },
  {
    flag: 'browser_automation',
    label: 'Browser Automation',
    scored: true,
    meaning: 'The browser is driven by an automation framework.',
  },
  {
    flag: 'ip_mismatch',
    label: 'IP Mismatch',
    scored: false,
    meaning:
      'The public IP and the local IP the browser reports are different addresses. This can be ordinary on mobile networks: compare public_ip.country with local_ip.country when location matters.',
  },
  {
    flag: 'incognito',
    label: 'Incognito',
    scored: false,
    meaning: 'The browser is in a private or incognito mode.',
  },
  {
    flag: 'search_bot',
    label: 'Search bot',
    scored: false,
    meaning:
      'A known search-engine crawler. Its Risk Score is set to 0 and its traffic channel is Search bot.',
  },
  {
    flag: 'suspicious_paid_click',
    label: 'Suspicious Paid Click',
    scored: false,
    meaning:
      'An identification on an ads or social channel (Google Ads, Meta, TikTok, LinkedIn, X, Pinterest, Microsoft Ads) with a Risk Score of 60 or more.',
  },
  {
    flag: 'javascript_disabled',
    label: 'JavaScript Disabled',
    scored: true,
    meaning:
      'The browser lacks capabilities every ordinary browser has: a headless or automated client.',
  },
  {
    flag: 'stun_not_checked',
    label: 'STUN not Checked',
    scored: true,
    meaning: 'The network path check did not complete.',
  },
  {
    flag: 'check_incomplete',
    label: 'Check Incomplete',
    scored: false,
    meaning:
      'One of the checks did not finish before the result was stored. The identification is scored on what arrived.',
  },
];

export const DETECTION_FLAG_KEYS: readonly DetectionFlagKey[] = DETECTION_FLAG_CATALOG.map(
  (info) => info.flag,
);

const BY_FLAG = new Map(DETECTION_FLAG_CATALOG.map((info) => [info.flag, info]));

export function detectionFlagInfo(flag: DetectionFlagKey): DetectionFlagInfo {
  return BY_FLAG.get(flag) as DetectionFlagInfo;
}
