import React from "react";
import { SerikaPersona } from "../icons.js";

/** Persona landing for the serika pill. Settings stay on the gear. */
export function PersonaPanel() {
  return <section className="card persona-panel" aria-label="人设">
    <SerikaPersona size={88} />
    <p>你的个人助手。聊天在左边，手札、任务和记忆从上面的胶囊进入。</p>
  </section>;
}
