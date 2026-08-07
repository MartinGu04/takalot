// Minimal, consistent stroke-icon set (no external icon dependency). All
// icons share a 20x20 viewBox, 1.75 stroke width, and round joins so they
// read as one visual family across the sidebar, header, and controls.
import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement>;

function base(props: IconProps) {
  return {
    xmlns: 'http://www.w3.org/2000/svg',
    viewBox: '0 0 20 20',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.75,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    ...props,
  };
}

export function IconPulse(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M2.5 10.5h3l2-5 3 9 2-7 1.5 3h3.5" />
    </svg>
  );
}

export function IconAlertTriangle(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M10 3.2 2.9 15.5a1 1 0 0 0 .87 1.5h12.46a1 1 0 0 0 .87-1.5L10 3.2Z" />
      <path d="M10 8.2v3.5" />
      <circle cx="10" cy="14.2" r="0.15" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function IconArrowsExchange(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M4 6.5h11l-2.5-2.5" />
      <path d="M16 13.5H5l2.5 2.5" />
    </svg>
  );
}

export function IconArchive(props: IconProps) {
  return (
    <svg {...base(props)}>
      <rect x="3" y="3.5" width="14" height="3.2" rx="0.8" />
      <path d="M4 6.7v8.3a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V6.7" />
      <path d="M8 10.2h4" />
    </svg>
  );
}

export function IconChartBar(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M3 16.5h14" />
      <rect x="4.5" y="11" width="3" height="5.2" rx="0.6" />
      <rect x="8.5" y="7.3" width="3" height="9" rx="0.6" />
      <rect x="12.5" y="3.8" width="3" height="12.5" rx="0.6" />
    </svg>
  );
}

export function IconTrash(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M3.5 5.5h13" />
      <path d="M8 3.2h4l.8 2.3H7.2L8 3.2Z" />
      <path d="m5 5.5.7 10.1a1.2 1.2 0 0 0 1.2 1.1h6.2a1.2 1.2 0 0 0 1.2-1.1L15 5.5" />
      <path d="M8.2 8.5v5.2M11.8 8.5v5.2" />
    </svg>
  );
}

export function IconLock(props: IconProps) {
  return (
    <svg {...base(props)}>
      <rect x="4.5" y="9" width="11" height="8" rx="1.6" />
      <path d="M6.5 9V6.3a3.5 3.5 0 0 1 7 0V9" />
      <circle cx="10" cy="12.6" r="1" fill="currentColor" stroke="none" />
      <path d="M10 13.6v1.6" />
    </svg>
  );
}

export function IconShield(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M10 2.7 16 5v4.4c0 4-2.6 6.6-6 7.9-3.4-1.3-6-3.9-6-7.9V5l6-2.3Z" />
      <path d="M7.5 9.8 9.3 11.6 12.7 8" />
    </svg>
  );
}

export function IconUsers(props: IconProps) {
  return (
    <svg {...base(props)}>
      <circle cx="7.2" cy="7" r="2.4" />
      <path d="M2.7 16.2c0-2.5 2-4.2 4.5-4.2s4.5 1.7 4.5 4.2" />
      <circle cx="14.2" cy="6.3" r="1.9" />
      <path d="M13 11.9c1.9.2 3.7 1.7 3.7 4.3" />
    </svg>
  );
}

export function IconSun(props: IconProps) {
  return (
    <svg {...base(props)}>
      <circle cx="10" cy="10" r="3.2" />
      <path d="M10 2.5v1.7M10 15.8v1.7M17.5 10h-1.7M4.2 10H2.5M15.3 4.7l-1.2 1.2M5.9 14.1l-1.2 1.2M15.3 15.3l-1.2-1.2M5.9 5.9 4.7 4.7" />
    </svg>
  );
}

export function IconMoon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M16.5 12.3A6.8 6.8 0 0 1 7.7 3.5a6.8 6.8 0 1 0 8.8 8.8Z" />
    </svg>
  );
}

export function IconMonitor(props: IconProps) {
  return (
    <svg {...base(props)}>
      <rect x="2.5" y="4" width="15" height="9.5" rx="1.2" />
      <path d="M7 17h6M10 13.5V17" />
    </svg>
  );
}

export function IconBell(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M5 8a5 5 0 0 1 10 0c0 3.2 1 4.4 1.5 5H3.5C4 12.4 5 11.2 5 8Z" />
      <path d="M8.2 15.5a1.8 1.8 0 0 0 3.6 0" />
    </svg>
  );
}

export function IconLogOut(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M8 17H4.8a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1H8" />
      <path d="M12.5 13.5 16 10l-3.5-3.5" />
      <path d="M16 10H7.5" />
    </svg>
  );
}

export function IconPlus(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M10 4.5v11M4.5 10h11" />
    </svg>
  );
}

export function IconChevronDown(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="m5 7.5 5 5 5-5" />
    </svg>
  );
}

export function IconDotsVertical(props: IconProps) {
  return (
    <svg {...base(props)}>
      <circle cx="10" cy="4" r="1.25" fill="currentColor" stroke="none" />
      <circle cx="10" cy="10" r="1.25" fill="currentColor" stroke="none" />
      <circle cx="10" cy="16" r="1.25" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function IconDotsHorizontal(props: IconProps) {
  return (
    <svg {...base(props)}>
      <circle cx="4" cy="10" r="1.25" fill="currentColor" stroke="none" />
      <circle cx="10" cy="10" r="1.25" fill="currentColor" stroke="none" />
      <circle cx="16" cy="10" r="1.25" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function IconChevronLeft(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="m12.5 5-5 5 5 5" />
    </svg>
  );
}

export function IconCheck(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="m4.5 10.5 3.5 3.5 7.5-8" />
    </svg>
  );
}

export function IconClock(props: IconProps) {
  return (
    <svg {...base(props)}>
      <circle cx="10" cy="10" r="7" />
      <path d="M10 6v4.2l2.8 1.8" />
    </svg>
  );
}

export function IconCalendar(props: IconProps) {
  return (
    <svg {...base(props)}>
      <rect x="3" y="4.2" width="14" height="12.3" rx="1.6" />
      <path d="M3 8h14" />
      <path d="M6.5 2.5v3" />
      <path d="M13.5 2.5v3" />
    </svg>
  );
}

export function IconFlag(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M5 3v14" />
      <path d="M5 4c1.5-1 3.5-1 5 0s3.5 1 5 0v7c-1.5 1-3.5 1-5 0s-3.5-1-5 0Z" />
    </svg>
  );
}

export function IconBriefcase(props: IconProps) {
  return (
    <svg {...base(props)}>
      <rect x="2.5" y="6.5" width="15" height="9.5" rx="1.4" />
      <path d="M7 6.5V5a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 13 5v1.5" />
      <path d="M2.5 10.8h15" />
    </svg>
  );
}

export function IconHeadset(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M4 11v-1a6 6 0 0 1 12 0v1" />
      <rect x="2.7" y="10.5" width="3.3" height="5" rx="1.2" />
      <rect x="14" y="10.5" width="3.3" height="5" rx="1.2" />
      <path d="M15.5 15.5v.8a2 2 0 0 1-2 2h-2.3" />
    </svg>
  );
}

export function IconWrench(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M12.5 3.8a3.6 3.6 0 0 0-4.7 4.3L3 12.9v2.6h2.6l4.8-4.8a3.6 3.6 0 0 0 4.3-4.7l-2.4 2.4-1.8-.6-.6-1.8 2.4-2.2Z" />
    </svg>
  );
}

/** Drag-handle grip: two columns of three dots, the universal "draggable"
 *  affordance. Deliberately no outline/frame of its own -- callers provide
 *  the hit target and any hover/focus treatment around it. */
export function IconGripVertical(props: IconProps) {
  return (
    <svg {...base(props)}>
      <circle cx="7.5" cy="5" r="1.15" fill="currentColor" stroke="none" />
      <circle cx="7.5" cy="10" r="1.15" fill="currentColor" stroke="none" />
      <circle cx="7.5" cy="15" r="1.15" fill="currentColor" stroke="none" />
      <circle cx="12.5" cy="5" r="1.15" fill="currentColor" stroke="none" />
      <circle cx="12.5" cy="10" r="1.15" fill="currentColor" stroke="none" />
      <circle cx="12.5" cy="15" r="1.15" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function IconEye(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M2 10s2.8-5 8-5 8 5 8 5-2.8 5-8 5-8-5-8-5Z" />
      <circle cx="10" cy="10" r="2.3" />
    </svg>
  );
}

/** Clipboard with a checklist -- used for the audit log (יומן ביקורת). */
export function IconClipboardList(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M7.5 3.5h5a1 1 0 0 1 1 1v.5h-7v-.5a1 1 0 0 1 1-1Z" />
      <path d="M6.5 5h-1a1.5 1.5 0 0 0-1.5 1.5v9A1.5 1.5 0 0 0 5.5 17h9a1.5 1.5 0 0 0 1.5-1.5v-9A1.5 1.5 0 0 0 14.5 5h-1" />
      <path d="M7 10h.01M9 10h4M7 13h.01M9 13h4" />
    </svg>
  );
}

/** Lightbulb -- "AVARIA noticed something worth a look", used for the
 *  creation-time similar-incident suggestion heading. Deliberately an
 *  insight cue, not IconAlertTriangle, which reads as a warning/error. */
export function IconLightbulb(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M7 8.2a3 3 0 1 1 6 0c0 1.5-.9 2.2-1.5 2.9-.4.5-.5 1-.5 1.6v.3h-2v-.3c0-.6-.1-1.1-.5-1.6C7.9 10.4 7 9.7 7 8.2Z" />
      <path d="M8.3 15h3.4" />
      <path d="M8.7 17h2.6" />
    </svg>
  );
}

/** Gear/settings icon -- used for the notification-center's system_admin-only "הגדרות התראות" trigger. */
export function IconSettings(props: IconProps) {
  return (
    <svg {...base(props)}>
      <circle cx="10" cy="10" r="2.6" />
      <path d="M10 3.2v1.7M10 15.1v1.7M16.8 10h-1.7M4.9 10H3.2M14.8 5.2l-1.2 1.2M6.4 13.4l-1.2 1.2M14.8 14.8l-1.2-1.2M6.4 6.6 5.2 5.4" />
    </svg>
  );
}
