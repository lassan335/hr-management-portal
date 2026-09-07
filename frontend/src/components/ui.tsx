import type { ReactNode } from "react";

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl ${className}`}>
      {children}
    </div>
  );
}

type BadgeTone = "green" | "amber" | "red" | "slate" | "blue";

const BADGE_TONE_CLASSES: Record<BadgeTone, string> = {
  green: "bg-green-100 text-green-700 dark:bg-green-500/15 dark:text-green-400",
  amber: "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-400",
  red: "bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-400",
  slate: "bg-slate-100 text-slate-600 dark:bg-slate-500/15 dark:text-slate-300",
  blue: "bg-blue-100 text-blue-700 dark:bg-blue-500/15 dark:text-blue-400",
};

export function Badge({ children, tone = "slate" }: { children: ReactNode; tone?: BadgeTone }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap ${BADGE_TONE_CLASSES[tone]}`}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {children}
    </span>
  );
}

/** Maps common status/boolean-ish strings across the app to a Badge tone. */
export function toneForStatus(status: string): BadgeTone {
  const s = status.toUpperCase();
  if (["ACTIVE", "APPROVED", "YES", "VALIDATED"].includes(s)) return "green";
  if (["PENDING_HOD", "PENDING_HR", "PENDING", "ON_LEAVE"].includes(s)) return "amber";
  if (["REJECTED", "CANCELLED", "SUSPENDED", "TERMINATED", "NO"].includes(s)) return "red";
  if (["RESIGNED", "INACTIVE"].includes(s)) return "slate";
  return "blue";
}

export function StatusBadge({ status }: { status: string }) {
  return <Badge tone={toneForStatus(status)}>{status.replace(/_/g, " ")}</Badge>;
}

const STAT_CARD_GRADIENTS = {
  teal: "from-teal-500 to-cyan-600",
  purple: "from-violet-500 to-purple-600",
  orange: "from-orange-500 to-amber-600",
  pink: "from-pink-500 to-rose-600",
} as const;

export function StatCard({
  label,
  value,
  icon,
  gradient,
  hint,
}: {
  label: string;
  value: ReactNode;
  icon: ReactNode;
  gradient: keyof typeof STAT_CARD_GRADIENTS;
  hint?: string;
}) {
  return (
    <div className={`rounded-xl p-4 text-white bg-gradient-to-br ${STAT_CARD_GRADIENTS[gradient]} shadow-sm`}>
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-white/90">{label}</span>
        <span className="text-white/80">{icon}</span>
      </div>
      <div className="mt-3 flex items-end justify-between">
        <span className="text-2xl font-semibold">{value}</span>
        {hint && <span className="text-xs text-white/80">{hint}</span>}
      </div>
    </div>
  );
}
