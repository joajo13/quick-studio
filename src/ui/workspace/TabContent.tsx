/**
 * quick-studio UI (Ring 2) — TabContent.
 *
 * Renders the body of the active Tab as a labelled shell PLACEHOLDER per kind.
 * No real data: table rows (Epic 3), ERD rendering (Epic 4), chat/report
 * (Epic 5/6) are out of scope. When no Tab is active it renders the empty state.
 */

import type { TabKind, WorkspaceTab } from "./workspace-state.ts";

/** Short human blurb per Tab kind for the placeholder body. */
const KIND_BLURB: Readonly<Record<TabKind, string>> = {
  table: "Browse rows and columns of a table. (Data lands in Epic 3.)",
  query: "Compose and run SQL against the connection. (Epic 3.)",
  erd: "Visualize the schema as an entity-relationship diagram. (Epic 4.)",
  chat: "Ask questions about your data in natural language. (Epic 5.)",
  report: "Assemble and export a data report. (Epic 6.)",
};

function EmptyState(): React.JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 text-center p-8">
      <div className="text-base font-medium text-foreground">No tab open</div>
      <p className="max-w-sm text-sm text-muted-foreground">
        Open a table, query, ERD, chat, or report from the launcher on the left to
        start working.
      </p>
    </div>
  );
}

export function TabContent({ tab }: { tab: WorkspaceTab | null }): React.JSX.Element {
  if (tab === null) {
    return <EmptyState />;
  }

  return (
    <section
      className="flex h-full flex-col gap-3 p-6"
      aria-label={`${tab.title} content`}
    >
      <header className="flex items-baseline gap-2">
        <h2 className="text-lg font-semibold text-foreground">{tab.title}</h2>
        <span className="rounded-full border border-border bg-muted px-2 py-0.5 text-xs uppercase tracking-wide text-muted-foreground">
          {tab.kind}
        </span>
      </header>
      <p className="max-w-prose text-sm text-muted-foreground">{KIND_BLURB[tab.kind]}</p>
      <div className="flex flex-1 items-center justify-center rounded-[var(--radius)] border border-dashed border-border bg-card/40 text-sm text-muted-foreground">
        {tab.kind} placeholder — shell only
      </div>
    </section>
  );
}
