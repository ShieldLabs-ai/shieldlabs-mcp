import type { DetectionFlags } from '@shieldlabs-ai/node';

export type RiskSignalGroup =
  'network' | 'consistency' | 'environment' | 'automation' | 'correction' | 'marker';

/** Plain-language description of one risk signal slug (`signals[].name`). */
export interface RiskSignalInfo {
  /** The slug exactly as it appears in `signals[].name`. */
  slug: string;
  /** Display label. */
  label: string;
  group: RiskSignalGroup;
  /** Current production weight, or null when the weight varies. The identification's own weight wins. */
  typical_weight: number | null;
  /** The detection flag that usually comes with this risk signal, if any. */
  related_flag: keyof DetectionFlags | null;
  /** What the risk signal indicates. */
  meaning: string;
  /** How to read it next to other risk signals. */
  reading: string;
}

/**
 * Known risk signals. Signal names are an open set: an identification can carry a name that is
 * not listed here, and weights can change. This catalog explains names; it never decides.
 */
export const RISK_SIGNAL_CATALOG: readonly RiskSignalInfo[] = [
  {
    slug: 'tor',
    label: 'Tor',
    group: 'network',
    typical_weight: 99,
    related_flag: 'tor',
    meaning:
      'The connection exits through the Tor network, which is built to hide where a connection comes from.',
    reading:
      'The strongest single network signal. When it is present, most other network, operating system and anti-detect weights are not added next to it.',
  },
  {
    slug: 'javascript_disabled',
    label: 'JavaScript Disabled',
    group: 'automation',
    typical_weight: 90,
    related_flag: 'javascript_disabled',
    meaning:
      'The browser lacks capabilities that every ordinary browser has, which marks a headless or automated client.',
    reading:
      'On its own it places the identification in the dangerous band. It still counts next to Tor and Privacy Relay.',
  },
  {
    slug: 'os_mismatch',
    label: 'OS Mismatch',
    group: 'consistency',
    typical_weight: 60,
    related_flag: 'os_mismatch',
    meaning:
      'The operating system the browser reports contradicts other evidence about the device.',
    reading:
      'An honest device does not contradict itself, so this is a strong sign of a spoofed environment.',
  },
  {
    slug: 'antidetect_browser',
    label: 'Anti-detect Browser',
    group: 'environment',
    typical_weight: 60,
    related_flag: 'anti_detect_browser',
    meaning:
      'Anti-detect or device-spoofing tooling is present: a deliberate attempt to look like a different device.',
    reading:
      'Counted once per identification, however many indicators fire. It can also be carried forward from an earlier identification of the same device and IP address, then with a partial weight.',
  },
  {
    slug: 'proxy_routed_antidetect',
    label: 'Anti-detect Browser, proxy-routed',
    group: 'environment',
    typical_weight: 60,
    related_flag: null,
    meaning: 'Anti-detect browser indicators were seen through a proxy connection.',
    reading: 'Added only when antidetect_browser did not fire. It has no detection_flags key.',
  },
  {
    slug: 'port_scan_routed_via_proxy',
    label: 'Anti-detect Browser, proxy-routed (carried forward)',
    group: 'environment',
    typical_weight: null,
    related_flag: null,
    meaning:
      'A proxy-routed anti-detect result carried forward from an earlier identification of the same device and IP address.',
    reading: 'Its weight is the part carried forward, so it varies. It has no detection_flags key.',
  },
  {
    slug: 'browser_automation',
    label: 'Browser Automation',
    group: 'automation',
    typical_weight: 60,
    related_flag: 'browser_automation',
    meaning: 'The browser is driven by an automation framework rather than by a person.',
    reading:
      'Near-certain non-human traffic. It counts independently of the connection type, also next to Tor.',
  },
  {
    slug: 'stun_not_checked',
    label: 'STUN not Checked',
    group: 'environment',
    typical_weight: 30,
    related_flag: 'stun_not_checked',
    meaning:
      'The network path check did not complete, so the connection could not be fully verified.',
    reading:
      'A later check can cancel it: the identification then also carries stun_late_correction with -30.',
  },
  {
    slug: 'stun_late_correction',
    label: 'Late network check (correction)',
    group: 'correction',
    typical_weight: -30,
    related_flag: null,
    meaning:
      'A correction: the network check completed after the first score and cancels stun_not_checked.',
    reading:
      'A negative weight that appears together with stun_not_checked. It has no detection_flags key.',
  },
  {
    slug: 'os_not_detected',
    label: 'OS not Detected',
    group: 'environment',
    typical_weight: 30,
    related_flag: 'os_not_detected',
    meaning: 'The operating system could not be derived from the available evidence.',
    reading: 'Points to a stripped or unusual environment. Treated as precautionary.',
  },
  {
    slug: 'browser_vpn_proxy',
    label: 'Browser VPN/Proxy',
    group: 'network',
    typical_weight: 30,
    related_flag: 'browser_vpn_proxy',
    meaning: 'An in-browser VPN or proxy extension is in use, rather than a system-wide VPN.',
    reading:
      'Stands in for the proxy, datacenter, abuser, operating system, network check and timezone weights. Not added together with anti-detect browser or JavaScript disabled.',
  },
  {
    slug: 'vpn',
    label: 'VPN',
    group: 'network',
    typical_weight: 15,
    related_flag: 'vpn',
    meaning: 'The connection runs through a VPN.',
    reading:
      'Common and often legitimate (corporate or privacy use), so a light signal on its own. It stands in for the proxy, datacenter, abuser, operating system, network check and timezone weights; anti-detect browser still adds on top.',
  },
  {
    slug: 'privacy_relay',
    label: 'Privacy Relay',
    group: 'network',
    typical_weight: 15,
    related_flag: 'privacy_relay',
    meaning: 'The connection goes through iCloud Private Relay or a similar privacy relay.',
    reading:
      'Mainstream and privacy-driven. When it is present, other network, operating system and anti-detect weights are not added next to it.',
  },
  {
    slug: 'proxy',
    label: 'Proxy',
    group: 'network',
    typical_weight: 10,
    related_flag: 'proxy',
    meaning: 'The connection is routed through a proxy.',
    reading: 'Stacks with datacenter_ip and abuser when no VPN is detected.',
  },
  {
    slug: 'datacenter_ip',
    label: 'Datacenter IP',
    group: 'network',
    typical_weight: 10,
    related_flag: 'datacenter_ip',
    meaning:
      'The IP address belongs to a datacenter or hosting network rather than a home or mobile provider.',
    reading:
      'Ordinary people rarely browse from datacenters, so it points to automation or relayed traffic.',
  },
  {
    slug: 'abuser',
    label: 'Abuser Flag',
    group: 'network',
    typical_weight: 10,
    related_flag: 'abuser',
    meaning: 'The IP address has a record of abuse in IP reputation data.',
    reading: 'Prior abuse on the address. Read it together with the other network risk signals.',
  },
  {
    slug: 'timezone_mismatch',
    label: 'Timezone Mismatch',
    group: 'consistency',
    typical_weight: 10,
    related_flag: 'timezone_mismatch',
    meaning: 'The device timezone does not match the location of the IP address.',
    reading: 'A light location signal that can be innocent (travel), so weigh it with the rest.',
  },
  {
    slug: 'rate_limited',
    label: 'Rate-limit marker',
    group: 'marker',
    typical_weight: 999,
    related_flag: null,
    meaning:
      'Not a risk signal: it comes with the 999 marker written when the visitor IP was temporarily banned after too many identifications.',
    reading:
      '999 is not a Risk Score and not a band. Skip this entry when you log or count risk signals.',
  },
];

const BY_SLUG = new Map(RISK_SIGNAL_CATALOG.map((info) => [info.slug, info]));

export function riskSignalInfo(slug: string): RiskSignalInfo | undefined {
  return BY_SLUG.get(slug);
}

/** Explanation used for a signal name this catalog does not know. */
export const UNKNOWN_SIGNAL_MEANING =
  'Not in this catalog: a newer or less common risk signal. Its weight on this identification counted toward the Risk Score.';

/** Rules that apply to every catalog entry. */
export const CATALOG_NOTES: readonly string[] = [
  'Weights are the current production values and can change. The weight on each identification is the one that counted.',
  'Signal names are an open set: an identification can carry a name that is not in this catalog.',
  'Branch on detection_flags and risk_score. Signal names are for display and logs.',
  'Never sum weights yourself: weights can be negative, carried forward or capped, so read risk_score for the total.',
];
