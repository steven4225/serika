import React, { useEffect, useRef, type ReactNode } from "react";
import { ChevronLeft } from "lucide-react";

export interface PageBack {
  label: string;
  onBack: () => void;
  disabled?: boolean;
}

/** The one navigation row every pushed page uses: back control, title, optional note and actions. */
export function PageHeader({ title, description, back, actions }: {
  title: string;
  description?: ReactNode;
  back?: PageBack;
  actions?: ReactNode;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  // Opening a page removes the row that was clicked, so keyboard focus has to land on the page itself.
  useEffect(() => { heading.current?.focus(); }, []);
  return <header className="page-header">
    {back ? <button type="button" className="page-back" aria-label={back.label} title={back.label} disabled={back.disabled === true} onClick={back.onBack}><ChevronLeft size={18} aria-hidden="true" /></button> : null}
    <div className="page-header-copy"><h1 ref={heading} tabIndex={-1}>{title}</h1>{description ? <p className="page-header-note">{description}</p> : null}</div>
    {actions ? <div className="page-header-actions">{actions}</div> : null}
  </header>;
}
