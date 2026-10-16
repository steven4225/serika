import React from "react";
import { ChevronRight } from "lucide-react";

/** Shared content for an action card or a disclosure's clickable summary. */
export function EntryCardContent({ title, description }: { title: string; description: string }) {
  return <>
    <span className="entry-card-copy"><strong>{title}</strong><span>{description}</span></span>
    <span className="entry-card-arrow" aria-hidden="true"><ChevronRight size={18} /></span>
  </>;
}
