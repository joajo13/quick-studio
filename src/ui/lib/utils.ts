/**
 * quick-studio UI (Ring 2) — shadcn/ui class-composition helper (Story 8.1).
 *
 * `cn()` merges conditional class-name inputs with `clsx`, then resolves any
 * conflicting Tailwind utility classes (last one wins) with `tailwind-merge`.
 * This is the single helper every `components/ui/*` primitive imports.
 */

import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
