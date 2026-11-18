import React, { type ReactNode } from "react";
import { ChevronRight } from "lucide-react";

/** A list of rows inside one rounded group. Rows either navigate or carry their own control. */
export function RowGroup({ children, label }: { children: ReactNode; label?: string }) {
  return <div className="settings-group" {...(label ? { role: "group", "aria-label": label } : {})}>{children}</div>;
}

export function NavigationRow({ title, description, disabled = false, onOpen }: {
  title: string;
  description: string;
  disabled?: boolean;
  onOpen: () => void;
}) {
  return <button type="button" className="settings-row" disabled={disabled} onClick={onOpen}>
    <span className="settings-row-copy"><strong>{title}</strong><small>{description}</small></span>
    <ChevronRight size={16} aria-hidden="true" />
  </button>;
}

export function NavigationRows<Route extends string>({ rows, disabled = false, onOpen }: {
  rows: readonly { route: Route; title: string; description: string }[];
  disabled?: boolean;
  onOpen: (route: Route) => void;
}) {
  return <RowGroup>
    {rows.map(row => <NavigationRow key={row.route} title={row.title} description={row.description} disabled={disabled} onOpen={() => onOpen(row.route)} />)}
  </RowGroup>;
}
