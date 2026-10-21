import type { DreamingControllerOverview } from "./assistant-controller.js";
import type { ControllerKernel } from "./controller-kernel.js";
import type { DreamingChangeInput, DreamingResult, LearnedSkill, LearnedSkillReferenceSnapshot } from "./dreaming.js";

/** Experience learning ("dreaming") and the learned text skills it maintains. */
export interface AssistantDreamingControls {
  getOverview(): Promise<DreamingResult<DreamingControllerOverview>>;
  /** Success means reflection started, not that any method was learned. */
  dream(): Promise<DreamingResult<{ runId: string }>>;
  changeLearnedSkill(input: DreamingChangeInput): Promise<DreamingResult<LearnedSkill>>;
  getLearnedSkillReferences(): (LearnedSkillReferenceSnapshot & { runId: string }) | null;
}

const dreamingFailure = (code: string, message: string): DreamingResult<never> => ({ ok: false, error: { code, message } });

export function createDreamingControls(k: ControllerKernel): AssistantDreamingControls {
  const { app } = k;
  return {
    getOverview: async () => {
      const enabled = false;
      if (!app.dreaming) return { ok: true, value: { enabled: false, skills: [], pendingExperiences: 0, processedExperiences: 0 } };
      const result = await app.dreaming.overview();
      return result.ok ? { ok: true, value: { ...result.value, enabled } } : result;
    },
    dream: async () => dreamingFailure("DREAMING_DISABLED", "新方法提炼已暂停；已有方法仍可按索引读取"),
    getLearnedSkillReferences: () => k.primaryReference(app.getLearnedSkillReferences?.()),
    changeLearnedSkill: async input => {
      if (!app.dreaming) return dreamingFailure("DREAMING_UNAVAILABLE", "当前工作区不支持经验学习");
      if (k.isClosed() || !k.isIdle()) return dreamingFailure("BUSY", "请等待当前操作结束");
      return k.exclusive("learned-skill-change", async (): Promise<DreamingResult<LearnedSkill>> => {
        try {
          await k.ensureRecovered();
          return await app.dreaming!.change(input);
        } catch (error) { return dreamingFailure("DREAMING_WRITE_UNCONFIRMED", String(error)); }
      });
    },
  };
}
