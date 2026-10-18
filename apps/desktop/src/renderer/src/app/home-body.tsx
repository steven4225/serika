import type { HomeView } from "../home-view.js";
import { presentHomeTaskItem, reminderClock } from "../reminder-copy.js";

export function HomeBody({ view }: { view: HomeView }) {
  if (view.sections.length === 0) {
    return <div className="muted">正在读取…</div>;
  }
  const clock = reminderClock();
  return (
    <div className="home-body">
      {view.sections.map((section) => (
        <div className="home-section" key={section.title}>
          <div className="home-title">
            <span>{section.title === "本地任务" ? "提醒与定时结果" : section.title}</span>
            {section.summary ? <span className="home-summary">{section.summary}</span> : null}
          </div>
          {section.items.length > 0 ? (
            <ul className="home-items">
              {section.items.map((item, index) => {
                const shown = section.title === "本地任务" ? presentHomeTaskItem(item, clock) : { primary: item.text, detail: null };
                return (
                  <li key={index} className={item.kind}>
                    {shown.primary}
                    {shown.detail ? <small>{shown.detail}</small> : null}
                  </li>
                );
              })}
            </ul>
          ) : null}
        </div>
      ))}
    </div>
  );
}
